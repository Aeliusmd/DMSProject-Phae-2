/**
 * Report aggregations for DMS reporting pages.
 */

const { getPool } = require("../config/database");
const Order = require("../models/Order");
const fileStorage = require("../utils/fileStorage");
const { ACTIVITY_FILTER_VALUES } = require("../lib/reportQueryParser");

const PRODUCED_STATUSES = new Set(["Ready", "Ready to Pickup", "Completed"]);

const { calculateOrderRushLevel } = require("../utils/rushUtils");

const RECORD_TITLES = {
  medical: "Medical Records",
  billing: "Billing Records",
  employment: "Employment Records",
  xrays: "X-Ray Films",
};

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function formatMoney(value) {
  return `$${toNumber(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function buildFullName(first, middle, last) {
  return [first, middle, last].filter(Boolean).join(" ").trim();
}

const {
  normalizeDate,
  formatDobDisplay,
  formatSsnLastFourDisplay,
} = require("../utils/dateUtils");

function buildRecordsRequested(row) {
  const rawTypes = row.order_record_types || row.order_type || "";
  const types = `${rawTypes}`
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const type =
    types.map((value) => RECORD_TITLES[value] || value).join(", ") || "Records";
  const parts = [];

  if (row.specific_record) parts.push(row.specific_record);
  if (row.specific_doctor) parts.push(row.specific_doctor);

  if (parts.length) {
    return parts.join(" ");
  }

  return type;
}

function buildAddress(row) {
  const address = [
    row.serve_address,
    [row.serve_city, row.serve_state].filter(Boolean).join(", "),
    row.serve_zip,
  ]
    .filter(Boolean)
    .join(" ");

  return address || row.full_address || "";
}

function resolveCombinedFinancials(row) {
  const standardTotal = toNumber(row.total_amount);
  const standardPaid = toNumber(row.amount_paid);
  const standardDue = toNumber(row.amount_due);
  const xrayTotal = toNumber(row.xray_total_amount);
  const xrayPaid = toNumber(row.xray_amount_paid);
  const xrayDue = Math.max(0, xrayTotal - xrayPaid);

  return {
    standardTotal,
    standardPaid,
    standardDue,
    xrayTotal,
    xrayPaid,
    xrayDue,
    totalInvoiced: standardTotal + xrayTotal,
    totalPaid: standardPaid + xrayPaid,
    totalDue: Math.max(0, standardDue) + xrayDue,
    hasAnyInvoice:
      (Boolean(row.invoice_id) && standardTotal > 0) ||
      (Boolean(row.xray_invoice_id) && xrayTotal > 0),
  };
}

function mapReportOrderRow(row) {
  const totalAmount = toNumber(row.total_amount);
  const invoiced = Boolean(row.invoice_id && totalAmount > 0);
  const rush = calculateOrderRushLevel(row.created_at);

  return {
    id: row.id,
    dbId: row.id,
    orderNo: row.order_number || "",
    recNumber: row.rec_number || "",
    subNo: row.order_ref || "",
    status: row.status || "",
    invoiced,
    invoicePaid: row.invoice_status === "Paid",
    invoiceStatus: row.invoice_status || null,
    invoiceAmount: invoiced ? formatMoney(totalAmount) : "$0.00",
    subpoenaDate: normalizeDate(row.subpoena_date),
    subpoenaUploadedAt: row.subpoena_uploaded_at || null,
    subpoenaUploadedAtDisplay: normalizeDate(row.subpoena_uploaded_at),
    dateServed: normalizeDate(row.date_served),
    applicant: buildFullName(
      row.applicant_first_name,
      row.applicant_middle_name,
      row.applicant_last_name
    ),
    caseNumber: row.case_number || "",
    dob: formatDobDisplay(row.dob),
    ssn: formatSsnLastFourDisplay(row.ssn_last_four),
    provider: row.serve_company_name || row.provider_name || "",
    recordsRequested: buildRecordsRequested(row),
    doctor: row.specific_doctor || "",
    address: buildAddress(row),
    createdAt: row.created_at || null,
    rushLevel: rush.label,
    rushLabel: rush.label,
    subpoenaUrl: fileStorage.toPublicUploadsUrl(row.subpoena_storage_path),
  };
}

function dedupeByOrderNumber(orders = []) {
  const seen = new Set();

  return orders.filter((order) => {
    const key = order.orderNo || String(order.id);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

async function getOrdersReport({
  orderNo = "",
  caseNumber = "",
  doctor = "",
  dateFrom = null,
  dateTo = null,
  rushLevel = "",
  unpaidOnly = false,
  showDuplicates = true,
} = {}) {
  const rows = await Order.findForReport({
    orderNo: orderNo || null,
    caseNumber: caseNumber || null,
    doctor: doctor || null,
    dateFrom,
    dateTo,
    rushLevel: rushLevel || null,
    unpaidOnly: Boolean(unpaidOnly),
  });

  let orders = rows.map(mapReportOrderRow);

  if (!showDuplicates) {
    orders = dedupeByOrderNumber(orders);
  }

  return {
    orders,
    count: orders.length,
  };
}

function deriveCaseActivities(row) {
  const activities = new Set();
  const financials = resolveCombinedFinancials(row);
  const invoiceStatus = String(row.invoice_status || "");

  if (financials.hasAnyInvoice) {
    activities.add("Invoiced");
  }

  if (invoiceStatus === "Written Off") {
    activities.add("Written Off");
  }

  if (financials.totalInvoiced > 0 && financials.totalPaid >= financials.totalInvoiced) {
    activities.add("Paid");
  }

  if (financials.totalInvoiced > 0 && financials.totalDue > 0 && invoiceStatus !== "Written Off") {
    activities.add("Unpaid");
  }

  if (PRODUCED_STATUSES.has(row.order_status)) {
    activities.add("Produced");
  }

  return Array.from(activities);
}

function getPrimaryActivity(activities = []) {
  if (activities.includes("Paid")) return "Paid";
  if (activities.includes("Written Off")) return "Written Off";
  if (activities.includes("Unpaid")) return "Unpaid";
  if (activities.includes("Invoiced")) return "Invoiced";
  if (activities.includes("Produced")) return "Produced";
  return "Activity";
}

function getCaseAmount(row, activity) {
  const financials = resolveCombinedFinancials(row);

  if (activity === "Paid") {
    return financials.totalPaid;
  }

  if (activity === "Written Off") {
    return toNumber(row.writeoff_amount);
  }

  if (activity === "Unpaid") {
    return financials.totalDue;
  }

  return financials.totalInvoiced;
}

function companyMatchesActivity(activities, filter) {
  if (!filter || filter === "All") return true;
  return activities.includes(filter);
}

function companyMatchesSearch(company, search) {
  if (!search) return true;

  const term = search.toLowerCase();

  return (
    company.name.toLowerCase().includes(term) ||
    String(company.cases).includes(term) ||
    String(company.invoiced).includes(term) ||
    String(company.paid).includes(term)
  );
}

async function getActivityReport({
  dateFrom = null,
  dateTo = null,
  facilityId = null,
  activity = "All",
  search = "",
} = {}) {
  const pool = getPool();
  const safeSearch = search;
  const safeActivity = ACTIVITY_FILTER_VALUES.has(activity) ? activity : "All";
  const conditions = [
    "f.is_active = 1",
    "o.status NOT IN ('Cancelled', 'Deleted')",
  ];
  const params = {};

  if (dateFrom) {
    conditions.push(
      "DATE(COALESCE(i.invoice_date, x.xray_invoice_date, o.created_at)) >= :dateFrom"
    );
    params.dateFrom = dateFrom;
  }

  if (dateTo) {
    conditions.push(
      "DATE(COALESCE(i.invoice_date, x.xray_invoice_date, o.created_at)) <= :dateTo"
    );
    params.dateTo = dateTo;
  }

  if (facilityId) {
    conditions.push("f.id = :facilityId");
    params.facilityId = facilityId;
  }

  const [rows] = await pool.execute(
    `SELECT
      f.id AS facility_id,
      f.facility_name,
      o.id AS order_id,
      o.order_number,
      o.applicant_first_name,
      o.applicant_middle_name,
      o.applicant_last_name,
      o.status AS order_status,
      o.created_at AS order_created_at,
      i.id AS invoice_id,
      i.total_amount,
      i.amount_paid,
      i.amount_due,
      i.writeoff_amount,
      i.status AS invoice_status,
      i.invoice_date,
      x.id AS xray_invoice_id,
      x.payment AS xray_total_amount,
      x.amount_paid AS xray_amount_paid,
      x.xray_invoice_date
    FROM orders o
    INNER JOIN facilities f ON f.id = o.facility_id
    LEFT JOIN invoices i ON i.id = (
      SELECT i2.id
      FROM invoices i2
      WHERE i2.order_id = o.id
      ORDER BY i2.id DESC
      LIMIT 1
    )
    LEFT JOIN invoice_xray_details x ON x.id = (
      SELECT x2.id
      FROM invoice_xray_details x2
      WHERE x2.order_id = o.id
      ORDER BY x2.id DESC
      LIMIT 1
    )
    WHERE ${conditions.join(" AND ")}
    ORDER BY f.facility_name ASC, o.id DESC`,
    params
  );

  const companiesMap = new Map();

  rows.forEach((row) => {
    const facilityKey = row.facility_id;

    if (!companiesMap.has(facilityKey)) {
      companiesMap.set(facilityKey, {
        id: row.facility_id,
        name: row.facility_name || "Unknown Facility",
        cases: [],
        invoiced: 0,
        paid: 0,
        activities: new Set(),
      });
    }

    const company = companiesMap.get(facilityKey);
    const caseActivities = deriveCaseActivities(row);
    const primaryActivity = getPrimaryActivity(caseActivities);
    const amount = getCaseAmount(row, primaryActivity);
    const financials = resolveCombinedFinancials(row);

    caseActivities.forEach((item) => company.activities.add(item));

    company.cases.push({
      orderId: row.order_id,
      caseNo: row.order_number || "",
      applicant:
        buildFullName(
          row.applicant_first_name,
          row.applicant_middle_name,
          row.applicant_last_name
        ) || "—",
      activity: primaryActivity,
      activities: caseActivities,
      amount,
      amountDisplay: formatMoney(amount),
      invoiceDate: normalizeDate(row.invoice_date || row.order_created_at),
    });

    company.invoiced += financials.totalInvoiced;
    company.paid += financials.totalPaid;
  });

  let companies = Array.from(companiesMap.values()).map((company) => {
    const activities = Array.from(company.activities);

    return {
      id: company.id,
      name: company.name,
      cases: company.cases.length,
      invoiced: company.invoiced,
      invoicedDisplay: formatMoney(company.invoiced),
      paid: company.paid,
      paidDisplay: formatMoney(company.paid),
      activities,
      caseRows: company.cases,
    };
  });

  companies = companies.filter((company) => {
    return (
      companyMatchesActivity(company.activities, safeActivity) &&
      companyMatchesSearch(company, safeSearch)
    );
  });

  const totalCases = companies.reduce((sum, company) => sum + company.cases, 0);

  return {
    companies,
    summary: {
      facilityCount: companies.length,
      totalCases,
    },
  };
}

async function getActivityReportPdf(options = {}) {
  const report = await getActivityReport(options);
  const { generateActivityReportPdf } = require("../utils/activityReportPdf");

  const pdfBuffer = await generateActivityReportPdf(report, {
    dateFrom: options.dateFrom || null,
    dateTo: options.dateTo || null,
    facilityLabel: options.facilityLabel || "All Facilities",
    activity: options.activity || "All",
    search: options.search || "",
    generatedAt: new Date(),
  });

  return {
    pdfBuffer,
    fileName: buildActivityReportFileName(options),
    report,
  };
}

function buildActivityReportFileName({
  dateFrom = null,
  dateTo = null,
} = {}) {
  const fromPart = dateFrom || "all";
  const toPart = dateTo || "all";
  return `activity-report-${fromPart}-${toPart}.pdf`;
}

module.exports = {
  getOrdersReport,
  getActivityReport,
  getActivityReportPdf,
};
