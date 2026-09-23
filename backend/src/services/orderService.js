/**
 * Order business logic — called by orderController.
 */

const ApiError = require("../utils/ApiError");
const { rethrowServiceError } = require("../utils/serviceErrorUtils");
const fs = require("fs");
const path = require("path");
const Order = require("../models/Order");
const FacilityDoctor = require("../models/FacilityDoctor");
const OrderRecord = require("../models/OrderRecord");
const Facility = require("../models/Facility");
const Provider = require("../models/Provider");
const { buildProviderPayload, findOrCreateProvider, resolveProviderFromHints } = require("./providerService");
const {
  isFacilityProfileIncomplete,
} = require("./facilityService");
const { normalizeFacilityName, resolveBatchFacilityMismatch } = require("../utils/facilityNameUtils");
const Employee = require("../models/Employee");
const ActivityLog = require("../models/ActivityLog");
const { stripOrderIdTag, mapLogRow } = require("./activityLogService");
const invoiceService = require("./invoiceService");
const Invoice = require("../models/Invoice");
const InvoiceXray = require("../models/InvoiceXray");
const PersonalRequestOrder = require("../models/PersonalRequestOrder");
const {
  areAllOrderInvoicesWrittenOffFromRows,
} = require("../utils/orderInvoicePayment");
const { getPool } = require("../config/database");
const { sanitizeText, sanitizeSearchText } = require("../utils/sanitize");
const {
  assertPositiveInt,
  parseOptionalIsoDate,
} = require("../utils/sqlSafety");
const {
  assertReportDateRange,
  RUSH_LEVEL_VALUES,
  parseReportPageSize,
  parseOptionalCursor,
} = require("../lib/reportQueryParser");
const { FIELD_LIMITS } = require("../utils/fieldLimits");
const { sanitizeZip, sanitizeZipOrNull } = require("../utils/zipUtils");
const { toRelativeStoragePath, ORDER_UPLOADS_ROOT } = require("../middleware/uploadMiddleware");
const {
  sumRegularInvoicePageCount,
  sumXrayInvoicePageCount,
  resolvePdfPageCountFromUpload,
} = require("../utils/orderRecordPageCount");
const { calculateOrderRushLevel, RUSH_READY_MIN_DAYS } = require("../utils/rushUtils");
const batchScanRepository = require("../repositories/batchScanRepository");
const {
  buildOrderPayloadFromExtractRow,
} = require("../utils/extractToOrderPayload");
const {
  AUTO_PENDING_ORDER_PREFIX,
  computeMissingRequiredFields,
  mapOrderRowToRequiredFieldData,
  isPendingAutoOrderNumber,
} = require("../utils/orderRequiredFields");
const Patient = require("../models/Patient");
const logger = require("../utils/logger");
const fileStorage = require("../utils/fileStorage");
const {
  toInputDate,
  toSqlDateOnly,
  toShortDate,
  toSlashDateLong,
  formatDobDisplay,
  extractYear,
  formatSsnLastFourDisplay,
} = require("../utils/dateUtils");
const config = require("../config");
const {
  toUtcIso,
  localInstantToUtc,
  toMysqlUtcDateTime,
  formatUtcInstantDisplay,
  calendarTodayInTimezone,
  embedUtcInstantToken,
  expandUtcInstantTokens,
} = require("../utils/timezoneUtils");
const { resolveOrderPeriodStartDate } = require("../utils/orderPeriodFilter");

function resolveClientCalendarDate(options = {}) {
  return calendarTodayInTimezone(
    options.timezone || config.businessTimezone || "UTC"
  );
}

/**
 * Expand [[utc:...]] tokens in note body. For legacy "Calledback - local time"
 * lines (no token), rewrite using fallbackInstant when provided.
 */
function expandCalledbackNoteText(
  noteText,
  timeZone = config.businessTimezone,
  fallbackInstant = null
) {
  let text = expandUtcInstantTokens(String(noteText || ""), timeZone);

  if (
    fallbackInstant &&
    /\bCalledback\s*-/i.test(text) &&
    !/\[\[utc:/i.test(String(noteText || ""))
  ) {
    const formatted = formatUtcInstantDisplay(fallbackInstant, timeZone);
    if (formatted) {
      text = text.replace(
        /Calledback\s*-\s*[^\n\r]*/i,
        `Calledback - ${formatted}`
      );
    }
  }

  return text;
}

/** Callback datetime from client (local wall time) → MySQL UTC DATETIME. */
function resolveCallbackAtUtc(value, timezone) {
  if (value === undefined || value === null || value === "") return null;

  const trimmed = String(value).trim();

  // Date-only legacy: treat as start of that calendar day in client TZ.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const utc = localInstantToUtc(
      `${trimmed}T00:00:00`,
      timezone || config.businessTimezone
    );
    return utc ? toMysqlUtcDateTime(utc) : null;
  }

  const utc = localInstantToUtc(trimmed, timezone || config.businessTimezone);
  if (!utc) {
    throw new ApiError(400, "Invalid callback date and time");
  }

  return toMysqlUtcDateTime(utc);
}

const WORKFLOW_STAGE_NAMES = [
  "Review Records",
  "Serve",
  "SENT",
];
const WORKFLOW_STAGE_STATUSES = ["pending", "complete", "failed", "sent"];
const DEFAULT_PREPAYMENT_CHARGE = 15;
const STATUS_FILTER_MAP = {
  active: "Active",
  ready_pickup: "Ready to Pickup",
  completed: "Completed",
  cancelled: "Cancelled",
  deleted: "Deleted",
  writeoffs: "Write Offs",
};

const ALLOWED_INJURY_TYPES = ["specific", "cumulative"];
const ALLOWED_CNR_DELIVERY = ["email", "fax", "pickup"];

function parseBoolean(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return (
      normalized === "true" ||
      normalized === "1" ||
      normalized === "yes" ||
      normalized === "on"
    );
  }
  return Boolean(value);
}

function isCnrOrder(data = {}) {
  return (
    parseBoolean(data.certificateNoRecords) ||
    parseBoolean(data.certificate_no_records)
  );
}

function assertValidCnrDeliveryDate(data = {}) {
  if (!isCnrOrder(data)) {
    return;
  }

  if (
    ALLOWED_CNR_DELIVERY.includes(data.cnrDelivery) &&
    !dateOrNull(data.cnrDateSent)
  ) {
    throw new ApiError(400, "CNR date is required for the selected delivery method");
  }
}

const PAYMENT_PREFIXES = ["prepayment", "xray"];

const RECORD_TITLES = {
  medical: "Medical Records",
  billing: "Billing Records",
  employment: "Employment Records",
  xrays: "X-Ray Films",
  other: "Other",
};

const VALID_RECORD_TYPES = ["medical", "billing", "employment", "xrays", "other"];

const RECORD_TYPE_FLAG_MAP = {
  medical: "medicalRecords",
  billing: "billingRecords",
  employment: "employmentRecords",
  xrays: "xrays",
  other: "otherRecord",
};

function resolveRecordTypesFromForm(data = {}) {
  const types = [];

  for (const recordType of VALID_RECORD_TYPES) {
    const flagKey = RECORD_TYPE_FLAG_MAP[recordType];
    if (parseBoolean(data[flagKey])) {
      types.push(recordType);
    }
  }

  if (!types.length && data.type) {
    types.push(data.type === "other" ? "other" : data.type);
  }

  return [...new Set(types.filter((type) => VALID_RECORD_TYPES.includes(type)))];
}

/** Keep only one record-type flag so each split order owns a single type. */
function applySingleRecordTypeToForm(data = {}, recordType) {
  const next = { ...data, type: recordType };
  for (const type of VALID_RECORD_TYPES) {
    const flagKey = RECORD_TYPE_FLAG_MAP[type];
    next[flagKey] = type === recordType;
  }
  return next;
}

function mapOrderRecordRow(row = {}) {
  const pageCount = Number(row.page_count);
  return {
    id: row.id,
    recordType: row.record_type,
    storagePath: row.storage_path || null,
    originalFileName: row.original_file_name || null,
    pageCount:
      Number.isFinite(pageCount) && pageCount >= 0 ? Math.floor(pageCount) : null,
    storageUrl: buildSubpoenaUrl(row.storage_path),
    uploadedAt: row.uploaded_at || null,
    hasFile: Boolean(row.storage_path),
  };
}

function mapOrderRecords(rows = []) {
  return rows.map(mapOrderRecordRow);
}

function getPrimaryRecordType(orderRecords = []) {
  return orderRecords[0]?.record_type || "";
}

function resolveOrderTypeForForm(_row, orderRecords = []) {
  const types = [
    ...new Set(orderRecords.map((row) => row.record_type).filter(Boolean)),
  ];
  if (types.length === 1) {
    return types[0];
  }
  return types[0] || getPrimaryRecordType(orderRecords);
}

function hasAnyRecordsRequested(orderRecords = []) {
  return orderRecords.length > 0;
}

function allOrderRecordsUploaded(orderRecords = []) {
  if (!orderRecords.length) return false;

  const types = [
    ...new Set(orderRecords.map((row) => row.record_type).filter(Boolean)),
  ];

  return types.every((type) =>
    orderRecords.some((row) => row.record_type === type && row.storage_path)
  );
}

function anyOrderRecordUploaded(orderRecords = []) {
  return orderRecords.some((row) => Boolean(row.storage_path));
}

const DEFAULT_ORDER_FORMS = [
  "Send Copy/Letter",
  "Certification of Records",
  "CNR",
];

function trimOrNull(value, options = {}) {
  if (value === undefined || value === null) return null;
  const sanitized = sanitizeText(value, {
    maxLength: options.maxLength || 4000,
    allowEmpty: true,
  });
  return sanitized === "" ? null : sanitized;
}

function dateOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  return toSqlDateOnly(value);
}

function boolToInt(value) {
  return parseBoolean(value) ? 1 : 0;
}

function readHasSubpoena(row = {}) {
  return Boolean(Number(row.has_subpoena ?? row.is_subpoena));
}

function readIsWriteOffs(row = {}) {
  return row.status === "Write Offs";
}

function resolveOrderWriteOffState(row, invoiceRow, xrayRow) {
  const isWriteOffs = areAllOrderInvoicesWrittenOffFromRows(invoiceRow, xrayRow);
  let status = row.status || "Active";

  if (isWriteOffs && status !== "Completed") {
    status = "Write Offs";
  } else if (!isWriteOffs && status === "Write Offs") {
    status = "Active";
  }

  return {
    isWriteOffs,
    status,
    displayStatus: deriveDisplayOrderStatus(
      status,
      row.created_at
    ),
    filterStatus:
      isWriteOffs && status !== "Completed"
        ? "writeoffs"
        : deriveFilterStatus(status),
  };
}

function assertOrderEditable(existing) {
  if (!existing) {
    throw new ApiError(404, "Order not found");
  }

  if (existing.status === "Cancelled") {
    throw new ApiError(400, "Cannot update a cancelled order");
  }

  if (existing.status === "Deleted") {
    throw new ApiError(400, "Cannot update a deleted order");
  }
}

function resolveOrderFlags(data, hasSubpoenaFile) {
  return {
    hasSubpoena: hasSubpoenaFile ? 1 : 0,
  };
}

function enumOrNull(value, allowed) {
  const trimmed = trimOrNull(value);
  if (!trimmed) return null;
  return allowed.includes(trimmed) ? trimmed : null;
}

function ssnLastFour(ssn) {
  const { normalizeOrderSsn } = require("../utils/dateUtils");
  return normalizeOrderSsn(ssn);
}

function buildFullName(first, middle, last) {
  return [first, middle, last].filter(Boolean).join(" ").trim();
}

function formatDoiDisplay(row) {
  if (!row) return "";

  if (row.injury_type === "specific" && row.injury_date) {
    return toShortDate(row.injury_date);
  }

  if (row.injury_type === "cumulative" && row.injury_date_begin) {
    const start = toShortDate(row.injury_date_begin);
    const end = row.injury_date_end ? toShortDate(row.injury_date_end) : "";
    return end ? `${start} - ${end}` : start;
  }

  return "";
}

function hasDoi(row) {
  return Boolean(formatDoiDisplay(row));
}

function hasInjuryPayload(data = {}) {
  const injuryType = trimOrNull(data.injuryType);
  if (!injuryType) return false;

  if (injuryType === "specific") {
    return Boolean(trimOrNull(data.injuryDate));
  }

  return Boolean(trimOrNull(data.injuryDateBegin) || trimOrNull(data.injuryDateEnd));
}

function applyInjuryFromExtract(data = {}, extract = null) {
  if (!extract || hasInjuryPayload(data)) {
    return data;
  }

  const {
    resolveExtractionSchema,
    mapSchemaToExtractRow,
  } = require("../utils/extractionMapper");

  let injuryDate = extract.date_of_injury ? toInputDate(extract.date_of_injury) : "";

  if (!injuryDate && extract.raw_extraction) {
    const raw =
      typeof extract.raw_extraction === "string"
        ? JSON.parse(extract.raw_extraction || "{}")
        : extract.raw_extraction;
    const mapped = mapSchemaToExtractRow(resolveExtractionSchema(raw));
    injuryDate = mapped.date_of_injury ? toInputDate(mapped.date_of_injury) : "";
  }

  if (!injuryDate) {
    return data;
  }

  return {
    ...data,
    injuryType: "specific",
    injuryDate,
    injuryDateBegin: "",
    injuryDateEnd: "",
  };
}

function buildInjuryDatePayload(data) {
  const injuryType = enumOrNull(data.injuryType, ALLOWED_INJURY_TYPES);

  if (injuryType === "specific") {
    return {
      injuryDate: dateOrNull(data.injuryDate),
      injuryDateBegin: null,
      injuryDateEnd: null,
    };
  }

  if (injuryType === "cumulative") {
    return {
      injuryDate: null,
      injuryDateBegin: dateOrNull(data.injuryDateBegin),
      injuryDateEnd: dateOrNull(data.injuryDateEnd),
    };
  }

  return {
    injuryDate: null,
    injuryDateBegin: null,
    injuryDateEnd: null,
  };
}

function buildSubpoenaUrl(storagePath) {
  const normalized = String(storagePath || "").replace(/\\/g, "/");
  if (!normalized) return "";

  if (fileStorage.isUploadsRelativePath(normalized)) {
    return `/uploads/${normalized}`;
  }

  return "";
}

function resolveOrderSubpoenaAbsolutePath(storagePath) {
  const normalized = String(storagePath || "").replace(/\\/g, "/");
  if (!normalized) return null;

  if (fileStorage.isUploadsRelativePath(normalized)) {
    return path.join(ORDER_UPLOADS_ROOT, normalized);
  }

  return fileStorage.resolveAbsolutePath(normalized);
}

function nestOrderUploadPath(relativePath, actorId, orderNumber) {
  return fileStorage.moveUploadToOrderFolder(relativePath, actorId, orderNumber);
}

async function nestAndPersistSubpoenaPath(
  connection,
  { orderId, orderNumber, storagePath, actorId }
) {
  const nestedPath = nestOrderUploadPath(storagePath, actorId, orderNumber);
  if (nestedPath && nestedPath !== storagePath) {
    await connection.execute(
      `UPDATE orders
       SET subpoena_storage_path = :subpoenaStoragePath
       WHERE id = :orderId`,
      { subpoenaStoragePath: nestedPath, orderId }
    );
  }
  return nestedPath || storagePath;
}

function buildOrderDbPayload(data) {
  return {
    facilityId: Number(data.facility),
    providerId: data.providerId ? Number(data.providerId) : null,
    court: trimOrNull(data.court, { maxLength: FIELD_LIMITS.VARCHAR_50 }) || "WCAB",
    caseNumber: trimOrNull(data.caseNumber, { maxLength: FIELD_LIMITS.VARCHAR_255 }),
    recNumber: trimOrNull(data.recNumber, { maxLength: FIELD_LIMITS.VARCHAR_50 }),
    orderRef: trimOrNull(data.orderRef, { maxLength: FIELD_LIMITS.VARCHAR_50 }),
    ssnLastFour: ssnLastFour(data.ssn || data.ssnLastFour),
    dob: dateOrNull(data.dob),
    applicantFirstName: trimOrNull(data.firstName, { maxLength: FIELD_LIMITS.VARCHAR_100 }),
    applicantMiddleName: trimOrNull(data.middleName, { maxLength: FIELD_LIMITS.VARCHAR_100 }),
    applicantLastName: trimOrNull(data.lastName, { maxLength: FIELD_LIMITS.VARCHAR_100 }),
    applicantAka: trimOrNull(data.aka, { maxLength: FIELD_LIMITS.VARCHAR_150 }),
    defendant: trimOrNull(data.defendant, { maxLength: FIELD_LIMITS.VARCHAR_200 }),
    injuryType: enumOrNull(data.injuryType, ALLOWED_INJURY_TYPES),
    ...buildInjuryDatePayload(data),
    serveCompanyName: trimOrNull(data.serveCompanyName, { maxLength: FIELD_LIMITS.VARCHAR_255 }),
    serveAddress: trimOrNull(data.address, { maxLength: FIELD_LIMITS.VARCHAR_255 }),
    serveZip: sanitizeZipOrNull(data.zip),
    serveCity: trimOrNull(data.city, { maxLength: FIELD_LIMITS.VARCHAR_100 }),
    serveState: trimOrNull(data.state, { maxLength: 2 }),
    servePhone: trimOrNull(data.phone, { maxLength: 20 }),
    serveFax: trimOrNull(data.fax, { maxLength: 20 }),
    serveEmail: trimOrNull(data.email, { maxLength: FIELD_LIMITS.VARCHAR_255 }),
    contact1Name: trimOrNull(data.contact1Name, { maxLength: FIELD_LIMITS.VARCHAR_150 }),
    contact1Title: trimOrNull(data.contact1Title, { maxLength: FIELD_LIMITS.VARCHAR_100 }),
    contact1Phone: trimOrNull(data.contact1Phone, { maxLength: 20 }),
    contact1Fax: trimOrNull(data.contact1Fax, { maxLength: 20 }),
    contact1Email: trimOrNull(data.contact1Email, { maxLength: FIELD_LIMITS.VARCHAR_255 }),
    contact2Name: trimOrNull(data.contact2Name, { maxLength: FIELD_LIMITS.VARCHAR_150 }),
    contact2Title: trimOrNull(data.contact2Title, { maxLength: FIELD_LIMITS.VARCHAR_100 }),
    contact2Phone: trimOrNull(data.contact2Phone, { maxLength: 20 }),
    contact2Fax: trimOrNull(data.contact2Fax, { maxLength: 20 }),
    contact2Email: trimOrNull(data.contact2Email, { maxLength: FIELD_LIMITS.VARCHAR_255 }),
    dateServed: dateOrNull(data.dateServed),
    depoDueDate: dateOrNull(data.depoDueDate),
    deliveryDate: dateOrNull(data.deliveryDate),
    subpoenaDate: dateOrNull(data.subpoenaDate),
    dateRequested: dateOrNull(data.dateRequested),
    readyDate: dateOrNull(data.readyDate),
    invoiceDate: dateOrNull(data.invoiceDate),
    xrayInvoiceDate: dateOrNull(data.xrayInvoiceDate),
    specificRecord: trimOrNull(data.specificRecord, { maxLength: FIELD_LIMITS.TEXT }),
    specificDoctor: trimOrNull(data.specificDoctor, { maxLength: FIELD_LIMITS.VARCHAR_200 }),
    specificDoctorIsDefault: boolToInt(data.specificDoctorIsDefault),
    fullAddress: trimOrNull(data.fullAddress, { maxLength: FIELD_LIMITS.TEXT }),
    certificateNoRecords: boolToInt(data.certificateNoRecords),
    cnrReason: trimOrNull(data.cnrReason, { maxLength: FIELD_LIMITS.TEXT }),
    cnrDelivery: enumOrNull(data.cnrDelivery, ALLOWED_CNR_DELIVERY),
    cnrDateSent: dateOrNull(data.cnrDateSent),
    cnrMemo: boolToInt(data.cnrMemo),
    subpoenaStoragePath: null,
    creationSource:
      data.creationSource === "auto"
        ? "auto"
        : data.creationSource === "personal_portal"
          ? "personal_portal"
          : data.creationSource === "company_portal"
            ? "company_portal"
            : "manual",
    batchChosenFacilityId: data.batchChosenFacilityId
      ? Number(data.batchChosenFacilityId)
      : null,
    extractedFacilityId: data.extractedFacilityId
      ? Number(data.extractedFacilityId)
      : null,
    facilityMismatch: boolToInt(data.facilityMismatch),
  };
}

function getUploadedFile(files, field) {
  if (!files) return null;
  const entry = files[field];
  if (Array.isArray(entry)) return entry[0] || null;
  return entry || null;
}

function parsePaymentAmount(value) {
  const amount = Number(`${value ?? ""}`.replace(/[^\d.]/g, ""));
  return Number.isFinite(amount) ? amount : 0;
}

function getPrepaymentPayment(payments = []) {
  return getPaymentByType(payments, "prepayment");
}

function getPaymentByType(payments = [], paymentType) {
  return payments.find((payment) => payment.paymentType === paymentType) || null;
}

async function syncOrderWorkflowFromState(
  connection,
  orderId,
  {
    payments = [],
    invoiceServiceFee = 0,
  } = {}
) {
  const prepayment = getPrepaymentPayment(payments);
  const paidAmount = parsePaymentAmount(prepayment?.amount);

  let chargeAmount = parsePaymentAmount(invoiceServiceFee);
  if (chargeAmount <= 0) {
    chargeAmount = DEFAULT_PREPAYMENT_CHARGE;
  }

  if (chargeAmount > 0 && paidAmount >= chargeAmount) {
    await Order.upsertWorkflowStage(
      orderId,
      "Serve",
      "complete",
      new Date(),
      connection
    );
  } else {
    await Order.upsertWorkflowStage(
      orderId,
      "Serve",
      "pending",
      null,
      connection
    );
  }
}

async function markOrderWorkflowSent(orderId, connection = null) {
  await Order.upsertWorkflowStage(
    orderId,
    "SENT",
    "sent",
    new Date(),
    connection
  );
}

function buildPaymentPayload(data, prefix) {
  const checkNumber = trimOrNull(data[`${prefix}Check`]);
  const paymentDate = dateOrNull(data[`${prefix}Date`]);
  const rawAmount = trimOrNull(data[`${prefix}Paid`]);
  const rawDue = trimOrNull(data[`${prefix}Due`]);
  const memo = trimOrNull(data[`${prefix}Memo`]);

  if (!checkNumber && !paymentDate && !rawAmount && !rawDue && !memo) {
    return null;
  }

  let amount = rawAmount !== null ? Number(rawAmount) : null;
  let dueAmount = rawDue !== null ? Number(rawDue) : null;

  if (Number.isNaN(amount)) amount = null;
  if (Number.isNaN(dueAmount)) dueAmount = null;

  const isPortalOrder =
    data.creationSource === "personal_portal" ||
    data.creationSource === "company_portal";

  if (prefix === "prepayment" && !isPortalOrder) {
    if (amount != null && amount > DEFAULT_PREPAYMENT_CHARGE) {
      amount = 0;
    }
    if (dueAmount != null) {
      dueAmount = Math.min(Math.max(0, dueAmount), DEFAULT_PREPAYMENT_CHARGE);
    }
  }

  return {
    paymentType: prefix,
    checkNumber,
    paymentDate,
    amount,
    dueAmount,
    isPaid: amount && amount > 0 ? 1 : 0,
    memo,
  };
}

function collectPayments(data) {
  return PAYMENT_PREFIXES.map((prefix) => buildPaymentPayload(data, prefix)).filter(
    Boolean
  );
}

function resolvePrepaymentDueAmount(data) {
  const paid = parsePaymentAmount(trimOrNull(data.prepaymentPaid));
  const isPortalOrder =
    data.creationSource === "personal_portal" ||
    data.creationSource === "company_portal";
  const maxCharge = DEFAULT_PREPAYMENT_CHARGE;
  const cappedPaid =
    !isPortalOrder && paid > maxCharge ? 0 : paid;
  const rawDue = trimOrNull(data.prepaymentDue);

  if (rawDue !== null) {
    const due = Number(rawDue);
    if (!Number.isNaN(due)) {
      const normalized = Math.max(0, due);
      return isPortalOrder ? normalized : Math.min(normalized, maxCharge);
    }
  }

  return Math.max(0, maxCharge - cappedPaid);
}

async function ensurePrepaymentPayment(connection, orderId, data) {
  const payment = buildPaymentPayload(data, "prepayment");
  const dueAmount = resolvePrepaymentDueAmount(data);
  const paid = parsePaymentAmount(trimOrNull(data.prepaymentPaid));
  const isPortalOrder =
    data.creationSource === "personal_portal" ||
    data.creationSource === "company_portal";
  const cappedPaid = isPortalOrder
    ? paid
    : paid > DEFAULT_PREPAYMENT_CHARGE
      ? 0
      : paid;

  if (payment) {
    const paymentAmount =
      payment.amount == null
        ? null
        : isPortalOrder
          ? payment.amount
          : Number(payment.amount) > DEFAULT_PREPAYMENT_CHARGE
            ? 0
            : Number(payment.amount) || 0;
    await Order.upsertPayment(connection, {
      ...payment,
      amount: paymentAmount,
      orderId,
      dueAmount: payment.dueAmount ?? dueAmount,
    });
    return;
  }

  await Order.upsertPayment(connection, {
    orderId,
    paymentType: "prepayment",
    checkNumber: null,
    paymentDate: null,
    amount: cappedPaid > 0 ? cappedPaid : null,
    dueAmount,
    isPaid: cappedPaid > 0 ? 1 : 0,
    memo: null,
  });
}

async function syncOrderPayments(connection, orderId, data) {
  const xrayRow = await InvoiceXray.findByOrderId(orderId, connection);
  const xrayTotal = xrayRow ? Number(xrayRow.payment) || 0 : null;

  for (const prefix of PAYMENT_PREFIXES) {
    const payment = buildPaymentPayload(data, prefix);

    if (payment) {
      if (
        prefix === "xray" &&
        xrayTotal != null &&
        payment.amount != null &&
        Number.isFinite(xrayTotal)
      ) {
        payment.amount = Math.min(
          Math.max(0, xrayTotal),
          Math.max(0, Number(payment.amount) || 0)
        );
        if (payment.dueAmount != null) {
          payment.dueAmount = Math.max(
            0,
            Math.min(xrayTotal, Number(payment.dueAmount) || 0)
          );
        }
      }

      await Order.upsertPayment(connection, { ...payment, orderId });
    } else {
      await Order.deletePaymentByType(connection, orderId, prefix);
    }
  }

  await ensurePrepaymentPayment(connection, orderId, data);

  await invoiceService.syncOrderPaymentDuesFromInvoice(connection, orderId);
  await invoiceService.syncServeWorkflowFromPrepayment(connection, orderId);
}

function mapPaymentsToForm(payments = []) {
  const formFields = {
    prepaymentCheck: "",
    prepaymentDate: "",
    prepaymentPaid: "",
    prepaymentDue: "",
    prepaymentMemo: "",
    custodianCheck: "",
    custodianDate: "",
    custodianPaid: "",
    custodianDue: "",
    custodianMemo: "",
    xrayCheck: "",
    xrayDate: "",
    xrayPaid: "",
    xrayDue: "",
    xrayMemo: "",
  };

  payments.forEach((payment) => {
    const prefix = payment.payment_type;
    if (!PAYMENT_PREFIXES.includes(prefix)) return;

    formFields[`${prefix}Check`] = payment.check_number || "";
    formFields[`${prefix}Date`] = toInputDate(payment.payment_date);
    formFields[`${prefix}Paid`] =
      payment.amount !== null && payment.amount !== undefined
        ? String(payment.amount)
        : "";
    formFields[`${prefix}Due`] =
      payment.due_amount !== null && payment.due_amount !== undefined
        ? String(payment.due_amount)
        : "";
    formFields[`${prefix}Memo`] = payment.memo || "";
  });

  return formFields;
}

function enrichPaymentDueFields(paymentForm, invoiceRow, xrayRow, payments = []) {
  const invoiceFees = invoiceService.mapOrderInvoiceFees(
    invoiceRow,
    xrayRow,
    payments
  );
  const prepaymentPaid = parsePaymentAmount(paymentForm.prepaymentPaid);
  const cappedPrepaymentPaid =
    prepaymentPaid > DEFAULT_PREPAYMENT_CHARGE ? 0 : prepaymentPaid;
  if (prepaymentPaid > DEFAULT_PREPAYMENT_CHARGE) {
    paymentForm.prepaymentPaid = "0";
  }
  paymentForm.prepaymentDue = Math.max(
    0,
    DEFAULT_PREPAYMENT_CHARGE - cappedPrepaymentPaid
  ).toFixed(2);

  if (invoiceFees.hasXrayInvoice) {
    const xrayFee = Math.max(0, Number(invoiceFees.xrayFee) || 0);
    const fromInvoicePaid = Number(invoiceFees.xrayPaid) || 0;
    const fromFormPaid = parsePaymentAmount(paymentForm.xrayPaid);
    // Never apply X-ray paid above the X-ray invoice total.
    const paid = Math.min(xrayFee, Math.max(fromInvoicePaid, fromFormPaid));

    if (paid > 0 || fromFormPaid > 0) {
      paymentForm.xrayPaid = paid.toFixed(2);
    }

    paymentForm.xrayDue = (
      Number.isFinite(Number(invoiceFees.xrayDue))
        ? Math.max(0, Number(invoiceFees.xrayDue))
        : Math.max(0, xrayFee - paid)
    ).toFixed(2);

    // Manual/online X-ray payment stores check on invoice_xray_details;
    // surface those on edit-order when order_payments check fields are empty.
    if (xrayRow) {
      const invoiceCheck = `${xrayRow.payment_check_number || ""}`.trim();
      const invoiceDate = toInputDate(xrayRow.payment_date);
      const fromManualOrOnline =
        xrayRow.payment_method === "manual" ||
        xrayRow.payment_method === "online";

      if (invoiceCheck && (fromManualOrOnline || !`${paymentForm.xrayCheck || ""}`.trim())) {
        paymentForm.xrayCheck = invoiceCheck;
      }

      if (invoiceDate && (fromManualOrOnline || !`${paymentForm.xrayDate || ""}`.trim())) {
        paymentForm.xrayDate = invoiceDate;
      }
    }
  } else if (paymentForm.xrayDue === "") {
    paymentForm.xrayDue = "0";
  }

  return paymentForm;
}

function deriveDisplayOrderStatus(status, createdAt) {
  if (status === "Ready" || status === "Ready to Pickup") {
    return status;
  }

  const rush = calculateOrderRushLevel(createdAt);
  if (status === "Active" && rush.level >= 2) {
    return "Ready";
  }

  return status || "Active";
}

function deriveFilterStatus(status) {
  if (status === "Completed") return "completed";
  if (status === "Cancelled") return "cancelled";
  if (status === "Deleted") return "deleted";
  if (status === "Write Offs") return "writeoffs";
  if (status === "Ready" || status === "Ready to Pickup") return "ready";
  return "active";
}

function buildCompanyBlock(row) {
  const name = row.serve_company_name || row.provider_name || "—";

  const address = [
    row.serve_address,
    [row.serve_city, row.serve_state].filter(Boolean).join(", "),
    row.serve_zip,
  ]
    .filter(Boolean)
    .join(", ");

  const phoneParts = [];
  if (row.serve_phone) phoneParts.push(`Phone ${row.serve_phone}`);
  if (row.serve_fax) phoneParts.push(`Fax ${row.serve_fax}`);

  return {
    name,
    address,
    phone: phoneParts.join(" | "),
    email: row.serve_email ? `Email: ${row.serve_email}` : "",
    emailAddress:
      trimOrNull(row.serve_email) ||
      trimOrNull(row.provider_email) ||
      trimOrNull(row.contact1_email) ||
      trimOrNull(row.contact2_email) ||
      "",
    faxNumber:
      trimOrNull(row.serve_fax) ||
      trimOrNull(row.contact1_fax) ||
      trimOrNull(row.contact2_fax) ||
      "",
  };
}

function buildFacilityBlock(row) {
  const addressLines = [];

  if (row.facility_address) {
    addressLines.push(row.facility_address);
  }

  const cityStateZip = [
    row.facility_city,
    [row.facility_state, row.facility_zip].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");

  if (cityStateZip) {
    addressLines.push(cityStateZip);
  }

  return {
    name: row.facility_name || "",
    address: addressLines.join(", "),
    addressLines,
  };
}

function normalizeCaptionText(value) {
  const text = trimOrNull(value);
  if (!text) return "";

  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function buildRecordsBlock(row, orderRecords = []) {
  const mappedRecords = mapOrderRecords(orderRecords);
  const primaryType = getPrimaryRecordType(orderRecords);
  const title = RECORD_TITLES[primaryType] || "Records";

  const requestedTypes = [
    ...new Map(
      orderRecords.map((record) => [
        record.record_type,
        RECORD_TITLES[record.record_type] || record.record_type,
      ])
    ),
  ].map(([type, label]) => ({ type, label }));

  const caption = normalizeCaptionText(row.specific_record);
  const dateRangeStart = toSlashDateLong(row.date_requested);
  const dateRange = dateRangeStart ? `${dateRangeStart} - Present` : "";

  const lines = [];

  const uploadedRecords = mappedRecords.filter((record) => record.hasFile);
  const hasMedicalRecords = allOrderRecordsUploaded(orderRecords);

  const hasCnr = Boolean(Number(row.certificate_no_records));
  const cnrReason = trimOrNull(row.cnr_reason) || "";

  return {
    title,
    lines,
    requestedTypes,
    caption,
    dateRange,
    specificDoctor: row.specific_doctor || "",
    links: [],
    hasMedicalRecords,
    allRecordsUploaded: hasMedicalRecords,
    anyRecordsUploaded: anyOrderRecordUploaded(orderRecords),
    orderRecords: mappedRecords,
    regularInvoicePageCount: sumRegularInvoicePageCount(orderRecords),
    xrayInvoicePageCount: sumXrayInvoicePageCount(orderRecords),
    medicalRecordsUrl: uploadedRecords[0]?.storageUrl || null,
    cnrNote:
      hasCnr && !Number(row.cnr_memo)
        ? {
            label: "CNR Note",
            text: cnrReason,
            hasNote: true,
          }
        : null,
  };
}

function deriveInvoiceDisplayStatus(invoiceRow) {
  if (!invoiceRow) {
    return "Pending";
  }

  return invoiceRow.status || "Unpaid";
}

function mapOrderListRow(
  row,
  workflowStages = [],
  invoiceRow = null,
  xrayRow = null,
  orderPayments = [],
  orderRecords = [],
  extras = {}
) {
  const orderYear = extractYear(row.created_at) || extractYear(row.subpoena_date) || "";
  const orderDateDisplay = formatDobDisplay(row.created_at) || "";
  const dob = formatDobDisplay(row.dob);
  const ssn = formatSsnLastFourDisplay(row.ssn_last_four);
  const doiDisplay = formatDoiDisplay(row);
  const dobSsn = [dob, ssn, doiDisplay].filter(Boolean);

  const rush = calculateOrderRushLevel(row.created_at);
  const writeOffState = resolveOrderWriteOffState(row, invoiceRow, xrayRow);

  const mapped = {
    id: row.order_number,
    dbId: row.id,
    facility: row.facility_id ? String(row.facility_id) : "",
    facilityName: row.facility_name || "",
    doctor: row.specific_doctor || "",
    facilityInfo: buildFacilityBlock(row),
    year: orderYear,
    orderDateDisplay,
    status: writeOffState.status,
    statusBeforeInactive: row.status_before_inactive || "",
    cancelReason: row.cancel_reason || "",
    cancelledAt: row.cancelled_at || null,
    deletedAt: row.deleted_at || null,
    deleteReason: row.delete_reason || "",
    displayStatus: writeOffState.displayStatus,
    filterStatus: writeOffState.filterStatus,
    workflowStages: workflowStages.map(mapWorkflowStage),
    note: Boolean(row.has_note),
    subpoena: readHasSubpoena(row),
    isSubpoena: readHasSubpoena(row),
    hasSubpoenaFile: Boolean(row.subpoena_storage_path),
    subpoenaUrl: buildSubpoenaUrl(row.subpoena_storage_path),
    isRecords: hasAnyRecordsRequested(orderRecords),
    isWriteOffs: writeOffState.isWriteOffs,
    court: row.court || "",
    applicant: buildFullName(
      row.applicant_first_name,
      row.applicant_middle_name,
      row.applicant_last_name
    ),
    caseNumber: row.case_number || "",
    recNumber: row.rec_number || "",
    orderRef: row.order_ref || "",
    providerName: row.serve_company_name || row.provider_name || "",
    providerEmail: trimOrNull(row.provider_email) || "",
    subpoenaDate: toInputDate(row.subpoena_date),
    subpoenaDateDisplay: toShortDate(row.subpoena_date),
    subpoenaUploadedAt: row.subpoena_uploaded_at || null,
    subpoenaUploadedAtDisplay: toShortDate(row.subpoena_uploaded_at),
    dateServed: toInputDate(row.date_served),
    dateServedDisplay: toShortDate(row.date_served),
    dateRequested: toInputDate(row.date_requested),
    dateRequestedDisplay: toShortDate(row.date_requested),
    createdAt: row.created_at || null,
    rushLevel: rush.level,
    rushLabel: rush.label,
    invoiceStatus: deriveInvoiceDisplayStatus(invoiceRow),
    records: buildRecordsBlock(row, orderRecords),
    company: buildCompanyBlock(row),
    dob,
    ssn,
    dobSsn,
    doiDisplay,
    hasDoi: hasDoi(row),
    forms: DEFAULT_ORDER_FORMS,
    invoice: invoiceService.mapOrderInvoiceSummary(
      invoiceRow,
      xrayRow,
      orderPayments,
      extras.timezone || null
    ),
    certificateNoRecords: Boolean(Number(row.certificate_no_records)),
    cnrReason: row.cnr_reason || "",
    cnrMemo: Boolean(Number(row.cnr_memo)),
    cnrDelivery: row.cnr_delivery || "",
    mailSentDate: toInputDate(row.ready_date),
    readyDate: toInputDate(row.ready_date),
    deliveryDate: toInputDate(row.delivery_date),
    recordsDownloaded: Boolean(row.records_downloaded_at),
    recordsDownloadedAt: row.records_downloaded_at || null,
    recordsDownloadedAtDisplay: toShortDate(row.records_downloaded_at),
    pickupPersonName: row.pickup_person_name || "",
    cnrDateSent: toInputDate(row.cnr_date_sent),
    recentNotes: extras.recentNotes || [],
    hasActiveReminder: Boolean(extras.hasActiveReminder),
    creationSource: row.creation_source || "manual",
    companyPortalStatus: extras.companyPortalStatus || null,
    companyPortalOrderId: extras.companyPortalOrderId || null,
    facilityNotInSystem: false,
    newFacilityRequest: null,
    pendingFacilitySearchFee: 0,
    portalStatus: extras.portalStatus || null,
    portalStatusLabel: extras.portalStatusLabel || null,
    batchChosenFacilityId: row.batch_chosen_facility_id
      ? String(row.batch_chosen_facility_id)
      : "",
    extractedFacilityId: row.extracted_facility_id
      ? String(row.extracted_facility_id)
      : "",
    extractedFacilityName: row.extracted_facility_name || "",
    facilityMismatch: Boolean(Number(row.facility_mismatch)),
  };

  if (extras.personalRequest) {
    const personalRequest = extras.personalRequest;
    mapped.driverLicenseNumber = personalRequest.driver_license_number || "";
    mapped.hasDriverLicenseDocument = Boolean(
      personalRequest.driver_license_storage_path
    );
    mapped.hasPersonalDocument = mapped.hasDriverLicenseDocument;
  }

  return appendOrderCompletenessFields(
    mapped,
    row,
    orderRecords,
    extras.personalRequest || null
  );
}

function mapDocument(doc) {
  return {
    id: doc.id,
    documentName: doc.document_name || "",
    originalFileName: doc.original_file_name || "",
    mimeType: doc.mime_type || "",
    storagePath: doc.storage_path || "",
    url: doc.storage_path ? `/uploads/${doc.storage_path}` : "",
    fileSizeBytes: doc.file_size_bytes ?? null,
    uploadedAt: doc.uploaded_at || null,
  };
}

function mapWorkflowStage(stage) {
  return {
    id: stage.id,
    stageName: stage.stage_name,
    stageStatus: stage.stage_status,
    completedAt: stage.completed_at || null,
  };
}

function normalizeNoteText(text) {
  return `${text || ""}`.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function mapActivityLog(log, timeZone = config.businessTimezone) {
  const callbackAt = toUtcIso(log.callback_date);
  const fallbackInstant =
    log.updated_at || log.activity_date || log.created_at || null;

  return {
    id: `order-${log.id}`,
    source: "order",
    date: toShortDate(log.activity_date),
    displayDate: toShortDate(log.activity_date),
    by: log.author_name || "—",
    action: callbackAt ? "Reminder" : "Note",
    callback: callbackAt
      ? formatUtcInstantDisplay(callbackAt, timeZone)
      : "",
    note: expandCalledbackNoteText(log.note, timeZone, fallbackInstant),
    module: "Orders",
    attachmentUrl: log.attachment_path
      ? `/uploads/${log.attachment_path}`
      : "",
    activityDate: log.activity_date,
  };
}

function mapNote(note, timeZone = config.businessTimezone) {
  const callbackAt = toUtcIso(note.callback_date);
  const calledAtFallback =
    Number(note.is_called) && (note.updated_at || note.note_date)
      ? note.updated_at || note.note_date
      : null;

  return {
    id: note.id,
    note: expandCalledbackNoteText(note.note, timeZone, calledAtFallback),
    authorName: note.author_name || "",
    createdBy: note.created_by || null,
    noteDate: note.note_date || null,
    noteDateAt: toUtcIso(note.note_date),
    callbackDate: callbackAt
      ? formatUtcInstantDisplay(callbackAt, timeZone)
      : null,
    callbackAt,
    isCalled: Boolean(note.is_called),
    attachmentPath: note.attachment_path || "",
    attachmentUrl: note.attachment_path
      ? `/uploads/${note.attachment_path}`
      : "",
  };
}

function mapReminderRow(row, timeZone = config.businessTimezone) {
  const applicant = buildFullName(
    row.applicant_first_name,
    row.applicant_middle_name,
    row.applicant_last_name
  );
  const callbackAt = toUtcIso(row.callback_date);
  const calledAtFallback =
    Number(row.is_called) && (row.updated_at || row.note_date)
      ? row.updated_at || row.note_date
      : null;

  return {
    noteId: row.note_id,
    orderId: row.order_id,
    orderNumber: row.order_number || "",
    caseNumber: row.case_number || row.order_number || "",
    date: toShortDate(row.note_date),
    by: row.author_name || "—",
    createdBy: row.created_by || null,
    note: expandCalledbackNoteText(row.note, timeZone, calledAtFallback),
    applicant: applicant || "—",
    callbackDate: callbackAt,
    callbackDateDisplay: callbackAt
      ? formatUtcInstantDisplay(callbackAt, timeZone)
      : "",
    callbackAt,
    isCalled: Boolean(row.is_called),
    status: Boolean(row.is_called) ? "callbacked" : "not_callbacked",
    attachmentPath: row.attachment_path || "",
    attachmentUrl: row.attachment_path ? `/uploads/${row.attachment_path}` : "",
  };
}

function mapGlobalOrderActivityLog(row) {
  const mapped = mapLogRow(row);
  const details = stripOrderIdTag(mapped.details);

  return {
    id: `global-${mapped.id}`,
    source: "global",
    date: mapped.date,
    displayDate: mapped.displayDate || mapped.date,
    by: mapped.performedBy || "—",
    action: mapped.action || "",
    callback: "",
    note: details,
    module: mapped.module || "Orders",
    attachmentUrl: "",
    activityDate: mapped.createdAt,
  };
}

function getActivityTimestamp(log) {
  const value = log.activityDate || log.activity_date || log.created_at;

  if (!value) return 0;

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

function mergeOrderActivityLogs(orderLogs = [], globalLogs = []) {
  const seen = new Set();

  orderLogs.forEach((log) => {
    seen.add(String(log.id));
    const key = `${normalizeNoteText(log.note)}|${log.date}|${log.by}|${log.action}`;
    seen.add(key);
  });

  const supplemental = globalLogs.filter((log) => {
    if (seen.has(String(log.id))) {
      return false;
    }

    const key = `${normalizeNoteText(log.note)}|${log.date}|${log.by}|${log.action}`;
    return !seen.has(key);
  });

  return [...orderLogs, ...supplemental].sort(
    (a, b) => getActivityTimestamp(b) - getActivityTimestamp(a)
  );
}

function mapOrderDetail(
  row,
  payments = [],
  documents = [],
  workflowStages = [],
  notes = [],
  invoiceRow = null,
  xrayRow = null,
  orderRecords = [],
  personalRequest = null
) {
  const paymentSummary = invoiceService.mapOrderPaymentsSummary(payments);
  const paymentForm = enrichPaymentDueFields(
    mapPaymentsToForm(payments),
    invoiceRow,
    xrayRow,
    payments
  );
  const mappedRecords = mapOrderRecords(orderRecords);
  const primaryUploaded = mappedRecords.find((record) => record.hasFile);
  const rush = calculateOrderRushLevel(row.created_at);
  const writeOffState = resolveOrderWriteOffState(row, invoiceRow, xrayRow);

  const mapped = {
    id: row.id,
    dbId: row.id,
    orderNumber: row.order_number || "",
    status: writeOffState.status,
    statusBeforeInactive: row.status_before_inactive || "",
    cancelReason: row.cancel_reason || "",
    cancelledAt: row.cancelled_at || null,
    deletedAt: row.deleted_at || null,
    deleteReason: row.delete_reason || "",
    isSubpoena: readHasSubpoena(row),
    isRecords: hasAnyRecordsRequested(orderRecords),
    isWriteOffs: writeOffState.isWriteOffs,
    workflowStages: workflowStages.map(mapWorkflowStage),
    notes: notes.map(mapNote),
    facility: row.facility_id ? String(row.facility_id) : "",
    facilityName: row.facility_name || "",
    facilityIsAutoCreated: Boolean(Number(row.facility_is_auto_created)),
    facilityProfileIncomplete: isFacilityProfileIncomplete({
      facility_name: row.facility_name || "",
      is_auto_created: row.facility_is_auto_created,
      email: row.facility_email,
    }),
    batchChosenFacilityId: row.batch_chosen_facility_id
      ? String(row.batch_chosen_facility_id)
      : "",
    extractedFacilityId: row.extracted_facility_id
      ? String(row.extracted_facility_id)
      : "",
    extractedFacilityName: row.extracted_facility_name || "",
    facilityMismatch: Boolean(Number(row.facility_mismatch)),
    providerId: row.provider_id ? String(row.provider_id) : "",
    providerName: row.provider_name || "",
    type: resolveOrderTypeForForm(row, orderRecords),
    recordTypes: [
      ...new Set(orderRecords.map((record) => record.record_type).filter(Boolean)),
    ],
    orderRecords: mappedRecords,
    allRecordsUploaded: allOrderRecordsUploaded(orderRecords),
    court: row.court || "",
    caseNumber: row.case_number || "",
    recNumber: row.rec_number || "",
    orderRef: row.order_ref || "",
    ssn: formatSsnLastFourDisplay(row.ssn_last_four),
    dob: toInputDate(row.dob),

    firstName: row.applicant_first_name || "",
    middleName: row.applicant_middle_name || "",
    lastName: row.applicant_last_name || "",
    aka: row.applicant_aka || "",
    defendant: row.defendant || "",
    injuryType: row.injury_type || "",
    injuryDate: toInputDate(row.injury_date),
    injuryDateBegin: toInputDate(row.injury_date_begin),
    injuryDateEnd: toInputDate(row.injury_date_end),
    doiDisplay: formatDoiDisplay(row),
    hasDoi: hasDoi(row),

    documentName: "",
    subpoenaFile: null,
    additionalDocumentFile: null,
    subpoenaStoragePath: row.subpoena_storage_path || null,
    subpoenaUrl: buildSubpoenaUrl(row.subpoena_storage_path),
    subpoenaUploadedAt: row.subpoena_uploaded_at || null,
    subpoenaUploadedAtDisplay: toShortDate(row.subpoena_uploaded_at),
    medicalRecordsStoragePath: primaryUploaded?.storagePath || null,
    medicalRecordsUrl: primaryUploaded?.storageUrl || null,
    documents: documents.map(mapDocument),

    serveCompanyName: row.serve_company_name || "",
    address: row.serve_address || "",
    zip: sanitizeZip(row.serve_zip || ""),
    city: row.serve_city || "",
    state: row.serve_state || "",
    phone: row.serve_phone || "",
    fax: row.serve_fax || "",
    email: row.serve_email || row.provider_email || "",

    contact1Name: row.contact1_name || "",
    contact1Title: row.contact1_title || "",
    contact1Phone: row.contact1_phone || "",
    contact1Fax: row.contact1_fax || "",
    contact1Email: row.contact1_email || "",

    contact2Name: row.contact2_name || "",
    contact2Title: row.contact2_title || "",
    contact2Phone: row.contact2_phone || "",
    contact2Fax: row.contact2_fax || "",
    contact2Email: row.contact2_email || "",

    dateServed: toInputDate(row.date_served),
    depoDueDate: toInputDate(row.depo_due_date),
    deliveryDate: toInputDate(row.delivery_date),
    subpoenaDate: toInputDate(row.subpoena_date),
    dateRequested: toInputDate(row.date_requested),
    createdAt: row.created_at || null,
    rushLevel: rush.level,
    rushLabel: rush.label,
    readyDate: toInputDate(row.ready_date),
    recordsDownloaded: Boolean(row.records_downloaded_at),
    recordsDownloadedAt: row.records_downloaded_at || null,
    recordsDownloadedAtDisplay: toShortDate(row.records_downloaded_at),
    invoiceDate: toInputDate(row.invoice_date || invoiceRow?.invoice_date),
    xrayInvoiceDate: toInputDate(
      row.xray_invoice_date || xrayRow?.xray_invoice_date
    ),

    medicalRecords: orderRecords.some((record) => record.record_type === "medical"),
    billingRecords: orderRecords.some((record) => record.record_type === "billing"),
    employmentRecords: orderRecords.some(
      (record) => record.record_type === "employment"
    ),
    xrays: orderRecords.some((record) => record.record_type === "xrays"),
    otherRecord: orderRecords.some((record) => record.record_type === "other"),

    specificRecord: row.specific_record || "",
    specificDoctor: row.specific_doctor || "",
    specificDoctorIsDefault: Boolean(Number(row.specific_doctor_is_default)),
    fullAddress: row.full_address || "",
    driverLicenseNumber: personalRequest?.driver_license_number || "",
    hasDriverLicenseDocument: Boolean(personalRequest?.driver_license_storage_path),
    hasPersonalDocument: Boolean(
      personalRequest?.driver_license_storage_path ||
        (Array.isArray(documents) && documents.length > 0)
    ),

    certificateNoRecords: Boolean(row.certificate_no_records),
    cnrReason: row.cnr_reason || "",
    cnrDelivery: row.cnr_delivery || "",
    cnrDateSent: toInputDate(row.cnr_date_sent),
    cnrMemo: Boolean(row.cnr_memo),

    ...paymentForm,
    paymentLines: paymentSummary.paymentLines,
    orderAmountPaid: paymentSummary.orderAmountPaid,
    invoiceFees: invoiceService.mapOrderInvoiceFees(invoiceRow, xrayRow, payments),
  };

  return appendOrderCompletenessFields(
    mapped,
    row,
    orderRecords,
    personalRequest
  );
}

function parseExcludeCompleted(value) {
  if (value === true || value === 1) return true;
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

async function getAllOrders(query = {}) {
  const filters = {};
  const creationSource = String(query.creationSource || "")
    .trim()
    .toLowerCase();

  if (creationSource === "company_portal") {
    filters.creationSource = "company_portal";
    // Best-effort: ensure paid portal orders have internal rows for tooling.
    // Only runs when the company-portal list is explicitly requested.
    try {
      const companyPortalInternalSyncService = require("./companyPortalInternalSyncService");
      await companyPortalInternalSyncService.backfillUnlinkedPaidPortalOrders({
        limit: 50,
      });
      await companyPortalInternalSyncService.backfillMissingPortalPrepayments({
        limit: 200,
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn(
        "[company-portal] backfill skipped:",
        error.message || error
      );
    }
  } else if (creationSource === "personal_portal") {
    filters.creationSource = "personal_portal";
  } else {
    // Default / "internal": keep Orders & Reports free of portal work.
    filters.excludeCreationSource = "company_portal";
  }

  if (query.facility) {
    filters.facilityId = assertPositiveInt(query.facility, "facility");
  }

  if (query.company && `${query.company}`.trim()) {
    filters.company = sanitizeSearchText(query.company, { maxLength: 255 });
  }

  const PERSONAL_PORTAL_STATUSES = new Set([
    "in_process",
    "invoice",
    "paid",
    "released",
    "pending_payment",
  ]);
  const COMPANY_PORTAL_STATUS_MAP = {
    in_process: "In Process",
    invoice: "Invoice",
    paid: "Paid",
    released: "Released",
    no_facility: "No facility",
  };
  const statusRaw = `${query.portalStatus || query.status || ""}`.trim();
  const statusKey = statusRaw.toLowerCase();

  if (filters.creationSource === "personal_portal") {
    if (PERSONAL_PORTAL_STATUSES.has(statusKey)) {
      filters.portalStatus = statusKey;
    }
  } else if (filters.creationSource === "company_portal") {
    if (COMPANY_PORTAL_STATUS_MAP[statusKey]) {
      filters.companyPortalStatus = COMPANY_PORTAL_STATUS_MAP[statusKey];
    }
  } else if (query.status === "ready") {
    filters.readyFilter = true;
  } else if (statusKey === "unpaid" || statusKey === "paid") {
    // Invoice due-amount filters — not orders.status values.
    filters.paymentDueFilter = statusKey;
  } else if (statusKey === "no_subpoena") {
    // Flag/file filter — not an orders.status ENUM value.
    filters.noSubpoenaFilter = true;
  } else if (statusKey === "no_records") {
    // Certificate of No Records flag — not an orders.status ENUM value.
    filters.noRecordsFilter = true;
  } else if (query.status && STATUS_FILTER_MAP[query.status]) {
    filters.status = STATUS_FILTER_MAP[query.status];
  }

  if (parseExcludeCompleted(query.excludeCompleted)) {
    // Company portal "Released" is mirrored as internal "Completed". When staff
    // explicitly filters Released, keep those rows visible on Reports.
    if (filters.companyPortalStatus !== "Released") {
      filters.excludeCompleted = true;
    }
  }

  const rushRaw = `${query.rushLevel || ""}`.trim();
  if (rushRaw && RUSH_LEVEL_VALUES.has(rushRaw)) {
    filters.rushLevel = rushRaw;
  }

  const sortDir = `${query.sortDir || query.createdSortDir || ""}`
    .trim()
    .toLowerCase();
  if (sortDir === "asc" || sortDir === "desc") {
    filters.sortDir = sortDir;
  }

  if (query.year) {
    const year = Number(query.year);

    if (Number.isFinite(year)) {
      filters.year = year;
    }
  }

  if (query.period) {
    const periodFrom = resolveOrderPeriodStartDate(`${query.period}`.trim());

    if (periodFrom) {
      filters.periodFrom = periodFrom;
    }
  }

  const createdFrom = parseOptionalIsoDate(query.createdFrom, "createdFrom");
  const createdTo = parseOptionalIsoDate(query.createdTo, "createdTo");
  assertReportDateRange(createdFrom, createdTo);

  if (createdFrom) {
    filters.createdFrom = createdFrom;
  }

  if (createdTo) {
    filters.createdTo = createdTo;
  }

  if (query.search && `${query.search}`.trim()) {
    filters.search = sanitizeSearchText(query.search);
  }

  if (query.limit) {
    const limit = Number(query.limit);
    if (Number.isFinite(limit) && limit > 0) {
      filters.limit = limit;
    }
  }

  const paginationMode = String(query.pagination || "").toLowerCase();
  const useKeysetPagination = paginationMode === "keyset";
  const useOffsetPagination = paginationMode === "offset";
  const pageSize = parseReportPageSize(query.pageSize || filters.limit);
  const cursorValue = parseOptionalCursor(query.cursor);
  const cursorRaw = Number(cursorValue);
  const cursorId = Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : null;

  let rows = [];
  let pagination = null;
  if (useKeysetPagination) {
    const keysetResult = await Order.findAllKeyset({
      ...filters,
      pageSize,
      cursor: cursorValue,
      cursorId,
    });
    rows = keysetResult.rows;
    pagination = {
      type: "keyset",
      pageSize: keysetResult.pageSize,
      hasMore: keysetResult.hasMore,
      nextCursor: keysetResult.nextCursor,
    };
  } else if (useOffsetPagination) {
    // Additive page/offset mode for numbered navigation (e.g. facility Orders modal).
    // Does not change keyset or legacy unpaginated callers.
    const pageRaw = Number(query.page || 1);
    const page =
      Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
    filters.limit = pageSize;
    filters.offset = (page - 1) * pageSize;

    const [pageRows, total] = await Promise.all([
      Order.findAll(filters),
      Order.countAll(filters),
    ]);
    rows = pageRows;
    pagination = {
      type: "offset",
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize) || 1),
    };
  } else {
    rows = await Order.findAll(filters);
  }

  const orderIds = rows.map((row) => row.id);
  const [
    stages,
    invoicesByOrderId,
    xrayByOrderId,
    paymentRows,
    orderRecordRows,
    recentNotesByOrderId,
    activeReminderByOrderId,
    portalByOrderId,
  ] = await Promise.all([
    Order.findWorkflowStagesByOrderIds(orderIds),
    invoiceService.getStandardInvoicesByOrderIds(orderIds),
    invoiceService.getXrayDetailsByOrderIds(orderIds),
    Order.findPaymentsByOrderIds(orderIds),
    OrderRecord.findByOrderIds(orderIds),
    Order.findRecentNotesByOrderIds(orderIds, 2),
    Order.findActiveReminderFlagsByOrderIds(orderIds),
    PersonalRequestOrder.findPortalStatusesByOrderIds(orderIds),
  ]);

  const PORTAL_STATUS_LABELS = {
    pending_payment: "Pending Payment",
    in_process: "In Process",
    invoice: "Invoice",
    paid: "Paid",
    released: "Released",
  };

  const stagesByOrderId = stages.reduce((acc, stage) => {
    if (!acc[stage.order_id]) acc[stage.order_id] = [];
    acc[stage.order_id].push(stage);
    return acc;
  }, {});

  const paymentsByOrderId = paymentRows.reduce((acc, payment) => {
    if (!acc[payment.order_id]) acc[payment.order_id] = [];
    acc[payment.order_id].push(payment);
    return acc;
  }, {});

  const recordsByOrderId = orderRecordRows.reduce((acc, record) => {
    if (!acc[record.order_id]) acc[record.order_id] = [];
    acc[record.order_id].push(record);
    return acc;
  }, {});

  const mappedOrders = rows.map((row) => {
    const invoiceRow = invoicesByOrderId[row.id] || null;
    const xrayRow = xrayByOrderId[row.id] || null;
    const portal = portalByOrderId[row.id] || null;
    const portalStatus =
      portal?.portal_status ||
      (row.creation_source === "personal_portal" ? "in_process" : null);
    const portalStatusLabel = portalStatus
      ? PORTAL_STATUS_LABELS[portalStatus] || portalStatus
      : null;

    return mapOrderListRow(
      row,
      stagesByOrderId[row.id] || [],
      invoiceRow,
      xrayRow,
      paymentsByOrderId[row.id] || [],
      recordsByOrderId[row.id] || [],
      {
        recentNotes: (recentNotesByOrderId[row.id] || []).map(mapNote),
        hasActiveReminder: Boolean(activeReminderByOrderId[row.id]),
        portalStatus,
        portalStatusLabel,
        personalRequest: portal,
        timezone: query.timezone || null,
      }
    );
  });

  if (filters.creationSource === "company_portal") {
    const companyPortalInternalSyncService = require("./companyPortalInternalSyncService");
    const {
      enrichCompanyPortalOrderStageMeta,
      maybeAdvanceCompanyPortalAfterInvoicesPaid,
      resolveEffectiveCompanyPortalStatus,
      canCompanyPortalScanRecords,
      canCompanyPortalEmailRecords,
    } = require("./companyPortalStageHooks");
    const [statusMap, stageMetaMap] = await Promise.all([
      companyPortalInternalSyncService.getCompanyPortalStatusMap(orderIds),
      enrichCompanyPortalOrderStageMeta(orderIds),
    ]);

    for (const order of mappedOrders) {
      const orderId = Number(order.dbId);
      let meta = statusMap.get(orderId);
      const stageMeta = stageMetaMap.get(orderId) || {};
      let portalStatus = meta?.companyPortalStatus || null;

      if (!meta) {
        try {
          const resolved =
            await companyPortalInternalSyncService.resolveCompanyPortalOrderForInternalOrder(
              orderId
            );
          if (resolved.portalOrder) {
            meta = {
              companyPortalOrderId: resolved.portalOrder.id,
              companyPortalStatus: resolved.portalOrder.status,
              companyPortalPaymentStatus: resolved.portalOrder.payment_status,
            };
            statusMap.set(orderId, meta);
            portalStatus = resolved.portalOrder.status;
          }
        } catch {
          // Keep row usable even if auto-link fails.
        }
      }

      if (meta && stageMeta.allInvoicesPaid && portalStatus === "Invoice") {
        try {
          const advanced = await maybeAdvanceCompanyPortalAfterInvoicesPaid(
            orderId
          );
          portalStatus = advanced?.status || portalStatus;
        } catch {
          // Keep stored status; effective status still resolves for UI.
        }
      }

      const effectiveStatus = resolveEffectiveCompanyPortalStatus(
        portalStatus,
        stageMeta
      );
      const hasUploadedRecords = Boolean(
        order.records?.anyRecordsUploaded || order.records?.hasMedicalRecords
      );
      const hasAllRecordsUploaded = Boolean(order.records?.allRecordsUploaded);

      if (meta) {
        order.companyPortalOrderId = meta.companyPortalOrderId;
        order.companyPortalStatus = effectiveStatus || portalStatus;
        order.companyPortalPaymentStatus = meta.companyPortalPaymentStatus;
      } else if (effectiveStatus) {
        order.companyPortalStatus = effectiveStatus;
      }

      order.companyPortalInvoiceSent = Boolean(stageMeta.invoiceSent);
      order.companyPortalAllInvoicesPaid = Boolean(stageMeta.allInvoicesPaid);
      order.companyPortalCanScanRecords = canCompanyPortalScanRecords(
        portalStatus,
        stageMeta,
        hasAllRecordsUploaded
      );
      order.companyPortalCanEmailRecords = canCompanyPortalEmailRecords(
        portalStatus,
        stageMeta,
        hasUploadedRecords
      );
    }

    // Flag orders whose facility is not in our internal system (external
    // company requested a new-facility search that is still pending).
    const portalOrderIds = mappedOrders
      .map((order) => Number(order.companyPortalOrderId))
      .filter((id) => Number.isFinite(id) && id > 0);

    if (portalOrderIds.length) {
      const CompanyPortalNewFacility = require("../models/CompanyPortalNewFacility");
      const newFacilityMap = await CompanyPortalNewFacility.findByPortalOrderIds(
        portalOrderIds
      );

      for (const order of mappedOrders) {
        const portalOrderId = Number(order.companyPortalOrderId);
        const row = newFacilityMap.get(portalOrderId);
        if (!row) continue;

        const searchFeeAmount = Number(row.search_fee_amount) || 0;
        // Fee is still owed when the facility was located/linked but the $5
        // search fee has not yet been rolled into a regular invoice.
        const feePending =
          row.status === "linked" && !row.invoice_billed_at && searchFeeAmount > 0;

        order.newFacilityRequest = {
          id: row.id,
          status: row.status,
          facilityName: row.facility_name || "",
          facilityAddress: row.facility_address || "",
          facilityCity: row.facility_city || "",
          facilityState: row.facility_state || "",
          facilityZip: sanitizeZip(row.facility_zip || ""),
          treatingDoctor: row.treating_doctor || "",
          searchFeeAmount,
          internalFacilityId: row.internal_facility_id || null,
          feeBilled: Boolean(row.invoice_billed_at),
          feePending,
        };
        // Amount that will be auto-added to the next regular invoice for this
        // external company order (0 when nothing is owed).
        order.pendingFacilitySearchFee = feePending ? searchFeeAmount : 0;
        // "Not in system" while the request is still pending (not yet linked
        // to a created internal facility and not cancelled).
        order.facilityNotInSystem = row.status === "pending";
      }
    }
  }

  try {
    const personalPortalService = require("./personalPortalService");
    await personalPortalService.enrichOrdersWithPersonalFacilitySearchFees(
      mappedOrders
    );
  } catch (_personalFeeError) {
    // Non-blocking
  }

  if (!useKeysetPagination && !useOffsetPagination) {
    return mappedOrders;
  }

  return {
    orders: mappedOrders,
    pagination,
  };
}

async function getOrderStats() {
  const row = await Order.countStats();

  return {
    totalOrders: Number(row.total_orders) || 0,
    activeCases: Number(row.active_cases) || 0,
    readyToPickup: Number(row.ready_to_pickup) || 0,
    completed: Number(row.completed) || 0,
  };
}

async function resolvePersonalPortalPrepaymentReceipt(orderId, payments = []) {
  const prepayment = payments.find((row) => row.payment_type === "prepayment");
  const currentCheck = `${prepayment?.check_number || ""}`.trim();
  const paidAmount = Number(prepayment?.amount);
  const isPaid =
    Number(prepayment?.is_paid) === 1 ||
    (Number.isFinite(paidAmount) && paidAmount > 0);

  // Unpaid personal orders should leave Receipt Number empty.
  if (!prepayment || !isPaid) {
    return "";
  }

  if (currentCheck && currentCheck !== "STRIPE-PORTAL") {
    return currentCheck;
  }

  const PersonalRequestStripePayment = require("../models/PersonalRequestStripePayment");
  const stripePaymentService = require("./stripePaymentService");

  const stripePayment =
    await PersonalRequestStripePayment.findSucceededProcessingFeeByOrderId(
      orderId
    );

  if (stripePayment?.stripe_charge_id) {
    const receiptNumber = await stripePaymentService.fetchStripeReceiptNumber(
      stripePayment.stripe_charge_id
    );
    if (receiptNumber) {
      return receiptNumber;
    }
  }

  const pool = getPool();
  const [onlineRows] = await pool.execute(
    `SELECT stripe_charge_id
     FROM stripe_online_payments
     WHERE order_id = :orderId
       AND status = 'succeeded'
     ORDER BY paid_at DESC, id DESC
     LIMIT 1`,
    { orderId }
  );

  const onlineChargeId = onlineRows[0]?.stripe_charge_id;
  if (onlineChargeId) {
    const receiptNumber =
      await stripePaymentService.fetchStripeReceiptNumber(onlineChargeId);
    if (receiptNumber) {
      return receiptNumber;
    }
  }

  return currentCheck || "";
}

async function getOrderById(id) {
  // Include Cancelled/Deleted so staff can open them in read-only view.
  const order = await Order.findByIdRaw(id);

  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  const payments = await Order.findPaymentsByOrderId(order.id);
  const documents = await Order.findDocumentsByOrderId(order.id);
  const workflowStages = await Order.findWorkflowStagesByOrderId(order.id);
  const notes = await Order.findNotesByOrderId(order.id);
  const invoiceRow = await Invoice.findByOrderId(order.id);
  const xrayRow = await InvoiceXray.findByOrderId(order.id);
  const orderRecords = await OrderRecord.findByOrderId(order.id);

  let personalRequest = null;
  if (order.creation_source === "personal_portal") {
    personalRequest = await PersonalRequestOrder.findByOrderId(order.id);
  }

  const mapped = mapOrderDetail(
    order,
    payments,
    documents,
    workflowStages,
    notes,
    invoiceRow,
    xrayRow,
    orderRecords,
    personalRequest
  );

  if (mapped.creationSource === "personal_portal") {
    mapped.prepaymentCheck = await resolvePersonalPortalPrepaymentReceipt(
      order.id,
      payments
    );

    try {
      const personalPortalService = require("./personalPortalService");
      await personalPortalService.enrichOrdersWithPersonalFacilitySearchFees([
        mapped,
      ]);
    } catch (_feeError) {
      // Non-blocking
    }

    if (personalRequest) {
      const license = `${personalRequest.driver_license_number || ""}`.trim();
      if (license) {
        mapped.driverLicenseNumber = license;
      }
      if (personalRequest.driver_license_storage_path) {
        mapped.hasDriverLicenseDocument = true;
        mapped.hasPersonalDocument = true;
      }
    }
  }

  return mapped;
}

async function resolveAuthorName(actorId) {
  if (!actorId) return "System";

  try {
    const employee = await Employee.findById(actorId);
    return employee?.name || "System";
  } catch {
    return "System";
  }
}

async function getOrderNotes(
  orderId,
  {
    includeCalled = false,
    noteId = null,
    actorId = null,
    actorRole = null,
    pagination = null,
    cursor = null,
    pageSize = 10,
    fromDate = null,
    toDate = null,
    timezone = null,
  } = {}
) {
  const order = await Order.findById(orderId);
  const timeZone = timezone || config.businessTimezone;

  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  if (noteId) {
    const note = await Order.findNoteById(noteId);

    if (!note || String(note.order_id) !== String(order.id)) {
      throw new ApiError(404, "Note not found");
    }

    const isAdmin = String(actorRole || "").toLowerCase() === "admin";
    if (
      !isAdmin &&
      actorId &&
      Number(note.created_by) !== Number(actorId)
    ) {
      throw new ApiError(403, "You can only access your own notes");
    }

    return [mapNote(note, timeZone)];
  }

  const useKeysetPagination = String(pagination || "").toLowerCase() === "keyset";
  const pendingOnly = includeCalled ? false : true;

  if (!useKeysetPagination) {
    const notes = await Order.findNotesByOrderId(order.id, pendingOnly);
    return notes.map((row) => mapNote(row, timeZone));
  }

  const keyset = await Order.findNotesByOrderIdKeyset(order.id, {
    pendingOnly,
    cursorId: cursor,
    limit: pageSize,
    fromDate,
    toDate,
  });

  return {
    notes: keyset.rows.map((row) => mapNote(row, timeZone)),
    pagination: {
      type: "keyset",
      pageSize: keyset.pageSize,
      hasMore: keyset.hasMore,
      nextCursor: keyset.nextCursor,
    },
  };
}

async function getOrderReminders(
  user,
  { scope = "my", limit = 500, timezone = null } = {}
) {
  const isAdmin = String(user?.role || "").toLowerCase() === "admin";
  const normalizedScope = String(scope || "my").toLowerCase();
  const includeAll = isAdmin && normalizedScope === "all";
  const timeZone = timezone || config.businessTimezone;

  const rows = await Order.findReminders({
    createdBy: includeAll ? null : user?.id || null,
    limit,
  });

  return rows.map((row) => mapReminderRow(row, timeZone));
}

async function addOrderNote(orderId, data, actorId, file, options = {}) {
  const order = await Order.findById(orderId);

  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  const noteText = trimOrNull(data.note, { maxLength: FIELD_LIMITS.ORDER_NOTE });

  if (!noteText) {
    throw new ApiError(400, "Note text is required");
  }

  const authorName = await resolveAuthorName(actorId);
  const callbackAt = resolveCallbackAtUtc(
    data.callbackDate,
    options.timezone || config.businessTimezone
  );
  const timeZone = options.timezone || config.businessTimezone;

  const attachmentPath = nestOrderUploadPath(
    toRelativeStoragePath(file),
    actorId,
    order.order_number
  );

  const noteId = await Order.createNote({
    orderId: order.id,
    createdBy: actorId || null,
    authorName,
    note: noteText,
    callbackDate: callbackAt,
    attachmentPath,
    isCalled: 0,
  });

  // Optional admin-only tagging — never blocks or changes core note creation.
  try {
    const orderNoteTagService = require("./orderNoteTagService");
    const taggedEmployeeIds = orderNoteTagService.parseTaggedEmployeeIds(data);
    if (taggedEmployeeIds.length) {
      await orderNoteTagService.attachTagsToNote({
        noteId,
        taggedEmployeeIds,
        taggedBy: actorId || null,
        actorRole: options.actorRole || null,
      });
    }
  } catch (_tagError) {
    // Tagging is additive; note already saved successfully.
  }

  await addOrderActivityLog({
    orderId: order.id,
    actorId,
    authorName,
    note: noteText,
    callbackDate: callbackAt,
    attachmentPath,
  });

  const notes = await Order.findNotesByOrderId(order.id, false);
  return notes.map((row) => mapNote(row, timeZone));
}

function parseBooleanFlag(value) {
  return value === true || value === "true" || value === "1" || value === 1;
}

function buildCallbackLine(date = new Date()) {
  const token = embedUtcInstantToken(date);
  return token ? `Calledback - ${token}` : `Calledback - ${new Date(date).toISOString()}`;
}

function hasCalledbackLine(text) {
  return /\bCalledback\b/i.test(text) || /\bCallback\s*-/i.test(text);
}

async function updateOrderNote(orderId, noteId, data, actorId, file, options = {}) {
  const order = await Order.findById(orderId);
  const timeZone = options.timezone || config.businessTimezone;

  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  const note = await Order.findNoteById(noteId);

  if (!note || String(note.order_id) !== String(order.id)) {
    throw new ApiError(404, "Note not found");
  }

  if (Number(note.is_called)) {
    throw new ApiError(400, "This note has been called back and cannot be edited");
  }

  const employee = await Employee.findById(actorId);
  const isAdmin = String(employee?.role || "").toLowerCase() === "admin";

  if (!isAdmin && Number(note.created_by) !== Number(actorId)) {
    throw new ApiError(403, "You can only update your own notes");
  }

  const markCalled = parseBooleanFlag(data.markCalled);
  let noteText = trimOrNull(data.note, { maxLength: FIELD_LIMITS.ORDER_NOTE });

  if (!noteText) {
    throw new ApiError(400, "Note text is required");
  }

  if (markCalled) {
    if (!hasCalledbackLine(noteText)) {
      const callLine = buildCallbackLine(new Date());
      noteText = noteText ? `${noteText}\n${callLine}` : callLine;
    }
  }

  const authorName = await resolveAuthorName(actorId);
  const attachmentPath = nestOrderUploadPath(
    toRelativeStoragePath(file),
    actorId,
    order.order_number
  );
  const callbackAt = resolveCallbackAtUtc(data.callbackDate, timeZone);

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    await Order.updateNote(connection, note.id, {
      note: noteText,
      callbackDate: callbackAt,
      attachmentPath,
      isCalled: markCalled ? 1 : Number(note.is_called) || 0,
    });

    const updatedNote = await Order.findNoteById(note.id, connection);

    if (markCalled) {
      await Order.createActivityLog(
        {
          orderId: order.id,
          activityDate: new Date(),
          performedBy: actorId || null,
          authorName,
          callbackDate: callbackAt || updatedNote?.callback_date || null,
          note: noteText,
          attachmentPath: updatedNote?.attachment_path || null,
        },
        connection
      );
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    rethrowServiceError(error);
  } finally {
    connection.release();
  }

  const notes = await Order.findNotesByOrderId(order.id, false);
  const activityLogs = await Order.findActivityLogsByOrderId(order.id);

  return {
    notes: notes.map((row) => mapNote(row, timeZone)),
    activityLogs: activityLogs.map((row) => mapActivityLog(row, timeZone)),
  };
}

function mapMergedActivityLogRow(
  row,
  notes = [],
  timeZone = config.businessTimezone
) {
  if (row.log_source === "global") {
    return mapGlobalOrderActivityLog(row);
  }

  let attachmentPath = row.attachment_path;

  if (!attachmentPath) {
    const match = notes.find(
      (note) =>
        note.is_called &&
        note.attachment_path &&
        normalizeNoteText(note.note) === normalizeNoteText(row.note)
    );

    if (match) {
      attachmentPath = match.attachment_path;
    }
  }

  return mapActivityLog({ ...row, attachment_path: attachmentPath }, timeZone);
}

async function getOrderActivityLogs(orderId, query = {}) {
  const order = await Order.findById(orderId);
  const timeZone = query.timezone || config.businessTimezone;

  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  const useKeysetPagination =
    String(query.pagination || "").toLowerCase() === "keyset";
  const pageSizeRaw = Number(query.pageSize || query.limit || 10);
  const pageSize = Number.isFinite(pageSizeRaw)
    ? Math.min(Math.max(pageSizeRaw, 1), 100)
    : 10;
  const cursorRaw = `${query.cursor || ""}`.trim();
  const cursorSortKey = /^\d+$/.test(cursorRaw) ? cursorRaw : null;
  const search = query.search
    ? sanitizeSearchText(query.search) || null
    : null;

  if (!useKeysetPagination) {
    const logs = await Order.findActivityLogsByOrderId(order.id);
    const globalLogs = await ActivityLog.findByOrderId(order.id, {
      orderNumber: order.order_number || null,
    });
    const notes = await Order.findNotesByOrderId(order.id, false);

    const mappedOrderLogs = logs.map((log) =>
      mapMergedActivityLogRow({ ...log, log_source: "order" }, notes, timeZone)
    );
    const mappedGlobalLogs = globalLogs.map(mapGlobalOrderActivityLog);

    return mergeOrderActivityLogs(mappedOrderLogs, mappedGlobalLogs);
  }

  const keyset = await Order.findMergedActivityLogsKeyset(order.id, {
    orderNumber: order.order_number || null,
    cursorSortKey,
    pageSize,
    search,
  });

  const needsNoteLookup = keyset.rows.some(
    (row) => row.log_source === "order" && !row.attachment_path
  );
  const notes = needsNoteLookup
    ? await Order.findNotesByOrderId(order.id, false)
    : [];

  // Keep SQL keyset order — do not re-merge/re-sort (breaks pagination).
  const seenIds = new Set();
  const logs = [];
  for (const row of keyset.rows) {
    const mapped = mapMergedActivityLogRow(row, notes, timeZone);
    if (!mapped?.id || seenIds.has(mapped.id)) continue;
    seenIds.add(mapped.id);
    logs.push(mapped);
  }

  return {
    logs,
    pagination: {
      type: "keyset",
      pageSize: keyset.pageSize,
      hasMore: keyset.hasMore,
      nextCursor: keyset.nextCursor,
    },
  };
}

async function addOrderActivityLog({
  orderId,
  actorId,
  authorName = null,
  note,
  callbackDate = null,
  attachmentPath = null,
}) {
  if (!orderId || !note) {
    return null;
  }

  const resolvedAuthorName =
    authorName || (await resolveAuthorName(actorId));

  return Order.createActivityLog({
    orderId,
    activityDate: new Date(),
    performedBy: actorId || null,
    authorName: resolvedAuthorName,
    callbackDate,
    note,
    attachmentPath,
  });
}

async function getWorkflowStages(orderId) {
  const order = await Order.findById(orderId);

  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  let stages = await Order.findWorkflowStagesByOrderId(order.id);

  // Backfill stages for orders created before this feature existed.
  if (stages.length === 0) {
    const pool = getPool();
    const connection = await pool.getConnection();
    try {
      await Order.seedWorkflowStages(connection, order.id);
    } finally {
      connection.release();
    }
    stages = await Order.findWorkflowStagesByOrderId(order.id);
  }

  return stages.map(mapWorkflowStage);
}

async function updateOrderWorkflowStage(orderId, stageName, stageStatus) {
  const order = await Order.findById(orderId);

  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  if (!WORKFLOW_STAGE_NAMES.includes(stageName)) {
    throw new ApiError(400, "Invalid workflow stage");
  }

  if (!WORKFLOW_STAGE_STATUSES.includes(stageStatus)) {
    throw new ApiError(400, "Invalid workflow stage status");
  }

  const completedAt =
    stageStatus === "complete" || stageStatus === "sent"
      ? new Date()
      : null;

  await Order.upsertWorkflowStage(order.id, stageName, stageStatus, completedAt);

  const stages = await Order.findWorkflowStagesByOrderId(order.id);
  return stages.map(mapWorkflowStage);
}

async function saveOrderDocuments(
  connection,
  { orderId, orderNumber, additionalDocFile, documentName, actorId }
) {
  // A subpoena uploaded with an order is stored directly on the order
  // (orders.subpoena_storage_path). The unprocessed_subpoenas table is
  // reserved for batch-scan parents (order_id NULL, children linked via
  // batch_scan_extracts), so no row is created here.
  if (additionalDocFile) {
    await Order.createAdditionalDocument(connection, {
      orderId,
      documentName: trimOrNull(documentName) || additionalDocFile.originalname,
      originalFileName: additionalDocFile.originalname,
      mimeType: additionalDocFile.mimetype || null,
      storagePath: nestOrderUploadPath(
        toRelativeStoragePath(additionalDocFile),
        actorId,
        orderNumber
      ),
      fileSizeBytes: additionalDocFile.size || null,
      uploadedBy: actorId || null,
    });

    return true;
  }

  return false;
}

function usesDmsPatientOrderNumbers(creationSource) {
  return creationSource !== "personal_portal" && creationSource !== "company_portal";
}

function buildApplicantIdentity(data = {}) {
  return {
    firstName: trimOrNull(data.firstName, { maxLength: FIELD_LIMITS.VARCHAR_100 }),
    middleName: trimOrNull(data.middleName, { maxLength: FIELD_LIMITS.VARCHAR_100 }),
    lastName: trimOrNull(data.lastName, { maxLength: FIELD_LIMITS.VARCHAR_100 }),
    dob: dateOrNull(data.dob),
    ssnLastFour: ssnLastFour(data.ssn || data.ssnLastFour),
  };
}

function maybeStashExternalOrderRef(payload, suppliedExternalNumber) {
  const external = trimOrNull(suppliedExternalNumber, {
    maxLength: FIELD_LIMITS.VARCHAR_50,
  });
  if (!external || isPendingAutoOrderNumber(external)) {
    return;
  }
  if (payload.orderRef) {
    return;
  }
  payload.orderRef = external;
}

async function assertOrderNumberAvailable(
  orderNumber,
  excludeId = null,
  recordTypes = [],
  connection = null
) {
  const existingOrder = await Order.findByOrderNumber(
    orderNumber,
    excludeId,
    connection
  );
  if (!existingOrder) return;

  const typeLabel = Patient.normalizeRecordTypes(recordTypes).join(", ");
  const typeHint = typeLabel
    ? ` for record type(s): ${typeLabel}`
    : "";
  throw new ApiError(
    409,
    `An order with this order number already exists (${orderNumber})${typeHint}`
  );
}

async function resolveOrderNumber(
  connection,
  rawOrderNumber,
  excludeId = null,
  {
    allowAutoPlaceholder = false,
    extractId = null,
    creationSource = "manual",
    applicantIdentity = {},
    existing = null,
    recordTypes = [],
  } = {}
) {
  if (usesDmsPatientOrderNumbers(creationSource)) {
    const existingNumber = trimOrNull(existing?.order_number);
    const existingPatientId = Number(existing?.patient_id) || null;
    const existingSequence = Number(existing?.patient_order_sequence) || null;
    const suppliedExternalNumber = trimOrNull(rawOrderNumber, {
      maxLength: FIELD_LIMITS.VARCHAR_50,
    });
    const normalizedTypes = Patient.normalizeRecordTypes(recordTypes);

    // Existing DMS patient order: rebuild number from current record types
    // (e.g. medical → 0001-1, medical+billing → 0001-1-2).
    if (existingPatientId && existingNumber && !isPendingAutoOrderNumber(existingNumber)) {
      const patient = await Patient.findById(connection, existingPatientId);
      if (patient) {
        const rebuiltNumber = Patient.formatOrderNumber(
          patient.patient_number,
          normalizedTypes,
          existingSequence
        );
        if (rebuiltNumber !== existingNumber) {
          await assertOrderNumberAvailable(
            rebuiltNumber,
            excludeId,
            normalizedTypes,
            connection
          );
        }
        return {
          orderNumber: rebuiltNumber,
          patientId: existingPatientId,
          patientOrderSequence: existingSequence,
          suppliedExternalNumber,
        };
      }

      return {
        orderNumber: existingNumber,
        patientId: existingPatientId,
        patientOrderSequence: existingSequence,
        suppliedExternalNumber,
      };
    }

    // Legacy row with a real number but no patient_id — keep it stable.
    if (existingNumber && !isPendingAutoOrderNumber(existingNumber)) {
      return {
        orderNumber: existingNumber,
        patientId: existingPatientId,
        patientOrderSequence: existingSequence,
        suppliedExternalNumber,
      };
    }

    const allocation = await Patient.allocateOrderNumber(
      connection,
      applicantIdentity,
      normalizedTypes,
      {
        isOrderNumberTaken: async (candidate) => {
          const row = await Order.findByOrderNumber(
            candidate,
            excludeId,
            connection
          );
          return Boolean(row);
        },
      }
    );
    await assertOrderNumberAvailable(
      allocation.orderNumber,
      excludeId,
      normalizedTypes,
      connection
    );

    return {
      orderNumber: allocation.orderNumber,
      patientId: allocation.patientId,
      patientOrderSequence: allocation.patientOrderSequence,
      suppliedExternalNumber,
    };
  }

  let orderNumber = trimOrNull(rawOrderNumber, {
    maxLength: FIELD_LIMITS.VARCHAR_50,
  });

  if (!orderNumber) {
    if (!allowAutoPlaceholder || !Number(extractId)) {
      throw new ApiError(400, "Order number is required");
    }
    orderNumber = `${AUTO_PENDING_ORDER_PREFIX}${Number(extractId)}`;
  }

  const existingOrder = await Order.findByOrderNumber(orderNumber, excludeId);

  if (existingOrder) {
    throw new ApiError(
      409,
      `An order with this order number already exists (${orderNumber})`
    );
  }

  return {
    orderNumber,
    patientId: null,
    patientOrderSequence: null,
    suppliedExternalNumber: null,
  };
}

async function resolveProviderId(connection, data) {
  const companyName = trimOrNull(data.serveCompanyName);

  if (!companyName) {
    return data.providerId ? Number(data.providerId) : null;
  }

  let providerPayload;
  try {
    providerPayload = buildProviderPayload(data);
  } catch {
    return data.providerId ? Number(data.providerId) : null;
  }

  if (data.providerId) {
    const selected = await Provider.findById(Number(data.providerId), connection);
    if (selected) {
      await Provider.update(connection, selected.id, providerPayload);
      return selected.id;
    }
  }

  const { provider } = await findOrCreateProvider(
    { ...data, ...providerPayload },
    connection
  );
  return provider.id;
}

async function resolveFacilityId(connection, data, options = {}) {
  const { allowCreate = true } = options;
  const facilityId = Number(data.facility);
  const facilityName = trimOrNull(data.facilityName);
  const matchPayload = {
    facilityName,
    address: data.facilityAddress || "",
    city: data.facilityCity || "",
    state: data.facilityState || "",
    zipCode: sanitizeZip(data.facilityZip || ""),
  };

  if (Number.isFinite(facilityId) && facilityId > 0) {
    const selected = await Facility.findById(facilityId, connection);
    if (selected) {
      const selectedName = selected.facility_name || "";
      if (
        !facilityName ||
        normalizeFacilityName(facilityName) ===
          normalizeFacilityName(selectedName)
      ) {
        return selected.id;
      }

      // Form ID and typed name disagree — prefer an existing name match when found,
      // otherwise keep the explicitly selected facility id.
      const byName = await Facility.findBestMatch(matchPayload, connection);
      if (byName?.id) return byName.id;
      return selected.id;
    }
  }

  if (!facilityName) {
    return Number.isFinite(facilityId) && facilityId > 0 ? facilityId : null;
  }

  const existing = await Facility.findBestMatch(matchPayload, connection);
  if (existing?.id) return existing.id;

  if (!allowCreate) {
    throw new ApiError(
      400,
      "Cannot create a new facility for this ended personal order. Restore it to In Process first, or select an existing facility."
    );
  }

  // Order create/update must pick an existing facility. Batch scan creates
  // facilities on its own path; do not auto-create incomplete profiles here.
  return null;
}

async function shouldBlockFacilityCreateForOrder(orderRow) {
  // Personal portal orders never auto-create facilities from typed names.
  // Staff must select an existing facility or use Add Facility.
  return orderRow?.creation_source === "personal_portal";
}

function isPersonalPortalPlaceholderFacility(facility) {
  return (
    `${facility?.facility_name || ""}`.trim() ===
    "Personal Portal - Pending Facility"
  );
}

function assertFacilityProfileComplete(facility) {
  if (isFacilityProfileIncomplete(facility)) {
    throw new ApiError(
      400,
      "Complete the facility profile before saving this order"
    );
  }
}

async function assertDoctorBelongsToFacility(facilityId, doctorName) {
  const trimmedName = trimOrNull(doctorName);
  if (!trimmedName) {
    return {
      doctor: null,
      doctorName: null,
      usedDefault: false,
      created: false,
      missingDefault: false,
      doctorMissing: false,
    };
  }

  const facilityService = require("./facilityService");
  const resolved = await facilityService.resolveFacilityDoctor(facilityId, {
    doctorName: trimmedName,
    useDefaultWhenMissing: false,
    allowCreate: false,
  });

  if (!resolved.doctor?.id || !resolved.doctorName) {
    throw new ApiError(400, "Validation failed", [
      {
        field: "specificDoctor",
        message:
          "Select a doctor linked to the selected facility, use the facility default, or clear Specific Doctor",
      },
    ]);
  }

  return resolved;
}

function appendOrderCompletenessFields(
  mappedOrder,
  row,
  orderRecords = [],
  personalRequest = null
) {
  const creationSource = row.creation_source || "manual";
  const isAutoCreated = creationSource === "auto";
  const requiredFieldData = mapOrderRowToRequiredFieldData(row, orderRecords);
  requiredFieldData.creationSource = creationSource;

  if (creationSource === "personal_portal" && personalRequest) {
    const license = `${personalRequest.driver_license_number || ""}`.trim();
    if (license) {
      requiredFieldData.driverLicenseNumber = license;
    }
    if (personalRequest.driver_license_storage_path) {
      requiredFieldData.hasDriverLicenseDocument = true;
      requiredFieldData.hasPersonalDocument = true;
    }
  }

  const missingRequiredFields = [
    ...computeMissingRequiredFields(requiredFieldData, orderRecords),
    ...(mappedOrder.facilityProfileIncomplete ? ["Facility profile"] : []),
  ];

  return {
    ...mappedOrder,
    creationSource,
    missingRequiredFields,
    hasIncompleteRequiredFields: missingRequiredFields.length > 0,
    autoProcessingStatus: isAutoCreated
      ? missingRequiredFields.length > 0
        ? "unprocessed"
        : "processed"
      : null,
  };
}

async function createOrder(data, actorId, files, options = {}) {
  const { allowIncomplete = false, creationSource = "manual" } = options;
  const canAllowIncomplete =
    allowIncomplete === true &&
    (creationSource === "auto" || creationSource === "personal_portal");
  const orderInput = {
    ...data,
    creationSource,
  };

  if (!canAllowIncomplete) {
    assertValidCnrDeliveryDate(orderInput);
  }

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const resolvedFacilityId = await resolveFacilityId(connection, orderInput, {
      allowCreate: creationSource !== "personal_portal",
    });

    if (!resolvedFacilityId) {
      throw new ApiError(400, "Selected facility does not exist");
    }

    orderInput.facility = String(resolvedFacilityId);

    const facility = await Facility.findById(resolvedFacilityId, connection);

    if (!facility) {
      throw new ApiError(400, "Selected facility does not exist");
    }

    if (!canAllowIncomplete) {
      assertFacilityProfileComplete(facility);
      const doctor = await assertDoctorBelongsToFacility(
        resolvedFacilityId,
        orderInput.specificDoctor
      );
      orderInput.specificDoctor = doctor.doctorName || null;
      orderInput.specificDoctorIsDefault = Boolean(
        doctor.doctorName && doctor.usedDefault
      );
    }

    const subpoenaExtractId = Number(orderInput.subpoenaExtractId) || null;
    const applicantIdentity = buildApplicantIdentity(orderInput);
    const recordTypes = resolveRecordTypesFromForm(orderInput);
    if (!recordTypes.length && !canAllowIncomplete) {
      throw new ApiError(400, "At least one record type is required");
    }

    // DMS: one order per selected record type (0001-1, 0001-2, …).
    const shouldSplitByRecordType =
      usesDmsPatientOrderNumbers(creationSource) && recordTypes.length > 1;
    const typesToCreate = shouldSplitByRecordType
      ? recordTypes
      : recordTypes.length
        ? [recordTypes]
        : [[]];

    const subpoenaFile = getUploadedFile(files, "subpoenaFile");
    const additionalDocFile = getUploadedFile(files, "additionalDocumentFile");

    let linkedExtract = null;
    if (subpoenaExtractId) {
      linkedExtract = await batchScanRepository.getExtractById(subpoenaExtractId);
      if (!linkedExtract) {
        throw new ApiError(400, "Subpoena extract not found");
      }
      if (linkedExtract.is_processed) {
        throw new ApiError(
          409,
          "This subpoena extract was already processed into an order"
        );
      }
    }

    const providerId = await resolveProviderId(connection, orderInput);
    const sharedSubpoenaPathFromUpload = toRelativeStoragePath(subpoenaFile);
    let sharedArchivedSubpoenaPath = null;
    const createdOrderIds = [];

    for (let index = 0; index < typesToCreate.length; index += 1) {
      const typeEntry = typesToCreate[index];
      const singleTypes = Array.isArray(typeEntry) ? typeEntry : [typeEntry];
      const singleType = singleTypes[0] || null;
      const typedInput =
        singleType && shouldSplitByRecordType
          ? applySingleRecordTypeToForm(orderInput, singleType)
          : orderInput;

      const resolvedNumber = await resolveOrderNumber(
        connection,
        typedInput.orderNumber,
        null,
        {
          allowAutoPlaceholder: canAllowIncomplete,
          extractId: subpoenaExtractId,
          creationSource,
          applicantIdentity,
          recordTypes: singleTypes,
        }
      );
      const {
        orderNumber,
        patientId,
        patientOrderSequence,
        suppliedExternalNumber,
      } = resolvedNumber;
      const payments = collectPayments(typedInput);

      let subpoenaStoragePath = null;
      if (subpoenaExtractId) {
        if (!sharedArchivedSubpoenaPath) {
          try {
            sharedArchivedSubpoenaPath =
              fileStorage.archiveBatchScanSubpoenaToProcessed(
                linkedExtract.storage_path,
                orderNumber,
                actorId
              );
          } catch (error) {
            throw new ApiError(404, error.message || "Subpoena PDF not found");
          }
        }
        subpoenaStoragePath = sharedArchivedSubpoenaPath;
        fileStorage.deleteUnusedProcessedSubpoenaUpload(
          sharedSubpoenaPathFromUpload,
          sharedArchivedSubpoenaPath
        );
      } else {
        subpoenaStoragePath = sharedSubpoenaPathFromUpload;
      }

      const payload = buildOrderDbPayload(
        applyInjuryFromExtract({ ...typedInput, providerId }, linkedExtract)
      );
      maybeStashExternalOrderRef(payload, suppliedExternalNumber);
      const hasSubpoenaFile = Boolean(subpoenaStoragePath);
      const orderFlags = resolveOrderFlags(typedInput, hasSubpoenaFile);

      const orderId = await Order.create(connection, {
        ...payload,
        patientId,
        patientOrderSequence,
        subpoenaStoragePath,
        subpoenaUploadedAt: hasSubpoenaFile ? new Date() : null,
        orderNumber,
        status: "Active",
        hasNote: 0,
        hasSubpoena: orderFlags.hasSubpoena,
        createdBy: actorId || null,
      });

      if (subpoenaStoragePath) {
        subpoenaStoragePath = await nestAndPersistSubpoenaPath(connection, {
          orderId,
          orderNumber,
          storagePath: subpoenaStoragePath,
          actorId,
        });
        sharedArchivedSubpoenaPath = subpoenaStoragePath;
        if (sharedSubpoenaPathFromUpload) {
          sharedSubpoenaPathFromUpload = subpoenaStoragePath;
        }
      }

      await OrderRecord.syncForOrder(connection, orderId, singleTypes);

      // Payments + extra docs on the first split order only (avoid duplicating money/files).
      const isPrimary = index === 0;
      if (isPrimary) {
        await syncOrderPayments(connection, orderId, typedInput);
        await saveOrderDocuments(connection, {
          orderId,
          orderNumber,
          additionalDocFile,
          documentName: typedInput.documentName,
          actorId,
        });
        if (subpoenaExtractId) {
          await batchScanRepository.linkExtractToOrder(connection, {
            extractId: subpoenaExtractId,
            orderId,
          });
        }
      }

      await Order.seedWorkflowStages(connection, orderId);

      await syncOrderWorkflowFromState(connection, orderId, {
        payments: isPrimary ? payments : [],
        invoiceServiceFee: 0,
      });

      createdOrderIds.push(orderId);
    }

    await connection.commit();

    for (const orderId of createdOrderIds) {
      await maybeSendCnrMemoEmail(orderId, orderInput, null, actorId);
    }

    const orders = [];
    for (const orderId of createdOrderIds) {
      orders.push(await getOrderById(orderId));
    }

    if (orders.length === 1) {
      return orders[0];
    }

    return orders;
  } catch (error) {
    await connection.rollback();
    rethrowServiceError(error);
  } finally {
    connection.release();
  }
}

async function applyDefaultFacilityDoctorIfMissing(payload) {
  const facilityId = Number(payload.facility);
  if (!Number.isFinite(facilityId)) {
    return false;
  }

  const facilityService = require("./facilityService");
  const result = await facilityService.resolveDoctorFromExtractHints(facilityId, {
    specificDoctor: payload.specificDoctor,
  });

  if (result.missingDefault || !result.doctorName) {
    return false;
  }

  payload.specificDoctor = result.doctorName;
  payload.specificDoctorIsDefault = Boolean(result.usedDefault);
  return true;
}

function resolveCustomerFacilityNameForMismatch(orderHints = {}, extract = {}) {
  const { splitNameAndAddress } = require("../utils/addressParseUtils");
  const fromCustomer = splitNameAndAddress(orderHints.customer || extract.customer || "");
  return (
    fromCustomer.name ||
    `${orderHints.customer || extract.customer || ""}`.trim()
  );
}

/** True when batch OCR produced at least one usable order field. */
function hasUsableBatchExtraction(extract = {}, orderHints = {}) {
  const values = [
    orderHints.applicantName,
    orderHints.caseName,
    orderHints.orderNumber,
    orderHints.recNumber,
    orderHints.ssn,
    orderHints.dateOfBirth,
    orderHints.dateOfInjury,
    orderHints.dateOfInjuryText,
    orderHints.customer,
    orderHints.companyName,
    orderHints.companyAddress,
    orderHints.specificDoctor,
    orderHints.doctorAddress,
    orderHints.recordType,
    orderHints.requestedRecord,
    orderHints.subpoenaDate,
    orderHints.dateRequested,
    orderHints.depoDueDate,
    orderHints.amount,
    orderHints.chequeDate,
    orderHints.chequeNumber,
    extract.applicant_name,
    extract.case_name,
    extract.order_number,
    extract.rec_number,
    extract.ssn,
    extract.date_of_birth,
    extract.date_of_injury,
    extract.customer,
    extract.company_name,
    extract.company_address,
    extract.specific_doctor,
    extract.doctor_address,
    extract.record_type,
    extract.requested_record,
    extract.subpoena_date,
    extract.date_requested,
    extract.depo_due_date,
    extract.amount,
    extract.cheque_date,
    extract.cheque_number,
  ];

  return values.some((value) => `${value ?? ""}`.trim() !== "");
}

async function createOrderFromExtract(extractId, actorId, options = {}) {
  const extract = await batchScanRepository.getExtractById(extractId);

  if (!extract) {
    throw new ApiError(404, "Subpoena extract not found");
  }

  if (extract.is_processed) {
    throw new ApiError(409, "This subpoena extract was already processed into an order");
  }

  const chosenFacilityId =
    Number(options.chosenFacilityId) ||
    Number(extract.chosen_facility_id) ||
    null;
  const extractedFacilityId = extract.extracted_facility_id
    ? Number(extract.extracted_facility_id)
    : null;

  const facilities = await Facility.findAll();
  const payload = buildOrderPayloadFromExtractRow(extract, facilities);

  const rawExtraction =
    typeof extract.raw_extraction === "string"
      ? JSON.parse(extract.raw_extraction || "{}")
      : extract.raw_extraction || {};
  const {
    mapSchemaToOrderHints,
    enrichOrderHintsFromRow,
    resolveExtractionSchema,
  } = require("../utils/extractionMapper");

  let orderHints = enrichOrderHintsFromRow(
    mapSchemaToOrderHints(resolveExtractionSchema(rawExtraction)),
    extract
  );

  if (!hasUsableBatchExtraction(extract, orderHints)) {
    const err = new ApiError(422, "No details were extracted from this subpoena");
    err.reason = "no_extraction";
    throw err;
  }

  const providerResolution = await resolveProviderFromHints(orderHints);
  orderHints = providerResolution.orderHints;

  const chosenFacility = chosenFacilityId
    ? await Facility.findById(chosenFacilityId)
    : null;
  const extractedFacilityName = resolveCustomerFacilityNameForMismatch(
    orderHints,
    extract
  );
  const facilityMismatch = resolveBatchFacilityMismatch({
    chosenFacilityId,
    extractedFacilityId,
    chosenFacilityName: chosenFacility?.facility_name || "",
    extractedFacilityName,
  });

  if (providerResolution.provider?.id) {
    payload.providerId = String(providerResolution.provider.id);
  }

  if (orderHints.companyName) {
    payload.serveCompanyName = orderHints.companyName;
  }

  const facilityService = require("./facilityService");
  const { splitNameAndAddress } = require("../utils/addressParseUtils");

  if (chosenFacilityId) {
    if (!chosenFacility) {
      throw new ApiError(400, "Selected facility does not exist");
    }

    let resolvedExtractedFacilityId = extractedFacilityId;

    // PDF facility differs from Batch Scan selection — ensure we have/create
    // that facility (email not required) instead of silently using the chosen one.
    if (
      facilityMismatch &&
      !resolvedExtractedFacilityId &&
      (orderHints.customer || extractedFacilityName)
    ) {
      const { facility } = await facilityService.resolveFacilityFromHints(
        orderHints.customer
          ? orderHints
          : { ...orderHints, customer: extractedFacilityName },
        null,
        { allowCreate: true }
      );
      if (facility?.id) {
        resolvedExtractedFacilityId = Number(facility.id);
      }
    }

    // Always assign the batch-selected facility. Extracted facility is stored
    // only for mismatch messaging in the orders table.
    payload.facility = String(chosenFacilityId);
    payload.facilityName = chosenFacility.facility_name || "";
    payload.batchChosenFacilityId = String(chosenFacilityId);
    payload.extractedFacilityId = resolvedExtractedFacilityId
      ? String(resolvedExtractedFacilityId)
      : "";
    payload.facilityMismatch = Boolean(
      facilityMismatch &&
        resolvedExtractedFacilityId &&
        Number(resolvedExtractedFacilityId) !== Number(chosenFacilityId)
    );
  } else if (orderHints.customer) {
    const { facility } = await facilityService.resolveFacilityFromHints(
      orderHints,
      null,
      { allowCreate: true }
    );
    if (facility) {
      const customerName =
        splitNameAndAddress(orderHints.customer).name || orderHints.customer;
      payload.facility = String(facility.id);
      payload.facilityName = facility.facilityName || customerName;
    }
  } else {
    const { facility } = await facilityService.findOrCreateFacility({
      facilityName: `Unidentified Facility - Extract ${extractId}`,
    });
    payload.facility = String(facility.id);
    payload.facilityName = facility.facilityName;
  }

  payload.subpoenaExtractId = String(extractId);

  if (payload.facility) {
    const doctorResolution = await facilityService.resolveDoctorFromExtractHints(
      payload.facility,
      orderHints,
      { allowCreate: true }
    );
    if (doctorResolution.doctorName) {
      payload.specificDoctor = doctorResolution.doctorName;
      payload.specificDoctorIsDefault = Boolean(doctorResolution.usedDefault);
    }
  }

  return createOrder(payload, actorId, {}, {
    allowIncomplete: true,
    creationSource: "auto",
  });
}

async function autoCreateOrdersFromBatch({ childIds = [], actorId, chosenFacilityId = null }) {
  const created = [];
  const failed = [];

  for (const extractId of childIds) {
    try {
      const createdResult = await createOrderFromExtract(extractId, actorId, {
        chosenFacilityId,
      });
      const orders = Array.isArray(createdResult)
        ? createdResult
        : [createdResult];
      for (const order of orders) {
        created.push({
          extractId,
          orderId: order.id,
          orderNumber: order.orderNumber,
          hasIncompleteRequiredFields: order.hasIncompleteRequiredFields,
          facilityMismatch: Boolean(order.facilityMismatch),
        });
      }
    } catch (error) {
      const message = error.message || "Failed to auto-create order";
      const isNoExtraction =
        error.reason === "no_extraction" ||
        /no details were extracted/i.test(message);
      const isDuplicate =
        !isNoExtraction &&
        (error.statusCode === 409 ||
          /already exists/i.test(message) ||
          /already processed/i.test(message));

      let orderNumber = "";
      const orderNumberMatch = message.match(/\(([^)]+)\)\s*$/);
      if (orderNumberMatch?.[1]) {
        orderNumber = orderNumberMatch[1].trim();
      } else if (!isNoExtraction) {
        try {
          const extract = await batchScanRepository.getExtractById(extractId);
          orderNumber = `${extract?.order_number || ""}`.trim();
        } catch {
          orderNumber = "";
        }
      }

      failed.push({
        extractId,
        orderNumber,
        reason: isNoExtraction
          ? "no_extraction"
          : isDuplicate
            ? "duplicate_order_number"
            : "create_failed",
        message: isNoExtraction
          ? "No details were extracted from this subpoena"
          : isDuplicate
            ? orderNumber
              ? `Duplicate order number ${orderNumber} — order already exists`
              : "Duplicate order — order number already exists"
            : message,
      });
      if (isNoExtraction) {
        logger.warn("Auto order creation skipped — empty extraction", {
          extractId,
        });
      } else {
        logger.error("Auto order creation failed", {
          extractId,
          orderNumber: orderNumber || undefined,
          error: message,
        });
      }
    }
  }

  return { created, failed };
}

async function updateOrderFacility(id, data, actorId) {
  const existing = await Order.findById(id);
  assertOrderEditable(existing);

  const blockCreate = await shouldBlockFacilityCreateForOrder(existing);

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const resolvedFacilityId = await resolveFacilityId(connection, data, {
      allowCreate: !blockCreate,
    });

    if (!resolvedFacilityId) {
      throw new ApiError(400, "Selected facility does not exist");
    }

    const facility = await Facility.findById(resolvedFacilityId, connection);

    if (!facility) {
      throw new ApiError(400, "Selected facility does not exist");
    }

    if (
      !(
        existing.creation_source === "personal_portal" &&
        isPersonalPortalPlaceholderFacility(facility)
      )
    ) {
      assertFacilityProfileComplete(facility);
    }

    const mismatchState = resolveOrderFacilityMismatchOnUpdate(existing);

    await connection.execute(
      `UPDATE orders
       SET facility_id = :facilityId,
           facility_mismatch = :facilityMismatch,
           specific_doctor = NULL,
           specific_doctor_is_default = 0,
           updated_at = NOW()
       WHERE id = :orderId`,
      {
        facilityId: resolvedFacilityId,
        facilityMismatch: mismatchState.facilityMismatch,
        orderId: existing.id,
      }
    );

    await connection.commit();

    const updated = await getOrderById(existing.id);
    return updated;
  } catch (error) {
    await connection.rollback();
    rethrowServiceError(error);
  } finally {
    connection.release();
  }
}

function resolveOrderFacilityMismatchOnUpdate(existing) {
  // Staff save confirms the selected facility as source of truth.
  // Keep extracted/batch IDs for history, but stop overriding display via mismatch.
  return {
    batchChosenFacilityId: existing.batch_chosen_facility_id || null,
    extractedFacilityId: existing.extracted_facility_id || null,
    facilityMismatch: 0,
  };
}

async function updateOrder(id, data, actorId, files) {
  assertValidCnrDeliveryDate(data);

  const existing = await Order.findById(id);
  assertOrderEditable(existing);

  if (existing.creation_source === "personal_portal") {
    // Personal required fields are validated in orderValidator (portal-specific).
    // Facility/doctor link helpers remain available in the UI but do not block update.
  }

  const blockCreate = await shouldBlockFacilityCreateForOrder(existing);

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const resolvedFacilityId = await resolveFacilityId(connection, data, {
      allowCreate: !blockCreate,
    });

    if (!resolvedFacilityId) {
      throw new ApiError(400, "Selected facility does not exist");
    }

    data.facility = String(resolvedFacilityId);

    const facility = await Facility.findById(resolvedFacilityId, connection);

    if (!facility) {
      throw new ApiError(400, "Selected facility does not exist");
    }

    if (
      !(
        existing.creation_source === "personal_portal" &&
        isPersonalPortalPlaceholderFacility(facility)
      )
    ) {
      assertFacilityProfileComplete(facility);
      const doctor = await assertDoctorBelongsToFacility(
        resolvedFacilityId,
        data.specificDoctor
      );
      data.specificDoctor = doctor.doctorName || null;
      data.specificDoctorIsDefault = Boolean(
        doctor.doctorName && doctor.usedDefault
      );
    }

    const rawOrderNumber = trimOrNull(data.orderNumber);
    const subpoenaExtractId = Number(data.subpoenaExtractId) || null;
    const applicantIdentity = buildApplicantIdentity(data);
    const recordTypes = resolveRecordTypesFromForm(data);
    if (!recordTypes.length) {
      throw new ApiError(400, "At least one record type is required");
    }
    const resolvedNumber = await resolveOrderNumber(
      connection,
      rawOrderNumber,
      existing.id,
      {
        extractId: subpoenaExtractId,
        creationSource: existing.creation_source || "manual",
        applicantIdentity,
        existing,
        recordTypes,
      }
    );
    const {
      orderNumber,
      patientId,
      patientOrderSequence,
      suppliedExternalNumber,
    } = resolvedNumber;
    const payments = collectPayments(data);

    const subpoenaFile = getUploadedFile(files, "subpoenaFile");
    const additionalDocFile = getUploadedFile(files, "additionalDocumentFile");

    let linkedExtract = null;
    let subpoenaStoragePath = null;
    if (subpoenaExtractId) {
      linkedExtract = await batchScanRepository.getExtractById(subpoenaExtractId);
      if (!linkedExtract) {
        throw new ApiError(400, "Subpoena extract not found");
      }
      if (
        linkedExtract.is_processed &&
        Number(linkedExtract.order_id) !== Number(existing.id)
      ) {
        throw new ApiError(
          409,
          "This subpoena extract was already processed into an order"
        );
      }
      try {
        subpoenaStoragePath = fileStorage.archiveBatchScanSubpoenaToProcessed(
          linkedExtract.storage_path,
          orderNumber,
          actorId
        );
        fileStorage.deleteUnusedProcessedSubpoenaUpload(
          toRelativeStoragePath(subpoenaFile),
          subpoenaStoragePath
        );
      } catch (error) {
        throw new ApiError(404, error.message || "Subpoena PDF not found");
      }
    } else {
      const newSubpoenaPath = nestOrderUploadPath(
        toRelativeStoragePath(subpoenaFile),
        actorId,
        orderNumber
      );
      subpoenaStoragePath =
        newSubpoenaPath || existing.subpoena_storage_path || null;
    }

    const previousSubpoenaPath = existing.subpoena_storage_path || null;
    let subpoenaUploadedAt = existing.subpoena_uploaded_at || null;
    if (subpoenaStoragePath && subpoenaStoragePath !== previousSubpoenaPath) {
      subpoenaUploadedAt = new Date();
    } else if (!subpoenaStoragePath) {
      subpoenaUploadedAt = null;
    }

    const providerId = await resolveProviderId(connection, data);
    const payload = buildOrderDbPayload(
      applyInjuryFromExtract({ ...data, providerId }, linkedExtract)
    );
    maybeStashExternalOrderRef(payload, suppliedExternalNumber);
    // Editing an auto-created order completes it; it must not convert the
    // source to manual or lose its Processed/Unprocessed classification.
    payload.creationSource = existing.creation_source || "manual";
    const doctorChanged =
      trimOrNull(data.specificDoctor) !== trimOrNull(existing.specific_doctor);
    payload.specificDoctorIsDefault = doctorChanged
      ? 0
      : boolToInt(existing.specific_doctor_is_default);
    const hasSubpoenaFile = Boolean(subpoenaStoragePath);
    const orderFlags = resolveOrderFlags(data, hasSubpoenaFile);
    const mismatchState = resolveOrderFacilityMismatchOnUpdate(existing);

    await Order.update(connection, existing.id, {
      ...payload,
      ...mismatchState,
      patientId:
        patientId ?? existing.patient_id ?? null,
      patientOrderSequence:
        patientOrderSequence ?? existing.patient_order_sequence ?? null,
      subpoenaStoragePath,
      subpoenaUploadedAt,
      hasSubpoena: orderFlags.hasSubpoena,
      orderNumber,
    });

    if (
      subpoenaExtractId &&
      linkedExtract &&
      !linkedExtract.is_processed
    ) {
      await batchScanRepository.linkExtractToOrder(connection, {
        extractId: subpoenaExtractId,
        orderId: existing.id,
      });
    }

    await OrderRecord.syncForOrder(
      connection,
      existing.id,
      recordTypes
    );

    const refreshedRecords = await OrderRecord.findByOrderId(existing.id, connection);
    const reviewStatus = allOrderRecordsUploaded(refreshedRecords)
      ? "complete"
      : "pending";

    await Order.upsertWorkflowStage(
      existing.id,
      "Review Records",
      reviewStatus,
      reviewStatus === "complete" ? new Date() : null,
      connection
    );

    await syncOrderPayments(connection, existing.id, data);

    await saveOrderDocuments(connection, {
      orderId: existing.id,
      orderNumber,
      additionalDocFile,
      documentName: data.documentName,
      actorId,
    });

    const savedPayments = await Order.findPaymentsByOrderId(existing.id, connection);

    await syncOrderWorkflowFromState(connection, existing.id, {
      payments: savedPayments.map((payment) => ({
        paymentType: payment.payment_type,
        amount: payment.amount,
        dueAmount: payment.due_amount,
      })),
      invoiceServiceFee: 0,
    });

    await connection.commit();

    if (existing.creation_source === "personal_portal") {
      try {
        const personalPortalService = require("./personalPortalService");
        await personalPortalService.syncPersonalOrderDetailsFromStaffUpdate(
          existing.id,
          {
            ...data,
            facilityName: data.facilityName || facility?.facility_name,
            facilityAddress:
              data.facilityAddress || data.fullAddress || facility?.address,
          }
        );
      } catch (syncError) {
        console.warn(
          "[personal-portal] Failed to sync staff personal fields:",
          syncError.message || syncError
        );
      }
    }

    await maybeSendCnrMemoEmail(existing.id, data, existing, actorId);

    const updated = await getOrderById(existing.id);
    return updated;
  } catch (error) {
    await connection.rollback();
    rethrowServiceError(error);
  } finally {
    connection.release();
  }
}

async function deleteOrder(id, { reason, actorId, actorName } = {}) {
  const existing = await Order.findByIdRaw(id);

  if (!existing) {
    throw new ApiError(404, "Order not found");
  }

  if (existing.status === "Deleted") {
    throw new ApiError(400, "Order is already deleted");
  }

  if (existing.status === "Cancelled") {
    throw new ApiError(400, "Cannot delete a cancelled order");
  }

  const trimmedReason = trimOrNull(reason, { maxLength: FIELD_LIMITS.TEXT });
  if (!trimmedReason) {
    throw new ApiError(400, "Deletion reason is required");
  }

  const deleted = await Order.deleteById(existing.id, {
    deletedBy: actorId || null,
    reason: trimmedReason,
  });

  if (!deleted) {
    throw new ApiError(404, "Order not found");
  }

  await Order.createActivityLog({
    orderId: existing.id,
    activityDate: new Date(),
    performedBy: actorId || null,
    authorName: actorName || "System",
    callbackDate: null,
    note: `Order deleted: ${trimmedReason}`,
    attachmentPath: null,
  });

  return { message: "Order deleted successfully" };
}

async function cancelOrder(id, { reason, actorId, actorName }) {
  const existing = await Order.findByIdRaw(id);

  if (!existing) {
    throw new ApiError(404, "Order not found");
  }

  if (existing.status === "Deleted") {
    throw new ApiError(400, "Cannot cancel a deleted order");
  }

  if (existing.status === "Cancelled") {
    throw new ApiError(400, "Order is already cancelled");
  }

  const trimmedReason = trimOrNull(reason, { maxLength: FIELD_LIMITS.TEXT });
  if (!trimmedReason) {
    throw new ApiError(400, "Cancellation reason is required");
  }

  const cancelled = await Order.cancelById(existing.id, {
    reason: trimmedReason,
    actorId: actorId || null,
  });

  if (!cancelled) {
    throw new ApiError(400, "Order is already cancelled");
  }

  await Order.createActivityLog({
    orderId: existing.id,
    activityDate: new Date(),
    performedBy: actorId || null,
    authorName: actorName || "System",
    callbackDate: null,
    note: `Order cancelled: ${trimmedReason}`,
    attachmentPath: null,
  });

  return {
    id: existing.id,
    orderNumber: existing.order_number,
    facility: existing.facility_id ? String(existing.facility_id) : "",
    facilityName: existing.facility_name || "",
    serveCompanyName: existing.serve_company_name || "",
    status: "Cancelled",
    cancelReason: trimmedReason,
  };
}

const RESTORABLE_STATUSES = new Set(["Cancelled", "Deleted"]);
const ALLOWED_RESTORE_TARGET_STATUSES = new Set([
  "Active",
  "Ready",
  "Ready to Pickup",
  "Completed",
  "Write Offs",
]);

function resolveRestoreTargetStatus(order = {}) {
  const previous = trimOrNull(order.status_before_inactive);
  if (previous && ALLOWED_RESTORE_TARGET_STATUSES.has(previous)) {
    return previous;
  }
  return "Active";
}

async function restoreOrder(id, { actorId, actorName } = {}) {
  const existing = await Order.findByIdRaw(id);

  if (!existing) {
    throw new ApiError(404, "Order not found");
  }

  if (!RESTORABLE_STATUSES.has(existing.status)) {
    throw new ApiError(400, "Only cancelled or deleted orders can be restored");
  }

  const restoreStatus = resolveRestoreTargetStatus(existing);
  const restored = await Order.restoreById(existing.id);

  if (!restored) {
    throw new ApiError(400, "Order could not be restored");
  }

  await Order.createActivityLog({
    orderId: existing.id,
    activityDate: new Date(),
    performedBy: actorId || null,
    authorName: actorName || "System",
    callbackDate: null,
    note: `Order restored to ${restoreStatus}`,
    attachmentPath: null,
  });

  return getOrderById(existing.id);
}

async function getOrderSubpoenaFile(orderId) {
  const order = await Order.findById(orderId);

  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  if (!order.subpoena_storage_path) {
    throw new ApiError(404, "This order does not have a subpoena PDF to open.");
  }

  const absolutePath = resolveOrderSubpoenaAbsolutePath(order.subpoena_storage_path);

  if (!absolutePath || !fs.existsSync(absolutePath)) {
    throw new ApiError(
      404,
      "This subpoena PDF could not be opened. The file may have been moved or deleted."
    );
  }

  return {
    absolutePath,
    fileName: path.basename(absolutePath),
  };
}

function deleteStoredMedicalRecordsFile(storagePath) {
  const absolutePath = resolveOrderSubpoenaAbsolutePath(storagePath);

  if (absolutePath && fs.existsSync(absolutePath)) {
    fs.unlinkSync(absolutePath);
  }
}

async function scanMedicalRecords(
  orderId,
  files,
  actorId,
  { recordType = "medical" } = {}
) {
  const fileList = (Array.isArray(files) ? files : [files]).filter(Boolean);
  if (!fileList.length) {
    throw new ApiError(400, "Records PDF is required");
  }

  const normalizedType = `${recordType || ""}`.trim().toLowerCase();
  if (!VALID_RECORD_TYPES.includes(normalizedType)) {
    throw new ApiError(400, "Invalid record type");
  }

  const existing = await Order.findById(orderId);
  if (!existing) {
    throw new ApiError(404, "Order not found");
  }

  if (Number(existing.certificate_no_records)) {
    throw new ApiError(
      400,
      "Medical records cannot be uploaded for Certificate of No Records orders"
    );
  }

  const orderRecords = await OrderRecord.findByOrderId(orderId);
  const targetRecord = orderRecords.find(
    (record) => record.record_type === normalizedType
  );

  if (!targetRecord) {
    throw new ApiError(
      400,
      "This record type is not on the order. Update the order record types first."
    );
  }

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    for (const file of fileList) {
      const pageCount = await resolvePdfPageCountFromUpload(file);

      await OrderRecord.insertScan(connection, {
        orderId,
        recordType: normalizedType,
        storagePath: nestOrderUploadPath(
          toRelativeStoragePath(file),
          actorId,
          existing.order_number
        ),
        originalFileName: file.originalname || null,
        pageCount,
        uploadedBy: actorId || null,
      });
    }

    const refreshedRecords = await OrderRecord.findByOrderId(orderId, connection);
    const reviewStatus = allOrderRecordsUploaded(refreshedRecords)
      ? "complete"
      : "pending";

    await Order.upsertWorkflowStage(
      orderId,
      "Review Records",
      reviewStatus,
      reviewStatus === "complete" ? new Date() : null,
      connection
    );

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    rethrowServiceError(error);
  } finally {
    connection.release();
  }

  try {
    const personalPortalService = require("./personalPortalService");
    await personalPortalService.syncPortalStatusForDmsOrder(orderId);
  } catch (_syncError) {
    // Non-blocking for personal portal status
  }

  return getOrderById(orderId);
}

async function deleteOrderAdditionalDocument(orderId, documentId) {
  const id = Number(orderId);
  const docId = Number(documentId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new ApiError(400, "Invalid order id");
  }
  if (!Number.isFinite(docId) || docId <= 0) {
    throw new ApiError(400, "Invalid document id");
  }

  const existing = await Order.findById(id);
  assertOrderEditable(existing);

  const deleted = await Order.softDeleteAdditionalDocument(id, docId);
  if (!deleted) {
    throw new ApiError(404, "Document not found");
  }

  return getOrderById(id);
}

async function removeOrderSubpoena(orderId) {
  const id = Number(orderId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new ApiError(400, "Invalid order id");
  }

  const existing = await Order.findById(id);
  assertOrderEditable(existing);

  await Order.clearSubpoena(id);
  return getOrderById(id);
}

async function removeMedicalRecords(orderId, _actorId, { recordType = null } = {}) {
  const existing = await Order.findById(orderId);
  if (!existing) {
    throw new ApiError(404, "Order not found");
  }

  if (Number(existing.certificate_no_records)) {
    throw new ApiError(
      400,
      "Medical records cannot be modified for Certificate of No Records orders"
    );
  }

  const orderRecords = await OrderRecord.findByOrderId(orderId);
  const normalizedType = recordType
    ? `${recordType}`.trim().toLowerCase()
    : null;

  const targets = normalizedType
    ? orderRecords.filter(
        (record) => record.record_type === normalizedType && record.storage_path
      )
    : orderRecords.filter((record) => record.storage_path);

  if (!targets.length) {
    throw new ApiError(
      404,
      "This records PDF could not be opened. No file is available for this order."
    );
  }

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const typesToClear = [
      ...new Set(targets.map((target) => target.record_type)),
    ];

    for (const type of typesToClear) {
      await OrderRecord.clearScan(connection, orderId, type);
    }

    await Order.upsertWorkflowStage(
      orderId,
      "Review Records",
      "pending",
      null,
      connection
    );

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    rethrowServiceError(error);
  } finally {
    connection.release();
  }

  try {
    const personalPortalService = require("./personalPortalService");
    await personalPortalService.syncPortalStatusForDmsOrder(orderId);
  } catch (_syncError) {
    // Non-blocking
  }

  return getOrderById(orderId);
}

async function getOrderMedicalRecordsFile(
  orderId,
  { recordType = "medical", recordId = null } = {}
) {
  const order = await Order.findById(orderId);
  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  const normalizedType = `${recordType || ""}`.trim().toLowerCase();
  if (!VALID_RECORD_TYPES.includes(normalizedType)) {
    throw new ApiError(400, "Invalid record type");
  }

  let targetRecord = null;

  if (recordId) {
    const byId = await OrderRecord.findById(recordId);
    if (
      byId &&
      Number(byId.order_id) === Number(orderId) &&
      byId.record_type === normalizedType
    ) {
      targetRecord = byId;
    }
  }

  if (!targetRecord) {
    targetRecord = await OrderRecord.findByOrderAndType(orderId, normalizedType);
  }

  if (!targetRecord?.storage_path) {
    throw new ApiError(
      404,
      "This records PDF could not be opened. No file is available for this order."
    );
  }

  const absolutePath = resolveOrderSubpoenaAbsolutePath(targetRecord.storage_path);

  if (!absolutePath || !fs.existsSync(absolutePath)) {
    throw new ApiError(
      404,
      "This records PDF could not be opened. The file may have been moved or deleted."
    );
  }

  const orderRecords = await OrderRecord.findByOrderId(orderId);
  if (allOrderRecordsUploaded(orderRecords)) {
    await Order.upsertWorkflowStage(
      orderId,
      "Review Records",
      "complete",
      new Date()
    );
  }

  return {
    absolutePath,
    fileName:
      targetRecord.original_file_name || path.basename(absolutePath),
  };
}

function buildApplicantName(row) {
  return buildFullName(
    row.applicant_first_name,
    row.applicant_middle_name,
    row.applicant_last_name
  );
}

function assertReadyForDelivery(order) {
  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  if (order.status !== "Ready to Pickup") {
    throw new ApiError(
      400,
      "Mail, fax, and pickup actions are only available for orders ready to pickup"
    );
  }
}

async function resolveOrderRecordsAttachments(order) {
  const records = await OrderRecord.findByOrderId(order.id);
  const withFiles = records.filter((record) => record.storage_path);
  const safeOrderNumber = `${order.order_number || order.id}`.replace(
    /[^\w.-]+/g,
    "_"
  );

  const attachments = [];
  const recordLabels = [];

  for (const record of withFiles) {
    const absolutePath = resolveOrderSubpoenaAbsolutePath(record.storage_path);

    if (!absolutePath || !fs.existsSync(absolutePath)) {
      continue;
    }

    const typeSuffix = record.record_type || "records";
    const originalName = `${record.original_file_name || ""}`.trim();
    const uniqueName = originalName
      ? `${safeOrderNumber}-${record.id}-${originalName}`
      : `${safeOrderNumber}-${typeSuffix}-${record.id}.pdf`;
    recordLabels.push(RECORD_TITLES[record.record_type] || "Records");
    attachments.push({
      filename: uniqueName,
      path: absolutePath,
    });
  }

  return { attachments, recordLabels };
}

async function resolveMedicalRecordsAttachment(order) {
  const { attachments } = await resolveOrderRecordsAttachments(order);
  return attachments[0] || null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normalizeRecipientEmails(primaryEmail, additionalEmails = []) {
  const primary = trimOrNull(primaryEmail);

  if (!primary || !EMAIL_PATTERN.test(primary)) {
    throw new ApiError(400, "A valid company email is required");
  }

  const recipients = [primary.toLowerCase()];

  for (const rawEmail of additionalEmails) {
    const email = trimOrNull(rawEmail);
    if (!email) continue;

    if (!EMAIL_PATTERN.test(email)) {
      throw new ApiError(400, `Invalid email address: ${email}`);
    }

    const normalized = email.toLowerCase();
    if (!recipients.includes(normalized)) {
      recipients.push(normalized);
    }
  }

  return recipients;
}

function resolveCnrRecipientEmail(row = {}, data = {}) {
  return (
    trimOrNull(data.email || data.serveEmail) ||
    trimOrNull(row.serve_email) ||
    trimOrNull(row.contact1_email) ||
    trimOrNull(row.contact2_email) ||
    trimOrNull(row.provider_email) ||
    null
  );
}

function buildCnrDocumentPdfData(order) {
  const isMemo = Boolean(Number(order.cnr_memo));

  return {
    isMemo,
    documentTitle: isMemo ? "Memo" : "Certificate of No Records",
    memoDate: order.cnr_date_sent || new Date(),
    recipientCompany: order.serve_company_name || order.provider_name || "",
    applicant: buildApplicantName(order),
    reference: order.order_number || "",
    facilityName: order.facility_name || "",
    cnrReason: trimOrNull(order.cnr_reason) || "",
  };
}

function buildCnrMemoPdfData(order) {
  return buildCnrDocumentPdfData(order);
}

function shouldSendCnrMemoEmail(existingOrder, data) {
  if (!isCnrOrder(data) || !parseBoolean(data.cnrMemo)) {
    return false;
  }

  if (data.cnrDelivery !== "email") {
    return false;
  }

  if (!dateOrNull(data.cnrDateSent)) {
    return false;
  }

  const recipient = resolveCnrRecipientEmail(existingOrder || {}, data);
  if (!recipient || !EMAIL_PATTERN.test(recipient)) {
    return false;
  }

  if (!existingOrder) {
    return true;
  }

  if (!Number(existingOrder.certificate_no_records)) {
    return true;
  }

  return (
    existingOrder.cnr_delivery !== "email" ||
    Boolean(Number(existingOrder.cnr_memo)) !== parseBoolean(data.cnrMemo) ||
    toInputDate(existingOrder.cnr_date_sent) !==
      toInputDate(dateOrNull(data.cnrDateSent)) ||
    trimOrNull(existingOrder.cnr_reason) !== trimOrNull(data.cnrReason) ||
    resolveCnrRecipientEmail(existingOrder) !==
      resolveCnrRecipientEmail(existingOrder, data)
  );
}

async function maybeSendCnrMemoEmail(orderId, data, existingOrder = null, actorId = null) {
  if (!shouldSendCnrMemoEmail(existingOrder, data)) {
    return null;
  }

  const order = await Order.findById(orderId);
  if (!order) {
    return null;
  }

  const recipient = resolveCnrRecipientEmail(order, data);
  const { generateCnrMemoPdf } = require("../utils/cnrMemoPdf");
  const { sendCnrMemoEmail } = require("./emailService");
  const pdfBuffer = await generateCnrMemoPdf(buildCnrMemoPdfData(order));
  const result = await sendCnrMemoEmail({
    to: recipient,
    orderNumber: order.order_number,
    applicantName: buildApplicantName(order),
    memoDate: order.cnr_date_sent,
    pdfBuffer,
  });

  await Order.createActivityLog({
    orderId,
    activityDate: new Date(),
    performedBy: actorId || null,
    authorName: "System",
    callbackDate: null,
    note: `CNR Memo emailed to ${recipient}`,
    attachmentPath: null,
  });

  return {
    recipient,
    sentDate: toInputDate(order.cnr_date_sent),
    delivered: Boolean(result.delivered),
    devLogged: Boolean(result.devLogged),
  };
}

async function sendCnrRecord(
  orderId,
  { emails, email, additionalEmails, sentDate, timezone } = {}
) {
  const normalizedId = Number(orderId);
  const recipients = resolveMailRecipients({ emails, email, additionalEmails });

  if (!Number.isFinite(normalizedId)) {
    throw new ApiError(400, "Invalid order id");
  }

  const order = await Order.findById(normalizedId);
  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  if (!Number(order.certificate_no_records)) {
    throw new ApiError(400, "This order is not marked as Certificate of No Records");
  }

  const pdfData = buildCnrDocumentPdfData(order);
  const { generateCnrDocumentPdf } = require("../utils/cnrMemoPdf");
  const { sendCnrRecordEmail } = require("./emailService");
  const pdfBuffer = await generateCnrDocumentPdf(pdfData);
  const mailSentDate =
    dateOrNull(sentDate) ||
    dateOrNull(order.cnr_date_sent) ||
    resolveClientCalendarDate({ timezone });
  const documentDate = mailSentDate;
  const deliveredTo = [];

  for (const recipient of recipients) {
    const result = await sendCnrRecordEmail({
      to: recipient,
      orderNumber: order.order_number,
      applicantName: buildApplicantName(order),
      documentDate,
      cnrReason: pdfData.cnrReason,
      documentTitle: pdfData.documentTitle,
      pdfBuffer,
    });

    if (!result.delivered && !result.devLogged) {
      throw new ApiError(500, "Failed to send CNR record email");
    }

    deliveredTo.push(recipient);
  }
  const pool = getPool();

  await pool.execute(
    `UPDATE orders
     SET cnr_date_sent = :mailSentDate,
         cnr_delivery = 'email',
         updated_at = NOW()
     WHERE id = :orderId`,
    { mailSentDate, orderId: normalizedId }
  );

  return {
    recipients: deliveredTo,
    recipient: deliveredTo.join(", "),
    delivered: deliveredTo.length > 0,
    devLogged: false,
    sentDate: mailSentDate,
    documentTitle: pdfData.documentTitle,
    cnrReason: pdfData.cnrReason,
  };
}

function resolveMailRecipients({ emails, email, additionalEmails = [] } = {}) {
  if (Array.isArray(emails) && emails.length) {
    const seen = new Set();
    const recipients = [];

    emails.forEach((value) => {
      const trimmed = trimOrNull(value);
      if (!trimmed) return;

      if (!EMAIL_PATTERN.test(trimmed)) {
        throw new ApiError(400, `Invalid email address: ${trimmed}`);
      }

      const key = trimmed.toLowerCase();
      if (seen.has(key)) return;

      seen.add(key);
      recipients.push(trimmed);
    });

    if (!recipients.length) {
      throw new ApiError(400, "At least one recipient email is required");
    }

    return recipients;
  }

  return normalizeRecipientEmails(email, additionalEmails);
}

function buildRecordsDownloadUrl(token) {
  const config = require("../config");
  const baseUrl = `${config.clientUrl || "http://localhost:3000"}`.replace(
    /\/$/,
    ""
  );
  return `${baseUrl}/download/records/${token}`;
}

async function mailCompletedOrder(
  orderId,
  { emails, email, additionalEmails, deliveryDate, timezone } = {}
) {
  const normalizedId = Number(orderId);
  const recipients = resolveMailRecipients({ emails, email, additionalEmails });

  if (!Number.isFinite(normalizedId)) {
    throw new ApiError(400, "Invalid order id");
  }

  const order = await Order.findById(normalizedId);
  assertReadyForDelivery(order);

  const {
    createDownloadLinkForOrder,
    resolveOrderRecordFiles,
  } = require("./recordDownloadService");

  const { token, expiresAt, files } = await createDownloadLinkForOrder(
    normalizedId
  );
  const { recordLabels } = await resolveOrderRecordFiles(order);

  if (!files.length) {
    throw new ApiError(
      400,
      "Records files not found. Scan records before sending email."
    );
  }

  const mailSentDate =
    dateOrNull(deliveryDate) || resolveClientCalendarDate({ timezone });

  const pool = getPool();

  const setCnrDate =
    Number(order.certificate_no_records) && order.cnr_delivery === "email";

  const downloadUrl = buildRecordsDownloadUrl(token);
  const { sendOrderCompletedMail } = require("./emailService");
  const deliveredTo = [];

  for (const recipient of recipients) {
    const result = await sendOrderCompletedMail({
      to: recipient,
      orderNumber: order.order_number,
      applicant: buildApplicantName(order),
      providerName: order.serve_company_name || order.provider_name || "",
      recordLabels,
      downloadUrl,
      expiresAt,
    });

    if (!result.delivered && !result.devLogged) {
      throw new ApiError(500, "Failed to send email");
    }

    deliveredTo.push(recipient);
  }

  await pool.execute(
    `UPDATE orders
     SET delivery_date = :mailSentDate,
         ready_date = :mailSentDate,
         status = 'Completed',
         ${setCnrDate ? "cnr_date_sent = :mailSentDate," : ""}
         updated_at = NOW()
     WHERE id = :orderId`,
    { mailSentDate, orderId: normalizedId }
  );

  return {
    recipients: deliveredTo,
    recipient: deliveredTo.join(", "),
    delivered: deliveredTo.length > 0,
    devLogged: false,
    sentDate: mailSentDate,
    readyDate: mailSentDate,
    downloadUrl,
    expiresAt,
  };
}

function splitAddressIntoLines(address = "") {
  const trimmed = String(address).trim();
  if (!trimmed) return [];

  const parts = trimmed.split(", ").filter(Boolean);
  if (parts.length <= 2) return parts;

  return [parts.slice(0, -2).join(", "), parts.slice(-2).join(", ")];
}

function buildCertificateOfRecordsPdfData(order) {
  const facilityInfo = buildFacilityBlock(order);
  const company = buildCompanyBlock(order);
  const reference = trimOrNull(order.order_ref) || order.order_number || "";

  return {
    documentDate: new Date(),
    applicant: buildApplicantName(order),
    reference,
    facilityName: facilityInfo.name || order.facility_name || "N/A",
    facilityAddressLines: facilityInfo.addressLines,
    companyName: company.name,
    companyAddressLines: splitAddressIntoLines(company.address),
  };
}

async function sendCertificateOfRecords(
  orderId,
  { emails, email, additionalEmails, sentDate, timezone } = {}
) {
  const normalizedId = Number(orderId);
  const recipients = resolveMailRecipients({ emails, email, additionalEmails });

  if (!Number.isFinite(normalizedId)) {
    throw new ApiError(400, "Invalid order id");
  }

  const order = await Order.findById(normalizedId);
  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  if (Number(order.certificate_no_records)) {
    throw new ApiError(
      400,
      "Certificate of Records is not available for Certificate of No Records orders"
    );
  }

  const pdfData = buildCertificateOfRecordsPdfData(order);
  const { generateCertificateOfRecordsPdf } = require("../utils/certificateOfRecordsPdf");
  const { sendCertificateOfRecordsEmail } = require("./emailService");
  const pdfBuffer = await generateCertificateOfRecordsPdf(pdfData);
  const documentDate =
    dateOrNull(sentDate) || resolveClientCalendarDate({ timezone });
  const deliveredTo = [];

  for (const recipient of recipients) {
    const result = await sendCertificateOfRecordsEmail({
      to: recipient,
      orderNumber: order.order_number,
      applicantName: buildApplicantName(order),
      documentDate,
      pdfBuffer,
    });

    if (!result.delivered && !result.devLogged) {
      throw new ApiError(500, "Failed to send certificate of records email");
    }

    deliveredTo.push(recipient);
  }

  return {
    recipients: deliveredTo,
    recipient: deliveredTo.join(", "),
    delivered: deliveredTo.length > 0,
    devLogged: false,
    sentDate: toInputDate(documentDate),
  };
}

async function sendCopyServiceLetter(
  orderId,
  { email, additionalEmails = [] } = {}
) {
  const normalizedId = Number(orderId);

  if (!Number.isFinite(normalizedId)) {
    throw new ApiError(400, "Invalid order id");
  }

  const recipients = normalizeRecipientEmails(email, additionalEmails);
  const order = await Order.findById(normalizedId);

  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  const facilityInfo = buildFacilityBlock(order);
  const sendDate = new Date();
  const {
    generateCopyServiceLetterPdf,
    addExpiryDate,
  } = require("../utils/copyServiceLetterPdf");
  const { sendCopyServiceLetterEmail } = require("./emailService");

  const pdfBuffer = await generateCopyServiceLetterPdf({
    facilityName: facilityInfo.name || order.facility_name || "N/A",
    facilityAddressLines: facilityInfo.addressLines,
    applicantName: buildApplicantName(order) || "N/A",
    orderNumber: order.order_number,
    sendDate,
  });

  const expiresDate = addExpiryDate(sendDate);
  const result = await sendCopyServiceLetterEmail({
    to: recipients.join(", "),
    orderNumber: order.order_number,
    applicantName: buildApplicantName(order),
    facilityName: facilityInfo.name || order.facility_name || "",
    sendDate,
    expiresDate,
    pdfBuffer,
  });

  if (!result.delivered && !result.devLogged) {
    throw new ApiError(500, "Failed to send copy service letter email");
  }

  return {
    recipients,
    delivered: result.delivered,
    devLogged: Boolean(result.devLogged),
    sentDate: sendDate.toISOString(),
    expiresDate: expiresDate.toISOString(),
  };
}

async function getPrintInvoicePdf(orderId) {
  const normalizedId = Number(orderId);

  if (!Number.isFinite(normalizedId)) {
    throw new ApiError(400, "Invalid order id");
  }

  const order = await Order.findById(normalizedId);

  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  const invoice = await Invoice.findByOrderId(normalizedId);

  if (!invoice) {
    throw new ApiError(404, "Invoice not found for this order");
  }

  const payments = await Order.findPaymentsByOrderId(normalizedId);
  const payload = invoiceService.buildPrintInvoicePdfData(
    invoice,
    order,
    payments
  );

  if (!payload) {
    throw new ApiError(404, "Invoice data not available for this order");
  }

  const { generatePrintInvoicePdf } = require("../utils/printInvoicePdf");
  const pdfBuffer = await generatePrintInvoicePdf(payload);
  const safeOrderNumber = `${order.order_number || order.id}`.replace(
    /[^\w.-]+/g,
    "_"
  );

  return {
    pdfBuffer,
    fileName: `invoice-${safeOrderNumber}.pdf`,
    orderNumber: order.order_number,
    totalDue: payload.totalDue,
  };
}

async function getPrintXrayInvoicePdf(orderId) {
  const normalizedId = Number(orderId);

  if (!Number.isFinite(normalizedId)) {
    throw new ApiError(400, "Invalid order id");
  }

  const order = await Order.findById(normalizedId);

  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  const xrayRow = await InvoiceXray.findByOrderId(normalizedId);

  if (!xrayRow) {
    throw new ApiError(404, "X-Ray invoice not found for this order");
  }

  const payments = await Order.findPaymentsByOrderId(normalizedId);
  const payload = invoiceService.buildPrintXrayInvoicePdfData(
    xrayRow,
    order,
    payments
  );

  if (!payload) {
    throw new ApiError(404, "X-Ray invoice data not available for this order");
  }

  const { generatePrintXrayInvoicePdf } = require("../utils/printXrayInvoicePdf");
  const pdfBuffer = await generatePrintXrayInvoicePdf(payload);
  const safeOrderNumber = `${order.order_number || order.id}`.replace(
    /[^\w.-]+/g,
    "_"
  );

  return {
    pdfBuffer,
    fileName: `xray-invoice-${safeOrderNumber}.pdf`,
    orderNumber: order.order_number,
    totalDue: payload.totalDue,
  };
}

async function recordOrderFax(orderId, { faxNumber, sentDate, notes } = {}) {
  const normalizedId = Number(orderId);

  if (!Number.isFinite(normalizedId)) {
    throw new ApiError(400, "Invalid order id");
  }

  const resolvedFax = trimOrNull(faxNumber);
  if (!resolvedFax) {
    throw new ApiError(400, "Fax number is required");
  }

  const order = await Order.findById(normalizedId);
  assertReadyForDelivery(order);

  const resolvedDate = dateOrNull(sentDate);
  if (!resolvedDate) {
    throw new ApiError(400, "Fax sent date is required");
  }

  const pool = getPool();

  await pool.execute(
    `UPDATE orders
     SET cnr_date_sent = :sentDate, updated_at = NOW()
     WHERE id = :orderId`,
    { sentDate: resolvedDate, orderId: normalizedId }
  );

  return {
    orderId: normalizedId,
    faxNumber: resolvedFax,
    sentDate: resolvedDate,
    notes: trimOrNull(notes) || "",
  };
}

async function recordOrderPickup(orderId, { pickupDate, pickupPersonName, notes } = {}) {
  const normalizedId = Number(orderId);

  if (!Number.isFinite(normalizedId)) {
    throw new ApiError(400, "Invalid order id");
  }

  const resolvedPerson = trimOrNull(pickupPersonName);
  if (!resolvedPerson) {
    throw new ApiError(400, "Pickup person name is required");
  }

  const order = await Order.findById(normalizedId);
  assertReadyForDelivery(order);

  const resolvedDate = dateOrNull(pickupDate);
  if (!resolvedDate) {
    throw new ApiError(400, "Pickup date is required");
  }

  const pool = getPool();

  await pool.execute(
    `UPDATE orders
     SET delivery_date = :pickupDate,
         ready_date = :pickupDate,
         pickup_person_name = :pickupPersonName,
         status = 'Completed',
         updated_at = NOW()
     WHERE id = :orderId`,
    {
      pickupDate: resolvedDate,
      pickupPersonName: resolvedPerson,
      orderId: normalizedId,
    }
  );

  return {
    orderId: normalizedId,
    pickupDate: resolvedDate,
    pickupPersonName: resolvedPerson,
    readyDate: resolvedDate,
    notes: trimOrNull(notes) || "",
  };
}

async function getOrderFilterCompanies() {
  return Order.findDistinctCompanyNames();
}

async function searchOrderDoctors(query, facilityId = null) {
  const trimmed = `${query || ""}`.trim();

  if (!trimmed) return [];

  const limit = 25;
  const normalizedFacilityId = Number(facilityId);

  const [orderDoctors, facilityDoctors] = await Promise.all([
    Order.searchDoctors(trimmed, limit),
    Number.isFinite(normalizedFacilityId) && normalizedFacilityId > 0
      ? FacilityDoctor.searchByQuery(normalizedFacilityId, trimmed, limit)
      : Promise.resolve([]),
  ]);

  const merged = new Map();

  for (const name of facilityDoctors) {
    const key = name.toLowerCase();
    if (!merged.has(key)) merged.set(key, name);
  }

  for (const name of orderDoctors) {
    const key = name.toLowerCase();
    if (!merged.has(key)) merged.set(key, name);
  }

  return Array.from(merged.values()).slice(0, limit);
}

async function searchOrderDoctorAddresses(query) {
  return Order.searchDoctorAddresses(query);
}

module.exports = {
  getAllOrders,
  getOrderStats,
  getOrderFilterCompanies,
  getOrderById,
  getOrderReminders,
  createOrder,
  createOrderFromExtract,
  autoCreateOrdersFromBatch,
  updateOrder,
  updateOrderFacility,
  deleteOrder,
  cancelOrder,
  restoreOrder,
  getOrderNotes,
  addOrderNote,
  updateOrderNote,
  getOrderActivityLogs,
  addOrderActivityLog,
  getWorkflowStages,
  updateOrderWorkflowStage,
  markOrderWorkflowSent,
  getOrderSubpoenaFile,
  scanMedicalRecords,
  removeMedicalRecords,
  deleteOrderAdditionalDocument,
  removeOrderSubpoena,
  getOrderMedicalRecordsFile,
  mailCompletedOrder,
  sendCnrRecord,
  sendCertificateOfRecords,
  sendCopyServiceLetter,
  getPrintInvoicePdf,
  getPrintXrayInvoicePdf,
  recordOrderFax,
  recordOrderPickup,
  searchOrderDoctors,
  searchOrderDoctorAddresses,
};
