const path = require("path");
const fs = require("fs");
const ApiError = require("../utils/ApiError");
const fileStorage = require("../utils/fileStorage");
const config = require("../config");
const Facility = require("../models/Facility");
const FacilityNote = require("../models/FacilityNote");
const FacilityNoteAttachment = require("../models/FacilityNoteAttachment");
const Employee = require("../models/Employee");
const {
  toMysqlUtcDateTime,
  formatUtcInstantDisplay,
} = require("../utils/timezoneUtils");

const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "text/plain",
]);

const MAX_ATTACHMENT_SIZE_BYTES = 15 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_NOTE = 10;

function formatDisplayDate(value, timeZone = config.businessTimezone) {
  if (!value) return "";
  return formatUtcInstantDisplay(value, timeZone) || "";
}

function mapAttachmentRow(row, facilityId) {
  return {
    id: row.id,
    fileName: row.original_filename || "attachment",
    originalFilename: row.original_filename || "",
    mimeType: row.mime_type || "",
    fileSizeBytes: row.file_size_bytes || 0,
    downloadUrl: `/facilities/${facilityId}/notes/${row.facility_note_id}/attachments/${row.id}/download`,
  };
}

function mapNoteRow(row, attachmentsByNoteId = {}, facilityId, timezone = null) {
  const viewerTz = timezone || config.businessTimezone;
  const attachments = attachmentsByNoteId[row.id] || [];
  const displayDate = formatDisplayDate(row.note_date, viewerTz);

  return {
    id: row.id,
    date: displayDate,
    by: row.author_name || "",
    authorName: row.author_name || "",
    note: row.note || "",
    noteDate: displayDate,
    createdBy: row.created_by,
    createdAt: row.created_at,
    attachments: attachments.map((attachment) =>
      mapAttachmentRow(attachment, facilityId)
    ),
  };
}

async function ensureFacilityExists(facilityId) {
  const facility = await Facility.findById(facilityId);

  if (!facility) {
    throw new ApiError(404, "Facility not found");
  }

  return facility;
}

function validateAttachmentFiles(files = []) {
  if (!files.length) return;

  if (files.length > MAX_ATTACHMENTS_PER_NOTE) {
    throw new ApiError(
      400,
      `You can upload up to ${MAX_ATTACHMENTS_PER_NOTE} files per note`
    );
  }

  files.forEach((file) => {
    if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(file.mimetype)) {
      throw new ApiError(
        400,
        "Only PDF, Word, image, or text files are allowed"
      );
    }

    if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
      throw new ApiError(400, "Each attachment must be 15 MB or less");
    }
  });
}

async function getNotes(facilityId, options = {}) {
  await ensureFacilityExists(facilityId);

  const notes = await FacilityNote.findByFacilityId(facilityId);
  const noteIds = notes.map((note) => note.id);
  const attachments = await FacilityNoteAttachment.findByNoteIds(noteIds);
  const timezone = options.timezone || null;

  const attachmentsByNoteId = attachments.reduce((acc, attachment) => {
    if (!acc[attachment.facility_note_id]) {
      acc[attachment.facility_note_id] = [];
    }
    acc[attachment.facility_note_id].push(attachment);
    return acc;
  }, {});

  return notes.map((note) =>
    mapNoteRow(note, attachmentsByNoteId, facilityId, timezone)
  );
}

async function createNote(facilityId, { note }, actorId, files = [], options = {}) {
  await ensureFacilityExists(facilityId);

  const trimmedNote = String(note || "").trim();

  if (!trimmedNote) {
    throw new ApiError(400, "Validation failed", [
      { field: "note", message: "Note is required" },
    ]);
  }

  if (trimmedNote.length > 500) {
    throw new ApiError(400, "Validation failed", [
      { field: "note", message: "Note must be 500 characters or less" },
    ]);
  }

  validateAttachmentFiles(files);

  const employee = await Employee.findByIdPublic(actorId);

  if (!employee) {
    throw new ApiError(404, "User not found");
  }

  const created = await FacilityNote.create({
    facilityId,
    noteDate: toMysqlUtcDateTime(new Date()),
    createdBy: actorId,
    authorName: employee.name || "Unknown",
    note: trimmedNote,
  });

  if (!created) {
    throw new ApiError(500, "Failed to create note");
  }

  let savedAttachments = [];
  const writtenPaths = [];

  if (files.length) {
    try {
      const attachmentRows = files.map((file) => {
        const storagePath = fileStorage.saveFacilityUploadFromMemory(file, {
          facilityId,
          employeeId: actorId,
          folderName: "note-attachments",
        });
        if (!storagePath) {
          throw new ApiError(400, "A file is required");
        }
        writtenPaths.push(storagePath);
        return {
          facilityNoteId: created.id,
          storagePath,
          originalFilename: file.originalname || "attachment",
          mimeType: file.mimetype || "",
          fileSizeBytes: file.size || 0,
        };
      });

      savedAttachments = await FacilityNoteAttachment.createMany(attachmentRows);
    } catch (error) {
      writtenPaths.forEach((storagePath) => {
        fileStorage.deleteStoredUploadIfExists(storagePath);
      });
      throw error;
    }
  }

  const attachmentsByNoteId = {
    [created.id]: savedAttachments,
  };

  return mapNoteRow(
    created,
    attachmentsByNoteId,
    facilityId,
    options.timezone || null
  );
}

async function getAttachmentFile(facilityId, noteId, attachmentId) {
  await ensureFacilityExists(facilityId);

  const notes = await FacilityNote.findByFacilityId(facilityId);
  const note = notes.find((row) => Number(row.id) === Number(noteId));

  if (!note) {
    throw new ApiError(404, "Note not found");
  }

  const attachment = await FacilityNoteAttachment.findById(attachmentId, noteId);

  if (!attachment) {
    throw new ApiError(404, "Attachment not found");
  }

  const absolutePath = fileStorage.resolveStoredAbsolutePath(attachment.storage_path);
  if (!absolutePath || !fs.existsSync(absolutePath)) {
    throw new ApiError(
      404,
      "This attachment could not be opened. The file may have been moved or deleted."
    );
  }

  return { ...attachment, absolutePath };
}

function resolveMimeType(fileName, mimeType) {
  if (mimeType) return mimeType;

  const extension = path.extname(fileName || "").toLowerCase();

  const map = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".txt": "text/plain",
  };

  return map[extension] || "application/octet-stream";
}

module.exports = {
  getNotes,
  createNote,
  getAttachmentFile,
  resolveMimeType,
};
