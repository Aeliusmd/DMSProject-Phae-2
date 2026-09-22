const path = require("path");
const fs = require("fs");
const config = require("./index");

/**
 * All HTTP-served / multer upload files live under FILE_SERVER/uploads.
 * Falls back to backend/uploads only when FILE_SERVER is unset (local dev).
 *
 * Layout:
 *   {FILE_SERVER}/uploads/facilities/
 *   {FILE_SERVER}/uploads/processed/
 *   {FILE_SERVER}/uploads/unprocessed-subpoenas/
 *   {FILE_SERVER}/uploads/additional-documents/
 *   {FILE_SERVER}/uploads/notes_attachments/
 *   {FILE_SERVER}/uploads/medical-records/
 *   {FILE_SERVER}/uploads/personal-portal/licenses/
 *
 * Batch-scan / company-portal intake stays at FILE_SERVER root:
 *   {FILE_SERVER}/Order/BatchScan/
 *   {FILE_SERVER}/Order/CompanyPortal/
 */
function resolveUploadsRoot() {
  if (config.fileServer) {
    return path.join(path.resolve(config.fileServer), "uploads");
  }
  return path.join(__dirname, "..", "..", "uploads");
}

const uploadsRoot = resolveUploadsRoot();
const facilityUploadsDir = path.join(uploadsRoot, "facilities");

function ensureUploadDirs() {
  [uploadsRoot, facilityUploadsDir].forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

module.exports = {
  uploadsRoot,
  facilityUploadsDir,
  ensureUploadDirs,
  resolveUploadsRoot,
};
