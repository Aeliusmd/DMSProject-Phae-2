const OrderNoteTag = require("../models/OrderNoteTag");
const Employee = require("../models/Employee");
const ApiError = require("../utils/ApiError");
const config = require("../config");
const {
  formatUtcInstantDisplay,
  toUtcIso,
} = require("../utils/timezoneUtils");

function buildApplicantName(row) {
  return [row.applicant_first_name, row.applicant_middle_name, row.applicant_last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function mapTaggedInboxItem(row, timeZone = config.businessTimezone) {
  const taggedAtIso = toUtcIso(row.tagged_at || row.note_date);
  const noteDateIso = toUtcIso(row.note_date);

  return {
    tagId: row.tag_id,
    noteId: row.note_id,
    orderId: row.order_id,
    orderNumber: row.order_number || "",
    caseNumber: row.case_number || "",
    applicant: buildApplicantName(row) || "—",
    note: row.note || "",
    authorName: row.author_name || "",
    taggedByName: row.tagged_by_name || row.author_name || "—",
    taggedBy: row.tagged_by || null,
    isRead: Boolean(Number(row.is_read)),
    taggedAt: taggedAtIso,
    taggedAtDisplay: taggedAtIso
      ? formatUtcInstantDisplay(taggedAtIso, timeZone)
      : "",
    noteDate: noteDateIso,
    noteDateDisplay: noteDateIso
      ? formatUtcInstantDisplay(noteDateIso, timeZone)
      : "",
    attachmentUrl: row.attachment_path ? `/uploads/${row.attachment_path}` : "",
  };
}

function parseTaggedEmployeeIds(data = {}) {
  const raw = data.taggedEmployeeIds ?? data["taggedEmployeeIds[]"];
  if (raw == null || raw === "") return [];

  let values = [];
  if (Array.isArray(raw)) {
    values = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      values = Array.isArray(parsed) ? parsed : [parsed];
    } catch (_error) {
      values = trimmed.split(",");
    }
  } else if (typeof raw === "number") {
    values = [raw];
  }

  const unique = new Set();
  for (const value of values) {
    const id = Number(value);
    if (Number.isFinite(id) && id > 0) {
      unique.add(id);
    }
  }
  return [...unique];
}

async function resolveValidTagTargets(employeeIds = []) {
  if (!employeeIds.length) return [];

  const validIds = [];
  for (const employeeId of employeeIds) {
    const employee = await Employee.findById(employeeId);
    if (!employee) continue;
    if (Number(employee.is_terminated)) continue;
    if (Number(employee.is_suspended)) continue;
    validIds.push(Number(employee.id));
  }
  return validIds;
}

async function attachTagsToNote({
  noteId,
  taggedEmployeeIds,
  taggedBy,
  actorRole,
}) {
  const role = String(actorRole || "").trim().toLowerCase();
  if (role !== "admin") {
    return [];
  }

  const ids = await resolveValidTagTargets(taggedEmployeeIds);
  if (!ids.length) return [];

  await OrderNoteTag.createMany(
    ids.map((taggedEmployeeId) => ({
      noteId,
      taggedEmployeeId,
      taggedBy: taggedBy || null,
    }))
  );

  return OrderNoteTag.findByNoteId(noteId);
}

async function getTaggableStaff({ search = "" } = {}) {
  const employees = await Employee.findAll({
    search: search || undefined,
    limit: 300,
  });

  return employees
    .filter(
      (row) =>
        !Number(row.is_terminated) &&
        !Number(row.is_suspended) &&
        ["employee", "manager"].includes(
          String(row.role || "").trim().toLowerCase()
        )
    )
    .map((row) => ({
      id: row.id,
      name: row.name || "",
      role: row.role || "",
      email: row.email || "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function getTaggedNotesInbox(employeeId, options = {}) {
  if (!employeeId) {
    throw new ApiError(401, "Unauthorized");
  }

  const timeZone = options.timezone || config.businessTimezone;
  const rows = await OrderNoteTag.findInboxForEmployee(employeeId, {
    limit: options.limit,
    offset: options.offset,
  });
  const unreadCount = await OrderNoteTag.countUnreadForEmployee(employeeId);

  return {
    notes: rows.map((row) => mapTaggedInboxItem(row, timeZone)),
    unreadCount,
  };
}

async function getTaggedNotesUnreadCount(employeeId) {
  if (!employeeId) {
    throw new ApiError(401, "Unauthorized");
  }
  return {
    unreadCount: await OrderNoteTag.countUnreadForEmployee(employeeId),
  };
}

async function markTaggedNoteAsRead(tagId, employeeId) {
  if (!employeeId) {
    throw new ApiError(401, "Unauthorized");
  }

  const id = Number(tagId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new ApiError(400, "Invalid tag id");
  }

  await OrderNoteTag.markAsRead(id, employeeId);
  return getTaggedNotesUnreadCount(employeeId);
}

async function markAllTaggedNotesAsRead(employeeId) {
  if (!employeeId) {
    throw new ApiError(401, "Unauthorized");
  }

  await OrderNoteTag.markAllAsRead(employeeId);
  return getTaggedNotesUnreadCount(employeeId);
}

module.exports = {
  parseTaggedEmployeeIds,
  attachTagsToNote,
  getTaggableStaff,
  getTaggedNotesInbox,
  getTaggedNotesUnreadCount,
  markTaggedNoteAsRead,
  markAllTaggedNotesAsRead,
};
