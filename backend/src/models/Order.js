/**
 * Order model — DMS order records.
 */

const { getPool } = require("../config/database");
const {
  RUSH_1_MIN_DAYS,
  RUSH_2_MIN_DAYS,
  RUSH_3_MIN_DAYS,
  RUSH_1_MAX_DAYS,
  RUSH_2_MAX_DAYS,
  RUSH_READY_MIN_DAYS,
  ORDER_AGE_SQL_ALIAS,
} = require("../utils/rushUtils");
const { toSqlDateOnly, parseDateOnlyParts } = require("../utils/dateUtils");
const { likeContains, likePrefix } = require("../utils/sqlSafety");
const { areAllOrderInvoicesPaid } = require("../utils/orderInvoicePayment");
const { toMysqlUtcDateTime } = require("../utils/timezoneUtils");

function toSqlDateTimeStart(value) {
  const dateOnly = toSqlDateOnly(value);
  return dateOnly ? `${dateOnly} 00:00:00` : null;
}

function toSqlDateTimeExclusiveEnd(value) {
  const parts = parseDateOnlyParts(value);
  if (!parts) return null;

  const end = new Date(parts.year, parts.month - 1, parts.day);
  end.setDate(end.getDate() + 1);

  const year = end.getFullYear();
  const month = String(end.getMonth() + 1).padStart(2, "0");
  const day = String(end.getDate()).padStart(2, "0");

  return `${year}-${month}-${day} 00:00:00`;
}

function appendYearFilter(conditions, params, year) {
  const normalizedYear = Number(year);
  if (!Number.isFinite(normalizedYear)) return;

  const yearStart = `${normalizedYear}-01-01`;
  const yearEnd = `${normalizedYear + 1}-01-01`;

  conditions.push(`(
    (o.subpoena_date IS NOT NULL AND o.subpoena_date >= :yearStart AND o.subpoena_date < :yearEnd)
    OR (o.subpoena_date IS NULL AND o.created_at >= :yearStartTs AND o.created_at < :yearEndTs)
  )`);
  params.yearStart = yearStart;
  params.yearEnd = yearEnd;
  params.yearStartTs = `${yearStart} 00:00:00`;
  params.yearEndTs = `${yearEnd} 00:00:00`;
}

function appendOrderSearchFilter(conditions, params, rawSearch) {
  const search = `${rawSearch || ""}`.trim();
  if (!search) return;

  const searchClauses = [
    "o.order_number LIKE :searchPrefix",
    "o.rec_number LIKE :searchPrefix",
    "o.case_number LIKE :searchPrefix",
    "o.order_ref LIKE :searchPrefix",
    "o.court LIKE :searchPrefix",
    "o.applicant_first_name LIKE :searchPrefix",
    "o.applicant_middle_name LIKE :searchPrefix",
    "o.applicant_last_name LIKE :searchPrefix",
    "o.applicant_aka LIKE :searchPrefix",
    "o.defendant LIKE :searchPrefix",
    "o.serve_company_name LIKE :searchPrefix",
    "o.serve_address LIKE :searchPrefix",
    "o.serve_city LIKE :searchPrefix",
    "o.serve_state LIKE :searchPrefix",
    "o.serve_zip LIKE :searchPrefix",
    "o.serve_phone LIKE :searchPrefix",
    "o.serve_fax LIKE :searchPrefix",
    "o.serve_email LIKE :searchPrefix",
    "o.contact1_name LIKE :searchPrefix",
    "o.contact1_title LIKE :searchPrefix",
    "o.contact1_phone LIKE :searchPrefix",
    "o.contact1_fax LIKE :searchPrefix",
    "o.contact1_email LIKE :searchPrefix",
    "o.contact2_name LIKE :searchPrefix",
    "o.contact2_title LIKE :searchPrefix",
    "o.contact2_phone LIKE :searchPrefix",
    "o.contact2_fax LIKE :searchPrefix",
    "o.contact2_email LIKE :searchPrefix",
    "o.injury_type LIKE :searchPrefix",
    "o.cancel_reason LIKE :searchPrefix",
    "o.delete_reason LIKE :searchPrefix",
    "o.specific_doctor LIKE :searchPrefix",
    "o.specific_record LIKE :searchPrefix",
    "CAST(o.status AS CHAR) LIKE :searchPrefix",
    "f.facility_name LIKE :searchPrefix",
    "f.address LIKE :searchPrefix",
    "f.city LIKE :searchPrefix",
    "f.state LIKE :searchPrefix",
    "f.zip_code LIKE :searchPrefix",
    "p.company_name LIKE :searchPrefix",
  ];

  params.searchPrefix = likePrefix(search);

  const ssnDigits = search.replace(/\D/g, "");
  if (ssnDigits.length === 4) {
    searchClauses.push(
      "o.ssn_last_four = :searchSsnLastFour",
      "RIGHT(REPLACE(REPLACE(o.ssn_last_four, '-', ''), 'X', ''), 4) = :searchSsnLastFour"
    );
    params.searchSsnLastFour = ssnDigits;
  } else if (ssnDigits.length === 9) {
    searchClauses.push(
      "o.ssn_last_four = :searchSsnFull",
      "REPLACE(o.ssn_last_four, '-', '') = :searchSsnDigits",
      "RIGHT(REPLACE(REPLACE(UPPER(o.ssn_last_four), '-', ''), 'X', ''), 4) = :searchSsnLastFourFromFull"
    );
    params.searchSsnFull = `${ssnDigits.slice(0, 3)}-${ssnDigits.slice(3, 5)}-${ssnDigits.slice(5)}`;
    params.searchSsnDigits = ssnDigits;
    params.searchSsnLastFourFromFull = ssnDigits.slice(-4);
  }

  const searchDate = toSqlDateOnly(search);
  if (searchDate) {
    searchClauses.push(
      "o.dob = :searchDate",
      "o.injury_date = :searchDate",
      "o.injury_date_begin = :searchDate",
      "o.injury_date_end = :searchDate"
    );
    params.searchDate = searchDate;
  }

  conditions.push(`(${searchClauses.join(" OR ")})`);
}

const REQUIRED_WORKFLOW_COMPLETION = {
  "Review Records": "complete",
  Serve: "complete",
  SENT: "sent",
};

const WORKFLOW_AUTO_COMPLETE_EXCLUDED_STATUSES = new Set([
  "Cancelled",
  "Deleted",
  "Completed",
  "Ready to Pickup",
  "Write Offs",
]);

const INACTIVE_ORDER_STATUSES = ["Cancelled", "Deleted"];
const ACTIVE_ORDER = `(status NOT IN ('Cancelled', 'Deleted'))`;
const ACTIVE_ORDER_ALIAS = `(o.status NOT IN ('Cancelled', 'Deleted'))`;
const NON_DELETED_ORDER_ALIAS = `(o.status <> 'Deleted')`;
// Billable activity exists only after an order reaches standard or x-ray invoicing.
// This prevents brand-new uninvoiced orders from being treated as "paid" just
// because no due balance exists yet.
const ORDER_HAS_BILLABLE_ACTIVITY = `(
  EXISTS (
    SELECT 1 FROM invoices i
    WHERE i.order_id = o.id
      AND (
        i.total_amount > 0
        OR i.amount_paid > 0
        OR i.writeoff_amount > 0
        OR i.status IN ('Paid', 'Partial', 'Unpaid', 'Written Off')
      )
  )
  OR EXISTS (
    SELECT 1 FROM invoice_xray_details x
    WHERE x.order_id = o.id
      AND (
        x.payment > 0
        OR x.amount_paid > 0
        OR x.writeoff_amount > 0
        OR x.status IN ('Paid', 'Partial', 'Unpaid', 'Written Off')
      )
  )
)`;
// Combined remaining balance: standard invoice.amount_due + x-ray (payment - paid - writeoff).
// Unique indexes on invoices.order_id and invoice_xray_details.order_id keep these EXISTS lookups O(1).
const ORDER_HAS_AMOUNT_DUE = `(
  EXISTS (
    SELECT 1 FROM invoices i
    WHERE i.order_id = o.id
      AND COALESCE(i.amount_due, 0) > 0
  )
  OR EXISTS (
    SELECT 1 FROM invoice_xray_details x
    WHERE x.order_id = o.id
      AND GREATEST(
        0,
        COALESCE(x.payment, 0)
          - COALESCE(x.amount_paid, 0)
          - COALESCE(x.writeoff_amount, 0)
      ) > 0
  )
)`;
const ORDER_COLUMNS = `
  order_number, rec_number, facility_id, provider_id, status, court,
  case_number, order_ref, ssn_last_four, dob,
  applicant_first_name, applicant_middle_name, applicant_last_name,
  applicant_aka, defendant, injury_type, injury_date, injury_date_begin, injury_date_end,
  serve_company_name, serve_address, serve_zip, serve_city, serve_state,
  serve_phone, serve_fax, serve_email,
  contact1_name, contact1_title, contact1_phone, contact1_fax, contact1_email,
  contact2_name, contact2_title, contact2_phone, contact2_fax, contact2_email,
  date_served, depo_due_date, delivery_date, subpoena_date, date_requested,
  ready_date, invoice_date, xray_invoice_date,
  specific_record, specific_doctor, specific_doctor_is_default, full_address,
  certificate_no_records, cnr_reason, cnr_delivery, cnr_date_sent, cnr_memo,
  subpoena_storage_path, subpoena_uploaded_at, has_note, has_subpoena, creation_source, created_by,
  batch_chosen_facility_id, extracted_facility_id, facility_mismatch`;

const ORDER_VALUES = `
  :orderNumber, :recNumber, :facilityId, :providerId, :status, :court,
  :caseNumber, :orderRef, :ssnLastFour, :dob,
  :applicantFirstName, :applicantMiddleName, :applicantLastName,
  :applicantAka, :defendant, :injuryType, :injuryDate, :injuryDateBegin, :injuryDateEnd,
  :serveCompanyName, :serveAddress, :serveZip, :serveCity, :serveState,
  :servePhone, :serveFax, :serveEmail,
  :contact1Name, :contact1Title, :contact1Phone, :contact1Fax, :contact1Email,
  :contact2Name, :contact2Title, :contact2Phone, :contact2Fax, :contact2Email,
  :dateServed, :depoDueDate, :deliveryDate, :subpoenaDate, :dateRequested,
  :readyDate, :invoiceDate, :xrayInvoiceDate,
  :specificRecord, :specificDoctor, :specificDoctorIsDefault, :fullAddress,
  :certificateNoRecords, :cnrReason, :cnrDelivery, :cnrDateSent, :cnrMemo,
  :subpoenaStoragePath, :subpoenaUploadedAt, :hasNote, :hasSubpoena, :creationSource, :createdBy,
  :batchChosenFacilityId, :extractedFacilityId, :facilityMismatch`;

const ORDER_UPDATE_SET = `
  order_number = :orderNumber,
  rec_number = :recNumber,
  facility_id = :facilityId,
  provider_id = :providerId,
  court = :court,
  case_number = :caseNumber,
  order_ref = :orderRef,
  ssn_last_four = :ssnLastFour,
  dob = :dob,
  applicant_first_name = :applicantFirstName,
  applicant_middle_name = :applicantMiddleName,
  applicant_last_name = :applicantLastName,
  applicant_aka = :applicantAka,
  defendant = :defendant,
  injury_type = :injuryType,
  injury_date = :injuryDate,
  injury_date_begin = :injuryDateBegin,
  injury_date_end = :injuryDateEnd,
  serve_company_name = :serveCompanyName,
  serve_address = :serveAddress,
  serve_zip = :serveZip,
  serve_city = :serveCity,
  serve_state = :serveState,
  serve_phone = :servePhone,
  serve_fax = :serveFax,
  serve_email = :serveEmail,
  contact1_name = :contact1Name,
  contact1_title = :contact1Title,
  contact1_phone = :contact1Phone,
  contact1_fax = :contact1Fax,
  contact1_email = :contact1Email,
  contact2_name = :contact2Name,
  contact2_title = :contact2Title,
  contact2_phone = :contact2Phone,
  contact2_fax = :contact2Fax,
  contact2_email = :contact2Email,
  date_served = :dateServed,
  depo_due_date = :depoDueDate,
  delivery_date = :deliveryDate,
  subpoena_date = :subpoenaDate,
  date_requested = :dateRequested,
  ready_date = :readyDate,
  invoice_date = :invoiceDate,
  xray_invoice_date = :xrayInvoiceDate,
  specific_record = :specificRecord,
  specific_doctor = :specificDoctor,
  specific_doctor_is_default = :specificDoctorIsDefault,
  full_address = :fullAddress,
  certificate_no_records = :certificateNoRecords,
  cnr_reason = :cnrReason,
  cnr_delivery = :cnrDelivery,
  cnr_date_sent = :cnrDateSent,
  cnr_memo = :cnrMemo,
  subpoena_storage_path = :subpoenaStoragePath,
  subpoena_uploaded_at = :subpoenaUploadedAt,
  has_subpoena = :hasSubpoena,
  creation_source = :creationSource,
  batch_chosen_facility_id = :batchChosenFacilityId,
  extracted_facility_id = :extractedFacilityId,
  facility_mismatch = :facilityMismatch,
  updated_at = NOW()`;

const ORDER_DETAIL_SELECT = `
  SELECT o.*, f.facility_name, f.slug AS facility_slug,
         f.address AS facility_address, f.city AS facility_city,
         f.state AS facility_state, f.zip_code AS facility_zip,
         f.email AS facility_email, f.is_auto_created AS facility_is_auto_created,
         ef.facility_name AS extracted_facility_name,
         p.company_name AS provider_name,
         p.email AS provider_email
  FROM orders o
  LEFT JOIN facilities f ON f.id = o.facility_id
  LEFT JOIN facilities ef ON ef.id = o.extracted_facility_id
  LEFT JOIN providers p ON p.id = o.provider_id`;

function appendRushLevelFilter(conditions, params, rushLevel) {
  const normalized = `${rushLevel || ""}`.trim();
  if (!normalized) return;

  const ageExpr = `DATEDIFF(CURDATE(), ${ORDER_AGE_SQL_ALIAS})`;

  if (normalized === "Rush 1") {
    conditions.push(
      `(${ageExpr} IS NOT NULL AND ${ageExpr} >= :rush1MinDays AND ${ageExpr} <= :rush1MaxDays)`
    );
    params.rush1MinDays = RUSH_1_MIN_DAYS;
    params.rush1MaxDays = RUSH_1_MAX_DAYS;
    return;
  }

  if (normalized === "Rush 2") {
    conditions.push(
      `(${ageExpr} IS NOT NULL AND ${ageExpr} >= :rush2MinDays AND ${ageExpr} <= :rush2MaxDays)`
    );
    params.rush2MinDays = RUSH_2_MIN_DAYS;
    params.rush2MaxDays = RUSH_2_MAX_DAYS;
    return;
  }

  if (normalized === "Rush 3") {
    conditions.push(`(${ageExpr} IS NOT NULL AND ${ageExpr} >= :rush3MinDays)`);
    params.rush3MinDays = RUSH_3_MIN_DAYS;
  }
}

function resolveListSort(filters = {}) {
  const sortDir = `${filters.sortDir || ""}`.trim().toLowerCase();
  if (sortDir === "asc" || sortDir === "desc") {
    const direction = sortDir.toUpperCase();
    return {
      mode: "created_at",
      direction,
      orderByClause: `ORDER BY o.created_at ${direction}, o.id ${direction}`,
    };
  }

  return {
    mode: "id",
    direction: "DESC",
    orderByClause: "ORDER BY o.id DESC",
  };
}

function encodeCreatedCursor(createdAt, id) {
  if (!createdAt || !id) return null;
  // MySQL DATETIME compare format (UTC) — avoids ISO Z/T mismatches across TZs.
  const dateValue =
    toMysqlUtcDateTime(createdAt) ||
    (createdAt instanceof Date ? createdAt.toISOString() : String(createdAt));
  return `${dateValue}|${id}`;
}

function decodeCreatedCursor(rawCursor) {
  if (rawCursor == null || rawCursor === "") return null;

  const value = String(rawCursor);
  const separatorIndex = value.lastIndexOf("|");
  if (separatorIndex <= 0) return null;

  const createdAt = value.slice(0, separatorIndex);
  const id = Number(value.slice(separatorIndex + 1));
  if (!createdAt || !Number.isFinite(id) || id <= 0) return null;

  return { createdAt, id };
}

function buildFindAllWhere(filters = {}) {
  const conditions = [];
  const params = {};

  // Personal Orders nav lists only personal_portal; normal Orders excludes them
  if (filters.creationSource === "personal_portal") {
    conditions.push("o.creation_source = 'personal_portal'");
  } else {
    conditions.push(
      "(o.creation_source IS NULL OR o.creation_source <> 'personal_portal')"
    );
  }

  if (filters.portalStatus) {
    conditions.push(`EXISTS (
      SELECT 1 FROM personal_request_orders pro
      WHERE pro.order_id = o.id
        AND pro.portal_status = :portalStatus
    )`);
    params.portalStatus = filters.portalStatus;
  }

  if (filters.companyPortalStatus) {
    // Uses unique index on company_portal_orders.internal_order_id (O(1) per row).
    conditions.push(`EXISTS (
      SELECT 1 FROM company_portal_orders cpo
      WHERE cpo.internal_order_id = o.id
        AND cpo.status = :companyPortalStatus
    )`);
    params.companyPortalStatus = filters.companyPortalStatus;
  }

  if (filters.readyFilter) {
    conditions.push(`(
      o.status IN ('Ready', 'Ready to Pickup')
      OR (
        o.status = 'Active'
        AND DATEDIFF(CURDATE(), ${ORDER_AGE_SQL_ALIAS}) >= :rushReadyMinDays
      )
    )`);
    params.rushReadyMinDays = RUSH_READY_MIN_DAYS;
  } else if (filters.status) {
    conditions.push("o.status = :status");
    params.status = filters.status;
  } else {
    conditions.push(NON_DELETED_ORDER_ALIAS);
  }

  if (filters.paymentDueFilter === "unpaid") {
    conditions.push(ORDER_HAS_BILLABLE_ACTIVITY);
    conditions.push(ORDER_HAS_AMOUNT_DUE);
  } else if (filters.paymentDueFilter === "paid") {
    conditions.push(ORDER_HAS_BILLABLE_ACTIVITY);
    conditions.push(`NOT ${ORDER_HAS_AMOUNT_DUE}`);
  }

  // Special status-dropdown filters (not orders.status ENUM values).
  if (filters.noSubpoenaFilter) {
    conditions.push(`(
      COALESCE(o.has_subpoena, 0) = 0
      AND (o.subpoena_storage_path IS NULL OR TRIM(o.subpoena_storage_path) = '')
    )`);
  }

  if (filters.noRecordsFilter) {
    conditions.push("COALESCE(o.certificate_no_records, 0) = 1");
  }

  if (filters.excludeCompleted) {
    conditions.push("o.status <> 'Completed'");
  }

  if (filters.facilityId) {
    conditions.push("o.facility_id = :facilityId");
    params.facilityId = filters.facilityId;
  }

  if (filters.company) {
    conditions.push(`(
      o.serve_company_name = :company
      OR p.company_name = :company
      OR TRIM(o.serve_company_name) = :company
      OR TRIM(p.company_name) = :company
    )`);
    params.company = filters.company;
  }

  if (filters.year) {
    appendYearFilter(conditions, params, filters.year);
  }

  if (filters.periodFrom) {
    const periodFrom = toSqlDateTimeStart(filters.periodFrom);
    if (periodFrom) {
      conditions.push("o.created_at >= :periodFrom");
      params.periodFrom = periodFrom;
    }
  }

  if (filters.createdFrom) {
    const createdFrom = toSqlDateTimeStart(filters.createdFrom);
    if (createdFrom) {
      conditions.push("o.created_at >= :createdFrom");
      params.createdFrom = createdFrom;
    }
  }

  if (filters.createdTo) {
    const createdToExclusive = toSqlDateTimeExclusiveEnd(filters.createdTo);
    if (createdToExclusive) {
      conditions.push("o.created_at < :createdToExclusive");
      params.createdToExclusive = createdToExclusive;
    }
  }

  if (filters.rushLevel) {
    appendRushLevelFilter(conditions, params, filters.rushLevel);
  }

  if (filters.search) {
    appendOrderSearchFilter(conditions, params, filters.search);
  }

  if (filters.creationSource) {
    conditions.push("o.creation_source = :creationSource");
    params.creationSource = filters.creationSource;
  } else if (filters.excludeCreationSource) {
    conditions.push(
      "(o.creation_source IS NULL OR o.creation_source <> :excludeCreationSource)"
    );
    params.excludeCreationSource = filters.excludeCreationSource;
  }

  return {
    whereClause: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

class Order {
  static async findAll(filters = {}) {
    const pool = getPool();
    const { whereClause, params } = buildFindAllWhere(filters);
    const { orderByClause } = resolveListSort(filters);

    const limit =
      filters.limit && Number(filters.limit) > 0
        ? Math.min(Number(filters.limit), 500)
        : null;
    const offset =
      filters.offset && Number(filters.offset) >= 0
        ? Number(filters.offset)
        : null;
    const limitClause = limit
      ? offset !== null
        ? `LIMIT ${offset}, ${limit}`
        : `LIMIT ${limit}`
      : "";

    const [rows] = await pool.execute(
      `${ORDER_DETAIL_SELECT}
       ${whereClause}
       ${orderByClause}
       ${limitClause}`,
      params
    );

    return rows;
  }

  static async findAllKeyset(filters = {}) {
    const pool = getPool();
    const { whereClause, params } = buildFindAllWhere(filters);
    const { mode, direction, orderByClause } = resolveListSort(filters);
    const pageSize = Math.min(Math.max(Number(filters.pageSize) || 10, 1), 100);
    const queryLimit = pageSize + 1;

    let cursorCondition = "";

    if (mode === "created_at") {
      const createdCursor =
        decodeCreatedCursor(filters.cursor) ||
        (filters.cursorCreatedAt && Number(filters.cursorId) > 0
          ? {
              createdAt: filters.cursorCreatedAt,
              id: Number(filters.cursorId),
            }
          : null);

      if (createdCursor) {
        const operator = direction === "ASC" ? ">" : "<";
        cursorCondition = `(
          o.created_at ${operator} :cursorCreatedAt
          OR (
            o.created_at = :cursorCreatedAt
            AND o.id ${operator} :cursorId
          )
        )`;
        params.cursorCreatedAt = createdCursor.createdAt;
        params.cursorId = createdCursor.id;
      }
    } else {
      const cursorId =
        Number(filters.cursorId) > 0
          ? Number(filters.cursorId)
          : Number(filters.cursor) > 0
            ? Number(filters.cursor)
            : null;
      if (cursorId) {
        cursorCondition = "o.id < :cursorId";
        params.cursorId = cursorId;
      }
    }

    const keysetWhereClause = cursorCondition
      ? whereClause
        ? `${whereClause} AND ${cursorCondition}`
        : `WHERE ${cursorCondition}`
      : whereClause;

    const [rows] = await pool.execute(
      `${ORDER_DETAIL_SELECT}
       ${keysetWhereClause}
       ${orderByClause}
       LIMIT ${queryLimit}`,
      params
    );

    const hasMore = rows.length > pageSize;
    const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
    const lastRow = pageRows[pageRows.length - 1] || null;
    const nextCursor =
      hasMore && lastRow
        ? mode === "created_at"
          ? encodeCreatedCursor(lastRow.created_at, lastRow.id)
          : lastRow.id || null
        : null;

    return {
      rows: pageRows,
      pageSize,
      hasMore,
      nextCursor,
    };
  }

  static async countAll(filters = {}) {
    const pool = getPool();
    const { whereClause, params } = buildFindAllWhere(filters);
    const [rows] = await pool.execute(
      `SELECT COUNT(*) AS total
       FROM orders o
       LEFT JOIN facilities f ON f.id = o.facility_id
       LEFT JOIN providers p ON p.id = o.provider_id
       ${whereClause}`,
      params
    );
    return Number(rows[0]?.total) || 0;
  }

  static async findDistinctCompanyNames() {
    const pool = getPool();

    const [rows] = await pool.execute(`
      SELECT DISTINCT company_name
      FROM (
        SELECT TRIM(o.serve_company_name) AS company_name
        FROM orders o
        WHERE o.serve_company_name IS NOT NULL
          AND TRIM(o.serve_company_name) != ''
        UNION
        SELECT TRIM(p.company_name) AS company_name
        FROM orders o
        INNER JOIN providers p ON p.id = o.provider_id
        WHERE p.company_name IS NOT NULL
          AND TRIM(p.company_name) != ''
      ) AS companies
      WHERE company_name IS NOT NULL
        AND company_name != ''
      ORDER BY company_name ASC
    `);

    return rows.map((row) => row.company_name);
  }

  static async searchDoctors(query, limit = 10) {
    const pool = getPool();
    const trimmed = `${query || ""}`.trim();

    if (!trimmed) return [];

    const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 25);

    const [rows] = await pool.execute(
      `SELECT DISTINCT TRIM(specific_doctor) AS name
       FROM orders
       WHERE specific_doctor IS NOT NULL
         AND TRIM(specific_doctor) <> ''
         AND specific_doctor LIKE :query
       ORDER BY name ASC
       LIMIT ${safeLimit}`,
      { query: likeContains(trimmed) }
    );

    return rows.map((row) => row.name).filter(Boolean);
  }

  static async searchDoctorAddresses(query, limit = 10) {
    const pool = getPool();
    const trimmed = `${query || ""}`.trim();

    if (!trimmed) return [];

    const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 25);

    const [rows] = await pool.execute(
      `SELECT DISTINCT TRIM(full_address) AS address
       FROM orders
       WHERE full_address IS NOT NULL
         AND TRIM(full_address) <> ''
         AND full_address LIKE :query
       ORDER BY address ASC
       LIMIT ${safeLimit}`,
      { query: likeContains(trimmed) }
    );

    return rows.map((row) => row.address).filter(Boolean);
  }

  static async findForReport(filters = {}) {
    const pool = getPool();
    const conditions = [ACTIVE_ORDER_ALIAS];
    const params = {};

    if (filters.orderNo) {
      conditions.push("o.order_number LIKE :orderNo");
      params.orderNo = likeContains(filters.orderNo);
    }

    if (filters.caseNumber) {
      conditions.push("o.case_number LIKE :caseNumber");
      params.caseNumber = likeContains(filters.caseNumber);
    }

    if (filters.doctor) {
      conditions.push("o.specific_doctor LIKE :doctor");
      params.doctor = likeContains(filters.doctor);
    }

    if (filters.dateFrom) {
      conditions.push("DATE(o.subpoena_date) >= :dateFrom");
      params.dateFrom = filters.dateFrom;
    }

    if (filters.dateTo) {
      conditions.push("DATE(o.subpoena_date) <= :dateTo");
      params.dateTo = filters.dateTo;
    }

    if (filters.unpaidOnly) {
      conditions.push("(i.id IS NULL OR COALESCE(i.total_amount, 0) <= 0)");
    }

    if (filters.rushLevel) {
      appendRushLevelFilter(conditions, params, filters.rushLevel);
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const [rows] = await pool.execute(
      `SELECT o.*, f.facility_name, f.slug AS facility_slug,
              p.company_name AS provider_name,
              i.id AS invoice_id,
              i.total_amount,
              i.amount_paid,
              i.amount_due,
              i.status AS invoice_status
       FROM orders o
       LEFT JOIN facilities f ON f.id = o.facility_id
       LEFT JOIN providers p ON p.id = o.provider_id
       LEFT JOIN invoices i ON i.id = (
         SELECT i2.id
         FROM invoices i2
         WHERE i2.order_id = o.id
         ORDER BY i2.id DESC
         LIMIT 1
       )
       ${whereClause}
       ORDER BY o.subpoena_date DESC, o.id DESC`,
      params
    );

    return rows;
  }

  static async countStats() {
    const pool = getPool();

    const [rows] = await pool.execute(`
      SELECT
        COUNT(*) AS total_orders,
        SUM(CASE WHEN status = 'Active' THEN 1 ELSE 0 END) AS active_cases,
        SUM(
          CASE
            WHEN status IN ('Ready', 'Ready to Pickup') THEN 1
            ELSE 0
          END
        ) AS ready_to_pickup,
        SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) AS completed
      FROM orders
      WHERE ${ACTIVE_ORDER}
        AND (creation_source IS NULL OR creation_source <> 'company_portal')
    `);

    return rows[0] || {};
  }

  static async findById(id, connection = null) {
    const db = connection || getPool();

    const [rows] = await db.execute(
      `${ORDER_DETAIL_SELECT}
       WHERE o.id = :id AND ${ACTIVE_ORDER_ALIAS}
       LIMIT 1`,
      { id }
    );

    return rows[0] || null;
  }

  static async findByIdRaw(id) {
    const pool = getPool();

    const [rows] = await pool.execute(
      `${ORDER_DETAIL_SELECT}
       WHERE o.id = :id
       LIMIT 1`,
      { id }
    );

    return rows[0] || null;
  }

  static async findByOrderNumber(orderNumber, excludeId = null) {
    const pool = getPool();

    const [rows] = await pool.execute(
      `SELECT id FROM orders
       WHERE order_number = :orderNumber
         ${excludeId ? "AND id <> :excludeId" : ""}
       LIMIT 1`,
      { orderNumber, excludeId }
    );

    return rows[0] || null;
  }

  static async findPaymentsByOrderId(orderId, connection = null) {
    const db = connection || getPool();

    const [rows] = await db.execute(
      `SELECT id, order_id, payment_type, check_number, payment_date, amount, due_amount, is_paid, memo
       FROM order_payments
       WHERE order_id = :orderId`,
      { orderId }
    );

    return rows;
  }

  static async findPaymentsByOrderIds(orderIds = []) {
    if (!orderIds.length) return [];

    const pool = getPool();

    const placeholders = orderIds.map((_, index) => `:id${index}`).join(", ");
    const params = orderIds.reduce((acc, id, index) => {
      acc[`id${index}`] = id;
      return acc;
    }, {});

    const [rows] = await pool.execute(
      `SELECT id, order_id, payment_type, check_number, payment_date, amount, due_amount, is_paid, memo
       FROM order_payments
       WHERE order_id IN (${placeholders})`,
      params
    );

    return rows;
  }

  static async create(connection, data) {
    const [result] = await connection.execute(
      `INSERT INTO orders (${ORDER_COLUMNS}, created_at, updated_at)
       VALUES (${ORDER_VALUES}, NOW(), NOW())`,
      data
    );

    return result.insertId;
  }

  static async update(connection, id, data) {
    await connection.execute(
      `UPDATE orders SET ${ORDER_UPDATE_SET} WHERE id = :id`,
      { ...data, id }
    );
  }

  static async upsertPayment(connection, payment) {
    await connection.execute(
      `INSERT INTO order_payments
        (order_id, payment_type, check_number, payment_date, amount, due_amount, is_paid, memo, created_at, updated_at)
       VALUES
        (:orderId, :paymentType, :checkNumber, :paymentDate, :amount, :dueAmount, :isPaid, :memo, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
        check_number = VALUES(check_number),
        payment_date = VALUES(payment_date),
        amount = VALUES(amount),
        due_amount = VALUES(due_amount),
        is_paid = VALUES(is_paid),
        memo = VALUES(memo),
        updated_at = NOW()`,
      {
        orderId: payment.orderId,
        paymentType: payment.paymentType,
        checkNumber: payment.checkNumber ?? null,
        paymentDate: payment.paymentDate ?? null,
        amount: payment.amount ?? null,
        dueAmount: payment.dueAmount ?? null,
        isPaid: payment.isPaid ?? 0,
        memo: payment.memo ?? null,
      }
    );
  }

  static async deletePaymentByType(connection, orderId, paymentType) {
    await connection.execute(
      `DELETE FROM order_payments
       WHERE order_id = :orderId
         AND payment_type = :paymentType`,
      { orderId, paymentType }
    );
  }

  static async createAdditionalDocument(connection, data) {
    const [result] = await connection.execute(
      `INSERT INTO order_additional_documents
        (order_id, document_name, original_file_name, mime_type, storage_path,
         file_size_bytes, uploaded_by, uploaded_at, created_at, updated_at)
       VALUES
        (:orderId, :documentName, :originalFileName, :mimeType, :storagePath,
         :fileSizeBytes, :uploadedBy, NOW(), NOW(), NOW())`,
      data
    );

    return result.insertId;
  }

  static async findDocumentsByOrderId(orderId) {
    const pool = getPool();

    const [rows] = await pool.execute(
      `SELECT id, order_id, document_name, original_file_name, mime_type,
              storage_path, file_size_bytes, uploaded_at
       FROM order_additional_documents
       WHERE order_id = :orderId AND is_deleted = 0
       ORDER BY id DESC`,
      { orderId }
    );

    return rows;
  }

  static async softDeleteAdditionalDocument(orderId, documentId, connection = null) {
    const executor = connection || getPool();
    const [result] = await executor.execute(
      `UPDATE order_additional_documents
       SET is_deleted = 1, updated_at = NOW()
       WHERE id = :documentId
         AND order_id = :orderId
         AND is_deleted = 0`,
      { orderId, documentId }
    );
    return Number(result.affectedRows || 0) > 0;
  }

  static async clearSubpoena(orderId, connection = null) {
    const executor = connection || getPool();
    const [result] = await executor.execute(
      `UPDATE orders
       SET subpoena_storage_path = NULL,
           subpoena_uploaded_at = NULL,
           has_subpoena = 0,
           updated_at = NOW()
       WHERE id = :orderId`,
      { orderId }
    );
    return Number(result.affectedRows || 0) > 0;
  }

  static async seedWorkflowStages(connection, orderId) {
    const stages = ["Review Records", "Serve", "SENT"];

    for (const stageName of stages) {
      await connection.execute(
        `INSERT INTO order_workflow_stages
          (order_id, stage_name, stage_status, created_at, updated_at)
         VALUES (:orderId, :stageName, 'pending', NOW(), NOW())
         ON DUPLICATE KEY UPDATE updated_at = updated_at`,
        { orderId, stageName }
      );
    }
  }

  static async findWorkflowStagesByOrderId(orderId) {
    const pool = getPool();

    const [rows] = await pool.execute(
      `SELECT id, order_id, stage_name, stage_status, completed_at
       FROM order_workflow_stages
       WHERE order_id = :orderId
       ORDER BY FIELD(stage_name, 'Review Records', 'Serve', 'SENT')`,
      { orderId }
    );

    return rows;
  }

  static async findWorkflowStagesByOrderIds(orderIds = []) {
    if (!orderIds.length) return [];

    const pool = getPool();

    const placeholders = orderIds.map((_, index) => `:id${index}`).join(", ");
    const params = orderIds.reduce((acc, id, index) => {
      acc[`id${index}`] = id;
      return acc;
    }, {});

    const [rows] = await pool.execute(
      `SELECT id, order_id, stage_name, stage_status, completed_at
       FROM order_workflow_stages
       WHERE order_id IN (${placeholders})
       ORDER BY FIELD(stage_name, 'Review Records', 'Serve', 'SENT')`,
      params
    );

    return rows;
  }

  static isWorkflowFullyComplete(stages = []) {
    const statusByName = new Map(
      stages.map((stage) => [stage.stage_name, stage.stage_status])
    );

    return Object.entries(REQUIRED_WORKFLOW_COMPLETION).every(
      ([stageName, requiredStatus]) =>
        statusByName.get(stageName) === requiredStatus
    );
  }

  static async syncOrderStatusFromWorkflow(orderId, connection = null) {
    const db = connection || getPool();

    const [orders] = await db.execute(
      `SELECT id, status
       FROM orders
       WHERE id = :orderId AND ${ACTIVE_ORDER}
       LIMIT 1`,
      { orderId }
    );
    const order = orders[0];

    if (!order || WORKFLOW_AUTO_COMPLETE_EXCLUDED_STATUSES.has(order.status)) {
      return false;
    }

    if (order.status !== "Active") {
      return false;
    }

    const [stageRows] = await db.execute(
      `SELECT stage_name, stage_status
       FROM order_workflow_stages
       WHERE order_id = :orderId`,
      { orderId }
    );

    if (!Order.isWorkflowFullyComplete(stageRows)) {
      return false;
    }

    if (!(await areAllOrderInvoicesPaid(orderId, db))) {
      return false;
    }

    await db.execute(
      `UPDATE orders
       SET status = 'Ready to Pickup', updated_at = NOW()
       WHERE id = :orderId`,
      { orderId }
    );

    setImmediate(() => {
      try {
        const personalPortalService = require("../services/personalPortalService");
        personalPortalService.syncPortalStatusForDmsOrder(orderId).catch(() => {});
      } catch (_error) {
        // ignore — personal portal sync is optional
      }
    });

    return true;
  }

  static async upsertWorkflowStage(
    orderId,
    stageName,
    stageStatus,
    completedAt,
    connection = null
  ) {
    const db = connection || getPool();

    await db.execute(
      `INSERT INTO order_workflow_stages
        (order_id, stage_name, stage_status, completed_at, created_at, updated_at)
       VALUES (:orderId, :stageName, :stageStatus, :completedAt, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
        stage_status = VALUES(stage_status),
        completed_at = VALUES(completed_at),
        updated_at = NOW()`,
      { orderId, stageName, stageStatus, completedAt }
    );

    await Order.syncOrderStatusFromWorkflow(orderId, connection);
  }

  static async findNotesByOrderId(orderId, pendingOnly = false) {
    const pool = getPool();

    const conditions = ["order_id = :orderId"];
    if (pendingOnly) {
      conditions.push("is_called = 0");
    }

    const [rows] = await pool.execute(
      `SELECT id, order_id, note_date, created_by, author_name, note,
              callback_date, attachment_path, is_called, updated_at
       FROM order_notes
       WHERE ${conditions.join(" AND ")}
       ORDER BY note_date DESC, id DESC`,
      { orderId }
    );

    return rows;
  }

  static async findNotesByOrderIdKeyset(
    orderId,
    {
      pendingOnly = false,
      cursorId = null,
      limit = 10,
      fromDate = null,
      toDate = null,
    } = {}
  ) {
    const pool = getPool();
    const conditions = ["order_id = :orderId"];
    const params = { orderId };

    if (pendingOnly) {
      conditions.push("is_called = 0");
    }

    if (cursorId && Number(cursorId) > 0) {
      conditions.push("id < :cursorId");
      params.cursorId = Number(cursorId);
    }

    if (fromDate) {
      conditions.push("DATE(note_date) >= :fromDate");
      params.fromDate = fromDate;
    }

    if (toDate) {
      conditions.push("DATE(note_date) <= :toDate");
      params.toDate = toDate;
    }

    const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 100);
    const queryLimit = safeLimit + 1;

    const [rows] = await pool.execute(
      `SELECT id, order_id, note_date, created_by, author_name, note,
              callback_date, attachment_path, is_called, updated_at
       FROM order_notes
       WHERE ${conditions.join(" AND ")}
       ORDER BY id DESC
       LIMIT ${queryLimit}`,
      params
    );

    const hasMore = rows.length > safeLimit;
    const pageRows = hasMore ? rows.slice(0, safeLimit) : rows;
    const nextCursor = hasMore ? pageRows[pageRows.length - 1]?.id || null : null;

    return {
      rows: pageRows,
      pageSize: safeLimit,
      hasMore,
      nextCursor,
    };
  }

  static async findReminders({ createdBy = null, limit = 500 } = {}) {
    const pool = getPool();
    const conditions = ["n.callback_date IS NOT NULL"];
    const params = {};

    if (createdBy) {
      conditions.push("n.created_by = :createdBy");
      params.createdBy = createdBy;
    }

    const [rows] = await pool.execute(
      `SELECT n.id AS note_id, n.order_id, n.note_date, n.created_by,
              n.author_name, n.note, n.callback_date, n.attachment_path,
              n.is_called, n.updated_at,
              o.order_number, o.case_number,
              o.applicant_first_name, o.applicant_middle_name, o.applicant_last_name
       FROM order_notes n
       INNER JOIN orders o ON o.id = n.order_id AND ${ACTIVE_ORDER_ALIAS}
       WHERE ${conditions.join(" AND ")}
       ORDER BY n.callback_date ASC, n.note_date DESC
       LIMIT ${Number(limit)}`,
      params
    );

    return rows;
  }

  static async findDueRemindersOnDate({ createdBy = null, date, untilUtc = null }) {
    const pool = getPool();
    const conditions = [
      "n.callback_date IS NOT NULL",
      "n.is_called = 0",
    ];
    const params = {};

    if (untilUtc) {
      // Due today or overdue: callback instant is at or before end of viewer's today.
      conditions.push("n.callback_date <= :untilUtc");
      params.untilUtc = untilUtc;
    } else if (date) {
      conditions.push("DATE(n.callback_date) = :dueDate");
      params.dueDate = date;
    }

    if (createdBy) {
      conditions.push("n.created_by = :createdBy");
      params.createdBy = createdBy;
    }

    const [rows] = await pool.execute(
      `SELECT n.id AS note_id, n.order_id, n.note_date, n.created_by,
              n.author_name, n.note, n.callback_date, n.attachment_path,
              n.is_called, n.updated_at,
              o.order_number, o.case_number,
              o.applicant_first_name, o.applicant_middle_name, o.applicant_last_name
       FROM order_notes n
       INNER JOIN orders o ON o.id = n.order_id AND ${ACTIVE_ORDER_ALIAS}
       WHERE ${conditions.join(" AND ")}
       ORDER BY n.callback_date ASC, o.order_number ASC`,
      params
    );

    return rows;
  }

  static async findRecentNotesByOrderIds(orderIds = [], limitPerOrder = 2) {
    if (!orderIds.length) return {};

    const pool = getPool();
    const placeholders = orderIds.map(() => "?").join(", ");

    const [rows] = await pool.execute(
      `SELECT id, order_id, note_date, created_by, author_name, note,
              callback_date, attachment_path, is_called
       FROM order_notes
       WHERE order_id IN (${placeholders})
       ORDER BY note_date DESC, id DESC`,
      orderIds
    );

    const grouped = {};

    rows.forEach((row) => {
      if (!grouped[row.order_id]) grouped[row.order_id] = [];
      if (grouped[row.order_id].length < limitPerOrder) {
        grouped[row.order_id].push(row);
      }
    });

    return grouped;
  }

  static async findActiveReminderFlagsByOrderIds(orderIds = []) {
    if (!orderIds.length) return {};

    const pool = getPool();
    const placeholders = orderIds.map(() => "?").join(", ");

    const [rows] = await pool.execute(
      `SELECT order_id, COUNT(*) AS reminder_count
       FROM order_notes
       WHERE order_id IN (${placeholders})
         AND callback_date IS NOT NULL
         AND is_called = 0
       GROUP BY order_id`,
      orderIds
    );

    return rows.reduce((acc, row) => {
      acc[row.order_id] = Number(row.reminder_count) > 0;
      return acc;
    }, {});
  }

  static async createNote(data) {
    const pool = getPool();

    const [result] = await pool.execute(
      `INSERT INTO order_notes
        (order_id, note_date, created_by, author_name, note,
         callback_date, attachment_path, is_called, created_at, updated_at)
       VALUES
        (:orderId, NOW(), :createdBy, :authorName, :note,
         :callbackDate, :attachmentPath, :isCalled, NOW(), NOW())`,
      data
    );

    await pool.execute(
      `UPDATE orders SET has_note = 1, updated_at = NOW() WHERE id = :orderId`,
      { orderId: data.orderId }
    );

    return result.insertId;
  }

  static async updateNote(connection, id, data) {
    // attachmentPath is COALESCE'd so passing null keeps the existing file.
    await connection.execute(
      `UPDATE order_notes
       SET note = :note,
           callback_date = :callbackDate,
           attachment_path = COALESCE(:attachmentPath, attachment_path),
           is_called = :isCalled,
           updated_at = NOW()
       WHERE id = :id`,
      { ...data, id }
    );
  }

  static async createActivityLog(data, connection = null) {
    const db = connection || getPool();

    const [result] = await db.execute(
      `INSERT INTO order_activity_logs
        (order_id, activity_date, performed_by, author_name,
         callback_date, note, attachment_path, created_at)
       VALUES
        (:orderId, :activityDate, :performedBy, :authorName,
         :callbackDate, :note, :attachmentPath, NOW())`,
      data
    );

    return result.insertId;
  }

  static async findActivityLogsByOrderId(orderId) {
    const pool = getPool();

    const [rows] = await pool.execute(
      `SELECT id, order_id, activity_date, performed_by, author_name,
              callback_date, note, attachment_path
       FROM order_activity_logs
       WHERE order_id = :orderId
       ORDER BY activity_date DESC, id DESC`,
      { orderId }
    );

    return rows;
  }

  static async findMergedActivityLogsKeyset(
    orderId,
    {
      orderNumber = null,
      cursorSortKey = null,
      pageSize = 10,
      search = null,
    } = {}
  ) {
    const pool = getPool();
    const safeLimit = Math.min(Math.max(Number(pageSize) || 10, 1), 100);
    const queryLimit = safeLimit + 1;
    const params = { orderId };
    const trimmedSearch = `${search || ""}`.trim();
    const orderSearchClause = trimmedSearch
      ? `AND (
          oal.note LIKE :search
          OR oal.author_name LIKE :search
        )`
      : "";
    const globalSearchClause = trimmedSearch
      ? `AND (
          al.details LIKE :search
          OR al.performer_name LIKE :search
          OR al.action LIKE :search
          OR al.module LIKE :search
        )`
      : "";

    if (trimmedSearch) {
      params.search = likeContains(trimmedSearch);
    }

    const globalConditions = ["al.details LIKE :orderTag"];
    params.orderTag = `%order_id:${Number(orderId)}%`;

    if (orderNumber) {
      globalConditions.push(
        "(al.module = 'Orders' AND (al.details LIKE :orderNumberTag OR al.details LIKE :orderLabelTag))"
      );
      params.orderNumberTag = likeContains(orderNumber);
      params.orderLabelTag = likeContains(`order ${orderNumber}`);
    }

    const cursorValue = `${cursorSortKey ?? ""}`.trim();
    const hasCursor = /^\d+$/.test(cursorValue);
    const cursorClause = hasCursor ? "AND merged.sort_key < :cursorSortKey" : "";
    if (hasCursor) {
      // Zero-pad so lexical compare matches numeric order for equal-length keys.
      params.cursorSortKey = cursorValue.padStart(30, "0");
    }

    const [rows] = await pool.execute(
      `SELECT merged.*
       FROM (
         SELECT
           LPAD(
             CAST(
               (UNIX_TIMESTAMP(oal.activity_date) * 1000000000) + oal.id
               AS CHAR
             ),
             30,
             '0'
           ) AS sort_key,
           'order' AS log_source,
           oal.id,
           oal.order_id,
           oal.activity_date,
           oal.performed_by,
           oal.author_name,
           oal.callback_date,
           oal.note,
           oal.attachment_path,
           NULL AS log_date,
           NULL AS log_time,
           NULL AS action,
           NULL AS module,
           NULL AS company_name,
           NULL AS facility_id,
           NULL AS performer_name,
           NULL AS performer_initials,
           NULL AS details,
           oal.activity_date AS created_at
         FROM order_activity_logs oal
         WHERE oal.order_id = :orderId
         ${orderSearchClause}

         UNION ALL

         SELECT
           LPAD(
             CAST(
               (
                 UNIX_TIMESTAMP(
                   COALESCE(
                     al.created_at,
                     STR_TO_DATE(
                       CONCAT(al.log_date, ' ', COALESCE(al.log_time, '00:00:00')),
                       '%Y-%m-%d %H:%i:%s'
                     )
                   )
                 ) * 1000000000
               ) + al.id
               AS CHAR
             ),
             30,
             '0'
           ) AS sort_key,
           'global' AS log_source,
           al.id,
           :orderId AS order_id,
           COALESCE(
             al.created_at,
             STR_TO_DATE(
               CONCAT(al.log_date, ' ', COALESCE(al.log_time, '00:00:00')),
               '%Y-%m-%d %H:%i:%s'
             )
           ) AS activity_date,
           al.performed_by,
           al.performer_name AS author_name,
           NULL AS callback_date,
           al.details AS note,
           NULL AS attachment_path,
           al.log_date,
           al.log_time,
           al.action,
           al.module,
           al.company_name,
           al.facility_id,
           al.performer_name,
           al.performer_initials,
           al.details,
           al.created_at
         FROM activity_logs al
         WHERE (${globalConditions.join(" OR ")})
         ${globalSearchClause}
       ) AS merged
       WHERE 1 = 1
       ${cursorClause}
       ORDER BY merged.sort_key DESC
       LIMIT ${queryLimit}`,
      params
    );

    const hasMore = rows.length > safeLimit;
    const pageRows = hasMore ? rows.slice(0, safeLimit) : rows;
    const lastSortKey = pageRows[pageRows.length - 1]?.sort_key;
    const nextCursor =
      hasMore && lastSortKey != null && `${lastSortKey}`.trim() !== ""
        ? `${lastSortKey}`
        : null;

    return {
      rows: pageRows,
      pageSize: safeLimit,
      hasMore,
      nextCursor,
    };
  }

  static async findNoteById(id, connection = null) {
    const db = connection || getPool();

    const [rows] = await db.execute(
      `SELECT id, order_id, note_date, created_by, author_name, note,
              callback_date, attachment_path, is_called
       FROM order_notes
       WHERE id = :id
       LIMIT 1`,
      { id }
    );

    return rows[0] || null;
  }

  static async deleteById(id, { deletedBy, reason } = {}) {
    const pool = getPool();

    const [result] = await pool.execute(
      `UPDATE orders
       SET status_before_inactive = status,
           status = 'Deleted',
           deleted_at = NOW(),
           deleted_by = :deletedBy,
           delete_reason = :reason,
           updated_at = NOW()
       WHERE id = :id AND ${ACTIVE_ORDER}`,
      { id, deletedBy: deletedBy || null, reason: reason || null }
    );

    return result.affectedRows > 0;
  }

  static async cancelById(id, { reason, actorId }) {
    const pool = getPool();

    const [result] = await pool.execute(
      `UPDATE orders
       SET status_before_inactive = status,
           status = 'Cancelled',
           cancel_reason = :reason,
           cancelled_at = NOW(),
           cancelled_by = :actorId,
           updated_at = NOW()
       WHERE id = :id AND ${ACTIVE_ORDER}`,
      { id, reason, actorId: actorId || null }
    );

    return result.affectedRows > 0;
  }

  static async restoreById(id) {
    const pool = getPool();

    const [result] = await pool.execute(
      `UPDATE orders
       SET status = COALESCE(status_before_inactive, 'Active'),
           status_before_inactive = NULL,
           cancel_reason = NULL,
           cancelled_at = NULL,
           cancelled_by = NULL,
           deleted_at = NULL,
           deleted_by = NULL,
           delete_reason = NULL,
           updated_at = NOW()
       WHERE id = :id
         AND status IN ('Cancelled', 'Deleted')`,
      { id }
    );

    return result.affectedRows > 0;
  }

  /**
   * First successful emailed-records download only.
   * Does not touch status, ready_date, or other order fields.
   */
  static async markRecordsDownloaded(orderId) {
    const pool = getPool();
    const id = Number(orderId);
    if (!Number.isFinite(id) || id <= 0) return false;

    const [result] = await pool.execute(
      `UPDATE orders
       SET records_downloaded_at = NOW(),
           updated_at = NOW()
       WHERE id = :id
         AND records_downloaded_at IS NULL`,
      { id }
    );

    return Number(result.affectedRows || 0) > 0;
  }
}

module.exports = Order;
