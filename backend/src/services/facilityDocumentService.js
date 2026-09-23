const path = require("path");
const fs = require("fs");
const ApiError = require("../utils/ApiError");
const fileStorage = require("../utils/fileStorage");
const config = require("../config");
const Facility = require("../models/Facility");
const FacilityDocument = require("../models/FacilityDocument");
const { formatUtcInstantDisplay } = require("../utils/timezoneUtils");

const DOCUMENT_TYPES = ["Standard", "Legal", "Medical", "Financial", "Other"];

function resolveViewerTimezone(timezone) {
  return timezone || config.businessTimezone || "UTC";
}

function formatDocumentRow(row) {
  return {
    id: row.id,
    name: row.document_name,
    documentName: row.document_name,
    documentType: row.upload_type,
    fileType: row.file_type,
    uploadedAt: row.uploaded_at,
    fileSizeBytes: row.file_size_bytes,
  };
}

/** Viewer-local date+time for upload instant (avoids UTC toISOString off-by-one). */
function formatDisplayDate(value, timezone = null) {
  if (!value) return "";
  return formatUtcInstantDisplay(value, resolveViewerTimezone(timezone)) || "";
}

async function ensureFacilityExists(facilityId) {
  const facility = await Facility.findById(facilityId);

  if (!facility) {
    throw new ApiError(404, "Facility not found");
  }

  return facility;
}

async function getDocuments(facilityId, options = {}) {
  await ensureFacilityExists(facilityId);

  const documents = await FacilityDocument.findByFacilityId(facilityId);
  const timezone = options.timezone || null;

  return documents.map((row) => ({
    ...formatDocumentRow(row),
    date: formatDisplayDate(row.uploaded_at, timezone),
  }));
}

async function createDocument(
  facilityId,
  file,
  documentType,
  uploadedBy,
  options = {}
) {
  await ensureFacilityExists(facilityId);

  if (!file) {
    throw new ApiError(400, "A file is required");
  }

  const normalizedType = String(documentType || "").trim();

  if (!DOCUMENT_TYPES.includes(normalizedType)) {
    throw new ApiError(400, "Invalid document type");
  }

  const documentId = await FacilityDocument.create({
    facilityId,
    documentName: file.originalname,
    uploadType: normalizedType,
    fileType: FacilityDocument.getFileTypeFromName(file.originalname),
    storagePath: fileStorage.toStoredFilePath(file.path),
    fileSizeBytes: file.size,
    uploadedBy,
  });

  const document = await FacilityDocument.findById(documentId, facilityId);

  return {
    ...formatDocumentRow(document),
    date: formatDisplayDate(document.uploaded_at, options.timezone || null),
  };
}

async function getDocumentFile(facilityId, documentId) {
  const document = await FacilityDocument.findById(documentId, facilityId);

  if (!document) {
    throw new ApiError(404, "Document not found");
  }

  const absolutePath = fileStorage.resolveStoredAbsolutePath(document.storage_path);
  if (!absolutePath || !fs.existsSync(absolutePath)) {
    throw new ApiError(
      404,
      "This document could not be opened. The file may have been moved or deleted."
    );
  }

  return { ...document, absolutePath };
}

async function deleteDocument(facilityId, documentId, deletedBy) {
  const document = await FacilityDocument.findById(documentId, facilityId);

  if (!document) {
    throw new ApiError(404, "Document not found");
  }

  await FacilityDocument.softDelete(documentId, facilityId, deletedBy);

  return { message: "Document deleted successfully" };
}

function resolveMimeType(fileType) {
  const normalized = String(fileType || "").toLowerCase();

  const mimeMap = {
    pdf: "application/pdf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    txt: "text/plain",
  };

  return mimeMap[normalized] || "application/octet-stream";
}

module.exports = {
  DOCUMENT_TYPES,
  getDocuments,
  createDocument,
  getDocumentFile,
  deleteDocument,
  resolveMimeType,
};
