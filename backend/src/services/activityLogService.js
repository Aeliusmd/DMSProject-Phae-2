const Employee = require("../models/Employee");
const Facility = require("../models/Facility");
const ActivityLog = require("../models/ActivityLog");
const milestoneRollupService = require("./milestoneRollupService");
const ApiError = require("../utils/ApiError");
const logger = require("../utils/logger");
const { runNonCritical } = require("../utils/serviceErrorUtils");
const {
  assertEnum,
  parseOptionalIsoDate,
} = require("../utils/sqlSafety");
const {
  sanitizeSearchText,
  sanitizeText,
} = require("../utils/sanitize");
const { FIELD_LIMITS } = require("../utils/fieldLimits");
const { assertReportDateRange } = require("../lib/reportQueryParser");
const {
  splitUtcInstant,
  loggedAtFromParts,
  normalizeCalendarDate,
  formatUtcInstantDisplay,
  expandUtcInstantTokens,
  embedUtcInstantToken,
  calendarTodayInTimezone,
  startOfCalendarDayUtc,
  endOfCalendarDayUtc,
  toMysqlUtcDateTime,
} = require("../utils/timezoneUtils");
const config = require("../config");

const MODULES = {
  SECURITY: "Security",
  EMPLOYEES: "Employees",
  FACILITIES: "Facilities",
  BILLING: "Billing",
  ORDERS: "Orders",
  PROCESSING: "Processing",
  REPORTS: "Reports",
};

const ALLOWED_LOG_MODULES = new Set(Object.values(MODULES));

const CONTEXT_MODULE_MAP = {
  auth: MODULES.SECURITY,
  security: MODULES.SECURITY,
  employees: MODULES.EMPLOYEES,
  facilities: MODULES.FACILITIES,
  documents: MODULES.FACILITIES,
  notes: MODULES.FACILITIES,
  settings: MODULES.SECURITY,
  billing: MODULES.BILLING,
  invoices: MODULES.BILLING,
  orders: MODULES.ORDERS,
  reports: MODULES.REPORTS,
  processing: MODULES.PROCESSING,
};

function getInitials(name) {
  return String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function resolveModule(context, explicitModule) {
  if (explicitModule) {
    return explicitModule;
  }

  if (!context) {
    return MODULES.REPORTS;
  }

  return CONTEXT_MODULE_MAP[String(context).toLowerCase()] || MODULES.REPORTS;
}

function formatActionLabel(action, context) {
  if (action && /[A-Z]/.test(action) && action.includes(" ")) {
    return action;
  }

  const labels = {
    login: "Login",
    logout: "Logout",
    impersonate: "Signed In As User",
    create:
      context === "employees"
        ? "Employee Added"
        : context === "facilities"
          ? "Facility Created"
          : context === "orders"
            ? "Order Created"
            : "Record Created",
    terminate: "Employee Terminated",
    activate: "Employee Activated",
    delete:
      context === "employees"
        ? "Employee Deleted"
        : context === "documents"
          ? "Document Deleted"
          : context === "facilities"
            ? "Facility Deleted"
            : context === "orders"
              ? "Order Deleted"
              : "Record Deleted",
    update:
      context === "facilities"
        ? "Facility Updated"
        : context === "orders"
          ? "Order Updated"
          : "Record Updated",
    update_profile: "Profile Updated",
    update_notifications: "Notifications Updated",
    change_password: "Password Changed",
    upload: "Document Uploaded",
    upload_document: "Document Uploaded",
    delete_document: "Document Deleted",
    create_doctors: "Doctor Added",
    deactivate_doctor: "Doctor Deactivated",
    reactivate_doctor: "Doctor Reactivated",
    set_default_doctor: "Default Doctor Updated",
    add_office_manager: "Office Manager Added",
    remove_office_manager: "Office Manager Removed",
    create_note:
      context === "orders"
        ? "Order Note Added"
        : context === "facilities" || context === "notes"
          ? "Facility Note Added"
          : "Note Added",
    update_note: "Order Note Callback",
    workflow_update: "Order Workflow Updated",
    cancel: "Order Cancelled",
    restore: "Order Restored",
    company_portal_no_facility: "Company Order No Facility",
    company_portal_restore_in_process: "Company Order Restored To In Process",
    company_portal_stage: "Company Order Stage Updated",
    company_portal_link_facility: "Company Order Facility Linked",
    personal_portal_no_facility: "Personal Order No Facility",
    personal_portal_restore_in_process: "Personal Order Restored To In Process",
    personal_portal_link_facility: "Personal Order Facility Linked",
    order_pickup: "Order Pickup Recorded",
    order_mail: "Records Ready Email Sent",
    copy_service_letter: "Copy Service Letter Sent",
    print_invoice: "Print Invoice",
    print_xray_invoice: "Print X-Ray Invoice",
    create_invoice: "Invoice Created",
    update_invoice: "Invoice Updated",
    send_invoices: "Invoice Sent",
    resend_invoices: "Invoice Resent",
    email_invoice: "Invoice Emailed",
    email_xray_invoice: "X-Ray Invoice Emailed",
    save_xray_invoice: "X-Ray Invoice Saved",
    write_off: "Invoice Written Off",
    record_payment: "Payment Recorded",
    sync_payment: "Invoice Payment Updated",
  };

  return labels[action] || String(action || "Activity");
}

function stripTargetTag(details) {
  return String(details || "")
    .replace(/\s*\|\s*target_employee_id:\d+\s*$/i, "")
    .trim();
}

function appendTargetEmployee(details, targetEmployeeId) {
  const base = stripTargetTag(details);

  if (!targetEmployeeId) {
    return base;
  }

  return `${base} | target_employee_id:${targetEmployeeId}`;
}

function stripOrderIdTag(details) {
  return String(details || "")
    .replace(/\s*\|\s*order_id:\d+\s*$/i, "")
    .trim();
}

function extractTargetEmployeeId(details) {
  const match = String(details || "").match(/target_employee_id:(\d+)/i);
  return match ? Number(match[1]) : null;
}

async function withRepairedSuspendLogDetails(rows = []) {
  const legacy = rows.filter((row) => {
    const action = String(row.action || "").toLowerCase();
    return (
      action === "suspend" &&
      extractTargetEmployeeId(row.details) &&
      !/\[\[utc:/i.test(String(row.details || ""))
    );
  });

  if (!legacy.length) {
    return rows;
  }

  const employeeIds = [
    ...new Set(
      legacy
        .map((row) => extractTargetEmployeeId(row.details))
        .filter((id) => Number.isFinite(id) && id > 0)
    ),
  ];

  const reactivatedByEmployeeId = new Map();

  await Promise.all(
    employeeIds.map(async (id) => {
      const employee = await Employee.findById(id, { includeDeleted: true });
      if (employee?.reactivated_date && Number(employee.is_suspended)) {
        reactivatedByEmployeeId.set(id, {
          name: employee.name,
          token: embedUtcInstantToken(employee.reactivated_date),
        });
      }
    })
  );

  if (!reactivatedByEmployeeId.size) {
    return rows;
  }

  return rows.map((row) => {
    const targetId = extractTargetEmployeeId(row.details);
    const meta = reactivatedByEmployeeId.get(targetId);
    if (!meta?.token || String(row.action || "").toLowerCase() !== "suspend") {
      return row;
    }
    if (/\[\[utc:/i.test(String(row.details || ""))) {
      return row;
    }

    const name = meta.name || "employee";
    const suffixMatch = String(row.details || "").match(
      /(\s*\|\s*target_employee_id:\d+\s*)$/i
    );
    const suffix = suffixMatch?.[1] || ` | target_employee_id:${targetId}`;

    return {
      ...row,
      details: `Suspended employee ${name} until ${meta.token}${suffix}`,
    };
  });
}

function appendOrderId(details, orderId) {
  const base = stripOrderIdTag(details);

  if (!orderId) {
    return base;
  }

  return `${base} | order_id:${orderId}`;
}

function normalizeDateValue(value) {
  if (!value) return "";

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";

    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  const str = String(value).trim();
  const isoMatch = str.match(/^(\d{4}-\d{2}-\d{2})/);

  if (isoMatch) {
    return isoMatch[1];
  }

  const parsed = new Date(str);

  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeTimeValue(value) {
  if (!value) return "";

  const str = String(value).trim();
  const timeMatch = str.match(/(\d{2}:\d{2})/);

  if (timeMatch) {
    return timeMatch[1];
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toTimeString().slice(0, 5);
  }

  return "";
}

function formatDisplayDate(logDate, logTime, timeZone = config.businessTimezone) {
  const loggedAt = loggedAtFromParts(logDate, logTime);
  if (loggedAt) {
    return formatUtcInstantDisplay(loggedAt, timeZone);
  }

  const datePart = normalizeCalendarDate(logDate);
  const timePart = normalizeTimeValue(logTime);

  if (!datePart) return "";

  return timePart ? `${datePart} ${timePart}` : datePart;
}

function formatPerformerRoleLabel(role) {
  const normalized = String(role || "").trim().toLowerCase();
  if (normalized === "admin") return "Super Admin";
  if (normalized === "manager") return "Manager";
  if (normalized === "employee") return "Employee";
  return role ? String(role).trim() : "";
}

function mapLogRow(row, timeZone = config.businessTimezone) {
  const details = expandUtcInstantTokens(
    stripOrderIdTag(stripTargetTag(row.details)),
    timeZone
  );
  const logDate = normalizeCalendarDate(row.log_date);
  const logTime = normalizeTimeValue(row.log_time);
  const loggedAt = loggedAtFromParts(row.log_date, row.log_time);
  const performerRole = formatPerformerRoleLabel(
    row.performer_role || row.role
  );

  return {
    id: row.id,
    date: logDate,
    time: logTime,
    loggedAt,
    displayDate: formatDisplayDate(row.log_date, row.log_time, timeZone),
    by: row.performer_name,
    performedBy: row.performer_name,
    performerRole,
    role: performerRole,
    initials: row.performer_initials || getInitials(row.performer_name),
    callback: row.action,
    action: row.action,
    note: details,
    details,
    module: row.module,
    company: row.company_name || "System",
    companyName: row.company_name || "System",
    facilityId: row.facility_id,
    performedById: row.performed_by,
    createdAt: row.created_at,
  };
}

async function resolveActor(actorId) {
  const employee = await Employee.findByIdPublic(actorId);

  return {
    performerName: employee?.name || "Unknown User",
    performerRole: employee?.role || null,
  };
}

async function resolveCompanyName({ companyName, facilityId }) {
  if (companyName) {
    return companyName;
  }

  if (!facilityId) {
    return "System";
  }

  const facility = await Facility.findById(facilityId);
  return facility?.facility_name || "System";
}

async function recordActivity({
  performedBy,
  performerName = null,
  action,
  context = null,
  module = null,
  details,
  companyName = null,
  facilityId = null,
  targetEmployeeId = null,
}) {
  if (!performedBy || !details) {
    return null;
  }

  let resolvedName = performerName;

  if (!resolvedName) {
    const actor = await resolveActor(performedBy);
    resolvedName = actor.performerName;
  }

  const now = new Date();
  const { date: logDate, time: logTime } = splitUtcInstant(now);
  const resolvedModule = resolveModule(context, module);
  const resolvedAction = formatActionLabel(action, context);
  const resolvedCompanyName = await resolveCompanyName({ companyName, facilityId });
  const resolvedDetails = sanitizeText(
    appendTargetEmployee(details, targetEmployeeId),
    { maxLength: FIELD_LIMITS.TEXT }
  );

  const logId = await ActivityLog.create({
    logDate,
    logTime,
    action: sanitizeText(resolvedAction, { maxLength: FIELD_LIMITS.ACTION }),
    module: resolvedModule,
    companyName:
      sanitizeText(resolvedCompanyName, {
        maxLength: FIELD_LIMITS.ACTIVITY_COMPANY_NAME,
        allowEmpty: true,
      }) || "System",
    facilityId: facilityId || null,
    performedBy,
    performerName:
      sanitizeText(resolvedName, {
        maxLength: FIELD_LIMITS.PERFORMER_NAME,
        allowEmpty: true,
      }) || "System",
    performerInitials: getInitials(resolvedName),
    details: resolvedDetails,
  });

  await milestoneRollupService.recordFromActivityLogSafe({
    employeeId: performedBy,
    action: resolvedAction,
    module: resolvedModule,
    details: resolvedDetails,
    eventDate: logDate,
  });

  return logId;
}

async function recordFromRequest(req, data) {
  return runNonCritical(
    "Failed to record activity log",
    () =>
      recordActivity({
        performedBy: req.user?.id,
        ...data,
        details:
          data.details ||
          data.description ||
          data.note ||
          formatActionLabel(data.action, data.context),
      }),
    logger
  );
}

async function recordSafe(payload) {
  return runNonCritical(
    "Failed to record activity log",
    () =>
      recordActivity({
        ...payload,
        performedBy: payload.performedBy || payload.actorId,
        performerName: payload.performerName || payload.actorName,
        details:
          payload.details ||
          payload.description ||
          payload.note ||
          formatActionLabel(payload.action, payload.context),
      }),
    logger
  );
}

async function queryLogs(query = {}, { timezone } = {}) {
  const timeZone = timezone || config.businessTimezone;
  const filters = {};

  if (query.performedBy) {
    const performedBy = Number(query.performedBy);
    if (Number.isFinite(performedBy) && performedBy > 0) {
      filters.performedBy = performedBy;
    }
  }

  const module = `${query.module || ""}`.trim();
  if (module && module !== "All Modules") {
    assertEnum(module, ALLOWED_LOG_MODULES, "module");
    filters.module = module;
  }

  const fromDate = parseOptionalIsoDate(query.fromDate, "fromDate");
  const toDate = parseOptionalIsoDate(query.toDate, "toDate");
  assertReportDateRange(fromDate, toDate);

  const today = calendarTodayInTimezone(timeZone);
  if (fromDate && fromDate > today) {
    throw new ApiError(400, "From date cannot be in the future");
  }
  if (toDate && toDate > today) {
    throw new ApiError(400, "To date cannot be in the future");
  }

  // Convert viewer calendar days to UTC instant bounds so local display
  // matches the filtered range (avoids UTC date-only mismatch).
  if (fromDate) {
    const fromUtc = startOfCalendarDayUtc(fromDate, timeZone);
    const fromMysql = toMysqlUtcDateTime(fromUtc);
    if (fromMysql) {
      filters.fromLoggedAt = fromMysql;
    } else {
      filters.fromDate = fromDate;
    }
  }

  if (toDate) {
    const toUtc = endOfCalendarDayUtc(toDate, timeZone);
    const toMysql = toMysqlUtcDateTime(toUtc);
    if (toMysql) {
      filters.toLoggedAt = toMysql;
    } else {
      filters.toDate = toDate;
    }
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

  const useKeysetPagination =
    String(query.pagination || "").toLowerCase() === "keyset";
  const pageSizeRaw = Number(query.pageSize || filters.limit || 10);
  const pageSize = Number.isFinite(pageSizeRaw)
    ? Math.min(Math.max(pageSizeRaw, 1), 100)
    : 10;
  const cursorRaw = Number(query.cursor);
  const cursorId = Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : null;

  if (!useKeysetPagination) {
    const logs = await withRepairedSuspendLogDetails(
      await ActivityLog.findAll(filters)
    );
    return logs.map((row) => mapLogRow(row, timeZone));
  }

  const keysetResult = await ActivityLog.findAllKeyset({
    ...filters,
    pageSize,
    cursorId,
  });
  const repairedRows = await withRepairedSuspendLogDetails(keysetResult.rows);

  return {
    logs: repairedRows.map((row) => mapLogRow(row, timeZone)),
    pagination: {
      type: "keyset",
      pageSize: keysetResult.pageSize,
      hasMore: keysetResult.hasMore,
      nextCursor: keysetResult.nextCursor,
    },
  };
}

async function getMyLogs(employeeId, query = {}, options = {}) {
  return queryLogs(
    {
      ...query,
      performedBy: employeeId,
    },
    options
  );
}

async function getEmployeeLogs(employeeId, query = {}, options = {}) {
  const timeZone = options.timezone || config.businessTimezone;
  const employee = await Employee.findByIdPublic(employeeId);

  if (!employee) {
    throw new ApiError(404, "Employee not found");
  }

  const useKeysetPagination =
    String(query.pagination || "").toLowerCase() === "keyset";
  const pageSizeRaw = Number(query.pageSize || query.limit || 10);
  const pageSize = Number.isFinite(pageSizeRaw)
    ? Math.min(Math.max(pageSizeRaw, 1), 100)
    : 10;
  const cursorRaw = Number(query.cursor);
  const cursorId = Number.isFinite(cursorRaw) && cursorRaw > 0 ? cursorRaw : null;
  const search = query.search
    ? sanitizeSearchText(query.search) || null
    : null;

  if (!useKeysetPagination) {
    const logs = await withRepairedSuspendLogDetails(
      await ActivityLog.findByEmployeeId(employeeId, {
        limit: pageSizeRaw > 0 ? Math.min(pageSizeRaw, 500) : 200,
      })
    );
    return logs.map((row) => mapLogRow(row, timeZone));
  }

  const keysetResult = await ActivityLog.findByEmployeeIdKeyset(employeeId, {
    pageSize,
    cursorId,
    search,
  });
  const repairedRows = await withRepairedSuspendLogDetails(keysetResult.rows);

  return {
    logs: repairedRows.map((row) => mapLogRow(row, timeZone)),
    pagination: {
      type: "keyset",
      pageSize: keysetResult.pageSize,
      hasMore: keysetResult.hasMore,
      nextCursor: keysetResult.nextCursor,
    },
  };
}

async function getAllLogs(query = {}, options = {}) {
  return queryLogs(query, options);
}

async function getLogById(id, options = {}) {
  const timeZone = options.timezone || config.businessTimezone;
  const log = await ActivityLog.findById(id);

  if (!log) {
    throw new ApiError(404, "Activity log not found");
  }

  const [repaired] = await withRepairedSuspendLogDetails([log]);
  return mapLogRow(repaired || log, timeZone);
}

module.exports = {
  MODULES,
  recordActivity,
  recordFromRequest,
  recordSafe,
  getMyLogs,
  getEmployeeLogs,
  getAllLogs,
  queryLogs,
  getLogById,
  mapLogRow,
  appendOrderId,
  stripOrderIdTag,
};
