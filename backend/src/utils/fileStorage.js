const fs = require("fs");
const path = require("path");
const config = require("../config");
const ApiError = require("./ApiError");
const { ORDER_UPLOAD_DIRS, ORDER_UPLOADS_ROOT } = require("../middleware/uploadMiddleware");

function getFileServerRoot() {
  const root = config.fileServer;
  if (!root) {
    throw new ApiError(503, "File storage is not configured");
  }
  return path.resolve(root);
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
    relativePath: `${relativeDir}/${safeName}`.replace(/\\/g, "/"),
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
    relativePath: `${relativeDir}/${safeName}`.replace(/\\/g, "/"),
    fileName: safeName,
    originalName: path.basename(fileName),
  };
}

function resolveAbsolutePath(relativePath) {
  return path.join(getFileServerRoot(), ...relativePath.split("/"));
}

function isUploadsRelativePath(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/");
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

  const normalized = String(relativePath).replace(/\\/g, "/");
  const orderFolder = resolveOrderNumberFolder(orderNumber);
  if (!normalized || !orderFolder) return normalized;

  const parts = normalized.split("/").filter(Boolean);
  if (parts.length < 2 || !ORDER_SCOPED_UPLOAD_ROOTS.has(parts[0])) {
    return normalized;
  }

  // type/userId/orderNumber/file — already nested (including shared split-order files)
  if (parts.length >= 4) {
    return normalized;
  }

  const fileName = parts[parts.length - 1];
  if (!fileName) return normalized;

  const folderId = resolveStaffFolderId(employeeId);
  const destRelative = `${parts[0]}/${folderId}/${orderFolder}/${fileName}`;
  const srcAbs = resolveOrderStorageAbsolutePath(normalized);
  if (!srcAbs || !fs.existsSync(srcAbs)) {
    return normalized;
  }

  const destAbs = path.join(ORDER_UPLOADS_ROOT, ...destRelative.split("/"));
  if (path.resolve(srcAbs) === path.resolve(destAbs)) {
    return destRelative;
  }

  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  fs.renameSync(srcAbs, destAbs);
  return destRelative;
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
  return relative.replace(/\\/g, "/");
}

function resolveOrderStorageAbsolutePath(storagePath) {
  const normalized = String(storagePath || "").replace(/\\/g, "/");
  if (!normalized) return null;

  if (isUploadsRelativePath(normalized)) {
    return path.join(ORDER_UPLOADS_ROOT, normalized);
  }

  return resolveAbsolutePath(normalized);
}

/**
 * Remove a multer-written processed subpoena that the order did not keep.
 * Only deletes files under processed-subpoena/ or legacy processed/.
 */
function deleteUnusedProcessedSubpoenaUpload(relativePath, keptRelativePath) {
  const unused = String(relativePath || "").replace(/\\/g, "/");
  const kept = String(keptRelativePath || "").replace(/\\/g, "/");
  if (!unused || unused === kept) return;

  const isProcessedUpload =
    unused.startsWith("processed-subpoena/") || unused.startsWith("processed/");
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
  isUploadsRelativePath,
  resolveOrderStorageAbsolutePath,
  resolveOrderNumberFolder,
  moveUploadToOrderFolder,
  archiveBatchScanSubpoenaToProcessed,
  deleteUnusedProcessedSubpoenaUpload,
};
