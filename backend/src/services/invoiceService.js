const ApiError = require("../utils/ApiError");
const { rethrowServiceError } = require("../utils/serviceErrorUtils");
const Invoice = require("../models/Invoice");
const InvoiceXray = require("../models/InvoiceXray");
const CompanyInvoice = require("../models/CompanyInvoice");
const InvoiceReport = require("../models/InvoiceReport");
const Order = require("../models/Order");
const Provider = require("../models/Provider");
const config = require("../config");
const { getPool } = require("../config/database");
const { calculateOrderRushLevel } = require("../utils/rushUtils");
const { formatDobDisplay, toShortDate: toSqlShortDate } = require("../utils/dateUtils");
const {
  calendarTodayInTimezone,
  toMysqlUtcDateTime,
  toUtcIso,
  formatUtcInstantDisplay,
} = require("../utils/timezoneUtils");
const {
  sanitizeTrimOrNull,
} = require("../utils/sanitize");
const { FIELD_LIMITS } = require("../utils/fieldLimits");
const {
  parseReportDateFilters,
  parseInvoiceListFilters,
  parseInvoiceReportQuery,
  parseCompanyInvoiceQuery,
  parseCompanyIdParam,
  parseOptionalReportType,
  parseOptionalReportTab,
  hasCompanyGroupKey,
} = require("../lib/reportQueryParser");
const { areAllOrderInvoicesWrittenOff } = require("../utils/orderInvoicePayment");

const ORDER_TYPE_LABELS = {
  medical: "Medical Records",
  billing: "Billing Records",
  employment: "Employment Records",
  xrays: "X-Rays",
  other: "Other",
};

function trimOrNull(value, options = {}) {
  return sanitizeTrimOrNull(value, options);
}

function parseInvoiceDateFilters(query = {}) {
  return parseReportDateFilters(query);
}

function getInvoiceRecipientEmail(row) {
  return trimOrNull(row?.provider_email);
}

function getInvoiceDisplayEmail(row) {
  return (
    getInvoiceRecipientEmail(row) ||
    trimOrNull(row?.recipient_emails) ||
    trimOrNull(row?.serve_email) ||
    ""
  );
}

function isPersonalPortalOrder(orderOrSource) {
  if (!orderOrSource) return false;
  if (typeof orderOrSource === "string") {
    return orderOrSource === "personal_portal";
  }
  return (
    orderOrSource.creation_source === "personal_portal" ||
    orderOrSource.creationSource === "personal_portal"
  );
}

async function resolveInvoiceRecipientFromOrder(order, connection = null) {
  // Personal portal invoices go to the requesting patient, not a provider.
  if (isPersonalPortalOrder(order) && order?.id) {
    try {
      const PersonalRequestOrder = require("../models/PersonalRequestOrder");
      const request = await PersonalRequestOrder.findByOrderId(
        order.id,
        connection
      );
      const personalEmail = trimOrNull(request?.email);
      if (personalEmail) {
        return personalEmail;
      }
    } catch (_error) {
      // fall through to provider email
    }
  }

  const providerId = order?.provider_id || null;

  if (providerId) {
    const provider = await Provider.findById(providerId, connection);
    const providerEmail = trimOrNull(provider?.email);
    if (providerEmail) {
      return providerEmail;
    }
  }

  return trimOrNull(order?.provider_email) || trimOrNull(order?.serve_email);
}

async function resolveInvoiceRecipientEmail(invoice, connection = null) {
  if (invoice?.order_id) {
    const order = await Order.findById(invoice.order_id, connection);
    const fromOrder = await resolveInvoiceRecipientFromOrder(order, connection);
    if (fromOrder) {
      return fromOrder;
    }
  }

  return getInvoiceRecipientEmail(invoice);
}

async function resolveAutomaticReminderRecipientEmails({
  invoice = null,
  order = null,
  xrayRow = null,
} = {}) {
  const stored =
    trimOrNull(invoice?.recipient_emails) || trimOrNull(xrayRow?.recipient_emails);

  if (stored) {
    return normalizeRecipientEmails(stored);
  }

  if (invoice) {
    const resolved = await resolveInvoiceRecipientEmail(invoice);
    if (resolved) {
      return normalizeRecipientEmails(resolved);
    }
  }

  if (order) {
    const fromOrder = await resolveInvoiceRecipientFromOrder(order);
    if (fromOrder) {
      return normalizeRecipientEmails(fromOrder);
    }

    const serveEmail = trimOrNull(order.serve_email);
    if (serveEmail) {
      return normalizeRecipientEmails(serveEmail);
    }
  }

  return [];
}

const NO_PROVIDER_EMAIL_MESSAGE =
  "No provider email on file. Edit the order to add the provider email.";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;

function normalizeRecipientEmails(value) {
  const raw = Array.isArray(value)
    ? value
    : `${value || ""}`.split(/[,;]+/);

  const seen = new Set();
  const emails = [];

  raw.forEach((item) => {
    const trimmed = `${item || ""}`.trim();
    if (!trimmed) return;

    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;

    seen.add(key);
    emails.push(trimmed);
  });

  return emails;
}

function assertValidRecipientEmails(emails = []) {
  const normalized = normalizeRecipientEmails(emails);

  if (!normalized.length) {
    throw new ApiError(400, "At least one recipient email is required");
  }

  const invalidEmail = normalized.find((email) => !EMAIL_PATTERN.test(email));
  if (invalidEmail) {
    throw new ApiError(400, `Invalid email address: ${invalidEmail}`);
  }

  return normalized;
}

function getXrayPayment(xrayRow) {
  return xrayRow ? toNumber(xrayRow.payment) : 0;
}

function buildStandardInvoiceNumber(order) {
  const orderRef = trimOrNull(order?.order_number) || String(order?.id || "");
  return `INV-${orderRef}`;
}

function buildXrayInvoiceNumber(order) {
  const orderRef = trimOrNull(order?.order_number) || String(order?.id || "");
  return `INV-${orderRef}X`;
}

function resolveXrayInvoiceNumber(xrayRow, order = null) {
  const stored = trimOrNull(xrayRow?.invoice_number);
  if (stored) return stored;
  if (order) return buildXrayInvoiceNumber(order);
  const orderRef =
    trimOrNull(xrayRow?.order_number) || String(xrayRow?.order_id || "");
  return orderRef ? `INV-${orderRef}X` : "";
}

const ORDER_PAYMENT_TYPES = ["prepayment", "custodian", "xray"];
const STANDARD_INVOICE_PAYMENT_TYPES = ["prepayment"];
const DEFAULT_CUSTODIAN_CHARGE = 0;
const DEFAULT_PREPAYMENT_CHARGE = 15;
const QUICK_RECORDS_FEE = 20;
const REQUEST_TOTAL_WITH_RECORDS_FEE =
  DEFAULT_PREPAYMENT_CHARGE + QUICK_RECORDS_FEE;

const ORDER_PAYMENT_LABELS = {
  prepayment: "Prepayment",
  custodian: "Custodian",
  xray: "X-Ray Fee",
};

function getOrderPaymentAmount(payments = [], paymentType) {
  const payment = payments.find((row) => row.payment_type === paymentType);
  if (!payment) return 0;

  const amount = toNumber(payment.amount);
  return amount > 0 ? amount : 0;
}

function sumOrderPayments(payments = []) {
  return ORDER_PAYMENT_TYPES.reduce(
    (sum, paymentType) => sum + getOrderPaymentAmount(payments, paymentType),
    0
  );
}

function sumStandardInvoicePayments(payments = []) {
  return STANDARD_INVOICE_PAYMENT_TYPES.reduce(
    (sum, paymentType) => sum + getOrderPaymentAmount(payments, paymentType),
    0
  );
}

function splitLineItemsAndFacility(rowOrPayload = {}) {
  const facilityFee = extractFacilitySearchFeeFromNotes(rowOrPayload.notes);
  const storageFee = getStorageFee(rowOrPayload);
  const storageOnly = Math.max(0, Number((storageFee - facilityFee).toFixed(2)));
  const lineItemsTotal = calculateTotals({
    pages: rowOrPayload.pages ?? rowOrPayload.page_count,
    perPageAmount: rowOrPayload.perPageAmount ?? rowOrPayload.per_page_amount,
    clericalTimeHours:
      rowOrPayload.clericalTimeHours ?? rowOrPayload.clerical_time_hours,
    clericalHourlyRate:
      rowOrPayload.clericalHourlyRate ?? rowOrPayload.clerical_hourly_rate,
    shippingHandling:
      rowOrPayload.shippingHandling ?? rowOrPayload.shipping_handling,
    storageFee: storageOnly,
  }).totalAmount;

  return {
    lineItemsTotal,
    facilityFee,
    totalAmount: lineItemsTotal + facilityFee,
  };
}

function resolvePersonalPortalPrepaymentCredit(orderPayments, lineItemsTotal) {
  const prepaymentPaid = getOrderPaymentAmount(orderPayments, "prepayment");
  return Math.min(prepaymentPaid, Math.max(0, toNumber(lineItemsTotal)));
}

/** Never apply more paid than the invoice total (ignore overpayment). */
function capPaidToInvoiceTotal(amountPaid, totalAmount) {
  const total = Math.max(0, toNumber(totalAmount));
  const paid = Math.max(0, toNumber(amountPaid));
  return Math.min(paid, total);
}

function resolveAmountPaid(orderPayments, existing = null, invoiceShape = null, options = {}) {
  const fromOrderPayments =
    orderPayments !== undefined
      ? sumStandardInvoicePayments(orderPayments)
      : null;
  const fromExisting = existing ? toNumber(existing.amount_paid) : 0;
  const shape = invoiceShape || existing;
  const personalPortal = Boolean(options.personalPortalOrder);
  const invoiceTotal =
    options.totalAmount != null
      ? toNumber(options.totalAmount)
      : shape
        ? splitLineItemsAndFacility(shape).totalAmount
        : null;

  let resolved;

  if (
    existing &&
    (existing.payment_method === "manual" || existing.payment_method === "online") &&
    existing.status === "Paid"
  ) {
    resolved = fromExisting;
  } else if (personalPortal && shape) {
    // Personal portal: credit prepayment against line items only — facility fee
    // is always due in full (not offset by the $35 processing fee).
    if (
      existing &&
      (existing.payment_method === "manual" || existing.payment_method === "online")
    ) {
      resolved = fromExisting;
    } else {
      const { lineItemsTotal } = splitLineItemsAndFacility(shape);
      resolved = resolvePersonalPortalPrepaymentCredit(
        orderPayments || [],
        lineItemsTotal
      );
    }
  } else if (shape && isQuickRecordsFeeInvoice(shape)) {
    // Flat $20 records-fee invoices do not credit the separate $15 prepayment.
    resolved = existing ? fromExisting : 0;
  } else if (fromOrderPayments !== null) {
    resolved = fromOrderPayments;
  } else if (existing) {
    resolved = fromExisting;
  } else {
    resolved = 0;
  }

  if (invoiceTotal == null) {
    return resolved;
  }

  return capPaidToInvoiceTotal(resolved, invoiceTotal);
}

function resolveInvoiceStatusForSave(existing, totalAmount, amountPaid, derivedStatus) {
  if (!existing) {
    return derivedStatus ?? deriveInvoiceStatus(totalAmount, amountPaid);
  }

  if (existing.status === "Written Off") {
    return "Written Off";
  }

  if (existing.status === "Needs Resend") {
    return "Needs Resend";
  }

  return derivedStatus ?? deriveInvoiceStatus(totalAmount, amountPaid);
}

async function syncInvoiceAmountPaidFromOrder(connection, orderId) {
  const db = connection || getPool();

  const [invoiceRows] = await db.execute(
    `SELECT id, page_count, per_page_amount,
            clerical_time_hours, clerical_hourly_rate, shipping_handling, storage_fee,
            total_amount, status, writeoff_amount, amount_paid, payment_method
     FROM invoices
     WHERE order_id = :orderId
     LIMIT 1`,
    { orderId }
  );
  const invoice = invoiceRows[0];

  if (!invoice) {
    return null;
  }

  // Manual/online full payments are owned by the Payments page and must not
  // be overwritten by order_payments sync — but still clamp overpayment.
  if (
    (invoice.payment_method === "manual" || invoice.payment_method === "online") &&
    invoice.status === "Paid"
  ) {
    const totalAmount = toNumber(invoice.total_amount);
    const cappedPaid = capPaidToInvoiceTotal(invoice.amount_paid, totalAmount);

    if (cappedPaid < toNumber(invoice.amount_paid) - 0.0001) {
      await db.execute(
        `UPDATE invoices
         SET amount_paid = :amountPaid,
             amount_due = 0,
             updated_at = NOW()
         WHERE id = :id`,
        { id: invoice.id, amountPaid: cappedPaid }
      );
    }

    return {
      amountPaid: cappedPaid,
      amountDue: 0,
      status: "Paid",
    };
  }

  const orderPayments = await Order.findPaymentsByOrderId(orderId, connection);
  const order = await Order.findById(orderId, connection);
  const financials = resolveRowFinancials(invoice, orderPayments, {
    personalPortalOrder: isPersonalPortalOrder(order),
  });
  const status = resolveInvoiceStatusForSave(
    invoice,
    financials.totalAmount,
    financials.amountPaid,
    deriveInvoiceStatus(
      financials.totalAmount,
      financials.amountPaid,
      financials.writeoffAmount
    )
  );

  await db.execute(
    `UPDATE invoices
     SET total_amount = :totalAmount,
         amount_paid = :amountPaid,
         amount_due = :amountDue,
         status = :status,
         updated_at = NOW()
     WHERE id = :id`,
    {
      totalAmount: financials.totalAmount,
      amountPaid: financials.amountPaid,
      amountDue: financials.amountDue,
      status,
      id: invoice.id,
    }
  );

  return {
    amountPaid: financials.amountPaid,
    amountDue: financials.amountDue,
    status,
  };
}

function toNumber(value) {
  const number = Number(value);
  return Number.isNaN(number) ? 0 : number;
}

function getStorageFee(rowOrPayload = {}) {
  const storageFee = toNumber(rowOrPayload.storage_fee ?? rowOrPayload.storageFee);
  if (storageFee > 0) {
    return storageFee;
  }

  return toNumber(rowOrPayload.other_fee ?? rowOrPayload.other);
}

function isFlatFeeInvoiceShape(rowOrPayload = {}) {
  const pageCount = Math.max(
    0,
    Math.floor(toNumber(rowOrPayload.page_count ?? rowOrPayload.pages))
  );
  const perPageAmount = toNumber(
    rowOrPayload.per_page_amount ?? rowOrPayload.perPageAmount
  );
  const clericalHours = toNumber(
    rowOrPayload.clerical_time_hours ?? rowOrPayload.clericalTimeHours
  );
  const clericalRate = toNumber(
    rowOrPayload.clerical_hourly_rate ?? rowOrPayload.clericalHourlyRate
  );
  const shipping = toNumber(
    rowOrPayload.shipping_handling ?? rowOrPayload.shippingHandling
  );

  return (
    pageCount === 0 &&
    perPageAmount === 0 &&
    clericalHours === 0 &&
    clericalRate === 0 &&
    shipping === 0
  );
}

function extractFacilitySearchFeeFromNotes(notes = "") {
  const match = `${notes || ""}`.match(
    /Includes\s+\$([0-9]+(?:\.[0-9]{1,2})?)\s+facility search fee/i
  );
  return match ? toNumber(match[1]) : 0;
}

function isQuickRecordsFeeInvoice(rowOrPayload = {}) {
  if (!isFlatFeeInvoiceShape(rowOrPayload)) return false;
  const storage = getStorageFee(rowOrPayload);
  const facilityFee = extractFacilitySearchFeeFromNotes(
    rowOrPayload.notes
  );
  const recordsFee = Math.max(0, Number((storage - facilityFee).toFixed(2)));
  return recordsFee === QUICK_RECORDS_FEE;
}

function isCnrWitnessOnlyInvoice(invoiceRow = {}, orderRow = null) {
  if (orderRow && !Number(orderRow.certificate_no_records)) {
    return false;
  }

  return (
    isFlatFeeInvoiceShape(invoiceRow) && getStorageFee(invoiceRow) === 0
  );
}

function getStorageOrRecordsFeeLabel(rowOrPayload = {}) {
  return isQuickRecordsFeeInvoice(rowOrPayload)
    ? "Records Fee"
    : "Storage Fee";
}


function appendFacilitySearchFeeNote(notes, amount) {
  const feeText = `Includes $${Number(amount).toFixed(2)} facility search fee`;
  const current = String(notes || "").trim();
  if (current.toLowerCase().includes("facility search fee")) {
    return current;
  }
  return current ? `${current}\n${feeText}` : feeText;
}

/**
 * Resolve $5 facility-search fee for company or personal portal orders.
 * Same invoice behavior for both: add once into storageFee.
 */
async function resolvePendingFacilitySearchFee(orderId) {
  try {
    const companyPortalInternalSyncService = require("./companyPortalInternalSyncService");
    const companyFee =
      await companyPortalInternalSyncService.getPendingFacilitySearchFee(
        orderId
      );
    if (companyFee?.amount > 0) {
      return {
        source: "company_portal",
        amount: companyFee.amount,
        newFacilityId: companyFee.newFacilityId,
        personalRequestId: null,
      };
    }
  } catch (_companyError) {
    // fall through to personal
  }

  try {
    const personalPortalService = require("./personalPortalService");
    const personalFee =
      await personalPortalService.getPendingPersonalFacilitySearchFee(orderId);
    if (personalFee?.amount > 0) {
      return {
        source: "personal_portal",
        amount: personalFee.amount,
        newFacilityId: null,
        personalRequestId: personalFee.personalRequestId,
      };
    }
  } catch (_personalError) {
    // ignore
  }

  return null;
}

async function markResolvedFacilitySearchFeeBilled(pendingFacilityFee) {
  if (!pendingFacilityFee?.amount) return;

  if (
    pendingFacilityFee.source === "company_portal" &&
    pendingFacilityFee.newFacilityId
  ) {
    const companyPortalInternalSyncService = require("./companyPortalInternalSyncService");
    await companyPortalInternalSyncService.markFacilitySearchFeeBilled(
      pendingFacilityFee.newFacilityId
    );
    return;
  }

  if (
    pendingFacilityFee.source === "personal_portal" &&
    pendingFacilityFee.personalRequestId
  ) {
    const personalPortalService = require("./personalPortalService");
    await personalPortalService.markPersonalFacilitySearchFeeBilled(
      pendingFacilityFee.personalRequestId
    );
  }
}

function boolToInt(value) {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" ? 1 : 0;
  }
  return value ? 1 : 0;
}

function toShortDate(value) {
  if (!value) return "";

  // Prefer calendar-safe formatting for DATE / YYYY-MM-DD values.
  const sqlShort = toSqlShortDate(value);
  if (sqlShort) return sqlShort;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const year = date.getFullYear();

  return `${month}/${day}/${year}`;
}

function resolveViewerTimezone(timezone) {
  return timezone || config.businessTimezone || "UTC";
}

function formatSentInstant(value, timeZone = config.businessTimezone) {
  if (!value) return "";
  return (
    formatUtcInstantDisplay(value, resolveViewerTimezone(timeZone)) ||
    toShortDate(value) ||
    ""
  );
}

function formatSentInstantCompact(value, timeZone = config.businessTimezone) {
  if (!value) return "";
  const full = formatUtcInstantDisplay(value, resolveViewerTimezone(timeZone));
  if (!full) return toCompactDate(value);
  const datePart = String(full).split(",")[0]?.trim();
  return datePart || full;
}

function resolveClientCalendarDate(options = {}) {
  return calendarTodayInTimezone(
    options.timezone || config.businessTimezone || "UTC"
  );
}

/** Exact send moment as MySQL UTC DATETIME. */
function resolveSentAtUtc() {
  return toMysqlUtcDateTime(new Date());
}

function toCompactDate(value) {
  if (!value) return "";

  const sqlShort = toSqlShortDate(value);
  if (sqlShort) return sqlShort;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const year = String(date.getFullYear()).slice(-2);

  return `${month}/${day}/${year}`;
}

function formatDateTimeDisplay(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return date.toLocaleString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function mapInvoiceReminderField(sentAt, level) {
  const sent = Boolean(sentAt);

  return {
    level,
    sent,
    sentAt: sentAt || null,
    sentAtDisplay: sent ? formatDateTimeDisplay(sentAt) : null,
    label: sent ? `Sent Reminder ${level}` : "Didn't send",
  };
}

function mapInvoiceReminderFields(row = {}) {
  return {
    reminder1: mapInvoiceReminderField(row.reminder_1_sent_at, 1),
    reminder2: mapInvoiceReminderField(row.reminder_2_sent_at, 2),
    reminder3: mapInvoiceReminderField(row.reminder_3_sent_at, 3),
  };
}

function toInputDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const year = date.getFullYear();

  return `${year}-${month}-${day}`;
}

function formatMoney(value) {
  const amount = toNumber(value);
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function buildApplicantName(row) {
  return [row.applicant_first_name, row.applicant_middle_name, row.applicant_last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function getInvoiceCompanyId(row) {
  const providerId = Number(row?.provider_id);
  return Number.isFinite(providerId) && providerId > 0 ? providerId : 0;
}

function getInvoiceCompanyName(row) {
  return (
    trimOrNull(row?.provider_name) ||
    trimOrNull(row?.serve_company_name) ||
    trimOrNull(row?.facility_name) ||
    "Unknown Company"
  );
}

function formatOrderRecordTypesLabel(orderRow) {
  const raw = orderRow?.order_record_types || orderRow?.order_type || "";
  const types = `${raw}`
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (!types.length) {
    return "";
  }

  return types
    .map((type) => ORDER_TYPE_LABELS[type] || type)
    .join(", ");
}

function withOrderRecordTypes(orderRow, sourceRow) {
  if (!orderRow) {
    return sourceRow || null;
  }

  const orderRecordTypes =
    sourceRow?.order_record_types || orderRow?.order_record_types || "";

  if (!orderRecordTypes) {
    return orderRow;
  }

  return {
    ...orderRow,
    order_record_types: orderRecordTypes,
  };
}

function resolveYourFileNumber(orderRow) {
  if (!orderRow) return "";

  const typeLabel = trimOrNull(formatOrderRecordTypesLabel(orderRow));
  if (typeLabel) return typeLabel;

  return trimOrNull(orderRow.specific_record) || "";
}

function buildOrderDetailsText(row, orderPayments = []) {
  if (!row) return "";

  const lines = [];
  const push = (label, value) => {
    const normalized = trimOrNull(value);
    if (normalized) {
      lines.push(`${label}: ${normalized}`);
    }
  };

  push("Order Number", row.order_number);
  push("Case Number", row.case_number);
  push("Applicant", buildApplicantName(row));
  push("Defendant", row.defendant);
  push(
    "Record Type",
    formatOrderRecordTypesLabel(row) || trimOrNull(row.specific_record)
  );
  push("Specific Record", row.specific_record);
  push("Doctor", row.specific_doctor);
  push("Serve Company", row.serve_company_name);

  const serveAddress = [
    trimOrNull(row.serve_address),
    [trimOrNull(row.serve_city), trimOrNull(row.serve_state)]
      .filter(Boolean)
      .join(", "),
    trimOrNull(row.serve_zip),
  ]
    .filter(Boolean)
    .join(" ");

  push("Serve Address", serveAddress);
  push(
    "Subpoena Date",
    row.subpoena_date ? toShortDate(row.subpoena_date) : null
  );
  push(
    "Depo Due Date",
    row.depo_due_date ? toShortDate(row.depo_due_date) : null
  );
  push(
    "Date Served",
    row.date_served ? toShortDate(row.date_served) : null
  );

  const feeLines = buildInvoiceFeeSummaryLines(row, orderPayments);
  if (feeLines.length) {
    lines.push("");
    lines.push("Invoice Fees:");
    lines.push(...feeLines);
  }

  return lines.join("\n");
}

function buildInvoiceFeeSummaryLines(row, orderPayments = []) {
  if (!row) return [];

  const totals = calculateTotalsWithPayments(
    {
      pages: row.page_count,
      perPageAmount: row.per_page_amount,
      clericalTimeHours: row.clerical_time_hours,
      clericalHourlyRate: row.clerical_hourly_rate,
      shippingHandling: row.shipping_handling,
      storageFee: getStorageFee(row),
    },
    orderPayments
  );
  const financials = resolveRowFinancials(row, orderPayments);
  const lines = [];
  const pushFee = (label, amount) => {
    if (toNumber(amount) > 0) {
      lines.push(`${label}: ${formatMoney(amount)}`);
    }
  };

  if (totals.pageCount > 0 && totals.perPageAmount > 0) {
    lines.push(
      `Per Page Charge (${totals.pageCount} x ${formatMoney(totals.perPageAmount)}): ${formatMoney(totals.pageCount * totals.perPageAmount)}`
    );
  }

  if (totals.clericalAmount > 0) {
    lines.push(`Clerical Time: ${formatMoney(totals.clericalAmount)}`);
  }

  pushFee("Shipping & Handling", totals.shippingHandling);
  pushFee(getStorageOrRecordsFeeLabel(row), totals.storageFee);
  lines.push(`Total Invoiced: ${formatMoney(financials.totalAmount)}`);
  lines.push(`Total Paid: ${formatMoney(financials.amountPaid)}`);
  lines.push(`Amount Due: ${formatMoney(financials.amountDue)}`);

  return lines;
}

function daysSince(dateValue) {
  if (!dateValue) return 0;
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return 0;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  date.setHours(0, 0, 0, 0);

  return Math.max(0, Math.floor((today - date) / (1000 * 60 * 60 * 24)));
}

function calculateTotals(payload = {}, { includeXrayFee = false } = {}) {
  const xrayFee = includeXrayFee ? toNumber(payload.xrayFee) : 0;
  const pageCount = Math.max(0, Math.floor(toNumber(payload.pages)));
  const perPageAmount = toNumber(payload.perPageAmount);
  const pagesAmount = pageCount * perPageAmount;
  const clericalTimeHours = Math.max(0, toNumber(payload.clericalTimeHours));
  const clericalHourlyRate = toNumber(payload.clericalHourlyRate);
  const clericalAmount = clericalTimeHours * clericalHourlyRate;
  const shippingHandling = toNumber(payload.shippingHandling);
  const storageFee = getStorageFee(payload);

  const totalAmount =
    xrayFee +
    pagesAmount +
    clericalAmount +
    shippingHandling +
    storageFee;

  return {
    custodianFee: 0,
    xrayFee,
    pageCount,
    perPageAmount,
    pagesAmount,
    clericalTimeHours,
    clericalHourlyRate,
    clericalAmount,
    shippingHandling,
    storageFee,
    totalAmount,
  };
}

function normalizeGrossFee(storedFee, paidAmount) {
  const stored = toNumber(storedFee);
  const paid = toNumber(paidAmount);
  const due = Math.max(0, stored - paid);

  return due + paid;
}

function groupPaymentsByOrderId(paymentRows = []) {
  return paymentRows.reduce((acc, payment) => {
    const orderId = payment.order_id;

    if (!acc[orderId]) {
      acc[orderId] = [];
    }

    acc[orderId].push(payment);
    return acc;
  }, {});
}

function calculateTotalsWithPayments(payload = {}, orderPayments = [], options = {}) {
  const includeXrayFee = options.includeXrayFee === true;
  const xrayPaid = getOrderPaymentAmount(orderPayments, "xray");

  return calculateTotals(
    {
      ...payload,
      xrayFee: includeXrayFee
        ? normalizeGrossFee(payload.xrayFee, xrayPaid)
        : 0,
    },
    { includeXrayFee }
  );
}

function resolveRowFinancials(row, orderPayments = [], options = {}) {
  const { lineItemsTotal, facilityFee, totalAmount } = splitLineItemsAndFacility(row);
  const fromOrderPayments = sumStandardInvoicePayments(orderPayments);
  const fromInvoice = toNumber(row.amount_paid);
  const personalPortal = Boolean(options.personalPortalOrder);
  let amountPaid;

  if (personalPortal) {
    amountPaid =
      row.payment_method === "manual" || row.payment_method === "online"
        ? fromInvoice
        : resolvePersonalPortalPrepaymentCredit(orderPayments, lineItemsTotal);
  } else if (isQuickRecordsFeeInvoice(row)) {
    amountPaid =
      row.payment_method === "manual" || row.payment_method === "online"
        ? fromInvoice
        : 0;
  } else {
    amountPaid =
      row.payment_method === "manual" || row.payment_method === "online"
        ? Math.max(fromInvoice, fromOrderPayments)
        : orderPayments.length
          ? fromOrderPayments
          : fromInvoice;
  }

  amountPaid = capPaidToInvoiceTotal(amountPaid, totalAmount);

  const writeoffAmount = toNumber(row.writeoff_amount);
  const { amountDue } = resolveInvoiceAmounts(
    totalAmount,
    amountPaid,
    writeoffAmount
  );

  return {
    totalAmount,
    lineItemsTotal,
    facilityFee,
    amountPaid,
    amountDue,
    writeoffAmount,
  };
}

function mapInvoiceDetail(row) {
  if (!row) return null;

  return {
    id: row.id,
    invoiceNumber: row.invoice_number || "",
    orderId: row.order_id,
    orderNumber: row.order_number || "",
    facilityId: row.facility_id,
    facilityName: row.facility_name || "",
    status: row.status,
    invoiceDate: toInputDate(row.invoice_date),
    sentDate: toInputDate(row.sent_date),
    custodianFee: "0.00",
    xrayFee: "0.00",
    storageFee: getStorageFee(row).toFixed(2),
    pages: String(row.page_count ?? 0),
    perPageAmount: toNumber(row.per_page_amount).toFixed(2),
    clericalTimeHours: toNumber(row.clerical_time_hours).toFixed(2),
    clericalHourlyRate: toNumber(row.clerical_hourly_rate).toFixed(2),
    clericalAmount: (
      toNumber(row.clerical_time_hours) * toNumber(row.clerical_hourly_rate)
    ).toFixed(2),
    shippingHandling: toNumber(row.shipping_handling).toFixed(2),
    totalAmount: toNumber(row.total_amount),
    amountPaid: toNumber(row.amount_paid),
    amountDue: toNumber(row.amount_due),
    writeoffAmount: toNumber(row.writeoff_amount),
    notes: row.notes || "",
    sendOrderDetails: Boolean(row.send_order_details),
    rushOrder: Boolean(row.is_rush_order),
    rushLevel: calculateOrderRushLevel(row.order_created_at).label,
    subpoenaDate: toInputDate(row.subpoena_date),
    applicant: buildApplicantName(row),
  };
}

function deriveInvoiceStatus(totalAmount, amountPaid, writeoffAmount = 0) {
  const total = toNumber(totalAmount);
  const paid = toNumber(amountPaid);
  const writeoff = toNumber(writeoffAmount);
  const amountDue = Math.max(0, total - paid - writeoff);

  if (amountDue <= 0) {
    if (paid >= total) {
      return "Paid";
    }

    if (writeoff > 0 && paid < total) {
      return "Written Off";
    }

    return paid > 0 ? "Paid" : writeoff > 0 ? "Written Off" : "Unpaid";
  }

  if (paid > 0 || writeoff > 0) {
    return "Partial";
  }

  return "Unpaid";
}

function resolveInvoiceAmounts(totalAmount, amountPaid, writeoffAmount = 0) {
  const total = toNumber(totalAmount);
  const rawPaid = toNumber(amountPaid);
  const paid = capPaidToInvoiceTotal(rawPaid, total);
  const writeoff = toNumber(writeoffAmount);
  const amountDue = Math.max(0, total - paid - writeoff);
  const overpayment = Math.max(0, rawPaid - total);
  const status = deriveInvoiceStatus(total, paid, writeoff);

  return {
    amountPaid: paid,
    amountDue,
    overpayment,
    status,
    isOverpaid: overpayment > 0,
  };
}

function mapXrayDetail(row, orderPayments = []) {
  const xrayPaidEarlier = getOrderPaymentAmount(orderPayments, "xray");

  if (!row) {
    return {
      invoiceNumber: "",
      xrayInvoiceDate: "",
      examDate: "",
      views: "0",
      perViewAmount: "0.00",
      payment: "0.00",
      xrayPaidEarlier: xrayPaidEarlier.toFixed(2),
      prepayment: xrayPaidEarlier.toFixed(2),
      checkNumber: "",
      description: "",
      recipientEmail: "",
      writeoffAmount: 0,
      amountPaid: 0,
      amountDue: 0,
    };
  }

  const payment = getXrayPayment(row);
  const financials = resolveXrayRowFinancials(row, orderPayments);

  return {
    invoiceNumber: resolveXrayInvoiceNumber(row),
    xrayInvoiceDate: toInputDate(row.xray_invoice_date),
    examDate: toInputDate(row.exam_date),
    views: String(row.view_count ?? 0),
    perViewAmount: toNumber(row.per_view_amount).toFixed(2),
    payment: payment.toFixed(2),
    xrayPaidEarlier: xrayPaidEarlier.toFixed(2),
    prepayment: xrayPaidEarlier.toFixed(2),
    checkNumber: row.check_number || "",
    description: row.description || "",
    recipientEmail: trimOrNull(row.recipient_emails) || "",
    writeoffAmount: financials.writeoffAmount,
    amountPaid: financials.amountPaid,
    amountDue: financials.amountDue,
  };
}

function hasStandardInvoiceFields(row) {
  return (
    Boolean(row.invoice_date) ||
    toNumber(row.page_count) > 0 ||
    toNumber(row.clerical_time_hours) > 0 ||
    toNumber(row.clerical_hourly_rate) > 0 ||
    toNumber(row.shipping_handling) > 0 ||
    getStorageFee(row) > 0
  );
}

function mapXrayReviewAmount(xrayRow, orderPayments = []) {
  if (!xrayRow) return null;

  const { amountDue } = resolveXrayRowFinancials(xrayRow, orderPayments);
  return formatMoney(amountDue);
}

function mapOrderPaymentsSummary(payments = []) {
  const amounts = ORDER_PAYMENT_TYPES.reduce((acc, paymentType) => {
    acc[paymentType] = getOrderPaymentAmount(payments, paymentType);
    return acc;
  }, {});

  const paymentLines = ORDER_PAYMENT_TYPES.reduce((lines, paymentType) => {
    const amount = amounts[paymentType];
    if (amount <= 0) return lines;

    lines.push({
      type: paymentType,
      label: ORDER_PAYMENT_LABELS[paymentType],
      amount,
      bracketLabel: `${ORDER_PAYMENT_LABELS[paymentType]} (${formatMoney(amount)})`,
    });

    return lines;
  }, []);

  return {
    prepaymentPaid: amounts.prepayment,
    custodianPaid: amounts.custodian,
    xrayPaid: amounts.xray,
    orderAmountPaid: sumOrderPayments(payments),
    paymentLines,
  };
}

function pushPrintFeeLine(feeLines, line) {
  const total = toNumber(line.total);

  if (total > 0) {
    feeLines.push({ ...line, total });
  }
}

function appendPrintInvoiceDeductions(feeLines, invoiceRow) {
  const writeoffAmount = toNumber(invoiceRow.writeoff_amount);

  if (writeoffAmount > 0) {
    feeLines.push({
      description: "Written Off",
      quantity: "",
      total: -writeoffAmount,
      italic: true,
    });
  }
}

function buildPrintInvoicePdfData(invoiceRow, orderRow, orderPayments = []) {
  if (!invoiceRow || !orderRow) {
    return null;
  }

  const prepaymentPaid = getOrderPaymentAmount(orderPayments, "prepayment");
  const isCnrPrint = isCnrWitnessOnlyInvoice(invoiceRow, orderRow);
  const isQuickPrint = isQuickRecordsFeeInvoice(invoiceRow);
  const feeLines = [];
  const personalPortal = isPersonalPortalOrder(orderRow);
  const commonMeta = {
    hideCompany: personalPortal,
    customer: personalPortal
      ? ""
      : orderRow.serve_company_name || orderRow.provider_name || "",
    requestedBy: personalPortal
      ? ""
      : orderRow.serve_company_name || orderRow.provider_name || "",
    yourFileNumber: resolveYourFileNumber(
      withOrderRecordTypes(orderRow, invoiceRow)
    ),
    ourCaseNumber: orderRow.order_number || "",
    applicant: buildApplicantName(orderRow),
  };

  if (isCnrPrint) {
    feeLines.push({
      description: "Witness Fee (Prepayment)",
      quantity: "1",
      total: DEFAULT_PREPAYMENT_CHARGE,
    });

    if (prepaymentPaid > 0) {
      feeLines.push({
        description: "Prepayment Paid",
        quantity: "",
        total: -Math.min(prepaymentPaid, DEFAULT_PREPAYMENT_CHARGE),
        italic: true,
      });
    }

    const totalInvoiced = DEFAULT_PREPAYMENT_CHARGE;
    const amountPaid = Math.min(prepaymentPaid, totalInvoiced);

    return {
      ...commonMeta,
      feeLines,
      totalInvoiced,
      totalDue: Math.max(0, totalInvoiced - amountPaid),
      amountPaid,
    };
  }

  if (isQuickPrint) {
    const facilityFee = extractFacilitySearchFeeFromNotes(invoiceRow.notes);
    const skipWitnessCredit = isPersonalPortalOrder(orderRow);

    if (!skipWitnessCredit) {
      feeLines.push({
        description: "Witness Fee (Prepayment)",
        quantity: "1",
        total: DEFAULT_PREPAYMENT_CHARGE,
      });
    }

    feeLines.push({
      description: "Records Fee",
      quantity: "1",
      total: QUICK_RECORDS_FEE,
    });

    if (facilityFee > 0) {
      feeLines.push({
        description: "Facility Search Fee",
        quantity: "1",
        total: facilityFee,
      });
    }

    if (!skipWitnessCredit && prepaymentPaid > 0) {
      feeLines.push({
        description: "Prepayment Paid",
        quantity: "",
        total: -Math.min(prepaymentPaid, DEFAULT_PREPAYMENT_CHARGE),
        italic: true,
      });
    } else if (skipWitnessCredit && prepaymentPaid > 0) {
      const prepaymentCredit = Math.min(prepaymentPaid, QUICK_RECORDS_FEE);
      if (prepaymentCredit > 0) {
        feeLines.push({
          description: "Prepayment",
          quantity: "",
          total: -prepaymentCredit,
          italic: true,
        });
      }
    }

    appendPrintInvoiceDeductions(feeLines, invoiceRow);

    const totalInvoiced =
      (skipWitnessCredit ? QUICK_RECORDS_FEE : REQUEST_TOTAL_WITH_RECORDS_FEE) +
      facilityFee;
    const amountPaid = skipWitnessCredit
      ? Math.min(prepaymentPaid, QUICK_RECORDS_FEE)
      : Math.min(prepaymentPaid, DEFAULT_PREPAYMENT_CHARGE);
    const writeoffAmount = toNumber(invoiceRow.writeoff_amount);

    return {
      ...commonMeta,
      feeLines,
      totalInvoiced,
      totalDue: Math.max(0, totalInvoiced - amountPaid - writeoffAmount),
      amountPaid,
    };
  }

  const pageCount = Math.max(0, Math.floor(toNumber(invoiceRow.page_count)));
  const perPageAmount = toNumber(invoiceRow.per_page_amount);
  const pagesTotal = pageCount * perPageAmount;
  const clericalTimeHours = Math.max(0, toNumber(invoiceRow.clerical_time_hours));
  const clericalHourlyRate = toNumber(invoiceRow.clerical_hourly_rate);
  const clericalAmount = clericalTimeHours * clericalHourlyRate;
  const shippingHandling = toNumber(invoiceRow.shipping_handling);
  const storageFee = getStorageFee(invoiceRow);

  if (clericalAmount > 0) {
    pushPrintFeeLine(feeLines, {
      description: `Clerical time $${formatPerViewRate(clericalHourlyRate)} per hour`,
      quantity: clericalTimeHours.toFixed(2),
      total: clericalAmount,
    });
  }

  if (pagesTotal > 0) {
    pushPrintFeeLine(feeLines, {
      description: "Per Page Charge",
      quantity: String(pageCount),
      total: pagesTotal,
    });
  }

  if (shippingHandling > 0) {
    pushPrintFeeLine(feeLines, {
      description: "Shipping & Handling",
      quantity: "1",
      total: shippingHandling,
    });
  }

  if (storageFee > 0) {
    const facilityFee = extractFacilitySearchFeeFromNotes(invoiceRow.notes);
    const storageOnly = Math.max(0, Number((storageFee - facilityFee).toFixed(2)));

    if (storageOnly > 0) {
      pushPrintFeeLine(feeLines, {
        description: getStorageOrRecordsFeeLabel(invoiceRow),
        quantity: "1",
        total: storageOnly,
      });
    }

    if (facilityFee > 0) {
      pushPrintFeeLine(feeLines, {
        description: "Facility Search Fee",
        quantity: "1",
        total: facilityFee,
      });
    }
  }

  if (prepaymentPaid > 0) {
    const prepayment = orderPayments.find((row) => row.payment_type === "prepayment");
    const checkLabel = trimOrNull(prepayment?.check_number)
      ? `CK# ${prepayment.check_number}`
      : "";

    if (isPersonalPortalOrder(orderRow)) {
      const { lineItemsTotal } = splitLineItemsAndFacility(invoiceRow);
      const prepaymentCredit = Math.min(prepaymentPaid, lineItemsTotal);
      if (prepaymentCredit > 0) {
        feeLines.push({
          description: "Prepayment",
          quantity: checkLabel,
          total: -prepaymentCredit,
          italic: true,
        });
      }
    } else {
      feeLines.push({
        description: "Prepayment",
        quantity: checkLabel,
        total: -prepaymentPaid,
        italic: true,
      });
    }
  }

  appendPrintInvoiceDeductions(feeLines, invoiceRow);

  const financials = resolveRowFinancials(invoiceRow, orderPayments, {
    personalPortalOrder: isPersonalPortalOrder(orderRow),
  });

  return {
    ...commonMeta,
    feeLines,
    totalInvoiced: financials.totalAmount,
    totalDue: financials.amountDue,
    amountPaid: financials.amountPaid,
  };
}

function formatPerViewRate(amount) {
  const value = toNumber(amount);

  if (Number.isInteger(value) || value === Math.trunc(value)) {
    return String(Math.trunc(value));
  }

  return value.toFixed(2);
}

function buildPrintXrayInvoicePdfData(xrayRow, orderRow, orderPayments = []) {
  if (!xrayRow || !orderRow) {
    return null;
  }

  const viewCount = Math.max(0, Math.floor(toNumber(xrayRow.view_count)));
  const perViewAmount = toNumber(xrayRow.per_view_amount);
  const viewsTotal = viewCount * perViewAmount;
  const xrayPaidEarlier = getOrderPaymentAmount(orderPayments, "xray");
  const totalInvoiced = viewsTotal - xrayPaidEarlier;
  const totalDue = Math.max(0, totalInvoiced);
  const description = trimOrNull(xrayRow.description) || "";
  const feeLines = [];

  if (viewsTotal > 0) {
    feeLines.push({
      description: `Views @ $${formatPerViewRate(perViewAmount)} per`,
      quantity: String(viewCount),
      total: viewsTotal,
      subDescription: description,
    });
  }

  if (xrayPaidEarlier > 0) {
    const checkLabel = trimOrNull(xrayRow.check_number)
      ? `CK# ${xrayRow.check_number}`
      : "CK#";

    feeLines.push({
      description: "Processing Fee",
      quantity: checkLabel,
      total: -xrayPaidEarlier,
    });
  }

  return {
    customer: orderRow.provider_name || orderRow.serve_company_name || "",
    requestedBy: orderRow.serve_company_name || orderRow.provider_name || "",
    specificDoctor: orderRow.specific_doctor || "",
    yourFileNumber: resolveYourFileNumber(
      withOrderRecordTypes(orderRow, xrayRow)
    ),
    ourCaseNumber: orderRow.order_number || "",
    applicant: buildApplicantName(orderRow),
    dob: formatDobDisplay(orderRow.dob) || "",
    examDate: toShortDate(xrayRow.exam_date) || "",
    feeLines,
    totalInvoiced,
    totalDue,
  };
}

function mapOrderInvoiceFees(invoiceRow, xrayRow = null, orderPayments = []) {
  const xrayFinancials = xrayRow
    ? resolveXrayRowFinancials(xrayRow, orderPayments)
    : null;
  const xrayPayment = xrayFinancials ? xrayFinancials.totalAmount : 0;
  const xrayPaid = xrayFinancials ? xrayFinancials.amountPaid : 0;
  const xrayDue = xrayFinancials ? xrayFinancials.amountDue : 0;
  const xrayPaymentMethod =
    xrayRow?.payment_method === "manual" || xrayRow?.payment_method === "online"
      ? xrayRow.payment_method
      : "";

  if (!invoiceRow) {
    return {
      hasInvoice: false,
      hasXrayInvoice: Boolean(xrayRow),
      invoiceTotal: 0,
      prepaymentPaid: 0,
      writeoffAmount: 0,
      xrayFee: xrayPayment,
      xrayPaid,
      xrayDue,
      xrayPaymentMethod,
    };
  }

  const totals = calculateTotalsWithPayments(
    {
      pages: invoiceRow.page_count,
      perPageAmount: invoiceRow.per_page_amount,
      clericalTimeHours: invoiceRow.clerical_time_hours,
      clericalHourlyRate: invoiceRow.clerical_hourly_rate,
      shippingHandling: invoiceRow.shipping_handling,
      storageFee: getStorageFee(invoiceRow),
    },
    orderPayments
  );
  const financials = resolveRowFinancials(invoiceRow, orderPayments);

  return {
    hasInvoice: true,
    hasXrayInvoice: Boolean(xrayRow),
    invoiceTotal: totals.totalAmount,
    invoiceAmountPaid: financials.amountPaid,
    invoiceAmountDue: financials.amountDue,
    prepaymentPaid: getOrderPaymentAmount(orderPayments, "prepayment"),
    writeoffAmount: toNumber(invoiceRow.writeoff_amount),
    xrayFee: xrayPayment,
    xrayPaid,
    xrayDue,
    xrayPaymentMethod,
    storageFee: getStorageFee(invoiceRow),
  };
}

function resolveCustodianDueAmount(_invoiceFees = {}, custodianPaid = 0) {
  const paid = toNumber(custodianPaid);
  return Math.max(0, DEFAULT_CUSTODIAN_CHARGE - paid);
}

function resolveCustodianPaymentDue(_invoiceRow, orderPayments = []) {
  const custodianPaid = getOrderPaymentAmount(orderPayments, "custodian");
  return resolveCustodianDueAmount({}, custodianPaid);
}

function shouldMarkCustodianStageComplete(dueAmount, custodianPaid) {
  if (toNumber(dueAmount) > 0) {
    return false;
  }

  return toNumber(custodianPaid) > 0;
}

function resolveXrayPaymentDue(xrayRow, orderPayments = []) {
  if (!xrayRow) {
    return 0;
  }

  return resolveXrayRowFinancials(xrayRow, orderPayments).amountDue;
}

async function upsertOrderPaymentDue(
  connection,
  orderId,
  paymentType,
  dueAmount,
  payments
) {
  const payment = payments.find((row) => row.payment_type === paymentType);

  if (payment) {
    await connection.execute(
      `UPDATE order_payments
       SET due_amount = :dueAmount, updated_at = NOW()
       WHERE id = :id`,
      { dueAmount, id: payment.id }
    );
    return;
  }

  await Order.upsertPayment(connection, {
    orderId,
    paymentType,
    checkNumber: null,
    paymentDate: null,
    amount: null,
    dueAmount,
    isPaid: 0,
    memo: null,
  });
}

async function syncOrderCustodianDueFromInvoice(connection, orderId) {
  const order = await Order.findById(orderId, connection);

  if (!order) {
    return;
  }

  const payments = await Order.findPaymentsByOrderId(orderId, connection);
  // Custodian is no longer a separate $15 charge — the single $15 witness fee
  // is tracked as prepayment only. Keep any existing custodian due at $0.
  const dueAmount = 0;

  await upsertOrderPaymentDue(connection, orderId, "custodian", dueAmount, payments);

  const custodianPaid = getOrderPaymentAmount(payments, "custodian");

  if (shouldMarkCustodianStageComplete(dueAmount, custodianPaid)) {
    await Order.upsertWorkflowStage(
      orderId,
      "Custodian",
      "complete",
      new Date(),
      connection
    );
  } else {
    await Order.upsertWorkflowStage(
      orderId,
      "Custodian",
      "pending",
      null,
      connection
    );
  }
}

async function syncOrderPaymentDuesFromInvoice(connection, orderId, _options = {}) {
  const order = await Order.findById(orderId, connection);

  if (!order) {
    return null;
  }

  const invoice = await Invoice.findByOrderId(orderId, connection);
  const xrayRow = await InvoiceXray.findByOrderId(orderId, connection);
  const payments = await Order.findPaymentsByOrderId(orderId, connection);

  if (xrayRow) {
    const financials = resolveXrayRowFinancials(xrayRow, payments);

    if (toNumber(xrayRow.amount_paid) > financials.totalAmount + 0.0001) {
      await connection.execute(
        `UPDATE invoice_xray_details
         SET amount_paid = :amountPaid,
             updated_at = NOW()
         WHERE order_id = :orderId`,
        {
          orderId,
          amountPaid: financials.amountPaid,
        }
      );
      xrayRow.amount_paid = financials.amountPaid;
    }

    const existing = payments.find((row) => row.payment_type === "xray");
    const nextAmount =
      financials.amountPaid > 0
        ? financials.amountPaid
        : existing?.amount != null
          ? toNumber(existing.amount)
          : null;
    const invoiceCheckNumber = trimOrNull(xrayRow.payment_check_number);
    const invoicePaymentDate = xrayRow.payment_date
      ? toInputDate(xrayRow.payment_date)
      : null;
    const fromManualOrOnline =
      xrayRow.payment_method === "manual" || xrayRow.payment_method === "online";
    const nextCheckNumber = fromManualOrOnline
      ? invoiceCheckNumber || existing?.check_number || null
      : existing?.check_number || invoiceCheckNumber || null;
    const nextPaymentDate = fromManualOrOnline
      ? invoicePaymentDate ||
        (existing?.payment_date ? toInputDate(existing.payment_date) : null)
      : existing?.payment_date
        ? toInputDate(existing.payment_date)
        : invoicePaymentDate;

    if (existing) {
      await connection.execute(
        `UPDATE order_payments
         SET amount = :amount,
             due_amount = :dueAmount,
             is_paid = :isPaid,
             check_number = :checkNumber,
             payment_date = :paymentDate,
             updated_at = NOW()
         WHERE id = :id`,
        {
          amount: nextAmount,
          dueAmount: financials.amountDue,
          isPaid: financials.amountDue <= 0 && financials.amountPaid > 0 ? 1 : 0,
          checkNumber: nextCheckNumber,
          paymentDate: nextPaymentDate,
          id: existing.id,
        }
      );
    } else {
      await Order.upsertPayment(connection, {
        orderId,
        paymentType: "xray",
        checkNumber: nextCheckNumber,
        paymentDate: nextPaymentDate,
        amount: nextAmount,
        dueAmount: financials.amountDue,
        isPaid: financials.amountDue <= 0 && financials.amountPaid > 0 ? 1 : 0,
        memo: null,
      });
    }
  }

  if (invoice) {
    return syncInvoiceAmountPaidFromOrder(connection, orderId);
  }

  return null;
}

function mapOrderInvoiceSummary(
  row,
  xrayRow = null,
  orderPayments = [],
  timezone = null
) {
  const viewerTz = resolveViewerTimezone(timezone);
  const paymentsSummary = mapOrderPaymentsSummary(orderPayments);

  if (!row) {
    const hasXray = Boolean(xrayRow);

    return {
      createOnly: true,
      hasXray,
      hasStandardInvoice: false,
      ...(hasXray
        ? {
            xrayReviewDate: toShortDate(xrayRow.xray_invoice_date),
            xrayReviewDateCompact: toCompactDate(xrayRow.xray_invoice_date),
            xrayReviewAmount: mapXrayReviewAmount(xrayRow, orderPayments),
            xraySentDate: xrayRow.sent_date
              ? formatSentInstant(xrayRow.sent_date, viewerTz)
              : null,
            xraySentDateCompact: xrayRow.sent_date
              ? formatSentInstantCompact(xrayRow.sent_date, viewerTz)
              : null,
            xrayRecipientEmail: trimOrNull(xrayRow.recipient_emails) || "",
            xrayDueMeta: `${toCompactDate(xrayRow.xray_invoice_date)} - Due:${mapXrayReviewAmount(xrayRow, orderPayments)}`,
          }
        : {}),
      ...paymentsSummary,
      status: null,
      due: formatMoney(0),
      paidAmount:
        paymentsSummary.orderAmountPaid > 0
          ? formatMoney(paymentsSummary.orderAmountPaid)
          : null,
    };
  }

  const hasXray = Boolean(xrayRow);
  const hasStandardInvoice = hasStandardInvoiceFields(row);
  const financials = resolveRowFinancials(row, orderPayments);

  const invoiceDueMeta = `${toCompactDate(row.invoice_date)} - Due:${formatMoney(financials.amountDue)}`;

  return {
    createOnly: !hasStandardInvoice,
    hasXray,
    hasStandardInvoice,
    invoiceId: row.id,
    reviewDate: toShortDate(row.invoice_date),
    invoiceDateCompact: toCompactDate(row.invoice_date),
    reviewAmount: formatMoney(financials.totalAmount),
    printAmount: formatMoney(financials.totalAmount),
    invoiceDueMeta,
    custodianAmount:
      getOrderPaymentAmount(orderPayments, "custodian") > 0
        ? formatMoney(getOrderPaymentAmount(orderPayments, "custodian"))
        : null,
    sentDate: row.sent_date
      ? formatSentInstant(row.sent_date, viewerTz)
      : null,
    sentDateCompact: row.sent_date
      ? formatSentInstantCompact(row.sent_date, viewerTz)
      : null,
    sentAt: toUtcIso(row.sent_date),
    xrayReviewDate: hasXray ? toShortDate(xrayRow.xray_invoice_date) : "",
    xrayReviewDateCompact: hasXray
      ? toCompactDate(xrayRow.xray_invoice_date)
      : "",
    xrayReviewAmount: mapXrayReviewAmount(xrayRow, orderPayments),
    xraySentDate:
      hasXray && xrayRow?.sent_date
        ? formatSentInstant(xrayRow.sent_date, viewerTz)
        : null,
    xraySentDateCompact:
      hasXray && xrayRow?.sent_date
        ? formatSentInstantCompact(xrayRow.sent_date, viewerTz)
        : null,
    xrayRecipientEmail:
      hasXray && xrayRow?.recipient_emails
        ? trimOrNull(xrayRow.recipient_emails) || ""
        : "",
    xrayDueMeta: hasXray
      ? `${toCompactDate(xrayRow.xray_invoice_date)} - Due:${mapXrayReviewAmount(xrayRow, orderPayments)}`
      : "",
    recipientEmail: trimOrNull(row.provider_email) || "",
    providerEmail: trimOrNull(row.provider_email) || "",
    showEmail: Boolean(trimOrNull(row.provider_email)),
    paid:
      financials.amountPaid > 0 ? formatMoney(financials.amountPaid) : null,
    status: row.status || "Unpaid",
    isWrittenOff: row.status === "Written Off",
    writeoffAmount:
      toNumber(row.writeoff_amount) > 0
        ? formatMoney(row.writeoff_amount)
        : null,
    date: toShortDate(row.invoice_date),
    sentDateRaw: toInputDate(row.sent_date),
    invoiced: formatMoney(financials.totalAmount),
    due: formatMoney(financials.amountDue),
    paidAmount: formatMoney(financials.amountPaid),
    ...paymentsSummary,
    custodianFee: "0.00",
    xrayFee: xrayRow ? toNumber(xrayRow.payment).toFixed(2) : "0.00",
    storageFee: getStorageFee(row).toFixed(2),
    pages: String(row.page_count ?? 0),
    perPageAmount: toNumber(row.per_page_amount).toFixed(2),
    clericalTimeHours: toNumber(row.clerical_time_hours).toFixed(2),
    clericalHourlyRate: toNumber(row.clerical_hourly_rate).toFixed(2),
    clericalAmount: (
      toNumber(row.clerical_time_hours) * toNumber(row.clerical_hourly_rate)
    ).toFixed(2),
    shippingHandling: toNumber(row.shipping_handling).toFixed(2),
    notes: row.notes || "",
    sendOrderDetails: Boolean(row.send_order_details),
    rushOrder: Boolean(row.is_rush_order),
    rushLevel: calculateOrderRushLevel(row.order_created_at).label,
    subpoenaDate: toInputDate(row.subpoena_date),
  };
}

function normalizeOrderId(value) {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function normalizeInvoiceId(value) {
  return normalizeOrderId(value);
}

function resolveXrayRowFinancials(xrayRow, orderPayments = []) {
  const totalAmount = getXrayPayment(xrayRow);
  const fromOrderPayments = getOrderPaymentAmount(orderPayments, "xray");
  const fromInvoice = toNumber(xrayRow?.amount_paid);
  let amountPaid =
    xrayRow?.payment_method === "manual" || xrayRow?.payment_method === "online"
      ? Math.max(fromInvoice, fromOrderPayments)
      : orderPayments.length
        ? fromOrderPayments
        : fromInvoice;
  amountPaid = capPaidToInvoiceTotal(amountPaid, totalAmount);
  const writeoffAmount = toNumber(xrayRow?.writeoff_amount);
  const amountDue = Math.max(0, totalAmount - amountPaid - writeoffAmount);

  return {
    totalAmount,
    amountPaid,
    amountDue,
    writeoffAmount,
  };
}

function deriveXrayInvoiceStatus(xrayRow, financials, { isSent = false } = {}) {
  const storedStatus = trimOrNull(xrayRow?.status);

  if (storedStatus === "Written Off") {
    return "Written Off";
  }

  if (financials.amountDue <= 0) {
    if (financials.writeoffAmount > 0 && financials.amountPaid < financials.totalAmount) {
      return "Written Off";
    }

    return "Paid";
  }

  if (storedStatus === "Partial" || financials.amountPaid > 0 || financials.writeoffAmount > 0) {
    return "Partial";
  }

  if (isSent || storedStatus === "Needs Resend") {
    return "Needs Resend";
  }

  return storedStatus || "Unpaid";
}

function getXrayRecipientEmail(row) {
  return (
    trimOrNull(row?.provider_email) ||
    trimOrNull(row?.recipient_emails) ||
    trimOrNull(row?.serve_email)
  );
}

function mapXrayOutstandingRow(row, orderPayments = [], timezone = null) {
  const viewerTz = resolveViewerTimezone(timezone);
  const isSent = Boolean(row.sent_date);
  const displayDate = isSent ? row.sent_date : row.xray_invoice_date;
  const orderId = normalizeOrderId(row.order_id);
  const financials = resolveXrayRowFinancials(row, orderPayments);
  const status = deriveXrayInvoiceStatus(row, financials, { isSent });
  const isWrittenOff = status === "Written Off";

  return {
    id: `${row.facility_id}-${row.order_number}-xray-${orderId}`,
    invoiceId: orderId,
    invoiceNumber: resolveXrayInvoiceNumber(row),
    orderId,
    invoiceType: "xray",
    caseNo: row.order_number,
    applicant: buildApplicantName(row),
    status,
    isWrittenOff,
    isSent,
    sentDate: isSent
      ? formatSentInstant(row.sent_date, viewerTz)
      : toShortDate(displayDate),
    sentAt: isSent ? toUtcIso(row.sent_date) : null,
    days: daysSince(displayDate),
    invDate: toShortDate(row.xray_invoice_date),
    invoiced: formatMoney(financials.totalAmount),
    paid: formatMoney(financials.amountPaid),
    due: formatMoney(financials.amountDue),
    writeoffAmount:
      financials.writeoffAmount > 0
        ? formatMoney(financials.writeoffAmount)
        : null,
  };
}

function mapXrayResendRow(row, orderPayments = [], timezone = null) {
  const viewerTz = resolveViewerTimezone(timezone);
  const isSent = Boolean(row.sent_date);
  const displayDate = isSent ? row.sent_date : row.xray_invoice_date;
  const orderId = normalizeOrderId(row.order_id);
  const financials = resolveXrayRowFinancials(row, orderPayments);
  const status = deriveXrayInvoiceStatus(row, financials, { isSent });
  const isWrittenOff = status === "Written Off";

  return {
    id: orderId || row.order_id,
    invoiceId: orderId,
    invoiceNumber: resolveXrayInvoiceNumber(row),
    orderId,
    invoiceType: "xray",
    company: getInvoiceCompanyName(row),
    email: getXrayRecipientEmail(row) || "",
    caseNo: row.order_number,
    applicant: buildApplicantName(row),
    status,
    isWrittenOff,
    isSent,
    sentDate: isSent
      ? formatSentInstant(row.sent_date, viewerTz)
      : toShortDate(displayDate),
    sentAt: isSent ? toUtcIso(row.sent_date) : null,
    days: daysSince(displayDate),
    invoiceDate: toShortDate(row.xray_invoice_date),
    invoiced: formatMoney(financials.totalAmount),
    paid: formatMoney(financials.amountPaid),
    due: formatMoney(financials.amountDue),
    writeoffAmount:
      financials.writeoffAmount > 0
        ? formatMoney(financials.writeoffAmount)
        : null,
    ...mapInvoiceReminderFields(row),
  };
}

function buildXraySummary(rows = [], paymentsByOrderId = {}) {
  const companies = new Set();

  let invoiced = 0;
  let paid = 0;
  let due = 0;

  rows.forEach((row) => {
    const orderPayments = paymentsByOrderId[row.order_id] || [];
    const financials = resolveXrayRowFinancials(row, orderPayments);

    companies.add(getInvoiceCompanyId(row));
    invoiced += financials.totalAmount;
    paid += financials.amountPaid;
    due += financials.amountDue;
  });

  return {
    companies: companies.size,
    cases: rows.length,
    invoiced: formatMoney(invoiced),
    paid: formatMoney(paid),
    due: formatMoney(due),
  };
}

function groupXrayOutstandingRows(
  rows = [],
  paymentsByOrderId = {},
  timezone = null
) {
  const groups = new Map();

  rows.forEach((row) => {
    const company = getInvoiceCompanyName(row);
    const orderPayments = paymentsByOrderId[row.order_id] || [];
    const mappedRow = mapXrayOutstandingRow(row, orderPayments, timezone);
    const financials = resolveXrayRowFinancials(row, orderPayments);

    if (!groups.has(company)) {
      groups.set(company, {
        company,
        emails: getXrayRecipientEmail(row) || "",
        rows: [],
        total: { invoiced: 0, paid: 0, due: 0 },
      });
    }

    const group = groups.get(company);
    group.rows.push(mappedRow);
    group.total.invoiced += financials.totalAmount;
    group.total.paid += financials.amountPaid;
    group.total.due += financials.amountDue;
  });

  return Array.from(groups.values()).map((group) => ({
    ...group,
    total: {
      invoiced: formatMoney(group.total.invoiced),
      paid: formatMoney(group.total.paid),
      due: formatMoney(group.total.due),
    },
  }));
}

function mapOutstandingRow(row, orderPayments = [], timezone = null) {
  const viewerTz = resolveViewerTimezone(timezone);
  const isSent = Boolean(row.sent_date);
  const displayDate = isSent ? row.sent_date : row.invoice_date;
  const invoiceDbId = normalizeInvoiceId(row.id);
  const isWrittenOff = row.status === "Written Off";
  const financials = resolveRowFinancials(row, orderPayments);

  return {
    id: `${row.facility_id}-${row.order_number}-${invoiceDbId || row.id}`,
    invoiceId: invoiceDbId,
    orderId: row.order_id,
    caseNo: row.order_number,
    applicant: buildApplicantName(row),
    status: row.status || "Unpaid",
    isWrittenOff,
    isSent,
    sentDate: isSent
      ? formatSentInstant(row.sent_date, viewerTz)
      : toShortDate(displayDate),
    sentAt: isSent ? toUtcIso(row.sent_date) : null,
    days: daysSince(displayDate),
    invDate: toShortDate(row.invoice_date),
    invoiced: formatMoney(financials.totalAmount),
    paid: formatMoney(financials.amountPaid),
    due: formatMoney(financials.amountDue),
  };
}

function mapResendRow(row, orderPayments = [], timezone = null) {
  const viewerTz = resolveViewerTimezone(timezone);
  const isSent = Boolean(row.sent_date);
  const displayDate = isSent ? row.sent_date : row.invoice_date;
  const invoiceDbId = normalizeInvoiceId(row.id);
  const financials = resolveRowFinancials(row, orderPayments);

  return {
    id: invoiceDbId || row.id,
    invoiceId: invoiceDbId,
    orderId: row.order_id,
    company: getInvoiceCompanyName(row),
    email: getInvoiceDisplayEmail(row),
    caseNo: row.order_number,
    applicant: buildApplicantName(row),
    isSent,
    sentDate: isSent
      ? formatSentInstant(row.sent_date, viewerTz)
      : toShortDate(displayDate),
    sentAt: isSent ? toUtcIso(row.sent_date) : null,
    days: daysSince(displayDate),
    invoiceDate: toShortDate(row.invoice_date),
    invoiced: formatMoney(financials.totalAmount),
    paid: formatMoney(financials.amountPaid),
    due: formatMoney(financials.amountDue),
    ...mapInvoiceReminderFields(row),
  };
}

function buildSummary(rows = [], paymentsByOrderId = {}) {
  const companies = new Set();

  let invoiced = 0;
  let paid = 0;
  let due = 0;

  rows.forEach((row) => {
    const orderPayments = paymentsByOrderId[row.order_id] || [];
    const financials = resolveRowFinancials(row, orderPayments);

    companies.add(getInvoiceCompanyId(row));
    invoiced += financials.totalAmount;
    paid += financials.amountPaid;
    due += financials.amountDue;
  });

  return {
    companies: companies.size,
    cases: rows.length,
    invoiced: formatMoney(invoiced),
    paid: formatMoney(paid),
    due: formatMoney(due),
  };
}

function groupOutstandingRows(
  rows = [],
  paymentsByOrderId = {},
  timezone = null
) {
  const groups = new Map();

  rows.forEach((row) => {
    const company = getInvoiceCompanyName(row);
    const orderPayments = paymentsByOrderId[row.order_id] || [];
    const mappedRow = mapOutstandingRow(row, orderPayments, timezone);
    const financials = resolveRowFinancials(row, orderPayments);

    if (!groups.has(company)) {
      groups.set(company, {
        company,
        emails: getInvoiceDisplayEmail(row),
        rows: [],
        total: { invoiced: 0, paid: 0, due: 0 },
      });
    }

    const group = groups.get(company);
    group.rows.push(mappedRow);
    group.total.invoiced += financials.totalAmount;
    group.total.paid += financials.amountPaid;
    group.total.due += financials.amountDue;
  });

  return Array.from(groups.values()).map((group) => ({
    ...group,
    total: {
      invoiced: formatMoney(group.total.invoiced),
      paid: formatMoney(group.total.paid),
      due: formatMoney(group.total.due),
    },
  }));
}

function buildInvoicePayload(body = {}, existing = null, options = {}) {
  const totals = calculateTotalsWithPayments({ ...body }, options.orderPayments || []);
  const invoiceShape = {
    ...body,
    storageFee: totals.storageFee,
    storage_fee: totals.storageFee,
    pages: totals.pageCount,
    page_count: totals.pageCount,
    perPageAmount: totals.perPageAmount,
    per_page_amount: totals.perPageAmount,
    clericalTimeHours: totals.clericalTimeHours,
    clerical_time_hours: totals.clericalTimeHours,
    clericalHourlyRate: totals.clericalHourlyRate,
    clerical_hourly_rate: totals.clericalHourlyRate,
    shippingHandling: totals.shippingHandling,
    shipping_handling: totals.shippingHandling,
  };
  const amountPaid = resolveAmountPaid(
    options.orderPayments,
    existing,
    invoiceShape,
    {
      personalPortalOrder: Boolean(options.personalPortalOrder),
      totalAmount: totals.totalAmount,
    }
  );
  const writeoffAmount = existing ? toNumber(existing.writeoff_amount) : 0;
  const {
    amountPaid: cappedPaid,
    amountDue,
    status: derivedStatus,
  } = resolveInvoiceAmounts(totals.totalAmount, amountPaid, writeoffAmount);
  const status = resolveInvoiceStatusForSave(
    existing,
    totals.totalAmount,
    cappedPaid,
    derivedStatus
  );

  return {
    status,
    invoiceDate: trimOrNull(body.invoiceDate),
    sentDate: existing?.sent_date || null,
    pageCount: totals.pageCount,
    perPageAmount: totals.perPageAmount,
    clericalTimeHours: totals.clericalTimeHours,
    clericalHourlyRate: totals.clericalHourlyRate,
    shippingHandling: totals.shippingHandling,
    storageFee: totals.storageFee,
    totalAmount: totals.totalAmount,
    amountPaid: cappedPaid,
    amountDue,
    notes: trimOrNull(body.notes, { maxLength: FIELD_LIMITS.TEXT }),
    sendOrderDetails: boolToInt(body.sendOrderDetails),
    isRushOrder: boolToInt(body.rushOrder),
  };
}

async function getInvoiceById(id) {
  const invoice = await Invoice.findById(id);

  if (!invoice) {
    throw new ApiError(404, "Invoice not found");
  }

  return mapInvoiceDetail(invoice);
}

function mapReportSummary(summary) {
  return {
    companies: summary.totalCompanies,
    cases: summary.totalCases,
    invoiced: formatMoney(summary.totalInvoiced),
    paid: formatMoney(summary.totalPaid),
    due: formatMoney(summary.totalDue),
  };
}

function buildReportPagination(keysetResult, totalCases = null) {
  return {
    type: "keyset",
    pageSize: keysetResult.pageSize,
    hasMore: keysetResult.hasMore,
    nextCursor: keysetResult.nextCursor,
    totalCases: totalCases ?? null,
  };
}

function buildReportGroupPagination(meta = {}, keysetResult = null) {
  if (keysetResult) {
    return buildReportPagination(keysetResult, meta.totalCases);
  }

  return {
    type: "keyset",
    pageSize: Number(meta.pageSize) || 10,
    hasMore: Boolean(meta.hasMore),
    nextCursor: meta.nextCursor || null,
    totalCases: Number(meta.company_case_count) || 0,
  };
}

function formatReportGroupTotals(meta = {}) {
  return {
    invoiced: formatMoney(meta.company_invoiced ?? meta.totalInvoiced ?? 0),
    paid: formatMoney(meta.company_paid ?? meta.totalPaid ?? 0),
    due: formatMoney(meta.company_due ?? meta.totalDue ?? 0),
  };
}

function mapResendRowForGroup(row) {
  return {
    id: String(row.id),
    invoiceId: row.invoiceId,
    orderId: row.orderId,
    caseNo: row.caseNo,
    applicant: row.applicant,
    isSent: row.isSent,
    sentDate: row.sentDate,
    days: row.days,
    invDate: row.invoiceDate,
    invoiced: row.invoiced,
    paid: row.paid,
    due: row.due,
    reminder1: row.reminder1 || null,
    reminder2: row.reminder2 || null,
    reminder3: row.reminder3 || null,
  };
}

function buildReportGroup(meta, rows, keysetResult = null) {
  return {
    companyGroupKey: Number(meta.company_partition),
    company: meta.company_name || meta.companyName || "Unknown Company",
    emails: meta.company_email || meta.companyEmail || "",
    rows,
    total: formatReportGroupTotals(meta),
    pagination: buildReportGroupPagination(
      {
        hasMore: meta.hasMore,
        nextCursor: meta.nextCursor,
        company_case_count: meta.company_case_count || meta.totalCases,
        totalCases: meta.totalCases,
      },
      keysetResult
    ),
  };
}

function parseReportFilters(query = {}) {
  return parseInvoiceReportQuery(query);
}

function isKeysetQuery(query = {}) {
  return String(query.pagination || "").toLowerCase() === "keyset";
}

function isSummaryOnlyQuery(query = {}) {
  return ["1", "true", "yes"].includes(
    String(query.summaryOnly || "").toLowerCase()
  );
}

async function hydrateStandardReportRows(pageRows = []) {
  if (!pageRows.length) return [];

  const ids = pageRows.map((row) => Number(row.source_id)).filter(Boolean);
  const rows = await Invoice.findDetailsByIds(ids);
  const rowsById = new Map(rows.map((row) => [Number(row.id), row]));

  return pageRows
    .map((pageRow) => rowsById.get(Number(pageRow.source_id)))
    .filter(Boolean);
}

async function hydrateXrayReportRows(pageRows = []) {
  if (!pageRows.length) return [];

  const orderIds = pageRows.map((row) => Number(row.source_id)).filter(Boolean);
  const rows = await InvoiceXray.findByOrderIdsWithDetails(orderIds);
  const rowsByOrderId = new Map(rows.map((row) => [Number(row.order_id), row]));

  return pageRows
    .map((pageRow) => rowsByOrderId.get(Number(pageRow.source_id)))
    .filter(Boolean);
}

function groupFirstPerCompanyPageRows(perCompanyRows = [], pageSize = 10) {
  const byCompany = new Map();

  for (const row of perCompanyRows) {
    const key = String(row.company_partition);
    if (!byCompany.has(key)) {
      byCompany.set(key, []);
    }
    byCompany.get(key).push(row);
  }

  return Array.from(byCompany.values()).map((companyRows) => {
    const ordered = [...companyRows].sort(
      (left, right) => Number(left.row_num) - Number(right.row_num)
    );
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const totalCases = Number(first.company_case_count) || 0;
    const hasMore = totalCases > ordered.length;

    return {
      meta: {
        company_partition: first.company_partition,
        company_name: first.company_name,
        company_email: first.company_email,
        company_invoiced: first.company_invoiced,
        company_paid: first.company_paid,
        company_due: first.company_due,
        company_case_count: totalCases,
        totalCases,
        pageSize,
        hasMore,
        nextCursor: hasMore ? last.nextCursor || null : null,
      },
      pageRows: ordered,
    };
  });
}

async function buildOutstandingGroupsFromFirstPerCompany(
  perCompanyRows = [],
  paymentsByOrderId = {},
  pageSize = 10,
  timezone = null
) {
  if (!perCompanyRows.length) return [];

  const groupedCompanies = groupFirstPerCompanyPageRows(perCompanyRows, pageSize);
  const hydratedRows = await hydrateStandardReportRows(
    perCompanyRows.map((row) => ({ source_id: row.source_id }))
  );
  const hydratedById = new Map(hydratedRows.map((row) => [Number(row.id), row]));

  return groupedCompanies
    .map(({ meta, pageRows }) => {
      const mappedRows = pageRows
        .map((pageRow) => {
          const sourceRow = hydratedById.get(Number(pageRow.source_id));
          if (!sourceRow) return null;

          return mapOutstandingRow(
            sourceRow,
            paymentsByOrderId[sourceRow.order_id] || [],
            timezone
          );
        })
        .filter(Boolean);

      if (!mappedRows.length) return null;

      return buildReportGroup(meta, mappedRows);
    })
    .filter(Boolean);
}

async function buildXrayOutstandingGroupsFromFirstPerCompany(
  perCompanyRows = [],
  paymentsByOrderId = {},
  pageSize = 10,
  timezone = null
) {
  if (!perCompanyRows.length) return [];

  const groupedCompanies = groupFirstPerCompanyPageRows(perCompanyRows, pageSize);
  const hydratedRows = await hydrateXrayReportRows(
    perCompanyRows.map((row) => ({ source_id: row.source_id }))
  );
  const hydratedByOrderId = new Map(
    hydratedRows.map((row) => [Number(row.order_id), row])
  );

  return groupedCompanies
    .map(({ meta, pageRows }) => {
      const mappedRows = pageRows
        .map((pageRow) => {
          const sourceRow = hydratedByOrderId.get(Number(pageRow.source_id));
          if (!sourceRow) return null;

          return mapXrayOutstandingRow(
            sourceRow,
            paymentsByOrderId[sourceRow.order_id] || [],
            timezone
          );
        })
        .filter(Boolean);

      if (!mappedRows.length) return null;

      return buildReportGroup(meta, mappedRows);
    })
    .filter(Boolean);
}

async function buildResendGroupsFromFirstPerCompany(
  perCompanyRows = [],
  paymentsByOrderId = {},
  pageSize = 10,
  timezone = null
) {
  if (!perCompanyRows.length) return [];

  const groupedCompanies = groupFirstPerCompanyPageRows(perCompanyRows, pageSize);
  const hydratedRows = await hydrateStandardReportRows(
    perCompanyRows.map((row) => ({ source_id: row.source_id }))
  );
  const hydratedById = new Map(hydratedRows.map((row) => [Number(row.id), row]));

  return groupedCompanies
    .map(({ meta, pageRows }) => {
      const mappedRows = pageRows
        .map((pageRow) => {
          const sourceRow = hydratedById.get(Number(pageRow.source_id));
          if (!sourceRow) return null;

          return mapResendRowForGroup(
            mapResendRow(
              sourceRow,
              paymentsByOrderId[sourceRow.order_id] || [],
              timezone
            )
          );
        })
        .filter(Boolean);

      if (!mappedRows.length) return null;

      return buildReportGroup(meta, mappedRows);
    })
    .filter(Boolean);
}

async function buildXrayResendGroupsFromFirstPerCompany(
  perCompanyRows = [],
  paymentsByOrderId = {},
  pageSize = 10,
  timezone = null
) {
  if (!perCompanyRows.length) return [];

  const groupedCompanies = groupFirstPerCompanyPageRows(perCompanyRows, pageSize);
  const hydratedRows = await hydrateXrayReportRows(
    perCompanyRows.map((row) => ({ source_id: row.source_id }))
  );
  const hydratedByOrderId = new Map(
    hydratedRows.map((row) => [Number(row.order_id), row])
  );

  return groupedCompanies
    .map(({ meta, pageRows }) => {
      const mappedRows = pageRows
        .map((pageRow) => {
          const sourceRow = hydratedByOrderId.get(Number(pageRow.source_id));
          if (!sourceRow) return null;

          return mapResendRowForGroup(
            mapXrayResendRow(
              sourceRow,
              paymentsByOrderId[sourceRow.order_id] || [],
              timezone
            )
          );
        })
        .filter(Boolean);

      if (!mappedRows.length) return null;

      return buildReportGroup(meta, mappedRows);
    })
    .filter(Boolean);
}

function clearKeysetWhenEmpty(keysetResult, filters, mappedRows) {
  if (filters.cursor && !mappedRows.length) {
    keysetResult.hasMore = false;
    keysetResult.nextCursor = null;
  }
}

async function getOutstandingInvoicesCompanyGroupPage(query = {}) {
  const filters = parseReportFilters(query);
  const timezone = query.timezone || null;
  const [keysetResult, companyTotals] = await Promise.all([
    InvoiceReport.findStandardOutstandingKeyset(filters),
    InvoiceReport.getStandardOutstandingCompanyTotals(
      filters,
      filters.companyGroupKey
    ),
  ]);

  const rows = await hydrateStandardReportRows(keysetResult.rows);
  const orderIds = [...new Set(rows.map((row) => row.order_id))];
  const paymentRows = await Order.findPaymentsByOrderIds(orderIds);
  const paymentsByOrderId = groupPaymentsByOrderId(paymentRows);
  const mappedRows = rows.map((row) =>
    mapOutstandingRow(row, paymentsByOrderId[row.order_id] || [], timezone)
  );

  clearKeysetWhenEmpty(keysetResult, filters, mappedRows);

  return {
    companyGroupKey: filters.companyGroupKey,
    group: buildReportGroup(
      {
        company_partition: filters.companyGroupKey,
        company_name: companyTotals.companyName,
        company_email: companyTotals.companyEmail,
        company_invoiced: companyTotals.totalInvoiced,
        company_paid: companyTotals.totalPaid,
        company_due: companyTotals.totalDue,
        totalCases: companyTotals.totalCases,
      },
      mappedRows,
      keysetResult
    ),
  };
}

async function getResendInvoicesCompanyGroupPage(query = {}) {
  const filters = parseReportFilters(query);
  const timezone = query.timezone || null;
  const [keysetResult, companyTotals] = await Promise.all([
    InvoiceReport.findStandardResendKeyset(filters),
    InvoiceReport.getStandardResendCompanyTotals(filters, filters.companyGroupKey),
  ]);

  const rows = await hydrateStandardReportRows(keysetResult.rows);
  const orderIds = [...new Set(rows.map((row) => row.order_id))];
  const paymentRows = await Order.findPaymentsByOrderIds(orderIds);
  const paymentsByOrderId = groupPaymentsByOrderId(paymentRows);
  const mappedRows = rows
    .map((row) =>
      mapResendRow(row, paymentsByOrderId[row.order_id] || [], timezone)
    )
    .map(mapResendRowForGroup);

  clearKeysetWhenEmpty(keysetResult, filters, mappedRows);

  return {
    companyGroupKey: filters.companyGroupKey,
    group: buildReportGroup(
      {
        company_partition: filters.companyGroupKey,
        company_name: companyTotals.companyName,
        company_email: companyTotals.companyEmail,
        company_invoiced: companyTotals.totalInvoiced,
        company_paid: companyTotals.totalPaid,
        company_due: companyTotals.totalDue,
        totalCases: companyTotals.totalCases,
      },
      mappedRows,
      keysetResult
    ),
  };
}

async function getXrayOutstandingInvoicesCompanyGroupPage(query = {}) {
  const filters = parseReportFilters(query);
  const timezone = query.timezone || null;
  const [keysetResult, companyTotals] = await Promise.all([
    InvoiceReport.findXrayOutstandingKeyset(filters),
    InvoiceReport.getXrayOutstandingCompanyTotals(filters, filters.companyGroupKey),
  ]);

  const rows = await hydrateXrayReportRows(keysetResult.rows);
  const orderIds = [...new Set(rows.map((row) => row.order_id))];
  const paymentRows = await Order.findPaymentsByOrderIds(orderIds);
  const paymentsByOrderId = groupPaymentsByOrderId(paymentRows);
  const mappedRows = rows.map((row) =>
    mapXrayOutstandingRow(row, paymentsByOrderId[row.order_id] || [], timezone)
  );

  clearKeysetWhenEmpty(keysetResult, filters, mappedRows);

  return {
    companyGroupKey: filters.companyGroupKey,
    group: buildReportGroup(
      {
        company_partition: filters.companyGroupKey,
        company_name: companyTotals.companyName,
        company_email: companyTotals.companyEmail,
        company_invoiced: companyTotals.totalInvoiced,
        company_paid: companyTotals.totalPaid,
        company_due: companyTotals.totalDue,
        totalCases: companyTotals.totalCases,
      },
      mappedRows,
      keysetResult
    ),
  };
}

async function getXrayResendInvoicesCompanyGroupPage(query = {}) {
  const filters = parseReportFilters(query);
  const timezone = query.timezone || null;
  const [keysetResult, companyTotals] = await Promise.all([
    InvoiceReport.findXrayResendKeyset(filters),
    InvoiceReport.getXrayResendCompanyTotals(filters, filters.companyGroupKey),
  ]);

  const rows = await hydrateXrayReportRows(keysetResult.rows);
  const orderIds = [...new Set(rows.map((row) => row.order_id))];
  const paymentRows = await Order.findPaymentsByOrderIds(orderIds);
  const paymentsByOrderId = groupPaymentsByOrderId(paymentRows);
  const mappedRows = rows
    .map((row) =>
      mapXrayResendRow(row, paymentsByOrderId[row.order_id] || [], timezone)
    )
    .map(mapResendRowForGroup);

  clearKeysetWhenEmpty(keysetResult, filters, mappedRows);

  return {
    companyGroupKey: filters.companyGroupKey,
    group: buildReportGroup(
      {
        company_partition: filters.companyGroupKey,
        company_name: companyTotals.companyName,
        company_email: companyTotals.companyEmail,
        company_invoiced: companyTotals.totalInvoiced,
        company_paid: companyTotals.totalPaid,
        company_due: companyTotals.totalDue,
        totalCases: companyTotals.totalCases,
      },
      mappedRows,
      keysetResult
    ),
  };
}

async function getOutstandingInvoicesKeyset(query = {}) {
  if (hasCompanyGroupKey(query)) {
    return getOutstandingInvoicesCompanyGroupPage(query);
  }

  const filters = parseReportFilters(query);
  const [perCompanyRows, summary] = await Promise.all([
    InvoiceReport.findStandardOutstandingFirstPerCompany(filters),
    InvoiceReport.getStandardOutstandingSummary(filters),
  ]);

  const orderIds = [
    ...new Set(
      (
        await hydrateStandardReportRows(
          perCompanyRows.map((row) => ({ source_id: row.source_id }))
        )
      ).map((row) => row.order_id)
    ),
  ];
  const paymentRows = await Order.findPaymentsByOrderIds(orderIds);
  const paymentsByOrderId = groupPaymentsByOrderId(paymentRows);
  const groups = await buildOutstandingGroupsFromFirstPerCompany(
    perCompanyRows,
    paymentsByOrderId,
    filters.pageSize,
    query.timezone || null
  );

  return {
    groups,
    summary: mapReportSummary(summary),
    count: summary.totalCases,
  };
}

async function getResendInvoicesKeyset(query = {}) {
  if (hasCompanyGroupKey(query)) {
    return getResendInvoicesCompanyGroupPage(query);
  }

  const filters = parseReportFilters(query);
  const [perCompanyRows, summary] = await Promise.all([
    InvoiceReport.findStandardResendFirstPerCompany(filters),
    InvoiceReport.getStandardResendSummary(filters),
  ]);

  const orderIds = [
    ...new Set(
      (
        await hydrateStandardReportRows(
          perCompanyRows.map((row) => ({ source_id: row.source_id }))
        )
      ).map((row) => row.order_id)
    ),
  ];
  const paymentRows = await Order.findPaymentsByOrderIds(orderIds);
  const paymentsByOrderId = groupPaymentsByOrderId(paymentRows);
  const groups = await buildResendGroupsFromFirstPerCompany(
    perCompanyRows,
    paymentsByOrderId,
    filters.pageSize,
    query.timezone || null
  );

  return {
    groups,
    invoices: groups.flatMap((group) => group.rows),
    summary: mapReportSummary(summary),
    count: summary.totalCases,
  };
}

async function getXrayOutstandingInvoicesKeyset(query = {}) {
  if (hasCompanyGroupKey(query)) {
    return getXrayOutstandingInvoicesCompanyGroupPage(query);
  }

  const filters = parseReportFilters(query);
  const [perCompanyRows, summary] = await Promise.all([
    InvoiceReport.findXrayOutstandingFirstPerCompany(filters),
    InvoiceReport.getXrayOutstandingSummary(filters),
  ]);

  const orderIds = [
    ...new Set(
      (
        await hydrateXrayReportRows(
          perCompanyRows.map((row) => ({ source_id: row.source_id }))
        )
      ).map((row) => row.order_id)
    ),
  ];
  const paymentRows = await Order.findPaymentsByOrderIds(orderIds);
  const paymentsByOrderId = groupPaymentsByOrderId(paymentRows);
  const groups = await buildXrayOutstandingGroupsFromFirstPerCompany(
    perCompanyRows,
    paymentsByOrderId,
    filters.pageSize,
    query.timezone || null
  );

  return {
    groups,
    summary: mapReportSummary(summary),
    count: summary.totalCases,
  };
}

async function getXrayResendInvoicesKeyset(query = {}) {
  if (hasCompanyGroupKey(query)) {
    return getXrayResendInvoicesCompanyGroupPage(query);
  }

  const filters = parseReportFilters(query);
  const [perCompanyRows, summary] = await Promise.all([
    InvoiceReport.findXrayResendFirstPerCompany(filters),
    InvoiceReport.getXrayResendSummary(filters),
  ]);

  const orderIds = [
    ...new Set(
      (
        await hydrateXrayReportRows(
          perCompanyRows.map((row) => ({ source_id: row.source_id }))
        )
      ).map((row) => row.order_id)
    ),
  ];
  const paymentRows = await Order.findPaymentsByOrderIds(orderIds);
  const paymentsByOrderId = groupPaymentsByOrderId(paymentRows);
  const groups = await buildXrayResendGroupsFromFirstPerCompany(
    perCompanyRows,
    paymentsByOrderId,
    filters.pageSize,
    query.timezone || null
  );

  return {
    groups,
    invoices: groups.flatMap((group) => group.rows),
    summary: mapReportSummary(summary),
    count: summary.totalCases,
  };
}

async function getOutstandingInvoicesSummaryOnly(query = {}) {
  const filters = parseReportFilters(query);
  const summary = await InvoiceReport.getStandardOutstandingSummary(filters);

  return {
    groups: [],
    summary: mapReportSummary(summary),
    count: summary.totalCases,
  };
}

async function getResendInvoicesSummaryOnly(query = {}) {
  const filters = parseReportFilters(query);
  const summary = await InvoiceReport.getStandardResendSummary(filters);

  return {
    invoices: [],
    summary: mapReportSummary(summary),
    count: summary.totalCases,
  };
}

async function getXrayOutstandingInvoicesSummaryOnly(query = {}) {
  const filters = parseReportFilters(query);
  const summary = await InvoiceReport.getXrayOutstandingSummary(filters);

  return {
    groups: [],
    summary: mapReportSummary(summary),
    count: summary.totalCases,
  };
}

async function getXrayResendInvoicesSummaryOnly(query = {}) {
  const filters = parseReportFilters(query);
  const summary = await InvoiceReport.getXrayResendSummary(filters);

  return {
    invoices: [],
    summary: mapReportSummary(summary),
    count: summary.totalCases,
  };
}

async function getOutstandingInvoices(query = {}) {
  if (isSummaryOnlyQuery(query)) {
    return getOutstandingInvoicesSummaryOnly(query);
  }

  if (isKeysetQuery(query)) {
    return getOutstandingInvoicesKeyset(query);
  }

  const rows = await Invoice.findOutstanding(parseInvoiceDateFilters(query));
  const orderIds = [...new Set(rows.map((row) => row.order_id))];
  const paymentRows = await Order.findPaymentsByOrderIds(orderIds);
  const paymentsByOrderId = groupPaymentsByOrderId(paymentRows);

  return {
    groups: groupOutstandingRows(rows, paymentsByOrderId, query.timezone || null),
    summary: buildSummary(rows, paymentsByOrderId),
    count: rows.length,
  };
}

async function getResendInvoices(query = {}) {
  if (isSummaryOnlyQuery(query)) {
    return getResendInvoicesSummaryOnly(query);
  }

  if (isKeysetQuery(query)) {
    return getResendInvoicesKeyset(query);
  }

  const rows = await Invoice.findResend(parseInvoiceDateFilters(query));
  const orderIds = [...new Set(rows.map((row) => row.order_id))];
  const paymentRows = await Order.findPaymentsByOrderIds(orderIds);
  const paymentsByOrderId = groupPaymentsByOrderId(paymentRows);
  const timezone = query.timezone || null;

  return {
    invoices: rows.map((row) =>
      mapResendRow(row, paymentsByOrderId[row.order_id] || [], timezone)
    ),
    summary: buildSummary(rows, paymentsByOrderId),
    count: rows.length,
  };
}

async function getXrayOutstandingInvoices(query = {}) {
  if (isSummaryOnlyQuery(query)) {
    return getXrayOutstandingInvoicesSummaryOnly(query);
  }

  if (isKeysetQuery(query)) {
    return getXrayOutstandingInvoicesKeyset(query);
  }

  const rows = await InvoiceXray.findOutstanding(parseInvoiceDateFilters(query));
  const orderIds = [...new Set(rows.map((row) => row.order_id))];
  const paymentRows = await Order.findPaymentsByOrderIds(orderIds);
  const paymentsByOrderId = groupPaymentsByOrderId(paymentRows);

  return {
    groups: groupXrayOutstandingRows(
      rows,
      paymentsByOrderId,
      query.timezone || null
    ),
    summary: buildXraySummary(rows, paymentsByOrderId),
    count: rows.length,
  };
}

async function getXrayResendInvoices(query = {}) {
  if (isSummaryOnlyQuery(query)) {
    return getXrayResendInvoicesSummaryOnly(query);
  }

  if (isKeysetQuery(query)) {
    return getXrayResendInvoicesKeyset(query);
  }

  const rows = await InvoiceXray.findResend(parseInvoiceDateFilters(query));
  const orderIds = [...new Set(rows.map((row) => row.order_id))];
  const paymentRows = await Order.findPaymentsByOrderIds(orderIds);
  const paymentsByOrderId = groupPaymentsByOrderId(paymentRows);
  const timezone = query.timezone || null;

  return {
    invoices: rows.map((row) =>
      mapXrayResendRow(row, paymentsByOrderId[row.order_id] || [], timezone)
    ),
    summary: buildXraySummary(rows, paymentsByOrderId),
    count: rows.length,
  };
}

async function getInvoices(query = {}) {
  const reportType = parseOptionalReportType(query.type);
  const reportTab = parseOptionalReportTab(query.tab);

  if (reportType === "xray") {
    if (reportTab === "resend") {
      return getXrayResendInvoices(query);
    }

    return getXrayOutstandingInvoices(query);
  }

  if (reportTab === "resend") {
    return getResendInvoices(query);
  }

  return getOutstandingInvoices(query);
}

async function getStandardInvoicesByOrderIds(orderIds = []) {
  return Invoice.findByOrderIds(orderIds);
}

async function getXrayDetailsByOrderIds(orderIds = []) {
  return InvoiceXray.findByOrderIds(orderIds);
}

async function getXrayInvoiceByOrderId(orderId) {
  const normalizedOrderId = Number(orderId);

  if (!Number.isFinite(normalizedOrderId)) {
    throw new ApiError(400, "Invalid order id");
  }

  const order = await Order.findById(normalizedOrderId);

  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  const [invoice, xray, orderPayments] = await Promise.all([
    Invoice.findByOrderId(normalizedOrderId),
    InvoiceXray.findByOrderId(normalizedOrderId),
    Order.findPaymentsByOrderId(normalizedOrderId),
  ]);

  return {
    invoiceId: invoice?.id || null,
    xray: mapXrayDetail(xray, orderPayments),
  };
}

async function createOrUpdateXrayInvoice(body, userId) {
  const orderId = Number(body.orderId);
  const viewCount = Math.max(0, Math.floor(toNumber(body.views)));
  const perViewAmount = toNumber(body.perViewAmount);
  const viewsAmount = viewCount * perViewAmount;
  const xrayInvoiceDate = trimOrNull(body.xrayInvoiceDate);
  const examDate = trimOrNull(body.examDate);
  const checkNumber = trimOrNull(body.checkNumber);
  const description = trimOrNull(body.description, { maxLength: FIELD_LIMITS.TEXT });

  if (!Number.isFinite(orderId)) {
    throw new ApiError(400, "orderId is required");
  }

  if (!xrayInvoiceDate) {
    throw new ApiError(400, "X-Ray invoice date is required");
  }

  const order = await Order.findById(orderId);

  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  {
    const companyPortalInternalSyncService = require("./companyPortalInternalSyncService");
    await companyPortalInternalSyncService.assertCompanyPortalOrderAllowsInvoicing(
      orderId
    );
    const personalPortalService = require("./personalPortalService");
    await personalPortalService.assertPersonalPortalOrderAllowsInvoicing(
      orderId
    );
  }

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const xrayFee = viewsAmount;
    const recipientEmails = await resolveInvoiceRecipientFromOrder(
      order,
      connection
    );

    await InvoiceXray.upsert(connection, orderId, {
      invoiceNumber: buildXrayInvoiceNumber(order),
      xrayInvoiceDate,
      examDate,
      viewCount,
      perViewAmount,
      payment: xrayFee,
      checkNumber,
      description,
      recipientEmails,
    });

    await connection.execute(
      `UPDATE orders
       SET xray_invoice_date = :xrayInvoiceDate, updated_at = NOW()
       WHERE id = :orderId`,
      { xrayInvoiceDate, orderId }
    );

    await connection.commit();

    try {
      const personalPortalService = require("./personalPortalService");
      await personalPortalService.syncPortalStatusForDmsOrder(orderId);
    } catch (syncError) {
      // Non-blocking: personal portal status sync must not fail invoice create
    }

    return getXrayInvoiceByOrderId(orderId);
  } catch (error) {
    await connection.rollback();
    rethrowServiceError(error);
  } finally {
    connection.release();
  }
}

async function syncInvoicePrepayment(connection, orderId, prepaymentAmount) {
  if (prepaymentAmount === undefined || prepaymentAmount === null) {
    return;
  }

  const amount = toNumber(prepaymentAmount);
  const existingPayments = await Order.findPaymentsByOrderId(orderId, connection);
  const existingPrepayment = existingPayments.find(
    (payment) => payment.payment_type === "prepayment"
  );

  await Order.upsertPayment(connection, {
    orderId,
    paymentType: "prepayment",
    checkNumber: existingPrepayment?.check_number || null,
    paymentDate: existingPrepayment?.payment_date || null,
    amount,
    dueAmount: existingPrepayment?.due_amount ?? null,
    isPaid: amount > 0 ? 1 : 0,
    memo: existingPrepayment?.memo || null,
  });

  await syncServeWorkflowFromPrepayment(connection, orderId);
  await syncInvoiceAmountPaidFromOrder(connection, orderId);
}

async function syncServeWorkflowFromPrepayment(connection, orderId) {
  const payments = await Order.findPaymentsByOrderId(orderId, connection);
  const prepaymentPaid = getOrderPaymentAmount(payments, "prepayment");
  const isServeComplete = prepaymentPaid >= DEFAULT_PREPAYMENT_CHARGE;

  await Order.upsertWorkflowStage(
    orderId,
    "Serve",
    isServeComplete ? "complete" : "pending",
    isServeComplete ? new Date() : null,
    connection
  );
}

async function createInvoice(body, userId) {
  const orderId = Number(body.orderId);

  if (!Number.isFinite(orderId)) {
    throw new ApiError(400, "orderId is required");
  }

  if (!trimOrNull(body.invoiceDate)) {
    throw new ApiError(400, "Invoice date is required");
  }

  const order = await Order.findById(orderId);

  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  {
    const companyPortalInternalSyncService = require("./companyPortalInternalSyncService");
    await companyPortalInternalSyncService.assertCompanyPortalOrderAllowsInvoicing(
      orderId
    );
    const personalPortalService = require("./personalPortalService");
    await personalPortalService.assertPersonalPortalOrderAllowsInvoicing(
      orderId
    );
  }

  if (Number(order.certificate_no_records)) {
    // CNR: only the $15 witness/prepayment applies — no $20 records fee.
    body = {
      ...body,
      pages: 0,
      perPageAmount: 0,
      clericalTimeHours: 0,
      clericalHourlyRate: 0,
      shippingHandling: 0,
      storageFee: 0,
    };
  }

  const existing = await Invoice.findByOrderId(orderId);

  if (existing && hasStandardInvoiceFields(existing)) {
    throw new ApiError(409, "An invoice already exists for this order");
  }

  if (existing && !hasStandardInvoiceFields(existing)) {
    return updateInvoice(existing.id, body);
  }

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    await syncInvoicePrepayment(connection, orderId, body.prepaymentAmount);

    const orderPayments = await Order.findPaymentsByOrderId(orderId, connection);

    // Company / personal portal: if a new facility was located and added,
    // add its $5 search fee to this invoice (once).
    let invoiceBody = body;
    let pendingFacilityFee = null;
    try {
      pendingFacilityFee = await resolvePendingFacilitySearchFee(orderId);
    } catch (_feeError) {
      pendingFacilityFee = null;
    }
    if (pendingFacilityFee && pendingFacilityFee.amount > 0) {
      invoiceBody = {
        ...body,
        storageFee: toNumber(body.storageFee) + pendingFacilityFee.amount,
        notes: appendFacilitySearchFeeNote(body.notes, pendingFacilityFee.amount),
      };
    }

    const invoicePayload = buildInvoicePayload(invoiceBody, null, {
      orderPayments,
      personalPortalOrder: isPersonalPortalOrder(order),
    });
    const recipientEmails = await resolveInvoiceRecipientFromOrder(order, connection);

    const invoiceId = await Invoice.create(connection, {
      invoiceNumber:
        trimOrNull(body.invoiceNumber) || buildStandardInvoiceNumber(order),
      orderId,
      facilityId: order.facility_id,
      status: invoicePayload.status,
      invoiceDate: invoicePayload.invoiceDate,
      sentDate: invoicePayload.sentDate,
      pageCount: invoicePayload.pageCount,
      perPageAmount: invoicePayload.perPageAmount,
      clericalTimeHours: invoicePayload.clericalTimeHours,
      clericalHourlyRate: invoicePayload.clericalHourlyRate,
      shippingHandling: invoicePayload.shippingHandling,
      storageFee: invoicePayload.storageFee,
      totalAmount: invoicePayload.totalAmount,
      amountPaid: invoicePayload.amountPaid,
      amountDue: invoicePayload.amountDue,
      notes: invoicePayload.notes,
      sendOrderDetails: invoicePayload.sendOrderDetails,
      isRushOrder: invoicePayload.isRushOrder,
      recipientEmails,
      createdBy: userId || null,
    });

    await connection.execute(
      `UPDATE orders
       SET invoice_date = :invoiceDate, updated_at = NOW()
       WHERE id = :orderId`,
      { invoiceDate: invoicePayload.invoiceDate, orderId }
    );

    await connection.commit();

    if (pendingFacilityFee && pendingFacilityFee.amount > 0) {
      try {
        await markResolvedFacilitySearchFeeBilled(pendingFacilityFee);
      } catch (_billError) {
        // Non-blocking; fee can be reconciled manually if this fails.
      }
    }

    try {
      const personalPortalService = require("./personalPortalService");
      await personalPortalService.syncPortalStatusForDmsOrder(orderId);
    } catch (_syncError) {
      // Non-blocking
    }

    return getInvoiceById(invoiceId);
  } catch (error) {
    await connection.rollback();
    rethrowServiceError(error);
  } finally {
    connection.release();
  }
}

async function updateInvoice(id, body) {
  const existing = await Invoice.findById(id);

  if (!existing) {
    throw new ApiError(404, "Invoice not found");
  }

  if (!trimOrNull(body.invoiceDate)) {
    throw new ApiError(400, "Invoice date is required");
  }

  const order = await Order.findById(existing.order_id);

  if (order && Number(order.certificate_no_records)) {
    // CNR invoices cannot change fee lines — notes + prepayment collection only.
    body = {
      ...body,
      pages: existing.page_count,
      perPageAmount: existing.per_page_amount,
      clericalTimeHours: existing.clerical_time_hours,
      clericalHourlyRate: existing.clerical_hourly_rate,
      shippingHandling: existing.shipping_handling,
      storageFee: getStorageFee(existing),
    };
  }

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    await syncInvoicePrepayment(connection, existing.order_id, body.prepaymentAmount);

    const orderPayments = await Order.findPaymentsByOrderId(existing.order_id, connection);

    // Company / personal portal: fold in the $5 facility-search fee if newly
    // added and not yet billed on this order's invoice.
    let invoiceBody = body;
    let pendingFacilityFee = null;
    try {
      pendingFacilityFee = await resolvePendingFacilitySearchFee(
        existing.order_id
      );
    } catch (_feeError) {
      pendingFacilityFee = null;
    }
    if (pendingFacilityFee && pendingFacilityFee.amount > 0) {
      invoiceBody = {
        ...body,
        storageFee: toNumber(body.storageFee) + pendingFacilityFee.amount,
        notes: appendFacilitySearchFeeNote(body.notes, pendingFacilityFee.amount),
      };
    }

    const invoicePayload = buildInvoicePayload(invoiceBody, existing, {
      orderPayments,
      personalPortalOrder: isPersonalPortalOrder(order),
    });
    const recipientEmails = order
      ? await resolveInvoiceRecipientFromOrder(order, connection)
      : trimOrNull(existing.recipient_emails);

    await Invoice.update(connection, id, {
      status: invoicePayload.status,
      invoiceDate: invoicePayload.invoiceDate,
      sentDate: invoicePayload.sentDate,
      pageCount: invoicePayload.pageCount,
      perPageAmount: invoicePayload.perPageAmount,
      clericalTimeHours: invoicePayload.clericalTimeHours,
      clericalHourlyRate: invoicePayload.clericalHourlyRate,
      shippingHandling: invoicePayload.shippingHandling,
      storageFee: invoicePayload.storageFee,
      totalAmount: invoicePayload.totalAmount,
      amountPaid: invoicePayload.amountPaid,
      amountDue: invoicePayload.amountDue,
      notes: invoicePayload.notes,
      sendOrderDetails: invoicePayload.sendOrderDetails,
      isRushOrder: invoicePayload.isRushOrder,
      recipientEmails,
    });

    await connection.execute(
      `UPDATE orders
       SET invoice_date = :invoiceDate, updated_at = NOW()
       WHERE id = :orderId`,
      { invoiceDate: invoicePayload.invoiceDate, orderId: existing.order_id }
    );

    await connection.commit();

    if (pendingFacilityFee && pendingFacilityFee.amount > 0) {
      try {
        await markResolvedFacilitySearchFeeBilled(pendingFacilityFee);
      } catch (_billError) {
        // Non-blocking; fee can be reconciled manually if this fails.
      }
    }

    try {
      const personalPortalService = require("./personalPortalService");
      await personalPortalService.syncPortalStatusForDmsOrder(existing.order_id);
    } catch (_syncError) {
      // Non-blocking
    }

    return getInvoiceById(id);
  } catch (error) {
    await connection.rollback();
    rethrowServiceError(error);
  } finally {
    connection.release();
  }
}

function ensureCompanyEntry(companiesMap, row) {
  const companyId = getInvoiceCompanyId(row);

  if (!companiesMap.has(companyId)) {
    companiesMap.set(companyId, {
      id: companyId,
      company: getInvoiceCompanyName(row),
      email: getInvoiceDisplayEmail(row),
      cases: 0,
      needsResend: 0,
      invoiced: 0,
      paid: 0,
      due: 0,
    });
  }

  return companiesMap.get(companyId);
}

function accumulateCompanyFinancials(
  companiesMap,
  row,
  financials,
  { needsResend = false } = {}
) {
  const company = ensureCompanyEntry(companiesMap, row);
  company.cases += 1;

  if (needsResend) {
    company.needsResend += 1;
  }

  company.invoiced += financials.totalAmount;
  company.paid += financials.amountPaid;
  company.due += financials.amountDue;
}

function isStandardNeedsResend(row) {
  if (row.status === "Paid" || toNumber(row.amount_due) <= 0) {
    return false;
  }

  return row.status === "Needs Resend" || Boolean(row.sent_date);
}

function isXrayNeedsResend(row) {
  if (row?.status === "Written Off") {
    return false;
  }

  const financials = resolveXrayRowFinancials(row, []);
  if (financials.amountDue <= 0) {
    return false;
  }

  return Boolean(row.sent_date);
}

function processCompanyStandardRows(
  companiesMap,
  rows,
  paymentsByOrderId,
  { needsResend = false } = {}
) {
  rows.forEach((row) => {
    const financials = resolveRowFinancials(
      row,
      paymentsByOrderId[row.order_id] || []
    );

    accumulateCompanyFinancials(companiesMap, row, financials, {
      needsResend: needsResend || isStandardNeedsResend(row),
    });
  });
}

function processCompanyXrayRows(
  companiesMap,
  rows,
  paymentsByOrderId,
  { needsResend = false } = {}
) {
  rows.forEach((row) => {
    const financials = resolveXrayRowFinancials(
      row,
      paymentsByOrderId[row.order_id] || []
    );

    accumulateCompanyFinancials(companiesMap, row, financials, {
      needsResend: needsResend || isXrayNeedsResend(row),
    });
  });
}

function sumStandardFinancials(rows, paymentsByOrderId) {
  let invoiced = 0;
  let paid = 0;
  let due = 0;

  rows.forEach((row) => {
    const financials = resolveRowFinancials(
      row,
      paymentsByOrderId[row.order_id] || []
    );
    invoiced += financials.totalAmount;
    paid += financials.amountPaid;
    due += financials.amountDue;
  });

  return { invoiced, paid, due };
}

function sumXrayFinancials(rows, paymentsByOrderId) {
  let invoiced = 0;
  let paid = 0;
  let due = 0;

  rows.forEach((row) => {
    const financials = resolveXrayRowFinancials(
      row,
      paymentsByOrderId[row.order_id] || []
    );
    invoiced += financials.totalAmount;
    paid += financials.amountPaid;
    due += financials.amountDue;
  });

  return { invoiced, paid, due };
}

async function getCompanyWise() {
  const [
    standardOutstanding,
    standardResend,
    xrayOutstanding,
    xrayResend,
    financialTotalsByProvider,
  ] = await Promise.all([
    Invoice.findOutstanding({}),
    Invoice.findResend({}),
    InvoiceXray.findOutstanding({}),
    InvoiceXray.findResend({}),
    CompanyInvoice.getFinancialTotalsGroupedByProvider(),
  ]);

  const standardRows = [...standardOutstanding, ...standardResend];
  const xrayRows = [...xrayOutstanding, ...xrayResend];
  const orderIds = [
    ...new Set([
      ...standardRows.map((row) => row.order_id),
      ...xrayRows.map((row) => row.order_id),
    ]),
  ];
  const paymentRows = await Order.findPaymentsByOrderIds(orderIds);
  const paymentsByOrderId = groupPaymentsByOrderId(paymentRows);
  const companiesMap = new Map();

  processCompanyStandardRows(
    companiesMap,
    standardOutstanding,
    paymentsByOrderId
  );
  processCompanyStandardRows(companiesMap, standardResend, paymentsByOrderId, {
    needsResend: true,
  });
  processCompanyXrayRows(companiesMap, xrayOutstanding, paymentsByOrderId);
  processCompanyXrayRows(companiesMap, xrayResend, paymentsByOrderId, {
    needsResend: true,
  });

  const resolveFinancialTotals = (companyId) => {
    const key = CompanyInvoice.normalizeProviderKey(companyId);
    return (
      financialTotalsByProvider.get(key) || {
        totalCases: 0,
        totalInvoiced: 0,
        totalPaid: 0,
        totalDue: 0,
      }
    );
  };

  const companies = Array.from(companiesMap.values())
    .map((company) => {
      const financialTotals = resolveFinancialTotals(company.id);

      return {
        ...company,
        cases: financialTotals.totalCases,
        invoiced: formatMoney(financialTotals.totalInvoiced),
        paid: formatMoney(financialTotals.totalPaid),
        due: formatMoney(financialTotals.totalDue),
        _financialTotals: financialTotals,
      };
    })
    .sort((a, b) => a.company.localeCompare(b.company));

  const overallFinancials = companies.reduce(
    (totals, company) => ({
      totalCases: totals.totalCases + Number(company._financialTotals.totalCases || 0),
      totalInvoiced:
        totals.totalInvoiced + Number(company._financialTotals.totalInvoiced || 0),
      totalPaid: totals.totalPaid + Number(company._financialTotals.totalPaid || 0),
      totalDue: totals.totalDue + Number(company._financialTotals.totalDue || 0),
    }),
    { totalCases: 0, totalInvoiced: 0, totalPaid: 0, totalDue: 0 }
  );

  const publicCompanies = companies.map(({ _financialTotals, ...company }) => company);

  const summary = {
    companies: publicCompanies.length,
    totalCases: overallFinancials.totalCases,
    needsResend: publicCompanies.reduce((sum, company) => sum + company.needsResend, 0),
    invoiced: formatMoney(overallFinancials.totalInvoiced),
    paid: formatMoney(overallFinancials.totalPaid),
    due: formatMoney(overallFinancials.totalDue),
  };

  return { companies: publicCompanies, summary };
}

function mapCompanyInvoiceRow(row, orderPayments = []) {
  const isSent = Boolean(row.sent_date);
  const displayDate = isSent ? row.sent_date : row.invoice_date;
  const isWrittenOff = row.status === "Written Off";
  const financials = resolveRowFinancials(row, orderPayments);
  const isPaid =
    !isWrittenOff &&
    (row.status === "Paid" ||
      (financials.amountDue <= 0 && financials.totalAmount > 0));

  return {
    id: row.id,
    invoiceId: row.order_number,
    orderId: row.order_id,
    invoiceDbId: row.id,
    invoiceType: "invoice",
    invoiceDate: toShortDate(row.invoice_date),
    days: daysSince(displayDate),
    status: row.status || "Unpaid",
    needsResend: isStandardNeedsResend(row),
    isWrittenOff,
    isPaid,
    isSent,
    invoiced: formatMoney(financials.totalAmount),
    paid: formatMoney(financials.amountPaid),
    due: formatMoney(financials.amountDue),
  };
}

function mapCompanyXrayInvoiceRow(row, orderPayments = []) {
  const isSent = Boolean(row.sent_date);
  const displayDate = isSent ? row.sent_date : row.xray_invoice_date;
  const financials = resolveXrayRowFinancials(row, orderPayments);
  const orderId = row.order_id;
  const status = deriveXrayInvoiceStatus(row, financials, { isSent });
  const isWrittenOff = status === "Written Off";
  const isPaid =
    !isWrittenOff &&
    (status === "Paid" ||
      (financials.amountDue <= 0 && financials.totalAmount > 0));

  return {
    id: `xray-${orderId}`,
    invoiceId: row.order_number,
    orderId,
    invoiceDbId: orderId,
    invoiceType: "xray",
    invoiceDate: toShortDate(row.xray_invoice_date),
    days: daysSince(displayDate),
    status,
    needsResend: isXrayNeedsResend(row),
    isWrittenOff,
    isPaid,
    isSent,
    invoiced: formatMoney(financials.totalAmount),
    paid: formatMoney(financials.amountPaid),
    due: formatMoney(financials.amountDue),
    writeoffAmount:
      financials.writeoffAmount > 0
        ? formatMoney(financials.writeoffAmount)
        : null,
  };
}

function buildCompanyInvoiceList(standardRows = [], xrayRows = [], paymentsByOrderId = {}) {
  const mergedRows = [
    ...standardRows.map((row) => ({
      sortDate: row.invoice_date,
      invoice: mapCompanyInvoiceRow(
        row,
        paymentsByOrderId[row.order_id] || []
      ),
    })),
    ...xrayRows.map((row) => ({
      sortDate: row.xray_invoice_date,
      invoice: mapCompanyXrayInvoiceRow(
        row,
        paymentsByOrderId[row.order_id] || []
      ),
    })),
  ];

  return mergedRows
    .sort((left, right) => String(right.sortDate).localeCompare(String(left.sortDate)))
    .map((entry) => entry.invoice);
}

function buildCompanyResponse(companyId, referenceRow, invoices, summary, pagination = null) {
  const response = {
    company: {
      id: companyId,
      name: referenceRow ? getInvoiceCompanyName(referenceRow) : "Company",
      email:
        (referenceRow && getInvoiceDisplayEmail(referenceRow)) ||
        (referenceRow && getXrayRecipientEmail(referenceRow)) ||
        "",
    },
    invoices,
    summary: {
      totalCases: summary.totalCases,
      needsResend: summary.needsResend,
      totalInvoiced: formatMoney(summary.totalInvoiced),
      totalPaid: formatMoney(summary.totalPaid),
      totalDue: formatMoney(summary.totalDue),
    },
  };

  if (pagination) {
    response.pagination = pagination;
  }

  return response;
}

async function hydrateCompanyInvoicePage(pageRows = []) {
  if (!pageRows.length) {
    return [];
  }

  const standardIds = pageRows
    .filter((row) => row.source_type === "standard")
    .map((row) => Number(row.source_id))
    .filter((id) => Number.isFinite(id) && id > 0);
  const xrayOrderIds = pageRows
    .filter((row) => row.source_type === "xray")
    .map((row) => Number(row.source_id))
    .filter((id) => Number.isFinite(id) && id > 0);

  const [standardRows, xrayRows] = await Promise.all([
    Invoice.findDetailsByIds(standardIds),
    InvoiceXray.findByOrderIdsWithDetails(xrayOrderIds),
  ]);

  const standardById = new Map(standardRows.map((row) => [Number(row.id), row]));
  const xrayByOrderId = new Map(
    xrayRows.map((row) => [Number(row.order_id), row])
  );
  const orderIds = [
    ...new Set([
      ...standardRows.map((row) => row.order_id),
      ...xrayRows.map((row) => row.order_id),
    ]),
  ];
  const paymentRows = await Order.findPaymentsByOrderIds(orderIds);
  const paymentsByOrderId = groupPaymentsByOrderId(paymentRows);

  return pageRows.map((pageRow) => {
    if (pageRow.source_type === "xray") {
      const row = xrayByOrderId.get(Number(pageRow.source_id));
      return row
        ? mapCompanyXrayInvoiceRow(row, paymentsByOrderId[row.order_id] || [])
        : null;
    }

    const row = standardById.get(Number(pageRow.source_id));
    return row
      ? mapCompanyInvoiceRow(row, paymentsByOrderId[row.order_id] || [])
      : null;
  }).filter(Boolean);
}

async function getByCompanyKeyset(companyId, query = {}) {
  const dateFilters = parseCompanyInvoiceQuery(query);
  const { pageSize, cursor } = dateFilters;

  const [keysetResult, summary, referenceRow] = await Promise.all([
    CompanyInvoice.findByProviderKeyset(companyId, {
      dateFrom: dateFilters.dateFrom,
      dateTo: dateFilters.dateTo,
      search: dateFilters.search,
      pageSize,
      cursor,
    }),
    CompanyInvoice.getSummaryByProvider(companyId, dateFilters),
    CompanyInvoice.findCompanyReference(companyId),
  ]);

  const invoices = await hydrateCompanyInvoicePage(keysetResult.rows);

  if (cursor && !invoices.length) {
    keysetResult.hasMore = false;
    keysetResult.nextCursor = null;
  }

  return buildCompanyResponse(
    companyId,
    referenceRow,
    invoices,
    summary,
    {
      type: "keyset",
      pageSize: keysetResult.pageSize,
      hasMore: keysetResult.hasMore,
      nextCursor: keysetResult.nextCursor,
    }
  );
}

async function getByCompany(providerId, query = {}) {
  const companyId = parseCompanyIdParam(providerId);

  if (String(query.pagination || "").toLowerCase() === "keyset") {
    return getByCompanyKeyset(companyId, query);
  }

  const dateFilters = parseInvoiceListFilters(query);

  const [summary, referenceRow, listRows] = await Promise.all([
    CompanyInvoice.getSummaryByProvider(companyId, dateFilters),
    CompanyInvoice.findCompanyReference(companyId),
    CompanyInvoice.findAllByProviderList(companyId, dateFilters),
  ]);

  if (!listRows.length) {
    return buildCompanyResponse(companyId, referenceRow, [], summary);
  }

  const invoices = await hydrateCompanyInvoicePage(listRows);

  return buildCompanyResponse(
    companyId,
    referenceRow,
    invoices,
    summary
  );
}

async function deliverInvoiceEmail(
  invoice,
  {
    isResend = false,
    reminderLevel = null,
    orderPayments = [],
    recipientEmails = null,
    sentDate = null,
    timezone = null,
  } = {}
) {
  if (!invoice) {
    throw new ApiError(404, "Invoice not found");
  }

  const recipients = recipientEmails
    ? assertValidRecipientEmails(recipientEmails)
    : normalizeRecipientEmails(await resolveInvoiceRecipientEmail(invoice));

  if (!recipients.length) {
    throw new ApiError(400, NO_PROVIDER_EMAIL_MESSAGE);
  }

  const payments =
    orderPayments.length > 0
      ? orderPayments
      : await Order.findPaymentsByOrderId(invoice.order_id);
  const financials = resolveRowFinancials(invoice, payments);
  const order = await Order.findById(invoice.order_id);
  const invoiceRow = order
    ? await Invoice.findByOrderId(invoice.order_id)
    : null;
  const attachments = [];
  const emailSentDate =
    sentDate ||
    (isResend
      ? invoice.sent_date || resolveSentAtUtc()
      : resolveSentAtUtc());

  if (order && invoiceRow) {
    const payload = buildPrintInvoicePdfData(invoiceRow, order, payments);

    if (payload) {
      const { generatePrintInvoicePdf } = require("../utils/printInvoicePdf");
      const pdfBuffer = await generatePrintInvoicePdf(payload);
      const safeOrderNumber = `${order.order_number || order.id}`.replace(
        /[^\w.-]+/g,
        "_"
      );

      attachments.push({
        filename: `invoice-${safeOrderNumber}.pdf`,
        content: pdfBuffer,
        contentType: "application/pdf",
      });
    }
  }

  const { sendInvoiceEmail } = require("./emailService");
  const deliveredTo = [];

  const reminderNumber = Number(reminderLevel) || 0;
  const isReminder = reminderNumber > 0;

  const { getPaymentUrlForOrder } = require("./stripePaymentService");
  const paymentUrl = await getPaymentUrlForOrder(invoice.order_id);

  for (const email of recipients) {
    const result = await sendInvoiceEmail({
      to: email,
      companyName: isPersonalPortalOrder(invoice)
        ? buildApplicantName(invoice) || "Valued Customer"
        : invoice.provider_name || invoice.facility_name || "Company",
      caseNo: invoice.order_number || "",
      applicant: buildApplicantName(invoice),
      invoiceDate: toShortDate(invoice.invoice_date),
      sentDate: toShortDate(emailSentDate),
      invoiced: formatMoney(financials.totalAmount),
      paid: formatMoney(financials.amountPaid),
      due: formatMoney(financials.amountDue),
      isResend: isResend || isReminder,
      reminderLevel: isReminder ? reminderNumber : null,
      sendOrderDetails: Boolean(invoice.send_order_details),
      isRushOrder: Boolean(invoice.is_rush_order),
      rushLevel: calculateOrderRushLevel(invoice.order_created_at).label,
      orderDetailsText: Boolean(invoice.send_order_details)
        ? buildOrderDetailsText(invoice, payments)
        : "",
      attachments,
      paymentUrl,
      subjectOverride: isReminder
        ? `Reminder ${reminderNumber} - Invoice - Case ${invoice.order_number || ""}`
        : null,
    });

    if (!result.delivered) {
      throw new ApiError(
        500,
        config.nodeEnv === "development" && result.devLogged
          ? "SMTP is not configured. Set SMTP_USER / SMTP_PASS in backend .env."
          : "Failed to deliver invoice email."
      );
    }

    deliveredTo.push(email);
  }

  return {
    recipient: deliveredTo.join(", "),
    recipients: deliveredTo,
    delivered: deliveredTo.length > 0,
    devLogged: false,
  };
}

async function deliverXrayInvoiceEmail(
  xrayRow,
  order,
  orderPayments = [],
  {
    isResend = false,
    reminderLevel = null,
    recipientEmails = null,
    sentDate = null,
    timezone = null,
  } = {}
) {
  if (!xrayRow || !order) {
    throw new ApiError(404, "X-Ray invoice not found");
  }

  const invoice = await Invoice.findByOrderId(order.id);
  const recipients = recipientEmails
    ? assertValidRecipientEmails(recipientEmails)
    : normalizeRecipientEmails(
        invoice
          ? await resolveInvoiceRecipientEmail(invoice)
          : await resolveInvoiceRecipientFromOrder(order)
      );

  if (!recipients.length) {
    throw new ApiError(400, NO_PROVIDER_EMAIL_MESSAGE);
  }

  const payments =
    orderPayments.length > 0
      ? orderPayments
      : await Order.findPaymentsByOrderId(order.id);
  const payload = buildPrintXrayInvoicePdfData(xrayRow, order, payments);
  const attachments = [];
  const emailSentDate =
    sentDate ||
    (isResend
      ? xrayRow.sent_date || resolveSentAtUtc()
      : resolveSentAtUtc());

  if (payload) {
    const { generatePrintXrayInvoicePdf } = require("../utils/printXrayInvoicePdf");
    const pdfBuffer = await generatePrintXrayInvoicePdf(payload);
    const safeOrderNumber = `${order.order_number || order.id}`.replace(
      /[^\w.-]+/g,
      "_"
    );

    attachments.push({
      filename: `xray-invoice-${safeOrderNumber}.pdf`,
      content: pdfBuffer,
      contentType: "application/pdf",
    });
  }

  const financials = resolveXrayRowFinancials(xrayRow, payments);
  const { sendInvoiceEmail } = require("./emailService");
  const deliveredTo = [];

  const reminderNumber = Number(reminderLevel) || 0;
  const isReminder = reminderNumber > 0;

  const { getPaymentUrlForOrder } = require("./stripePaymentService");
  const paymentUrl = await getPaymentUrlForOrder(order.id);

  for (const email of recipients) {
    const result = await sendInvoiceEmail({
      to: email,
      companyName: isPersonalPortalOrder(order)
        ? buildApplicantName(order) || "Valued Customer"
        : order.provider_name || order.serve_company_name || "Company",
      caseNo: order.order_number || "",
      applicant: buildApplicantName(order),
      invoiceDate: toShortDate(xrayRow.xray_invoice_date),
      sentDate: toShortDate(emailSentDate),
      invoiced: formatMoney(financials.totalAmount),
      paid: formatMoney(financials.amountPaid),
      due: formatMoney(financials.amountDue),
      isResend: isResend || isReminder,
      reminderLevel: isReminder ? reminderNumber : null,
      paymentUrl,
      subjectOverride: isReminder
        ? `Reminder ${reminderNumber} - X-Ray Invoice - Case ${order.order_number || ""}`
        : isResend
          ? `Resent X-Ray Invoice - Case ${order.order_number || ""}`
          : `X-Ray Invoice - Case ${order.order_number || ""}`,
      attachments,
    });

    if (!result.delivered) {
      throw new ApiError(
        500,
        config.nodeEnv === "development" && result.devLogged
          ? "SMTP is not configured. Set SMTP_USER / SMTP_PASS in backend .env."
          : "Failed to deliver X-Ray invoice email."
      );
    }

    deliveredTo.push(email);
  }

  return {
    recipient: deliveredTo.join(", "),
    recipients: deliveredTo,
    delivered: deliveredTo.length > 0,
    devLogged: false,
  };
}

async function sendInvoices(invoiceIds = [], options = {}) {
  const ids = [
    ...new Set(
      (Array.isArray(invoiceIds) ? invoiceIds : [])
        .map((id) => normalizeInvoiceId(id))
        .filter(Boolean)
    ),
  ];

  if (!ids.length) {
    throw new ApiError(400, "At least one invoice id is required");
  }

  const customEmails = options.emails
    ? assertValidRecipientEmails(options.emails)
    : null;
  const sentDate = resolveSentAtUtc();

  const existing = await Invoice.findByIds(ids);
  const unsentIds = existing
    .filter((row) => !row.sent_date)
    .map((row) => normalizeInvoiceId(row.id))
    .filter(Boolean);

  if (!unsentIds.length) {
    throw new ApiError(400, "Selected invoices are already sent");
  }

  const sent = [];

  for (const invoiceId of unsentIds) {
    const invoice = await Invoice.findById(invoiceId);

    if (!invoice) {
      throw new ApiError(404, `Invoice ${invoiceId} not found`);
    }

    if (invoice.sent_date) {
      continue;
    }

    const recipientEmails =
      customEmails || normalizeRecipientEmails(await resolveInvoiceRecipientEmail(invoice));

    if (!recipientEmails.length) {
      throw new ApiError(400, NO_PROVIDER_EMAIL_MESSAGE);
    }

    const orderPayments = await Order.findPaymentsByOrderId(invoice.order_id);
    const { recipient: deliveredTo } = await deliverInvoiceEmail(invoice, {
      isResend: false,
      orderPayments,
      recipientEmails,
      sentDate,
      timezone: options.timezone,
    });

    const markedCount = await Invoice.markAsSent([invoiceId], sentDate);

    if (!markedCount) {
      continue;
    }

    await getPool().execute(
      `UPDATE invoices
       SET recipient_emails = :recipientEmails,
           updated_at = NOW()
       WHERE id = :invoiceId`,
      { recipientEmails: deliveredTo, invoiceId }
    );

    if (invoice.order_id) {
      await Order.upsertWorkflowStage(
        invoice.order_id,
        "SENT",
        "sent",
        new Date()
      );

      try {
        const {
          maybeAdvanceCompanyPortalAfterInvoiceSent,
        } = require("./companyPortalStageHooks");
        await maybeAdvanceCompanyPortalAfterInvoiceSent(invoice.order_id);
      } catch (error) {
        // Company-portal stage advances must not block invoice send.
        console.warn(
          "[company-portal] Invoice-sent stage advance skipped:",
          error.message || error
        );
      }

      try {
        const personalPortalService = require("./personalPortalService");
        await personalPortalService.notifyPersonalUserAfterInvoiceSent(
          invoice.order_id
        );
      } catch (error) {
        console.warn(
          "[personal-portal] Invoice-sent notify skipped:",
          error.message || error
        );
      }
    }

    sent.push({ invoiceId, recipient: deliveredTo });
  }

  if (!sent.length) {
    throw new ApiError(400, "Selected invoices are already sent");
  }

  return { sentCount: sent.length, sent };
}

function canDeliverInvoiceEmail(invoice) {
  if (!invoice) return false;

  if (invoice.status === "Needs Resend") {
    return true;
  }

  return Boolean(invoice.sent_date);
}

async function resendInvoices(invoiceIds = [], options = {}) {
  const ids = [
    ...new Set(
      (Array.isArray(invoiceIds) ? invoiceIds : [])
        .map((id) => normalizeInvoiceId(id))
        .filter(Boolean)
    ),
  ];

  if (!ids.length) {
    throw new ApiError(400, "At least one invoice id is required");
  }

  const customEmails = options.emails
    ? assertValidRecipientEmails(options.emails)
    : null;
  const sentDate = resolveSentAtUtc();

  const resent = [];

  for (const invoiceId of ids) {
    const invoice = await Invoice.findById(invoiceId);

    if (!invoice) {
      throw new ApiError(404, `Invoice ${invoiceId} not found`);
    }

    if (!canDeliverInvoiceEmail(invoice)) {
      throw new ApiError(
        400,
        "Only sent invoices awaiting email or marked for resend can be emailed"
      );
    }

    const recipientEmails =
      customEmails || normalizeRecipientEmails(await resolveInvoiceRecipientEmail(invoice));

    if (!recipientEmails.length) {
      throw new ApiError(400, NO_PROVIDER_EMAIL_MESSAGE);
    }

    const { recipient: deliveredTo } = await deliverInvoiceEmail(invoice, {
      isResend: true,
      recipientEmails,
      sentDate,
      timezone: options.timezone,
    });

    await getPool().execute(
      `UPDATE invoices
       SET recipient_emails = :recipientEmails,
           sent_date = :sentDate,
           status = CASE
             WHEN status IN ('Paid', 'Partial', 'Unpaid', 'Written Off') THEN status
             ELSE 'Needs Resend'
           END,
           updated_at = NOW()
       WHERE id = :invoiceId`,
      { recipientEmails: deliveredTo, invoiceId, sentDate }
    );

    if (invoice.order_id) {
      await Order.upsertWorkflowStage(invoice.order_id, "SENT", "sent", new Date());
    }

    resent.push({ invoiceId, recipient: deliveredTo });
  }

  return { resentCount: resent.length };
}

async function emailInvoiceByOrderId(orderId, options = {}) {
  const normalizedOrderId = Number(orderId);

  if (!Number.isFinite(normalizedOrderId)) {
    throw new ApiError(400, "Invalid order id");
  }

  const invoice = await Invoice.findByOrderId(normalizedOrderId);

  if (!invoice) {
    throw new ApiError(404, "No invoice found for this order");
  }

  if (invoice.sent_date) {
    throw new ApiError(400, "Invoice is already marked as sent");
  }

  const recipientEmail = await resolveInvoiceRecipientEmail(invoice);

  if (!recipientEmail) {
    throw new ApiError(400, NO_PROVIDER_EMAIL_MESSAGE);
  }

  const sentDate = resolveSentAtUtc();
  const orderPayments = await Order.findPaymentsByOrderId(normalizedOrderId);
  const { recipient, delivered, devLogged } = await deliverInvoiceEmail(invoice, {
    isResend: false,
    orderPayments,
    sentDate,
    timezone: options.timezone,
  });

  const invoiceId = normalizeInvoiceId(invoice.id);
  const sentCount = await Invoice.markAsSent([invoiceId], sentDate);

  if (!sentCount) {
    throw new ApiError(400, "Invoice is already marked as sent");
  }

  await getPool().execute(
    `UPDATE invoices
     SET recipient_emails = :recipientEmails,
         updated_at = NOW()
     WHERE id = :invoiceId`,
    { recipientEmails: recipientEmail, invoiceId }
  );

  await Order.upsertWorkflowStage(normalizedOrderId, "SENT", "sent", new Date());

  try {
    const personalPortalService = require("./personalPortalService");
    await personalPortalService.notifyPersonalUserAfterInvoiceSent(
      normalizedOrderId
    );
  } catch (error) {
    console.warn(
      "[personal-portal] Invoice-sent notify skipped:",
      error.message || error
    );
  }

  return {
    invoiceId,
    orderId: normalizedOrderId,
    isResend: false,
    recipient,
    recipientEmail: recipient,
    emailed: delivered,
    devLogged: Boolean(devLogged),
    sentDate: formatSentInstant(sentDate, options.timezone),
    sentDateCompact: formatSentInstantCompact(sentDate, options.timezone),
  };
}

async function sendXrayInvoices(orderIds = [], options = {}) {
  const ids = [
    ...new Set(
      (Array.isArray(orderIds) ? orderIds : [])
        .map((id) => normalizeOrderId(id))
        .filter(Boolean)
    ),
  ];

  if (!ids.length) {
    throw new ApiError(400, "At least one order id is required");
  }

  const customEmails = options.emails
    ? assertValidRecipientEmails(options.emails)
    : null;
  const sentDate = resolveSentAtUtc();

  const sent = [];

  for (const orderId of ids) {
    const order = await Order.findById(orderId);

    if (!order) {
      throw new ApiError(404, `Order ${orderId} not found`);
    }

    const xrayRow = await InvoiceXray.findByOrderId(orderId);

    if (!xrayRow) {
      throw new ApiError(404, `No X-Ray invoice found for order ${orderId}`);
    }

    if (xrayRow.sent_date) {
      continue;
    }

    const orderPayments = await Order.findPaymentsByOrderId(orderId);
    const recipientEmails =
      customEmails ||
      normalizeRecipientEmails(
        await resolveInvoiceRecipientFromOrder(order)
      );

    if (!recipientEmails.length) {
      throw new ApiError(400, NO_PROVIDER_EMAIL_MESSAGE);
    }

    const { recipient: deliveredTo } = await deliverXrayInvoiceEmail(
      xrayRow,
      order,
      orderPayments,
      { isResend: false, recipientEmails, sentDate, timezone: options.timezone }
    );

    const markedCount = await InvoiceXray.markAsSent(orderId, sentDate);

    if (!markedCount) {
      continue;
    }

    await getPool().execute(
      `UPDATE invoice_xray_details
       SET recipient_emails = :recipientEmails,
           updated_at = NOW()
       WHERE order_id = :orderId`,
      { recipientEmails: deliveredTo, orderId }
    );

    await Order.upsertWorkflowStage(orderId, "SENT", "sent", new Date());

    try {
      const {
        maybeAdvanceCompanyPortalAfterInvoiceSent,
      } = require("./companyPortalStageHooks");
      await maybeAdvanceCompanyPortalAfterInvoiceSent(orderId);
    } catch (error) {
      console.warn(
        "[company-portal] X-Ray invoice-sent stage advance skipped:",
        error.message || error
      );
    }

    sent.push({ orderId, recipient: deliveredTo });
  }

  if (!sent.length) {
    throw new ApiError(400, "Selected X-Ray invoices are already sent");
  }

  return { sentCount: sent.length, sent };
}

async function resendXrayInvoices(orderIds = [], options = {}) {
  const ids = [
    ...new Set(
      (Array.isArray(orderIds) ? orderIds : [])
        .map((id) => normalizeOrderId(id))
        .filter(Boolean)
    ),
  ];

  if (!ids.length) {
    throw new ApiError(400, "At least one order id is required");
  }

  const customEmails = options.emails
    ? assertValidRecipientEmails(options.emails)
    : null;
  const sentDate = resolveSentAtUtc();

  const resent = [];

  for (const orderId of ids) {
    const order = await Order.findById(orderId);

    if (!order) {
      throw new ApiError(404, `Order ${orderId} not found`);
    }

    const xrayRow = await InvoiceXray.findByOrderId(orderId);

    if (!xrayRow) {
      throw new ApiError(404, `No X-Ray invoice found for order ${orderId}`);
    }

    if (!xrayRow.sent_date) {
      throw new ApiError(
        400,
        "Only sent X-Ray invoices can be resent from the resend tab"
      );
    }

    const orderPayments = await Order.findPaymentsByOrderId(orderId);
    const recipientEmails =
      customEmails ||
      normalizeRecipientEmails(
        await resolveInvoiceRecipientFromOrder(order)
      );

    if (!recipientEmails.length) {
      throw new ApiError(400, NO_PROVIDER_EMAIL_MESSAGE);
    }

    const { recipient: deliveredTo } = await deliverXrayInvoiceEmail(
      xrayRow,
      order,
      orderPayments,
      { isResend: true, recipientEmails, sentDate, timezone: options.timezone }
    );

    await getPool().execute(
      `UPDATE invoice_xray_details
       SET sent_date = :sentDate,
           recipient_emails = :recipientEmails,
           updated_at = NOW()
       WHERE order_id = :orderId`,
      { recipientEmails: deliveredTo, orderId, sentDate }
    );

    resent.push({ orderId, recipient: deliveredTo });
  }

  return { resentCount: resent.length, resent };
}

async function emailXrayInvoiceByOrderId(orderId, options = {}) {
  const normalizedOrderId = normalizeOrderId(orderId);

  if (!normalizedOrderId) {
    throw new ApiError(400, "Invalid order id");
  }

  const result = await sendXrayInvoices([normalizedOrderId], options);
  const sentEntry = result.sent?.[0];

  if (!sentEntry) {
    throw new ApiError(400, "X-Ray invoice is already marked as sent");
  }

  const sentDate = resolveSentAtUtc();

  return {
    orderId: normalizedOrderId,
    recipient: sentEntry.recipient,
    recipientEmail: sentEntry.recipient,
    emailed: true,
    devLogged: false,
    xraySentDate: formatSentInstant(sentDate, options.timezone),
    xraySentDateCompact: formatSentInstantCompact(sentDate, options.timezone),
  };
}

async function syncOrderWriteOffStatus(connection, orderId, orderAction = "keep_write_off") {
  const allWrittenOff = await areAllOrderInvoicesWrittenOff(orderId, connection);

  if (!allWrittenOff) {
    await connection.execute(
      `UPDATE orders
       SET is_write_offs = 0,
           status = CASE WHEN status = 'Write Offs' THEN 'Active' ELSE status END,
           updated_at = NOW()
       WHERE id = :orderId`,
      { orderId }
    );
    return null;
  }

  const newStatus =
    orderAction === "close_order" ? "Completed" : "Write Offs";

  await connection.execute(
    `UPDATE orders
     SET status = :status,
         is_write_offs = :isWriteOffs,
         updated_at = NOW()
     WHERE id = :orderId`,
    {
      status: newStatus,
      isWriteOffs: orderAction === "close_order" ? 0 : 1,
      orderId,
    }
  );

  return newStatus;
}

async function writeOffInvoices(body = {}, userId, options = {}) {
  const items = Array.isArray(body.invoices) ? body.invoices : [];

  if (!items.length) {
    throw new ApiError(400, "No invoices selected for write off");
  }

  const orderAction = body.orderAction === "close_order" ? "close_order" : "keep_write_off";
  const writeoffDate = resolveClientCalendarDate(options);
  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const writtenOff = [];

    for (const item of items) {
      const invoiceType = item.invoiceType === "xray" ? "xray" : "regular";

      if (invoiceType === "xray") {
        const orderId = normalizeOrderId(
          item.orderId || item.invoiceId || item.invoiceDbId || item.id
        );

        if (!orderId) {
          continue;
        }

        const xrayRow = await InvoiceXray.findByOrderId(orderId, connection);

        if (!xrayRow) {
          throw new ApiError(404, `X-Ray invoice for order ${orderId} not found`);
        }

        if (xrayRow.status === "Written Off") {
          throw new ApiError(400, "X-Ray invoice is already written off");
        }

        const orderPayments = await Order.findPaymentsByOrderId(orderId, connection);
        const financials = resolveXrayRowFinancials(xrayRow, orderPayments);
        const currentDue = financials.amountDue;
        const requestedWriteOff = toNumber(
          item.writeOffAmount ?? item.dueAmount ?? body.amount
        );

        if (currentDue <= 0 || body.isZeroDue) {
          if (xrayRow.status !== "Paid") {
            await InvoiceXray.writeOff(connection, orderId, {
              status: currentDue <= 0 ? "Paid" : "Written Off",
              writeoffAmount: toNumber(xrayRow.writeoff_amount),
              writeoffBy: userId || null,
              writeoffDate,
              writeoffReason:
                orderAction === "close_order"
                  ? "Order closed with no remaining due"
                  : "Order marked as write off with no remaining due",
            });
          }

          const newOrderStatus = await syncOrderWriteOffStatus(
            connection,
            orderId,
            orderAction
          );

          writtenOff.push({
            invoiceId: orderId,
            orderId,
            invoiceType: "xray",
            writeOffAmount: 0,
            amountDue: 0,
            status: newOrderStatus || xrayRow.status,
            orderStatus: newOrderStatus,
          });

          await syncOrderPaymentDuesFromInvoice(connection, orderId);
          continue;
        }

        const writeOffAmount = requestedWriteOff;

        if (writeOffAmount <= 0) {
          continue;
        }

        const appliedAmount = Math.min(writeOffAmount, currentDue);

        if (appliedAmount <= 0) {
          throw new ApiError(400, "There is no due amount available to write off");
        }

        const newDue = Math.max(0, currentDue - appliedAmount);
        const totalWriteoff = toNumber(xrayRow.writeoff_amount) + appliedAmount;
        const newStatus = newDue <= 0 ? "Written Off" : "Partial";
        const writeoffReason =
          body.writeOffType === "specified"
            ? `Specified write off of ${formatMoney(appliedAmount)}`
            : `Full write off of ${formatMoney(appliedAmount)}`;

        await InvoiceXray.writeOff(connection, orderId, {
          status: newStatus,
          writeoffAmount: totalWriteoff,
          writeoffBy: userId || null,
          writeoffDate,
          writeoffReason,
        });

        const newOrderStatus = await syncOrderWriteOffStatus(
          connection,
          orderId,
          orderAction
        );

        writtenOff.push({
          invoiceId: orderId,
          orderId,
          invoiceType: "xray",
          writeOffAmount: appliedAmount,
          amountDue: newDue,
          status: newStatus,
          orderStatus: newOrderStatus,
        });

        await syncOrderPaymentDuesFromInvoice(connection, orderId);
        continue;
      }

      const invoiceId = normalizeInvoiceId(
        item.invoiceId || item.invoiceDbId || item.id
      );

      if (!invoiceId) {
        continue;
      }

      const invoice = await Invoice.findById(invoiceId);

      if (!invoice) {
        throw new ApiError(404, `Invoice ${invoiceId} not found`);
      }

      if (invoice.status === "Written Off") {
        throw new ApiError(400, "Invoice is already written off");
      }

      const orderPayments = await Order.findPaymentsByOrderId(
        invoice.order_id,
        connection
      );
      const financials = resolveRowFinancials(invoice, orderPayments);
      const currentDue = financials.amountDue;
      const requestedWriteOff = toNumber(
        item.writeOffAmount ?? item.dueAmount ?? body.amount
      );

      if (currentDue <= 0 || body.isZeroDue) {
        if (invoice.status !== "Paid") {
          await Invoice.writeOff(connection, invoiceId, {
            status: currentDue <= 0 ? "Paid" : "Written Off",
            amountDue: 0,
            writeoffAmount: toNumber(invoice.writeoff_amount),
            writeoffBy: userId || null,
            writeoffDate,
            writeoffReason:
              orderAction === "close_order"
                ? "Order closed with no remaining due"
                : "Order marked as write off with no remaining due",
          });
        }

        const newOrderStatus = await syncOrderWriteOffStatus(
          connection,
          invoice.order_id,
          orderAction
        );

        writtenOff.push({
          invoiceId,
          orderId: invoice.order_id,
          invoiceType: "regular",
          writeOffAmount: 0,
          amountDue: 0,
          status: newOrderStatus || invoice.status,
          orderStatus: newOrderStatus,
        });

        await syncOrderPaymentDuesFromInvoice(connection, invoice.order_id);
        continue;
      }

      const writeOffAmount = requestedWriteOff;

      if (writeOffAmount <= 0) {
        continue;
      }

      const appliedAmount = Math.min(writeOffAmount, currentDue);

      if (appliedAmount <= 0) {
        throw new ApiError(400, "There is no due amount available to write off");
      }

      const newDue = Math.max(0, currentDue - appliedAmount);
      const totalWriteoff = toNumber(invoice.writeoff_amount) + appliedAmount;
      const newStatus = newDue <= 0 ? "Written Off" : "Partial";
      const writeoffReason =
        body.writeOffType === "specified"
          ? `Specified write off of ${formatMoney(appliedAmount)}`
          : `Full write off of ${formatMoney(appliedAmount)}`;

      await Invoice.writeOff(connection, invoiceId, {
        status: newStatus,
        amountDue: newDue,
        writeoffAmount: totalWriteoff,
        writeoffBy: userId || null,
        writeoffDate,
        writeoffReason,
      });

      const newOrderStatus = await syncOrderWriteOffStatus(
        connection,
        invoice.order_id,
        orderAction
      );

      writtenOff.push({
        invoiceId,
        orderId: invoice.order_id,
        invoiceType: "regular",
        writeOffAmount: appliedAmount,
        amountDue: newDue,
        status: newStatus,
        orderStatus: newOrderStatus,
      });

      await syncOrderPaymentDuesFromInvoice(connection, invoice.order_id);
    }

    if (!writtenOff.length) {
      throw new ApiError(400, "No valid invoices to write off");
    }

    await connection.commit();

    return { writtenOffCount: writtenOff.length, invoices: writtenOff };
  } catch (error) {
    await connection.rollback();
    rethrowServiceError(error);
  } finally {
    connection.release();
  }
}

function isReminderAlreadySent(row, reminderLevel) {
  if (reminderLevel === 1) return Boolean(row.reminder_1_sent_at);
  if (reminderLevel === 2) return Boolean(row.reminder_2_sent_at);
  if (reminderLevel === 3) return Boolean(row.reminder_3_sent_at);
  return true;
}

function canSendInvoiceReminder(row, orderPayments, reminderLevel) {
  if (!row?.sent_date) return false;
  if (isReminderAlreadySent(row, reminderLevel)) return false;

  if (reminderLevel === 2 && !row.reminder_1_sent_at) return false;
  if (reminderLevel === 3 && !row.reminder_2_sent_at) return false;

  if (row.status === "Paid" || row.status === "Written Off") return false;

  const financials = resolveRowFinancials(row, orderPayments);
  return financials.amountDue > 0;
}

function canSendXrayInvoiceReminder(row, orderPayments, reminderLevel) {
  if (!row?.sent_date) return false;
  if (isReminderAlreadySent(row, reminderLevel)) return false;

  if (reminderLevel === 2 && !row.reminder_1_sent_at) return false;
  if (reminderLevel === 3 && !row.reminder_2_sent_at) return false;

  if (row.status === "Written Off") return false;

  const financials = resolveXrayRowFinancials(row, orderPayments);
  return financials.amountDue > 0;
}

async function markStandardInvoiceReminderSent(invoiceId, reminderLevel) {
  const columnMap = {
    1: "reminder_1_sent_at",
    2: "reminder_2_sent_at",
    3: "reminder_3_sent_at",
  };
  const column = columnMap[reminderLevel];

  if (!column) {
    throw new ApiError(400, "Invalid reminder level");
  }

  await getPool().execute(
    `UPDATE invoices
     SET ${column} = NOW(), updated_at = NOW()
     WHERE id = :invoiceId`,
    { invoiceId }
  );
}

async function markXrayInvoiceReminderSent(orderId, reminderLevel) {
  const columnMap = {
    1: "reminder_1_sent_at",
    2: "reminder_2_sent_at",
    3: "reminder_3_sent_at",
  };
  const column = columnMap[reminderLevel];

  if (!column) {
    throw new ApiError(400, "Invalid reminder level");
  }

  await getPool().execute(
    `UPDATE invoice_xray_details
     SET ${column} = NOW(), updated_at = NOW()
     WHERE order_id = :orderId`,
    { orderId }
  );
}

async function sendAutomaticInvoiceReminder(targetId, reminderLevel, type = "standard") {
  const level = Number(reminderLevel);

  if (![1, 2, 3].includes(level)) {
    throw new ApiError(400, "Invalid reminder level");
  }

  if (type === "xray") {
    const orderId = normalizeOrderId(targetId);

    if (!orderId) {
      throw new ApiError(400, "Invalid order id");
    }

    const order = await Order.findById(orderId);
    const xrayRow = await InvoiceXray.findByOrderId(orderId);

    if (!order || !xrayRow) {
      throw new ApiError(404, "X-Ray invoice not found");
    }

    const orderPayments = await Order.findPaymentsByOrderId(orderId);

    if (!canSendXrayInvoiceReminder(xrayRow, orderPayments, level)) {
      return false;
    }

    const recipientEmails = await resolveAutomaticReminderRecipientEmails({
      order,
      xrayRow,
    });

    if (!recipientEmails.length) {
      throw new ApiError(400, NO_PROVIDER_EMAIL_MESSAGE);
    }

    await deliverXrayInvoiceEmail(xrayRow, order, orderPayments, {
      isResend: true,
      reminderLevel: level,
      recipientEmails,
    });

    await markXrayInvoiceReminderSent(orderId, level);
    return true;
  }

  const invoiceId = normalizeInvoiceId(targetId);
  const invoice = await Invoice.findById(invoiceId);

  if (!invoice) {
    throw new ApiError(404, "Invoice not found");
  }

  const orderPayments = await Order.findPaymentsByOrderId(invoice.order_id);

  if (!canSendInvoiceReminder(invoice, orderPayments, level)) {
    return false;
  }

  const order = await Order.findById(invoice.order_id);
  const recipientEmails = await resolveAutomaticReminderRecipientEmails({
    invoice,
    order,
  });

  if (!recipientEmails.length) {
    throw new ApiError(400, NO_PROVIDER_EMAIL_MESSAGE);
  }

  await deliverInvoiceEmail(invoice, {
    isResend: true,
    reminderLevel: level,
    orderPayments,
    recipientEmails,
  });

  await markStandardInvoiceReminderSent(invoiceId, level);
  return true;
}

module.exports = {
  getInvoices,
  getOutstandingInvoices,
  getResendInvoices,
  getCompanyWise,
  getByCompany,
  getInvoiceById,
  createInvoice,
  updateInvoice,
  sendInvoices,
  resendInvoices,
  sendXrayInvoices,
  resendXrayInvoices,
  getXrayOutstandingInvoices,
  getXrayResendInvoices,
  emailInvoiceByOrderId,
  emailXrayInvoiceByOrderId,
  writeOffInvoices,
  getStandardInvoicesByOrderIds,
  getXrayDetailsByOrderIds,
  getXrayInvoiceByOrderId,
  createOrUpdateXrayInvoice,
  sendAutomaticInvoiceReminder,
  mapOrderInvoiceSummary,
  mapOrderPaymentsSummary,
  mapOrderInvoiceFees,
  resolveCustodianDueAmount,
  resolveCustodianPaymentDue,
  shouldMarkCustodianStageComplete,
  DEFAULT_CUSTODIAN_CHARGE,
  syncOrderCustodianDueFromInvoice,
  syncOrderPaymentDuesFromInvoice,
  buildPrintInvoicePdfData,
  buildPrintXrayInvoicePdfData,
  syncInvoiceAmountPaidFromOrder,
  syncServeWorkflowFromPrepayment,
  resolvePendingFacilitySearchFee,
};
