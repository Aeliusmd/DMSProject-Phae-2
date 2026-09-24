const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const config = require("../config");
const ApiError = require("./ApiError");
const { ORDER_UPLOAD_DIRS, ORDER_UPLOADS_ROOT } = require("../middleware/uploadMiddleware");
const { facilityUploadsDir } = require("../config/uploads");
const { getFileServerBasePath } = require("../services/appSettingsService");

function getFileServerRoot() {
  const root = getFileServerBasePath() || config.fileServer;
  if (!root) {
    throw new ApiError(503, "File storage is not configured");
  }
  return path.resolve(root);
}

function normalizeToForward(inputPath) {
  return String(inputPath || "").replace(/\\/g, "/").trim();
}

function isWindowsAbsolutePath(inputPath) {
  return /^[a-zA-Z]:[\\/]/.test(String(inputPath || ""));
}

function toFileServerRelative(inputPath) {
  return normalizeToForward(inputPath).replace(/^\/+/, "");
}

function isStoredRelativePath(inputPath) {
  const relative = toFileServerRelative(inputPath);
  return (
    relative.startsWith("uploads/") ||
    relative.startsWith("Order/") ||
    isUploadsRelativePath(relative)
  );
}

function formatStoredFilePath(relativePath) {
  const cleaned = toFileServerRelative(relativePath);
  if (!cleaned) return "";
  return `\\${cleaned.replace(/\//g, "\\")}`;
}

/**
 * Store paths without the file-server base, e.g.
 * \uploads\facilities\109\note-attachments\file.pdf
 */
function toStoredFilePath(inputPath) {
  if (!inputPath) return inputPath;

  const raw = String(inputPath);
  const normalized = normalizeToForward(raw);

  if (!isStoredRelativePath(raw) && (isWindowsAbsolutePath(raw) || path.isAbsolute(raw))) {
    const absolute = path.resolve(raw);
    const base = getFileServerRoot();
    let relative = path.relative(base, absolute).replace(/\\/g, "/");
    if (!relative || relative.startsWith("..")) {
      const uploadsRel = path
        .relative(ORDER_UPLOADS_ROOT, absolute)
        .replace(/\\/g, "/");
      if (uploadsRel && !uploadsRel.startsWith("..")) {
        relative = `uploads/${uploadsRel}`;
      } else {
        return raw;
      }
    }
    return formatStoredFilePath(relative);
  }

  const relative = toFileServerRelative(normalized);
  if (isUploadsRelativePath(relative)) {
    return formatStoredFilePath(`uploads/${relative}`);
  }
  return formatStoredFilePath(relative);
}

/**
 * Merge app_settings base path + stored relative path.
 * Legacy absolute paths and uploads-relative paths stay readable.
 */
function resolveStoredAbsolutePath(storagePath) {
  const raw = String(storagePath || "").trim();
  if (!raw) return null;

  const relative = toFileServerRelative(raw);
  if (!relative) return null;

  // Stored form starts with \uploads\... — Windows treats that as absolute.
  // Merge with the file-server base before any path.isAbsolute check.
  if (relative.startsWith("uploads/") || relative.startsWith("Order/")) {
    return path.join(getFileServerRoot(), ...relative.split("/"));
  }

  if (isUploadsRelativePath(relative)) {
    return path.join(ORDER_UPLOADS_ROOT, ...relative.split("/"));
  }

  if (isWindowsAbsolutePath(raw)) {
    if (fs.existsSync(raw)) return path.resolve(raw);
    try {
      const absolute = path.resolve(raw);
      const base = getFileServerRoot();
      const fromBase = path.relative(base, absolute).replace(/\\/g, "/");
      if (fromBase && !fromBase.startsWith("..")) {
        return path.join(base, ...fromBase.split("/"));
      }
    } catch {
      // Keep the original stored absolute path.
    }
    return raw;
  }

  return path.join(getFileServerRoot(), ...relative.split("/"));
}

function toPublicUploadsUrl(storagePath) {
  if (!storagePath) return "";

  const relative = toFileServerRelative(storagePath);
  if (relative.startsWith("uploads/")) {
    return `/${relative}`;
  }
  if (isUploadsRelativePath(relative)) {
    return `/uploads/${relative}`;
  }

  if (isWindowsAbsolutePath(storagePath) || path.isAbsolute(storagePath)) {
    const abs = resolveStoredAbsolutePath(storagePath);
    if (!abs) return "";
    const uploadsRel = path.relative(ORDER_UPLOADS_ROOT, abs).replace(/\\/g, "/");
    if (uploadsRel && !uploadsRel.startsWith("..")) {
      return `/uploads/${uploadsRel}`;
    }
  }

  return "";
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureFileServerReady() {
  const root = getFileServerRoot();
  ensureDir(root);
  return root;
}

function getBatchScanDir(userId) {
  return path.join("Order", "BatchScan", String(userId)).replace(/\\/g, "/");
}

function sanitizeFileStem(fileName) {
  const stem = path.basename(fileName, path.extname(fileName));
  const safe = stem.replace(/[^\w.\-]+/g, "_").replace(/_+/g, "_");
  return (safe || "upload").slice(0, 80);
}

/**
 * Save a file under Order/BatchScan/{userId}/
 */
function saveBatchScanFile(userId, fileName, buffer) {
  ensureFileServerReady();
  const root = getFileServerRoot();
  const relativeDir = getBatchScanDir(userId);
  const absoluteDir = path.join(root, ...relativeDir.split("/"));
  ensureDir(absoluteDir);

  const safeName = path.basename(fileName).replace(/[^\w.\-]+/g, "_");
  const absolutePath = path.join(absoluteDir, safeName);
  fs.writeFileSync(absolutePath, buffer);

  return {
    absolutePath,
    relativePath: toStoredFilePath(`${relativeDir}/${safeName}`),
    fileName: safeName,
  };
}

function getCompanyPortalOrderDir(companyUserId) {
  return path
    .join("Order", "CompanyPortal", String(companyUserId))
    .replace(/\\/g, "/");
}

/**
 * Save a company-portal subpoena PDF under Order/CompanyPortal/{companyUserId}/
 */
function saveCompanyPortalSubpoena(companyUserId, fileName, buffer) {
  ensureFileServerReady();
  const root = getFileServerRoot();
  const relativeDir = getCompanyPortalOrderDir(companyUserId);
  const absoluteDir = path.join(root, ...relativeDir.split("/"));
  ensureDir(absoluteDir);

  const stamp = Date.now();
  const stem = sanitizeFileStem(fileName);
  const safeName = `${stamp}-${stem}.pdf`;
  const absolutePath = path.join(absoluteDir, safeName);
  fs.writeFileSync(absolutePath, buffer);

  return {
    absolutePath,
    relativePath: toStoredFilePath(`${relativeDir}/${safeName}`),
    fileName: safeName,
    originalName: path.basename(fileName),
  };
}

function resolveAbsolutePath(relativePath) {
  return resolveStoredAbsolutePath(relativePath);
}

function isUploadsRelativePath(relativePath) {
  const normalized = toFileServerRelative(relativePath);
  if (normalized.startsWith("uploads/")) return false;
  return (
    normalized.startsWith("processed-subpoena/") ||
    normalized.startsWith("processed/") ||
    normalized.startsWith("unprocessed-subpoenas/") ||
    normalized.startsWith("additional-documents/") ||
    normalized.startsWith("notes_attachments/") ||
    normalized.startsWith("medical-records/") ||
    normalized.startsWith("facilities/") ||
    normalized.startsWith("personal-portal/")
  );
}

function resolveStaffFolderId(employeeId) {
  const id = Number(employeeId);
  return Number.isFinite(id) && id > 0 ? String(id) : "system";
}

function resolveOrderNumberFolder(orderNumber) {
  const raw = String(orderNumber || "").trim();
  if (!raw) return null;
  const safe = raw
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 80);
  return safe || null;
}

const ORDER_SCOPED_UPLOAD_ROOTS = new Set([
  "processed-subpoena",
  "processed",
  "additional-documents",
  "notes_attachments",
  "medical-records",
]);

function orderUploadTypeKey(typeRoot) {
  const relative = path.relative(ORDER_UPLOADS_ROOT, typeRoot).replace(/\\/g, "/");
  return relative && !relative.startsWith("..") ? relative : path.basename(typeRoot);
}

function buildOrderMemoryFileName(file, orderId, orderNumber) {
  const original = file?.originalname || "file";
  const extension = path.extname(original).toLowerCase();
  const stem = sanitizeFileStem(original);
  const safeOrderId = String(orderId || "order").replace(/[^\w-]/g, "") || "order";
  const safeOrderNumber = resolveOrderNumberFolder(orderNumber) || "order";
  return `${safeOrderId}_${Date.now()}_${Math.round(Math.random() * 1e9)}_${safeOrderNumber}_${stem}${extension}`;
}

/**
 * Write a memory-upload buffer into
 * {type}/{userId}/{orderNumber}/{orderId}_{timestamp}_{random}_{orderNumber}_{name}.
 * Used after the order id is known so create/update/notes do not leave orphans.
 */
function saveOrderUploadFromMemory(
  file,
  { typeRoot, employeeId, orderNumber, orderId }
) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    return null;
  }
  if (!typeRoot) return null;

  const destDir = staffOrderUploadDir(typeRoot, employeeId, orderNumber);
  const fileName = buildOrderMemoryFileName(file, orderId, orderNumber);
  const destAbsolute = path.join(destDir, fileName);
  fs.writeFileSync(destAbsolute, file.buffer);

  const folderId = resolveStaffFolderId(employeeId);
  const orderFolder = resolveOrderNumberFolder(orderNumber);
  const typeKey = orderUploadTypeKey(typeRoot);
  const relative = orderFolder
    ? `${typeKey}/${folderId}/${orderFolder}/${fileName}`
    : `${typeKey}/${folderId}/${fileName}`;
  return toStoredFilePath(relative);
}

function resolveFacilityFolderId(facilityId) {
  const safe = String(facilityId || "unknown").replace(/[^\w-]/g, "");
  return safe || "unknown";
}

function buildFacilityUploadFileName(file, facilityId) {
  const extension = path.extname(file?.originalname || "").toLowerCase();
  return `${randomUUID()}_${Date.now()}_${resolveFacilityFolderId(facilityId)}${extension}`;
}

/**
 * Write a facility memory-upload into
 * facilities/{facilityId}/{uploads|note-attachments}/{userId}/{uuid}_{timestamp}_{facilityId}.ext
 * after the facility (and note, when attaching) already exists.
 */
function saveFacilityUploadFromMemory(file, { facilityId, employeeId, folderName }) {
  if (!file || !Buffer.isBuffer(file.buffer) || file.buffer.length === 0) {
    return null;
  }
  if (folderName !== "uploads" && folderName !== "note-attachments") {
    return null;
  }

  const facilityFolder = resolveFacilityFolderId(facilityId);
  const folderId = resolveStaffFolderId(employeeId);
  const destDir = path.join(facilityUploadsDir, facilityFolder, folderName, folderId);
  ensureDir(destDir);

  const fileName = buildFacilityUploadFileName(file, facilityId);
  const destAbsolute = path.join(destDir, fileName);
  fs.writeFileSync(destAbsolute, file.buffer);

  return toStoredFilePath(
    `facilities/${facilityFolder}/${folderName}/${folderId}/${fileName}`
  );
}

/**
 * Move a disk Multer file into the same order-scoped folder/name as
 * saveOrderUploadFromMemory. Existing stored paths are not rewritten.
 */
function relocateDiskUploadToOrderFolder(
  file,
  { typeRoot, employeeId, orderNumber, orderId }
) {
  const sourceAbsolute = file?.path ? path.resolve(file.path) : "";
  if (!sourceAbsolute || !fs.existsSync(sourceAbsolute) || !typeRoot) {
    return null;
  }

  const destDir = staffOrderUploadDir(typeRoot, employeeId, orderNumber);
  const fileName = buildOrderMemoryFileName(file, orderId, orderNumber);
  const destAbsolute = path.resolve(path.join(destDir, fileName));

  if (sourceAbsolute !== destAbsolute) {
    fs.renameSync(sourceAbsolute, destAbsolute);
  }

  const folderId = resolveStaffFolderId(employeeId);
  const orderFolder = resolveOrderNumberFolder(orderNumber);
  const typeKey = orderUploadTypeKey(typeRoot);
  const relative = orderFolder
    ? `${typeKey}/${folderId}/${orderFolder}/${fileName}`
    : `${typeKey}/${folderId}/${fileName}`;
  return toStoredFilePath(relative);
}

function deleteStoredUploadIfExists(storagePath) {
  if (!storagePath) return;
  try {
    const absolutePath = resolveStoredAbsolutePath(storagePath);
    if (absolutePath && fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath);
    }
  } catch {
    // Non-fatal cleanup after a rolled-back request.
  }
}

function staffOrderUploadDir(typeRoot, employeeId, orderNumber) {
  const folderId = resolveStaffFolderId(employeeId);
  const orderFolder = resolveOrderNumberFolder(orderNumber);
  const dir = orderFolder
    ? path.join(typeRoot, folderId, orderFolder)
    : path.join(typeRoot, folderId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Move a staff upload from {type}/{employeeId}/file into
 * {type}/{employeeId}/{orderNumber}/file after the order number is known.
 * Already-nested paths and unknown/legacy locations are left unchanged.
 */
function moveUploadToOrderFolder(relativePath, employeeId, orderNumber) {
  if (!relativePath) return relativePath;

  const orderFolder = resolveOrderNumberFolder(orderNumber);
  if (!orderFolder) return toStoredFilePath(relativePath) || relativePath;

  const relative = toFileServerRelative(relativePath);
  const scoped = relative.startsWith("uploads/")
    ? relative.slice("uploads/".length)
    : relative;
  const parts = scoped.split("/").filter(Boolean);
  if (parts.length < 2 || !ORDER_SCOPED_UPLOAD_ROOTS.has(parts[0])) {
    return toStoredFilePath(relativePath) || relativePath;
  }

  // type/userId/orderNumber/file — already nested (including shared split-order files)
  if (parts.length >= 4) {
    return toStoredFilePath(relativePath) || relativePath;
  }

  const fileName = parts[parts.length - 1];
  if (!fileName) return toStoredFilePath(relativePath) || relativePath;

  const folderId = resolveStaffFolderId(employeeId);
  const destRelative = `${parts[0]}/${folderId}/${orderFolder}/${fileName}`;
  const srcAbs = resolveStoredAbsolutePath(relativePath);
  if (!srcAbs || !fs.existsSync(srcAbs)) {
    return toStoredFilePath(relativePath) || relativePath;
  }

  const destAbs = path.join(ORDER_UPLOADS_ROOT, ...destRelative.split("/"));
  if (path.resolve(srcAbs) === path.resolve(destAbs)) {
    return toStoredFilePath(destRelative);
  }

  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.renameSync(srcAbs, destAbs);
  return toStoredFilePath(destRelative);
}

/**
 * Copy a batch-scan subpoena PDF from FILE_SERVER/Order/BatchScan/
 * into FILE_SERVER/uploads/processed-subpoena/{employeeId}/{orderNumber}/.
 * The source remains available if the surrounding database transaction fails
 * and the extract needs to be retried.
 * Returns the relative path stored on orders.subpoena_storage_path.
 */
function archiveBatchScanSubpoenaToProcessed(
  batchScanRelativePath,
  orderNumber,
  employeeId
) {
  const sourceAbsolute = resolveAbsolutePath(batchScanRelativePath);
  if (!fs.existsSync(sourceAbsolute)) {
    throw new ApiError(404, `Subpoena file not found: ${batchScanRelativePath}`);
  }

  const folderId = resolveStaffFolderId(employeeId);
  const destDir = staffOrderUploadDir(
    ORDER_UPLOAD_DIRS.processedSubpoena,
    employeeId,
    orderNumber
  );

  const stem = path.basename(batchScanRelativePath, path.extname(batchScanRelativePath));
  const safeStem = stem.replace(/[^\w.\-]+/g, "_").slice(0, 80) || "subpoena";
  const safeOrder = resolveOrderNumberFolder(orderNumber) || "order";
  const fileName = `${safeOrder}_${Date.now()}_${safeStem}.pdf`;
  const destAbsolute = path.join(destDir, fileName);

  fs.copyFileSync(sourceAbsolute, destAbsolute);

  const orderFolder = resolveOrderNumberFolder(orderNumber);
  const relative = orderFolder
    ? `processed-subpoena/${folderId}/${orderFolder}/${fileName}`
    : `processed-subpoena/${folderId}/${fileName}`;
  return toStoredFilePath(relative);
}

function resolveOrderStorageAbsolutePath(storagePath) {
  return resolveStoredAbsolutePath(storagePath);
}

/**
 * Remove a multer-written processed subpoena that the order did not keep.
 * Only deletes files under processed-subpoena/ or legacy processed/.
 */
function deleteUnusedProcessedSubpoenaUpload(relativePath, keptRelativePath) {
  const unused = toFileServerRelative(relativePath);
  const kept = toFileServerRelative(keptRelativePath);
  if (!unused || unused === kept) return;

  const unusedScoped = unused.startsWith("uploads/")
    ? unused.slice("uploads/".length)
    : unused;
  const isProcessedUpload =
    unusedScoped.startsWith("processed-subpoena/") ||
    unusedScoped.startsWith("processed/");
  if (!isProcessedUpload) return;

  const absolutePath = resolveOrderStorageAbsolutePath(unused);
  if (!absolutePath || !fs.existsSync(absolutePath)) return;

  try {
    fs.unlinkSync(absolutePath);
  } catch {
    // Non-fatal: order already points at the kept file.
  }
}

module.exports = {
  getFileServerRoot,
  ensureFileServerReady,
  getBatchScanDir,
  sanitizeFileStem,
  saveBatchScanFile,
  getCompanyPortalOrderDir,
  saveCompanyPortalSubpoena,
  resolveAbsolutePath,
  resolveStoredAbsolutePath,
  toStoredFilePath,
  toPublicUploadsUrl,
  isUploadsRelativePath,
  resolveOrderStorageAbsolutePath,
  resolveOrderNumberFolder,
  moveUploadToOrderFolder,
  saveOrderUploadFromMemory,
  saveFacilityUploadFromMemory,
  relocateDiskUploadToOrderFolder,
  deleteStoredUploadIfExists,
  archiveBatchScanSubpoenaToProcessed,
  deleteUnusedProcessedSubpoenaUpload,
};
