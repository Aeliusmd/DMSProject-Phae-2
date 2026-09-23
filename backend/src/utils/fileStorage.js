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

/**
 * Copy a batch-scan subpoena PDF from FILE_SERVER/Order/BatchScan/
 * into FILE_SERVER/uploads/processed-subpoena/{employeeId}/.
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
  const destDir = path.join(ORDER_UPLOAD_DIRS.processedSubpoena, folderId);
  fs.mkdirSync(destDir, { recursive: true });

  const stem = path.basename(batchScanRelativePath, path.extname(batchScanRelativePath));
  const safeStem = stem.replace(/[^\w.\-]+/g, "_").slice(0, 80) || "subpoena";
  const safeOrder = String(orderNumber || "order").replace(/[^\w.\-]+/g, "_");
  const fileName = `${safeOrder}_${Date.now()}_${safeStem}.pdf`;
  const destAbsolute = path.join(destDir, fileName);

  fs.copyFileSync(sourceAbsolute, destAbsolute);

  return `processed-subpoena/${folderId}/${fileName}`.replace(/\\/g, "/");
}

function resolveOrderStorageAbsolutePath(storagePath) {
  const normalized = String(storagePath || "").replace(/\\/g, "/");
  if (!normalized) return null;

  if (isUploadsRelativePath(normalized)) {
    return path.join(ORDER_UPLOADS_ROOT, normalized);
  }

  return resolveAbsolutePath(normalized);
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
  archiveBatchScanSubpoenaToProcessed,
};
