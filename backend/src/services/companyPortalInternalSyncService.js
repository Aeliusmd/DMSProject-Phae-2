/**
 * Sync paid company portal orders into the internal `orders` table so staff
 * can reuse invoice / CNR / records / rush tooling without mixing them into
 * the normal Orders page (filtered by creation_source = company_portal).
 */

const ApiError = require("../utils/ApiError");
const CompanyPortalOrder = require("../models/CompanyPortalOrder");
const CompanyPortalNewFacility = require("../models/CompanyPortalNewFacility");
const Order = require("../models/Order");
const orderService = require("./orderService");
const {
  flagsFromDbRow,
  formatRecordTypesLabel,
} = require("../utils/companyPortalRecordTypes");
const { getPool } = require("../config/database");
const { sanitizeZip } = require("../utils/zipUtils");
const config = require("../config");
const { calendarTodayInTimezone } = require("../utils/timezoneUtils");

function resolveClientCalendarDate(options = {}) {
  return calendarTodayInTimezone(
    options.timezone || config.businessTimezone || "UTC"
  );
}

const COMPANY_PORTAL_STAGES = [
  "In Process",
  "Invoice",
  "Paid",
  "Released",
];

const DEFAULT_PORTAL_FEE = 15;

function splitApplicantName(fullName) {
  const parts = String(fullName || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) {
    return { firstName: "Unknown", lastName: "Applicant" };
  }
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "" };
  }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(" "),
  };
}

function toDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return null;
}

function resolvePortalFeeAmount(portalOrder) {
  const amount = Number(portalOrder?.payment_amount);
  if (Number.isFinite(amount) && amount > 0) {
    return Number(amount.toFixed(2));
  }
  return DEFAULT_PORTAL_FEE;
}

async function resolveWalletTransactionId(portalOrder) {
  if (!portalOrder?.id || portalOrder.payment_method !== "wallet") {
    return null;
  }

  const CompanyPortalWalletTransaction = require("../models/CompanyPortalWalletTransaction");
  const walletTx = await CompanyPortalWalletTransaction.findOrderPaymentByPortalOrderId(
    portalOrder.id
  );
  return walletTx?.id || null;
}

function buildPortalPrepaymentFields(portalOrder, walletTransactionId = null) {
  const paid = resolvePortalFeeAmount(portalOrder);
  const paymentMethod = String(portalOrder?.payment_method || "stripe").trim();
  const intentId = String(portalOrder?.stripe_payment_intent_id || "").trim();
  const walletRef = walletTransactionId
    ? `WALLET-TX-${walletTransactionId}`
    : "WALLET-CP";

  return {
    prepaymentPaid: paid.toFixed(2),
    prepaymentDue: "0.00",
    prepaymentDate:
      toDateOnly(portalOrder?.paid_at) ||
      toDateOnly(portalOrder?.created_at) ||
      toDateOnly(new Date()),
    prepaymentCheck:
      paymentMethod === "wallet"
        ? walletRef.slice(0, 50)
        : intentId
          ? intentId.slice(0, 50)
          : "STRIPE-CP",
    prepaymentMemo:
      paymentMethod === "wallet"
        ? "Company portal wallet prepayment"
        : "Company portal processing fee",
  };
}

const PLACEHOLDER_FACILITY_NAME = "Company Portal - Pending Facility";

/**
 * A single reserved facility used for company portal orders whose facility is
 * not yet in our internal system. We intentionally do NOT create a real
 * facility from the external company's input; internal staff create it later
 * via the "Add this facility to system" flow, which re-points the order.
 */
async function resolvePlaceholderFacilityId() {
  const facilityService = require("./facilityService");
  const { facility } = await facilityService.findOrCreateFacility({
    facilityName: PLACEHOLDER_FACILITY_NAME,
    address: "",
    city: "",
    state: "",
    zipCode: "",
  });
  return facility?.id || null;
}

async function portalOrderNeedsPlaceholderFacility(portalOrder) {
  if (!portalOrder?.id) return false;
  const newFacility = await CompanyPortalNewFacility.findByOrderId(
    portalOrder.id
  );
  // Only pending (not yet linked / not cancelled) requests are "not in system".
  return Boolean(newFacility && newFacility.status === "pending");
}

function buildInternalOrderPayload(portalOrder, options = {}) {
  const { placeholderFacilityId = null } = options;
  const flags = flagsFromDbRow(portalOrder);
  const name = splitApplicantName(portalOrder.applicant_name);
  const { normalizeOrderSsn } = require("../utils/dateUtils");
  const ssnLastFour = normalizeOrderSsn(portalOrder.ssn);

  // When the facility isn't in our system yet, point the internal order at the
  // reserved placeholder facility (by id) and clear the name so resolveFacilityId
  // does not auto-create a facility from the external company's input.
  const usePlaceholder =
    Number.isFinite(Number(placeholderFacilityId)) &&
    Number(placeholderFacilityId) > 0;

  return {
    orderNumber: portalOrder.order_number,
    firstName: name.firstName,
    middleName: "",
    lastName: name.lastName,
    dob: toDateOnly(portalOrder.date_of_birth),
    ssn: ssnLastFour || "",
    ssnLastFour,
    caseNumber: portalOrder.case_number || "",
    recNumber: portalOrder.rec_number || "",
    ...(usePlaceholder
      ? { facility: String(placeholderFacilityId), facilityName: "" }
      : {
          facilityName: portalOrder.facility_name || "Company Portal Facility",
        }),
    facilityAddress: portalOrder.facility_address || "",
    facilityCity: portalOrder.facility_city || "",
    facilityState: portalOrder.facility_state || "",
    facilityZip: sanitizeZip(portalOrder.facility_zip || ""),
    fullAddress: [
      portalOrder.facility_address,
      portalOrder.facility_city,
      portalOrder.facility_state,
      portalOrder.facility_zip,
    ]
      .filter(Boolean)
      .join(", "),
    address: portalOrder.facility_address || "",
    specificDoctor:
      portalOrder.treating_doctor || "Records Department",
    specificRecord:
      formatRecordTypesLabel(flags) ||
      portalOrder.record_type ||
      portalOrder.requested_record ||
      "Records",
    serveCompanyName: portalOrder.company_name || "Company Portal",
    serveAddress: portalOrder.company_address || "",
    serveCity: portalOrder.company_city || "",
    serveState: portalOrder.company_state || "",
    serveZip: sanitizeZip(portalOrder.company_zip || ""),
    serveEmail: portalOrder.contact_email || "",
    servePhone: portalOrder.contact_phone || "",
    subpoenaDate: toDateOnly(portalOrder.subpoena_date),
    dateRequested: toDateOnly(portalOrder.date_requested),
    depoDueDate: toDateOnly(portalOrder.depo_due_date),
    injuryType: "specific",
    injuryDate: toDateOnly(portalOrder.date_of_injury),
    medicalRecords: Boolean(flags.medicalRecords),
    billingRecords: Boolean(flags.billingRecords),
    employmentRecords: Boolean(flags.employmentRecords),
    xrays: Boolean(flags.xrays),
    otherRecord: Boolean(flags.otherRecord),
    creationSource: "company_portal",
    orderRef: `COMPANY_PORTAL:${portalOrder.id}`,
    // Portal Stripe fee becomes the invoice prepayment deduction.
    ...buildPortalPrepaymentFields(portalOrder),
  };
}

async function attachSubpoenaPath(internalOrderId, storagePath) {
  if (!storagePath || !internalOrderId) return;
  const pool = getPool();
  await pool.execute(
    `UPDATE orders
     SET subpoena_storage_path = :path,
         subpoena_uploaded_at = NOW(),
         has_subpoena = 1,
         updated_at = NOW()
     WHERE id = :id`,
    { id: internalOrderId, path: storagePath }
  );
}

async function ensurePortalPrepaymentRecord(internalOrderId, portalOrder) {
  if (!internalOrderId || !portalOrder) return false;

  const payments = await Order.findPaymentsByOrderId(internalOrderId);
  const existing = payments.find(
    (payment) => payment.payment_type === "prepayment"
  );
  const existingAmount = Number(existing?.amount || 0);
  if (Number.isFinite(existingAmount) && existingAmount > 0) {
    return false;
  }

  const walletTransactionId = await resolveWalletTransactionId(portalOrder);
  const fields = buildPortalPrepaymentFields(portalOrder, walletTransactionId);
  const paid = resolvePortalFeeAmount(portalOrder);
  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await Order.upsertPayment(connection, {
      orderId: internalOrderId,
      paymentType: "prepayment",
      checkNumber: fields.prepaymentCheck,
      paymentDate: fields.prepaymentDate,
      amount: paid,
      dueAmount: 0,
      isPaid: 1,
      memo: fields.prepaymentMemo,
    });
    return true;
  } finally {
    connection.release();
  }
}

async function ensureWalletOrderOnlinePaymentRecord(internalOrderId, portalOrder) {
  if (!internalOrderId || !portalOrder) return false;
  if (portalOrder.payment_method !== "wallet") return false;
  if (portalOrder.payment_status !== "paid") return false;

  const stripePaymentService = require("./stripePaymentService");
  return stripePaymentService.recordCompanyPortalWalletOrderPayment(
    internalOrderId,
    portalOrder
  );
}

async function linkPortalOrderToInternalOrder(portalOrder, internalOrderId) {
  if (!portalOrder?.id || !internalOrderId) return portalOrder;

  const linkedId = Number(internalOrderId);
  if (!Number.isFinite(linkedId) || linkedId <= 0) return portalOrder;

  if (Number(portalOrder.internal_order_id) === linkedId) {
    return portalOrder;
  }

  if (
    portalOrder.internal_order_id &&
    Number(portalOrder.internal_order_id) !== linkedId
  ) {
    throw new ApiError(
      409,
      "Company portal order is already linked to a different internal order"
    );
  }

  return CompanyPortalOrder.setInternalOrderId(portalOrder.id, linkedId);
}

async function findExistingInternalOrderForPortalOrder(portalOrder) {
  if (!portalOrder) return null;

  if (portalOrder.internal_order_id) {
    const linked = await Order.findById(portalOrder.internal_order_id);
    if (linked) return linked;
  }

  const orderNumber = String(portalOrder.order_number || "").trim();
  if (orderNumber) {
    const byNumber = await Order.findByOrderNumber(orderNumber);
    if (byNumber?.id) {
      const existing = await Order.findById(byNumber.id);
      if (existing?.creation_source === "company_portal") {
        return existing;
      }
    }
  }

  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT id
     FROM orders
     WHERE creation_source = 'company_portal'
       AND order_ref = :orderRef
     LIMIT 1`,
    { orderRef: `COMPANY_PORTAL:${portalOrder.id}` }
  );
  if (rows[0]?.id) {
    return Order.findById(rows[0].id);
  }

  return null;
}

async function resolveCompanyPortalOrderForInternalOrder(internalOrderId) {
  const orderId = Number(internalOrderId);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    return { order: null, portalOrder: null };
  }

  const order = await Order.findById(orderId);
  if (!order) {
    return { order: null, portalOrder: null };
  }

  let portalOrder = await CompanyPortalOrder.findByInternalOrderId(orderId);
  if (portalOrder) {
    return { order, portalOrder };
  }

  if (order.order_number) {
    portalOrder = await CompanyPortalOrder.findByOrderNumber(order.order_number);
    if (portalOrder) {
      portalOrder = await linkPortalOrderToInternalOrder(portalOrder, orderId);
      return { order, portalOrder };
    }
  }

  const orderRef = String(order.order_ref || "").trim();
  const portalRefMatch = orderRef.match(/^COMPANY_PORTAL:(\d+)$/i);
  if (portalRefMatch) {
    const portalId = Number(portalRefMatch[1]);
    if (Number.isFinite(portalId) && portalId > 0) {
      portalOrder = await CompanyPortalOrder.findById(portalId);
      if (portalOrder) {
        portalOrder = await linkPortalOrderToInternalOrder(portalOrder, orderId);
        return { order, portalOrder };
      }
    }
  }

  return { order, portalOrder: null };
}

async function ensureInternalOrderForPortalOrder(portalOrder) {
  if (!portalOrder) {
    throw new ApiError(404, "Company portal order not found");
  }

  if (portalOrder.payment_status !== "paid") {
    throw new ApiError(400, "Only paid company portal orders can be synced");
  }

  const existingInternal = await findExistingInternalOrderForPortalOrder(
    portalOrder
  );
  if (existingInternal) {
    const linkedPortal = await linkPortalOrderToInternalOrder(
      portalOrder,
      existingInternal.id
    );
    await ensurePortalPrepaymentRecord(existingInternal.id, linkedPortal);
    await ensureWalletOrderOnlinePaymentRecord(
      existingInternal.id,
      linkedPortal
    );
    return {
      portalOrder: linkedPortal,
      internalOrderId: existingInternal.id,
      created: false,
    };
  }

  let placeholderFacilityId = null;
  if (await portalOrderNeedsPlaceholderFacility(portalOrder)) {
    placeholderFacilityId = await resolvePlaceholderFacilityId();
  }

  const payload = buildInternalOrderPayload(portalOrder, {
    placeholderFacilityId,
  });
  const created = await orderService.createOrder(payload, null, {}, {
    allowIncomplete: true,
    creationSource: "company_portal",
  });

  const internalOrderId = Number(created.dbId);
  if (!Number.isFinite(internalOrderId) || internalOrderId <= 0) {
    throw new ApiError(500, "Failed to create internal order for company portal");
  }

  await attachSubpoenaPath(
    internalOrderId,
    portalOrder.subpoena_storage_path
  );
  // createOrder already syncs payments from payload; keep a safety net.
  await ensurePortalPrepaymentRecord(internalOrderId, portalOrder);
  await ensureWalletOrderOnlinePaymentRecord(internalOrderId, portalOrder);

  await CompanyPortalOrder.setInternalOrderId(portalOrder.id, internalOrderId);

  const refreshed = await CompanyPortalOrder.findById(portalOrder.id);
  return {
    portalOrder: refreshed,
    internalOrderId,
    created: true,
  };
}

async function syncPortalOrderById(portalOrderId) {
  const portalOrder = await CompanyPortalOrder.findById(portalOrderId);
  return ensureInternalOrderForPortalOrder(portalOrder);
}

async function backfillUnlinkedPaidPortalOrders({ limit = 100 } = {}) {
  const rows = await CompanyPortalOrder.listPaidUnlinked({ limit });
  const results = [];
  for (const row of rows) {
    try {
      const synced = await ensureInternalOrderForPortalOrder(row);
      results.push({
        portalOrderId: row.id,
        internalOrderId: synced.internalOrderId,
        ok: true,
      });
    } catch (error) {
      results.push({
        portalOrderId: row.id,
        ok: false,
        error: error.message || "Sync failed",
      });
    }
  }
  return results;
}

async function backfillMissingPortalPrepayments({ limit = 200 } = {}) {
  const rows = await CompanyPortalOrder.listPaidLinked({ limit });
  let updated = 0;

  for (const row of rows) {
    try {
      const didUpdate = await ensurePortalPrepaymentRecord(
        row.internal_order_id,
        row
      );
      if (didUpdate) updated += 1;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        "[company-portal] prepayment backfill failed:",
        row.id,
        error.message || error
      );
    }
  }

  return { checked: rows.length, updated };
}

async function updateCompanyPortalStage(internalOrderId, status, options = {}) {
  if (!COMPANY_PORTAL_STAGES.includes(status)) {
    throw new ApiError(400, "Invalid company portal stage");
  }

  const { portalOrder } = await resolveCompanyPortalOrderForInternalOrder(
    internalOrderId
  );
  if (!portalOrder) {
    throw new ApiError(404, "Company portal order not found for this order");
  }

  const updated = await CompanyPortalOrder.updateStatus(
    portalOrder.id,
    status
  );

  // Mirror Released onto the internal order lifecycle fields.
  if (status === "Released") {
    const deliveryDate = resolveClientCalendarDate(options);
    const pool = getPool();
    await pool.execute(
      `UPDATE orders
       SET status = 'Completed',
           delivery_date = COALESCE(delivery_date, :deliveryDate),
           updated_at = NOW()
       WHERE id = :id
         AND status NOT IN ('Cancelled', 'Deleted')`,
      { id: internalOrderId, deliveryDate }
    );
  }

  return updated;
}

function buildRecordsDownloadUrl(token) {
  const config = require("../config");
  const baseUrl = String(config.clientUrl || "").replace(/\/$/, "");
  return `${baseUrl}/download/records/${token}`;
}

async function emailCompanyPortalRecords(
  internalOrderId,
  { emails, email, additionalEmails, timezone } = {}
) {
  const orderId = Number(internalOrderId);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new ApiError(400, "Invalid order id");
  }

  const { order, portalOrder: initialPortalOrder } =
    await resolveCompanyPortalOrderForInternalOrder(orderId);

  if (!order || order.creation_source !== "company_portal") {
    throw new ApiError(404, "Company portal order not found");
  }

  if (!initialPortalOrder) {
    throw new ApiError(404, "Company portal order not found");
  }

  const {
    maybeAdvanceCompanyPortalAfterInvoiceSent,
    maybeAdvanceCompanyPortalAfterInvoicesPaid,
  } = require("./companyPortalStageHooks");

  await maybeAdvanceCompanyPortalAfterInvoiceSent(orderId);
  let portalOrder =
    (await maybeAdvanceCompanyPortalAfterInvoicesPaid(orderId)) ||
    initialPortalOrder;

  if (!portalOrder?.id) {
    portalOrder = initialPortalOrder;
  }

  if (!["Paid", "Released"].includes(portalOrder.status)) {
    throw new ApiError(
      400,
      "Email records is available after all invoices are Paid"
    );
  }

  const recipients = [];
  const pushEmail = (value) => {
    const cleaned = String(value || "").trim().toLowerCase();
    if (cleaned && cleaned.includes("@") && !recipients.includes(cleaned)) {
      recipients.push(cleaned);
    }
  };

  if (Array.isArray(emails)) {
    emails.forEach(pushEmail);
  }
  pushEmail(email);
  if (Array.isArray(additionalEmails)) {
    additionalEmails.forEach(pushEmail);
  }
  pushEmail(portalOrder.contact_email);
  pushEmail(order.serve_email);

  if (!recipients.length) {
    throw new ApiError(400, "At least one recipient email is required");
  }

  const {
    createDownloadLinkForOrder,
    resolveOrderRecordFiles,
  } = require("./recordDownloadService");

  const { token, expiresAt, files } = await createDownloadLinkForOrder(orderId);
  const { recordLabels } = await resolveOrderRecordFiles(order);

  if (!files.length) {
    throw new ApiError(
      400,
      "Records files not found. Scan records before sending email."
    );
  }

  const downloadUrl = buildRecordsDownloadUrl(token);
  const { sendOrderCompletedMail } = require("./emailService");
  const deliveredTo = [];

  for (const recipient of recipients) {
    const result = await sendOrderCompletedMail({
      to: recipient,
      orderNumber: order.order_number || portalOrder.order_number,
      applicant:
        portalOrder.applicant_name ||
        [order.applicant_first_name, order.applicant_last_name]
          .filter(Boolean)
          .join(" "),
      providerName:
        portalOrder.company_name ||
        order.serve_company_name ||
        order.provider_name ||
        "",
      recordLabels,
      downloadUrl,
      expiresAt,
    });

    if (!result.delivered && !result.devLogged) {
      throw new ApiError(500, "Failed to send email");
    }

    deliveredTo.push(recipient);
  }

  await CompanyPortalOrder.updateStatus(portalOrder.id, "Released");

  const calendarDate = resolveClientCalendarDate({ timezone });
  const pool = getPool();
  await pool.execute(
    `UPDATE orders
     SET delivery_date = :deliveryDate,
         ready_date = COALESCE(ready_date, :readyDate),
         status = 'Completed',
         updated_at = NOW()
     WHERE id = :orderId
       AND status NOT IN ('Cancelled', 'Deleted')`,
    { orderId, deliveryDate: calendarDate, readyDate: calendarDate }
  );

  return {
    recipients: deliveredTo,
    downloadUrl,
    expiresAt,
    companyPortalStatus: "Released",
  };
}

async function getNewFacilityContextForInternalOrder(internalOrderId) {
  const orderId = Number(internalOrderId);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    throw new ApiError(400, "Invalid order id");
  }

  const { order, portalOrder } =
    await resolveCompanyPortalOrderForInternalOrder(orderId);

  if (!order || order.creation_source !== "company_portal" || !portalOrder) {
    throw new ApiError(404, "Company portal order not found");
  }

  const newFacility = await CompanyPortalNewFacility.findByOrderId(
    portalOrder.id
  );

  return { order, portalOrder, newFacility };
}

/**
 * Link a (newly created or existing) internal facility to a company portal
 * order whose facility was previously not in our system. Sets the internal
 * order's facility, mirrors the facility onto the portal order, and marks the
 * new-facility request as linked (which also flags the $5 search fee to be
 * billed on the next regular invoice).
 */
async function linkFacilityToPortalOrder(internalOrderId, facilityId) {
  const facilityIdNum = Number(facilityId);
  if (!Number.isFinite(facilityIdNum) || facilityIdNum <= 0) {
    throw new ApiError(400, "A valid facility is required");
  }

  const { portalOrder, newFacility } =
    await getNewFacilityContextForInternalOrder(internalOrderId);

  if (portalOrder.status === "No facility") {
    throw new ApiError(
      400,
      "This order was ended with No facility status and cannot be linked"
    );
  }

  // Point the internal order at the resolved facility (sets orders.facility_id).
  await orderService.updateOrderFacility(Number(internalOrderId), {
    facility: facilityIdNum,
  });

  // Mirror the facility onto the portal order for display / tracking.
  const Facility = require("../models/Facility");
  const facility = await Facility.findById(facilityIdNum);
  if (facility) {
    await CompanyPortalOrder.updateFacilityDetails(portalOrder.id, {
      facilityName: facility.facility_name || portalOrder.facility_name,
      facilityAddress: facility.address || portalOrder.facility_address,
      facilityCity: facility.city ?? portalOrder.facility_city,
      facilityState: facility.state ?? portalOrder.facility_state,
      facilityZip: sanitizeZip(
        facility.zip_code ?? portalOrder.facility_zip ?? ""
      ),
    });
  }

  if (newFacility && newFacility.status !== "linked") {
    await CompanyPortalNewFacility.markLinked(newFacility.id, facilityIdNum);
  }

  return {
    internalOrderId: Number(internalOrderId),
    companyPortalOrderId: portalOrder.id,
    facilityId: facilityIdNum,
    facilitySearchFee: newFacility
      ? Number(newFacility.search_fee_amount) || 0
      : 0,
  };
}

/**
 * Mark a company portal order as "No facility" when DMS could not locate the
 * requested facility. Stops further processing; no refund is issued.
 */
async function markPortalOrderNoFacility(internalOrderId) {
  const { portalOrder, newFacility } =
    await getNewFacilityContextForInternalOrder(internalOrderId);

  const updated = await CompanyPortalOrder.updateStatus(
    portalOrder.id,
    "No facility"
  );

  if (newFacility && newFacility.status === "pending") {
    await CompanyPortalNewFacility.markCancelled(newFacility.id);
  }

  return updated;
}

/**
 * Restore a "No facility" company portal order back to "In Process" so staff
 * can continue (e.g. add a facility). Re-opens a cancelled new-facility
 * request when one exists and was never linked.
 */
async function restorePortalOrderInProcess(internalOrderId) {
  const { portalOrder, newFacility } =
    await getNewFacilityContextForInternalOrder(internalOrderId);

  if (portalOrder.status !== "No facility") {
    throw new ApiError(
      400,
      "Only orders with No facility status can be restored to In Process"
    );
  }

  const updated = await CompanyPortalOrder.updateStatus(
    portalOrder.id,
    "In Process"
  );

  if (
    newFacility &&
    newFacility.status === "cancelled" &&
    !newFacility.internal_facility_id
  ) {
    await CompanyPortalNewFacility.markPending(newFacility.id);
  }

  return updated;
}

/**
 * Block invoice tooling when a company portal order was ended with No facility.
 * No-ops for non-company-portal orders.
 */
async function assertCompanyPortalOrderAllowsInvoicing(internalOrderId) {
  const orderId = Number(internalOrderId);
  if (!Number.isFinite(orderId) || orderId <= 0) return;

  const { portalOrder } =
    await resolveCompanyPortalOrderForInternalOrder(orderId);
  if (!portalOrder) return;

  if (portalOrder.status === "No facility") {
    throw new ApiError(
      400,
      "Invoices cannot be created for company portal orders with No facility status"
    );
  }
}

/**
 * If a company portal order has a linked new-facility request whose $5 search
 * fee has not yet been billed, return its id and amount (without marking it
 * billed). Returns null when nothing is due. Call markFacilitySearchFeeBilled
 * after the invoice is committed to avoid losing the fee on rollback.
 */
async function getPendingFacilitySearchFee(internalOrderId) {
  const orderId = Number(internalOrderId);
  if (!Number.isFinite(orderId) || orderId <= 0) return null;

  const { portalOrder } =
    await resolveCompanyPortalOrderForInternalOrder(orderId);
  if (!portalOrder) return null;

  const newFacility = await CompanyPortalNewFacility.findByOrderId(
    portalOrder.id
  );
  if (
    !newFacility ||
    newFacility.status !== "linked" ||
    newFacility.invoice_billed_at
  ) {
    return null;
  }

  const amount = Number(newFacility.search_fee_amount) || 0;
  if (amount <= 0) return null;

  return { newFacilityId: newFacility.id, amount };
}

async function markFacilitySearchFeeBilled(newFacilityId) {
  if (!newFacilityId) return;
  await CompanyPortalNewFacility.markInvoiceBilled(newFacilityId);
}

async function getCompanyPortalStatusMap(internalOrderIds = []) {
  const ids = [...new Set(internalOrderIds.map(Number).filter((id) => id > 0))];
  if (!ids.length) return new Map();

  const rows = await CompanyPortalOrder.findByInternalOrderIds(ids);
  const map = new Map();
  for (const row of rows) {
    map.set(Number(row.internal_order_id), {
      companyPortalOrderId: row.id,
      companyPortalStatus: row.status,
      companyPortalPaymentStatus: row.payment_status,
      companyName: row.company_name || null,
    });
  }
  return map;
}

module.exports = {
  COMPANY_PORTAL_STAGES,
  ensureInternalOrderForPortalOrder,
  syncPortalOrderById,
  backfillUnlinkedPaidPortalOrders,
  backfillMissingPortalPrepayments,
  updateCompanyPortalStage,
  emailCompanyPortalRecords,
  getCompanyPortalStatusMap,
  buildInternalOrderPayload,
  resolveCompanyPortalOrderForInternalOrder,
  linkPortalOrderToInternalOrder,
  getNewFacilityContextForInternalOrder,
  linkFacilityToPortalOrder,
  markPortalOrderNoFacility,
  restorePortalOrderInProcess,
  assertCompanyPortalOrderAllowsInvoicing,
  getPendingFacilitySearchFee,
  markFacilitySearchFeeBilled,
  resolvePlaceholderFacilityId,
};
