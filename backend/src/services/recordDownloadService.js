const fs = require("fs");
const path = require("path");
const { randomBytes } = require("crypto");
const { createZipArchive } = require("../utils/zipArchive");
const ApiError = require("../utils/ApiError");
const {
  sendFileResponse,
  streamArchiveToResponse,
} = require("../utils/responseUtils");
const Order = require("../models/Order");
const OrderRecord = require("../models/OrderRecord");
const RecordDownloadLink = require("../models/RecordDownloadLink");
const { resolveOrderStorageAbsolutePath } = require("../utils/fileStorage");

const RECORD_TITLES = {
  medical: "Medical Records",
  billing: "Billing Records",
  employment: "Employment Records",
  xrays: "X-Rays",
  other: "Other Records",
};

const LINK_VALID_DAYS = 7;

function buildToken() {
  return randomBytes(32).toString("hex");
}

function addExpiryDate(fromDate = new Date()) {
  const expires = new Date(fromDate);
  expires.setDate(expires.getDate() + LINK_VALID_DAYS);
  return expires;
}

async function resolveOrderRecordFiles(order) {
  const records = await OrderRecord.findByOrderId(order.id);
  const withFiles = records.filter((record) => record.storage_path);
  const safeOrderNumber = `${order.order_number || order.id}`.replace(
    /[^\w.-]+/g,
    "_"
  );

  const files = [];
  const recordLabels = [];

  for (const record of withFiles) {
    const absolutePath = resolveOrderStorageAbsolutePath(record.storage_path);

    if (!absolutePath || !fs.existsSync(absolutePath)) {
      continue;
    }

    const typeSuffix = record.record_type || "records";
    const originalName = `${record.original_file_name || ""}`.trim();
    recordLabels.push(RECORD_TITLES[record.record_type] || "Records");
    files.push({
      recordType: record.record_type,
      label: RECORD_TITLES[record.record_type] || "Records",
      filename: originalName
        ? `${safeOrderNumber}-${record.id}-${originalName}`
        : `${safeOrderNumber}-${typeSuffix}-${record.id}.pdf`,
      path: absolutePath,
    });
  }

  return { files, recordLabels };
}

async function createDownloadLinkForOrder(orderId) {
  const normalizedId = Number(orderId);

  if (!Number.isFinite(normalizedId)) {
    throw new ApiError(400, "Invalid order id");
  }

  const order = await Order.findById(normalizedId);
  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  const { files } = await resolveOrderRecordFiles(order);
  if (!files.length) {
    throw new ApiError(
      400,
      "Records files not found. Scan records before sending email."
    );
  }

  const token = buildToken();
  const expiresAt = addExpiryDate(new Date());

  await RecordDownloadLink.create({
    orderId: normalizedId,
    token,
    expiresAt,
  });

  return {
    token,
    expiresAt,
    files,
  };
}

async function getValidLink(token) {
  const row = await RecordDownloadLink.findByToken(`${token || ""}`.trim());

  if (!row) {
    throw new ApiError(404, "Download link not found");
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw new ApiError(410, "This download link has expired");
  }

  return row;
}

/**
 * Shared 7-day download window used by emailed links and company portal UI.
 * Aligns portal "Download Documents" with the latest records email link.
 */
async function getRecordsDownloadWindow(internalOrderId) {
  const orderId = Number(internalOrderId);
  if (!Number.isFinite(orderId) || orderId <= 0) {
    return {
      canDownload: false,
      expired: false,
      expiresAt: null,
      reason: "Records download is not available for this order.",
    };
  }

  const link = await RecordDownloadLink.findLatestByOrderId(orderId);
  if (!link) {
    return {
      canDownload: false,
      expired: false,
      expiresAt: null,
      reason:
        "Download records is not available yet. Records become available after they are emailed.",
    };
  }

  const expiresAt = link.expires_at ? new Date(link.expires_at) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
    return {
      canDownload: false,
      expired: true,
      expiresAt: null,
      reason:
        "Download records is not available because the download window has expired.",
    };
  }

  if (expiresAt.getTime() <= Date.now()) {
    return {
      canDownload: false,
      expired: true,
      expiresAt,
      reason:
        "Download records is not available because 7 days have passed since the records were sent.",
    };
  }

  return {
    canDownload: true,
    expired: false,
    expiresAt,
    reason: null,
  };
}

async function getDownloadMetadata(token) {
  const link = await getValidLink(token);
  const order = await Order.findById(link.order_id);

  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  const { files, recordLabels } = await resolveOrderRecordFiles(order);

  if (!files.length) {
    throw new ApiError(404, "Records are no longer available for download");
  }

  return {
    orderNumber: order.order_number || String(order.id),
    applicant:
      [order.applicant_first_name, order.applicant_last_name]
        .filter(Boolean)
        .join(" ") || "",
    expiresAt: link.expires_at,
    recordLabels,
    files: files.map((file) => ({
      recordType: file.recordType,
      label: file.label,
      filename: file.filename,
    })),
  };
}

async function streamDownloadByToken(token, res) {
  const link = await getValidLink(token);
  const order = await Order.findById(link.order_id);

  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  const { files } = await resolveOrderRecordFiles(order);

  if (!files.length) {
    throw new ApiError(404, "Records are no longer available for download");
  }

  // Additive tracking: mark viewed/downloaded when the file is actually served.
  // Failures here must never block the download.
  try {
    await RecordDownloadLink.markDownloaded(link.id);
    await Order.markRecordsDownloaded(order.id);
  } catch (_trackingError) {
    // Intentionally ignore tracking errors.
  }

  const safeOrderNumber = `${order.order_number || order.id}`.replace(
    /[^\w.-]+/g,
    "_"
  );

  if (files.length === 1) {
    const file = files[0];
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${file.filename.replace(/"/g, "")}"`
    );
    await sendFileResponse(res, file.path);
    return;
  }

  const zipName = `${safeOrderNumber}-records.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${zipName.replace(/"/g, "")}"`
  );

  const archive = createZipArchive();

  files.forEach((file) => {
    archive.file(file.path, { name: file.filename });
  });

  await streamArchiveToResponse(archive, res);
}

module.exports = {
  LINK_VALID_DAYS,
  addExpiryDate,
  createDownloadLinkForOrder,
  getDownloadMetadata,
  getRecordsDownloadWindow,
  streamDownloadByToken,
  resolveOrderRecordFiles,
};
