import { API_BASE_URL } from "@/config/api";
import { validateNoHtmlMarkup } from "@/lib/validations/nameValidation";
import { isFutureDateTimeLocal } from "@/lib/utils/dateUtils";
import { formatDateTimeValue, formatUtcInstant } from "@/lib/utils/timezoneUtils";

export const MAX_NOTE_LENGTH = 1000;
export const MAX_FILE_SIZE_MB = 10;
export const ALLOWED_FILE_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];

export function toFileUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  const origin = API_BASE_URL.replace(/\/api\/?$/, "");
  return `${origin}${path.startsWith("/") ? "" : "/"}${path}`;
}

export function formatNoteDate(value) {
  if (!value) return "";
  return formatDateTimeValue(value, { fallback: String(value) });
}

export function expandNoteUtcTokens(text) {
  return String(text || "").replace(/\[\[utc:([^\]]+)\]\]/gi, (_match, raw) => {
    return formatUtcInstant(raw) || String(raw || "").trim();
  });
}

export function formatNotePreview(text, maxLength = 90) {
  const normalized = expandNoteUtcTokens(`${text || ""}`)
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "—";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}…`;
}

export function toHistoryItem(note) {
  return {
    id: note.id,
    date: formatNoteDate(note.noteDateAt || note.noteDate),
    noteDate: note.noteDateAt || note.noteDate || null,
    by: note.authorName || "—",
    note: expandNoteUtcTokens(note.note || ""),
    callbackDate: note.callbackAt || note.callbackDate || "",
    callbackAt: note.callbackAt || null,
    callbackDateDisplay:
      note.callbackDate ||
      (note.callbackAt ? formatUtcInstant(note.callbackAt) : ""),
    isCalled: Boolean(note.isCalled),
    isReminder: Boolean(note.callbackAt || note.callbackDate),
    attachmentUrl: toFileUrl(note.attachmentUrl),
  };
}

export function filterNotesByDate(notes, { from = "", to = "" } = {}) {
  if (!from && !to) return notes;

  return notes.filter((note) => {
    const raw = note.noteDate;
    if (!raw) return false;

    const noteDay = new Date(raw);
    if (Number.isNaN(noteDay.getTime())) return false;
    noteDay.setHours(0, 0, 0, 0);

    if (from) {
      const fromDay = new Date(from);
      if (Number.isNaN(fromDay.getTime())) return true;
      fromDay.setHours(0, 0, 0, 0);
      if (noteDay < fromDay) return false;
    }

    if (to) {
      const toDay = new Date(to);
      if (Number.isNaN(toDay.getTime())) return true;
      toDay.setHours(0, 0, 0, 0);
      if (noteDay > toDay) return false;
    }

    return true;
  });
}

export function buildCallbackLine(date = new Date()) {
  const instant = date instanceof Date ? date : new Date(date);
  const iso = Number.isNaN(instant.getTime())
    ? new Date().toISOString()
    : instant.toISOString();
  return `Calledback - [[utc:${iso}]]`;
}

export function hasCalledbackLine(text) {
  return /\bCalledback\b/i.test(text) || /\bCallback\s*-/i.test(text);
}

export function validateNoteForm({
  noteText,
  callbackDate,
  attachment,
  existingAttachmentUrl,
  requireCallbackDate = false,
}) {
  const errors = {};
  const trimmedNote = `${noteText || ""}`.trim();
  const trimmedCallbackDate = `${callbackDate || ""}`.trim();

  if (!trimmedNote) {
    errors.noteText = "Note text is required.";
  } else if (trimmedNote.length > MAX_NOTE_LENGTH) {
    errors.noteText = `Note cannot be more than ${MAX_NOTE_LENGTH} characters.`;
  } else {
    const markupError = validateNoHtmlMarkup(trimmedNote, {
      fieldLabel: "Note text",
    });
    if (markupError) errors.noteText = markupError;
  }

  if (requireCallbackDate && !trimmedCallbackDate) {
    errors.callbackDate = "Callback Date & Time is required.";
  } else if (trimmedCallbackDate && !isFutureDateTimeLocal(trimmedCallbackDate)) {
    errors.callbackDate = "Callback date and time must be in the future.";
  }

  if (attachment) {
    const attachmentError = getNoteAttachmentError(attachment);
    if (attachmentError) errors.attachment = attachmentError;
  }

  return errors;
}

export function getNoteAttachmentError(file) {
  if (!file) return "";

  if (!ALLOWED_FILE_TYPES.includes(file.type)) {
    return "Only PDF, Word, JPG, and PNG files are allowed.";
  }

  const fileSizeMb = file.size / (1024 * 1024);
  if (fileSizeMb > MAX_FILE_SIZE_MB) {
    return `File size must be less than ${MAX_FILE_SIZE_MB} MB.`;
  }

  return "";
}
