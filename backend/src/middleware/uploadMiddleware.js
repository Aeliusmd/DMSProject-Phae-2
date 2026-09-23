const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { randomUUID } = require("crypto");
const ApiError = require("../utils/ApiError");
const {
  uploadsRoot,
  facilityUploadsDir,
  ensureUploadDirs,
} = require("../config/uploads");

/**
 * Facility document uploads:
 * Stored inside facility-specific folder:
 * {FILE_SERVER}/uploads/facilities/<facilityId>/
 */

/**
 * Order document uploads (under FILE_SERVER/uploads):
 * processed-subpoena/{employeeId}/{orderNumber}/
 * additional-documents/{employeeId}/{orderNumber}/
 * notes_attachments/{employeeId}/{orderNumber}/
 * medical-records/{employeeId}/{orderNumber}/
 * personal-portal/licenses/
 *
 * Employee folders are created on first file write, not at user creation.
 * Order-number folders are created when the order number is known.
 * Multer writes under {employeeId}/ first; the file is then moved into {orderNumber}/.
 */

const ORDER_UPLOADS_ROOT = uploadsRoot;

const ORDER_UPLOAD_DIRS = {
  processedSubpoena: path.join(ORDER_UPLOADS_ROOT, "processed-subpoena"),
  additionalDocuments: path.join(ORDER_UPLOADS_ROOT, "additional-documents"),
  orderNotes: path.join(ORDER_UPLOADS_ROOT, "notes_attachments"),
  medicalRecords: path.join(ORDER_UPLOADS_ROOT, "medical-records"),
  personalPortalLicenses: path.join(ORDER_UPLOADS_ROOT, "personal-portal", "licenses"),
};

const FIELD_DESTINATIONS = {
  subpoenaFile: ORDER_UPLOAD_DIRS.processedSubpoena,
  additionalDocumentFile: ORDER_UPLOAD_DIRS.additionalDocuments,
  attachment: ORDER_UPLOAD_DIRS.orderNotes,
};

function resolveUploaderFolderId(req) {
  const id = Number(req?.user?.id);
  return Number.isFinite(id) && id > 0 ? String(id) : "system";
}

function staffUploadDir(typeRoot, req) {
  const dir = path.join(typeRoot, resolveUploaderFolderId(req));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureOrderUploadDirs() {
  fs.mkdirSync(ORDER_UPLOADS_ROOT, { recursive: true });
  fs.mkdirSync(ORDER_UPLOAD_DIRS.personalPortalLicenses, { recursive: true });
}

ensureUploadDirs();
ensureOrderUploadDirs();

const FACILITY_ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
]);

const ORDER_ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
]);

function sanitizeFileName(originalName) {
  const ext = path.extname(originalName || "");
  const base = path
    .basename(originalName || "file", ext)
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60)
    .replace(/^-|-$/g, "");

  return `${base || "file"}${ext.toLowerCase()}`;
}

/**
 * Facility upload storage
 */
const facilityStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const facilityDir = path.join(
      facilityUploadsDir,
      String(req.params.id || "unknown")
    );

    fs.mkdirSync(facilityDir, { recursive: true });
    cb(null, facilityDir);
  },

  filename: (_req, file, cb) => {
    const extension = path.extname(file.originalname || "").toLowerCase();
    cb(null, `${randomUUID()}${extension}`);
  },
});

function facilityFileFilter(_req, file, cb) {
  if (FACILITY_ALLOWED_MIME_TYPES.has(file.mimetype)) {
    cb(null, true);
    return;
  }

  cb(new ApiError(400, "Unsupported file type"));
}

const facilityDocumentUpload = multer({
  storage: facilityStorage,
  fileFilter: facilityFileFilter,
  limits: {
    fileSize: 15 * 1024 * 1024,
  },
});

const facilityNoteAttachmentStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const facilityDir = path.join(
      facilityUploadsDir,
      String(req.params.id || "unknown"),
      "note-attachments"
    );

    fs.mkdirSync(facilityDir, { recursive: true });
    cb(null, facilityDir);
  },

  filename: (_req, file, cb) => {
    const extension = path.extname(file.originalname || "").toLowerCase();
    cb(null, `${randomUUID()}${extension}`);
  },
});

const facilityNoteAttachmentUpload = multer({
  storage: facilityNoteAttachmentStorage,
  fileFilter: facilityFileFilter,
  limits: {
    fileSize: 15 * 1024 * 1024,
    files: 10,
  },
});

/**
 * Order / subpoena / note attachment storage
 */
const orderStorage = multer.diskStorage({
  destination(req, file, cb) {
    const typeRoot =
      FIELD_DESTINATIONS[file.fieldname] || ORDER_UPLOAD_DIRS.processedSubpoena;
    cb(null, staffUploadDir(typeRoot, req));
  },

  filename(_req, file, cb) {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}-${sanitizeFileName(file.originalname)}`);
  },
});

function orderFileFilter(_req, file, cb) {
  if (file.fieldname === "subpoenaFile") {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
      return;
    }
    cb(new ApiError(400, "Only PDF files are allowed for subpoena"));
    return;
  }

  if (ORDER_ALLOWED_MIME_TYPES.has(file.mimetype)) {
    cb(null, true);
    return;
  }

  cb(new ApiError(400, "Only PDF, Word, JPG, or PNG files are allowed"));
}

const orderUpload = multer({
  storage: orderStorage,
  fileFilter: orderFileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

const uploadOrderFiles = orderUpload.fields([
  { name: "subpoenaFile", maxCount: 1 },
  { name: "additionalDocumentFile", maxCount: 1 },
]);

const uploadNoteAttachment = orderUpload.single("attachment");

const medicalRecordsStorage = multer.diskStorage({
  destination(req, _file, cb) {
    cb(null, staffUploadDir(ORDER_UPLOAD_DIRS.medicalRecords, req));
  },
  filename(req, file, cb) {
    const orderId = req.params.id || "order";
    const unique = `${orderId}-${Date.now()}`;
    cb(null, `${unique}-${sanitizeFileName(file.originalname)}`);
  },
});

const uploadMedicalRecordsScan = multer({
  storage: medicalRecordsStorage,
  fileFilter(_req, file, cb) {
    if (file.mimetype === PDF_MIME || (file.originalname || "").toLowerCase().endsWith(".pdf")) {
      cb(null, true);
      return;
    }
    cb(new ApiError(400, "Only PDF files are allowed"));
  },
  limits: {
    fileSize: Number(process.env.UPLOAD_MAX_FILE_SIZE_MB || 50) * 1024 * 1024,
  },
}).array("file", 20);

function toRelativeStoragePath(file) {
  if (!file) return null;
  return path.relative(ORDER_UPLOADS_ROOT, file.path).split(path.sep).join("/");
}

const PDF_MIME = "application/pdf";

const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.UPLOAD_MAX_FILE_SIZE_MB || 50) * 1024 * 1024,
  },
  fileFilter(_req, file, cb) {
    const isPdf =
      file.mimetype === PDF_MIME ||
      (file.originalname || "").toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      return cb(new ApiError(400, "Only PDF files are allowed"));
    }
    cb(null, true);
  },
});

function uploadSinglePdf(fieldName = "file") {
  return memoryUpload.single(fieldName);
}

const DRIVER_LICENSE_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
]);

const personalPortalLicenseStorage = multer.diskStorage({
  destination(_req, _file, cb) {
    fs.mkdirSync(ORDER_UPLOAD_DIRS.personalPortalLicenses, { recursive: true });
    cb(null, ORDER_UPLOAD_DIRS.personalPortalLicenses);
  },
  filename(_req, file, cb) {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}-${sanitizeFileName(file.originalname)}`);
  },
});

const uploadPersonalPortalLicense = multer({
  storage: personalPortalLicenseStorage,
  fileFilter(_req, file, cb) {
    if (DRIVER_LICENSE_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(
      new ApiError(400, "Driver's license must be a PDF, JPG, or PNG image")
    );
  },
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
}).single("driverLicenseFile");

module.exports = {
  facilityDocumentUpload,
  facilityNoteAttachmentUpload,

  ORDER_UPLOADS_ROOT,
  ORDER_UPLOAD_DIRS,
  resolveUploaderFolderId,
  orderUpload,
  uploadOrderFiles,
  uploadNoteAttachment,
  toRelativeStoragePath,
  uploadSinglePdf,
  uploadMedicalRecordsScan,
  uploadPersonalPortalLicense,
};
