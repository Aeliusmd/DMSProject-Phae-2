const path = require("path");
const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const { throwIfInvalid } = require("../utils/validationUtils");
const { validateDocumentUpload } = require("../validators/facilityValidator");
const {
  sendFileResponse,
  pipeStreamToResponse,
} = require("../utils/responseUtils");
const facilityDocumentService = require("../services/facilityDocumentService");
const facilityService = require("../services/facilityService");
const activityLogService = require("../services/activityLogService");
const notificationService = require("../services/notificationService");

function buildFacilityLogBase(req, facility) {
  return {
    facilityId: Number(facility.id),
    companyName: facility.facilityName,
    targetEmployeeId: req.user?.id,
  };
}

exports.listDocuments = asyncHandler(async (req, res) => {
  const documents = await facilityDocumentService.getDocuments(req.params.id, {
    timezone: req.clientTimezone,
  });
  return ApiResponse.success(res, { documents });
});

exports.uploadDocument = asyncHandler(async (req, res) => {
  throwIfInvalid(validateDocumentUpload(req.body, req.file));
  const facility = await facilityService.getFacilityById(req.params.id);
  const document = await facilityDocumentService.createDocument(
    req.params.id,
    req.file,
    req.body.documentType,
    req.user.id,
    { timezone: req.clientTimezone }
  );

  await activityLogService.recordFromRequest(req, {
    ...buildFacilityLogBase(req, facility),
    context: "documents",
    action: "upload_document",
    details: `Uploaded document "${document.documentName}" (${document.documentType}) to ${facility.facilityName}`,
  });

  await notificationService.notifyFacilityEvent({
    title: "Facility Document Uploaded",
    description: `"${document.documentName}" uploaded to ${facility.facilityName}`,
    facilityId: facility.id,
  });

  return ApiResponse.created(res, { document }, "Document uploaded successfully");
});

exports.downloadDocument = asyncHandler(async (req, res) => {
  const document = await facilityDocumentService.getDocumentFile(
    req.params.id,
    req.params.documentId
  );

  const mimeType = facilityDocumentService.resolveMimeType(document.file_type);

  res.setHeader("Content-Type", mimeType);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${path.basename(document.document_name)}"`
  );
  await sendFileResponse(res, document.absolutePath || document.storage_path);
});

exports.previewDocument = asyncHandler(async (req, res) => {
  const document = await facilityDocumentService.getDocumentFile(
    req.params.id,
    req.params.documentId
  );

  const mimeType = facilityDocumentService.resolveMimeType(document.file_type);

  res.setHeader("Content-Type", mimeType);
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${path.basename(document.document_name)}"`
  );

  const fs = require("fs");
  await pipeStreamToResponse(
    res,
    fs.createReadStream(document.absolutePath || document.storage_path)
  );
});

exports.deleteDocument = asyncHandler(async (req, res) => {
  const facility = await facilityService.getFacilityById(req.params.id);
  const document = await facilityDocumentService.getDocumentFile(
    req.params.id,
    req.params.documentId
  );

  const result = await facilityDocumentService.deleteDocument(
    req.params.id,
    req.params.documentId,
    req.user.id
  );

  await activityLogService.recordFromRequest(req, {
    ...buildFacilityLogBase(req, facility),
    context: "documents",
    action: "delete_document",
    details: `Deleted document "${document.document_name}" from ${facility.facilityName}`,
  });

  await notificationService.notifyFacilityEvent({
    title: "Facility Document Deleted",
    description: `"${document.document_name}" removed from ${facility.facilityName}`,
    facilityId: facility.id,
  });

  return ApiResponse.success(res, result, result.message);
});
