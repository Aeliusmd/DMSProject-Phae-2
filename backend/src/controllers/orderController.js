const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const ApiError = require("../utils/ApiError");
const { throwIfInvalid } = require("../utils/validationUtils");
const {
  sendFileResponse,
  sendBufferResponse,
} = require("../utils/responseUtils");
const orderService = require("../services/orderService");
const orderEditLockService = require("../services/orderEditLockService");
const orderNoteEditLockService = require("../services/orderNoteEditLockService");
const batchScanService = require("../services/batchScanService");
const activityLogService = require("../services/activityLogService");
const notificationService = require("../services/notificationService");
const {
  validateCreateOrder,
  validateUpdateOrder,
  validateOrderFacilityUpdate,
  validateOrderNote,
  validateWorkflowStageUpdate,
} = require("../validators/orderValidator");
const {
  validateCancelOrder,
  validateDeleteOrder,
  validateMailWithOptionalDate,
  validateMailWithSentDate,
  validateCopyServiceLetter,
  validateRecordPickup,
  validateRecordFax,
  validateScanMedicalRecords,
  validateRemoveMedicalRecords,
  validateMedicalRecordTypeQuery,
  validateBatchScan,
  validateSingleSubpoenaUpload,
} = require("../validators/orderActionValidator");
const {
  validateOrderNotesQuery,
  validateSearchQuery,
} = require("../validators/queryValidators");

function getOrderLogContext(order) {
  const facilityId = order?.facility ? Number(order.facility) : null;

  return {
    facilityId: Number.isFinite(facilityId) ? facilityId : null,
    companyName: order?.facilityName || order?.serveCompanyName || "System",
  };
}

const PAYMENT_PREFIXES = ["prepayment", "custodian", "xray"];
const PAYMENT_LABELS = {
  prepayment: "Prepayment",
  custodian: "Custodian",
  xray: "X-Ray Fee",
};

function requestIncludesPayments(body = {}) {
  return PAYMENT_PREFIXES.some((prefix) =>
    [`${prefix}Check`, `${prefix}Date`, `${prefix}Paid`, `${prefix}Memo`].some(
      (field) => body[field] !== undefined && `${body[field]}`.trim() !== ""
    )
  );
}

function formatCurrency(amount) {
  const num = Number(amount);
  if (!Number.isFinite(num)) return "$0.00";

  return `$${num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function buildPaymentLogDetails(order) {
  const lines = PAYMENT_PREFIXES.map((prefix) => {
    const amount = Number(order[`${prefix}Paid`]);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return `${PAYMENT_LABELS[prefix]} ${formatCurrency(amount)}`;
  }).filter(Boolean);

  if (!lines.length && Number(order.orderAmountPaid) > 0) {
    return `Total payments ${formatCurrency(order.orderAmountPaid)}`;
  }

  return lines.join(", ");
}

async function logBillingPaymentActivity(req, order, body) {
  if (!requestIncludesPayments(body)) {
    return;
  }

  const logContext = getOrderLogContext(order);
  const paymentDetails = buildPaymentLogDetails(order);

  if (!paymentDetails) {
    return;
  }

  const taggedDetails = activityLogService.appendOrderId(
    `Recorded payments on order ${order.orderNumber}: ${paymentDetails}`,
    order.id
  );

  await activityLogService.recordFromRequest(req, {
    context: "billing",
    module: activityLogService.MODULES.BILLING,
    action: "record_payment",
    details: taggedDetails,
    facilityId: logContext.facilityId,
    companyName: logContext.companyName,
  });

  await notificationService.notifyInvoiceEvent({
    title: `Payment Recorded — ${order.orderNumber}`,
    description: paymentDetails,
    orderId: order.id,
  });
}

async function logOrderActivity(
  req,
  order,
  { action, details, callbackDate = null, attachmentPath = null, skipOrderLog = false }
) {
  const logContext = getOrderLogContext(order);
  const taggedDetails = activityLogService.appendOrderId(details, order.id);

  await activityLogService.recordFromRequest(req, {
    context: "orders",
    action,
    details: taggedDetails,
    facilityId: logContext.facilityId,
    companyName: logContext.companyName,
    targetEmployeeId: req.user.id,
  });

  if (!skipOrderLog) {
    await orderService.addOrderActivityLog({
      orderId: order.id,
      actorId: req.user.id,
      note: details,
      callbackDate,
      attachmentPath,
    });
  }
}

exports.getAll = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  const result = await orderService.getAllOrders({
    ...req.query,
    timezone: req.clientTimezone,
  });
  if (Array.isArray(result)) {
    return ApiResponse.success(res, { orders: result });
  }
  return ApiResponse.success(res, result);
});

exports.getFilterCompanies = asyncHandler(async (req, res) => {
  const companies = await orderService.getOrderFilterCompanies();
  return ApiResponse.success(res, { companies });
});

exports.searchDoctors = asyncHandler(async (req, res) => {
  throwIfInvalid(validateSearchQuery(req.query));
  const doctors = await orderService.searchOrderDoctors(
    req.query.q,
    req.query.facility
  );
  return ApiResponse.success(res, { doctors });
});

exports.searchDoctorAddresses = asyncHandler(async (req, res) => {
  throwIfInvalid(validateSearchQuery(req.query));
  const addresses = await orderService.searchOrderDoctorAddresses(req.query.q);
  return ApiResponse.success(res, { addresses });
});

exports.getStats = asyncHandler(async (_req, res) => {
  const stats = await orderService.getOrderStats();
  return ApiResponse.success(res, { stats });
});

exports.getUnprocessed = asyncHandler(async (_req, res) => {
  const items = await batchScanService.getUnprocessedQueue();
  return ApiResponse.success(res, items, "Unprocessed subpoenas retrieved");
});

exports.getUnprocessedById = asyncHandler(async (req, res) => {
  const item = await batchScanService.getUnprocessedExtract(req.params.extractId);
  return ApiResponse.success(res, item, "Unprocessed subpoena retrieved");
});

exports.getUnprocessedFile = asyncHandler(async (req, res) => {
  const fileInfo = await batchScanService.getUnprocessedExtractFile(
    req.params.extractId
  );

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${fileInfo.fileName.replace(/"/g, "")}"`
  );
  await sendFileResponse(res, fileInfo.absolutePath);
});

exports.batchScan = asyncHandler(async (req, res) => {
  throwIfInvalid(
    validateBatchScan(req.body, req.file, req.user?.id)
  );
  const result = await batchScanService.processBatchScan(
    req.file,
    req.body.uploadedBy || req.user?.id,
    { chosenFacilityId: req.body.chosenFacilityId }
  );
  return ApiResponse.created(res, result, "Batch scan processed successfully");
});

exports.uploadSubpoena = asyncHandler(async (req, res) => {
  throwIfInvalid(
    validateSingleSubpoenaUpload(req.body, req.file, req.user?.id)
  );
  const result = await batchScanService.processSingleSubpoena(
    req.file,
    req.user?.id
  );
  return ApiResponse.created(
    res,
    result,
    "Subpoena uploaded and extracted successfully"
  );
});

exports.getById = asyncHandler(async (req, res) => {
  const order = await orderService.getOrderById(req.params.id);
  return ApiResponse.success(res, { order });
});

exports.getSubpoenaFile = asyncHandler(async (req, res) => {
  const fileInfo = await orderService.getOrderSubpoenaFile(req.params.id);

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${fileInfo.fileName.replace(/"/g, "")}"`
  );
  await sendFileResponse(res, fileInfo.absolutePath);
});

exports.scanMedicalRecords = asyncHandler(async (req, res) => {
  const files = req.files?.length ? req.files : req.file ? [req.file] : [];
  throwIfInvalid(
    validateScanMedicalRecords(req.body, req.query, files)
  );

  const recordType = req.query.recordType || req.body?.recordType || "medical";

  const order = await orderService.scanMedicalRecords(
    req.params.id,
    files,
    req.user.id,
    { recordType }
  );

  return ApiResponse.success(
    res,
    { order },
    "Records uploaded successfully"
  );
});

exports.removeMedicalRecords = asyncHandler(async (req, res) => {
  throwIfInvalid(validateRemoveMedicalRecords(req.query));

  const recordType = req.query.recordType || null;

  const order = await orderService.removeMedicalRecords(
    req.params.id,
    req.user.id,
    { recordType }
  );

  return ApiResponse.success(res, { order }, "Records removed");
});

exports.deleteAdditionalDocument = asyncHandler(async (req, res) => {
  const order = await orderService.deleteOrderAdditionalDocument(
    req.params.id,
    req.params.documentId
  );

  await logOrderActivity(req, order, {
    action: "delete_document",
    details: `Removed additional document #${req.params.documentId} from order ${order.orderNumber}`,
  });

  return ApiResponse.success(res, { order }, "Document removed");
});

exports.removeSubpoena = asyncHandler(async (req, res) => {
  const order = await orderService.removeOrderSubpoena(req.params.id);

  await logOrderActivity(req, order, {
    action: "delete_document",
    details: `Removed subpoena from order ${order.orderNumber}`,
  });

  return ApiResponse.success(res, { order }, "Subpoena removed");
});

exports.getMedicalRecordsFile = asyncHandler(async (req, res) => {
  throwIfInvalid(validateMedicalRecordTypeQuery(req.query));

  const recordType = req.query.recordType || "medical";
  const recordId = req.query.recordId || null;
  const fileInfo = await orderService.getOrderMedicalRecordsFile(req.params.id, {
    recordType,
    recordId,
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${fileInfo.fileName.replace(/"/g, "")}"`
  );
  await sendFileResponse(res, fileInfo.absolutePath);
});

exports.getPrintInvoiceFile = asyncHandler(async (req, res) => {
  const result = await orderService.getPrintInvoicePdf(req.params.id);
  const order = await orderService.getOrderById(req.params.id);

  await logOrderActivity(req, order, {
    action: "print_invoice",
    details: `Print invoice generated for order ${order.orderNumber}`,
  });

  sendBufferResponse(res, result.pdfBuffer, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="${result.fileName.replace(/"/g, "")}"`,
  });
});

exports.getPrintXrayInvoiceFile = asyncHandler(async (req, res) => {
  const result = await orderService.getPrintXrayInvoicePdf(req.params.id);
  const order = await orderService.getOrderById(req.params.id);

  await logOrderActivity(req, order, {
    action: "print_xray_invoice",
    details: `Print X-Ray invoice generated for order ${order.orderNumber}`,
  });

  sendBufferResponse(res, result.pdfBuffer, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="${result.fileName.replace(/"/g, "")}"`,
  });
});

exports.getReminders = asyncHandler(async (req, res) => {
  const reminders = await orderService.getOrderReminders(req.user, {
    scope: req.query.scope,
    timezone: req.clientTimezone,
  });
  return ApiResponse.success(res, { reminders });
});

exports.getDueRemindersToday = asyncHandler(async (req, res) => {
  const data = await notificationService.getDueRemindersForUser(req.user, {
    timezone: req.clientTimezone,
  });
  return ApiResponse.success(res, data, "Due reminders retrieved");
});

exports.create = asyncHandler(async (req, res) => {
  const validation = validateCreateOrder(req.body);

  if (!validation.valid) {
    throw new ApiError(400, "Validation failed", validation.errors);
  }

  const created = await orderService.createOrder(
    req.body,
    req.user.id,
    req.files
  );
  const orders = Array.isArray(created) ? created : [created];
  const order = orders[0];

  for (const createdOrder of orders) {
    await logOrderActivity(req, createdOrder, {
      action: "create",
      details: `Created order ${createdOrder.orderNumber} for ${getOrderLogContext(createdOrder).companyName}`,
    });

    await notificationService.notifyOrderCreated({
      orderNumber: createdOrder.orderNumber,
      companyName: getOrderLogContext(createdOrder).companyName,
      orderId: createdOrder.id,
    });
  }

  await logBillingPaymentActivity(req, order, req.body);

  const message =
    orders.length > 1
      ? `${orders.length} orders created successfully`
      : "Order created successfully";

  return ApiResponse.created(
    res,
    { order, orders },
    message
  );
});

exports.acquireEditLock = asyncHandler(async (req, res) => {
  const lock = await orderEditLockService.acquireOrderEditLock(
    req.params.id,
    req.user.id
  );
  return ApiResponse.success(res, { lock }, "Order edit lock acquired");
});

exports.heartbeatEditLock = asyncHandler(async (req, res) => {
  const lock = await orderEditLockService.heartbeatOrderEditLock(
    req.params.id,
    req.user.id
  );
  return ApiResponse.success(res, { lock }, "Order edit lock refreshed");
});

exports.releaseEditLock = asyncHandler(async (req, res) => {
  const result = await orderEditLockService.releaseOrderEditLock(
    req.params.id,
    req.user.id
  );
  return ApiResponse.success(res, result, "Order edit lock released");
});

exports.update = asyncHandler(async (req, res) => {
  await orderEditLockService.assertNotLockedByOther(req.params.id, req.user.id);
  const existing = await orderService.getOrderById(req.params.id);
  if (!existing) {
    throw new ApiError(404, "Order not found");
  }

  const payload = {
    ...req.body,
    creationSource:
      req.body.creationSource ||
      existing.creationSource ||
      "manual",
    hasDriverLicenseDocument:
      req.body.hasDriverLicenseDocument ?? existing.hasDriverLicenseDocument,
    hasPersonalDocument:
      req.body.hasPersonalDocument ?? existing.hasPersonalDocument,
    documents: existing.documents || [],
    facilityName: req.body.facilityName || existing.facilityName || "",
    facilityAddress:
      req.body.facilityAddress ||
      req.body.fullAddress ||
      existing.facilityAddress ||
      existing.fullAddress ||
      "",
    driverLicenseNumber:
      req.body.driverLicenseNumber || existing.driverLicenseNumber || "",
    additionalDocumentFile:
      req.files?.additionalDocumentFile?.[0] ||
      req.files?.additionalDocumentFile ||
      req.body.additionalDocumentFile ||
      null,
  };

  const validation = validateUpdateOrder(payload);

  if (!validation.valid) {
    throw new ApiError(400, "Validation failed", validation.errors);
  }

  const order = await orderService.updateOrder(
    req.params.id,
    payload,
    req.user.id,
    req.files
  );

  await logOrderActivity(req, order, {
    action: "update",
    details: `Updated order ${order.orderNumber} for ${getOrderLogContext(order).companyName}`,
  });

  await logBillingPaymentActivity(req, order, req.body);

  await notificationService.notifyOrderStatusChange({
    orderNumber: order.orderNumber,
    details: `Order updated for ${getOrderLogContext(order).companyName}`,
    orderId: order.id,
  });

  return ApiResponse.success(res, { order }, "Order updated successfully");
});

exports.updateFacility = asyncHandler(async (req, res) => {
  await orderEditLockService.assertNotLockedByOther(req.params.id, req.user.id);
  const validation = validateOrderFacilityUpdate(req.body);

  if (!validation.valid) {
    throw new ApiError(400, "Validation failed", validation.errors);
  }

  const order = await orderService.updateOrderFacility(
    req.params.id,
    req.body,
    req.user.id
  );

  await logOrderActivity(req, order, {
    action: "update",
    details: `Updated facility for order ${order.orderNumber} to ${order.facilityName || "facility"}`,
  });

  return ApiResponse.success(res, { order }, "Order facility updated successfully");
});

exports.remove = asyncHandler(async (req, res) => {
  throwIfInvalid(validateDeleteOrder(req.body));
  const order = await orderService.getOrderById(req.params.id);
  const result = await orderService.deleteOrder(req.params.id, {
    reason: req.body.reason,
    actorId: req.user.id,
    actorName: req.user.name,
  });

  await logOrderActivity(req, order, {
    action: "delete",
    details: `Deleted order ${order.orderNumber} for ${getOrderLogContext(order).companyName} and deleted reason: ${req.body.reason}`,
  });

  await notificationService.notifyOrderStatusChange({
    orderNumber: order.orderNumber,
    details: `Order deleted for ${getOrderLogContext(order).companyName}`,
    orderId: order.id,
  });

  return ApiResponse.success(res, result, result.message);
});

exports.cancel = asyncHandler(async (req, res) => {
  throwIfInvalid(validateCancelOrder(req.body));
  const order = await orderService.cancelOrder(req.params.id, {
    reason: req.body.reason,
    actorId: req.user.id,
    actorName: req.user.name,
  });

  await logOrderActivity(req, order, {
    action: "cancel",
    details: `Cancelled order ${order.orderNumber} for ${getOrderLogContext(order).companyName}: ${req.body.reason}`,
  });

  await notificationService.notifyOrderStatusChange({
    orderNumber: order.orderNumber,
    details: `Order cancelled for ${getOrderLogContext(order).companyName}`,
    orderId: order.id,
  });

  return ApiResponse.success(res, { order }, "Order cancelled successfully");
});

exports.restore = asyncHandler(async (req, res) => {
  const order = await orderService.restoreOrder(req.params.id, {
    actorId: req.user.id,
    actorName: req.user.name,
  });

  await logOrderActivity(req, order, {
    action: "restore",
    details: `Restored order ${order.orderNumber} to ${order.status} for ${getOrderLogContext(order).companyName}`,
  });

  await notificationService.notifyOrderStatusChange({
    orderNumber: order.orderNumber,
    details: `Order restored for ${getOrderLogContext(order).companyName}`,
    orderId: order.id,
  });

  return ApiResponse.success(res, { order }, "Order restored successfully");
});

exports.getNotes = asyncHandler(async (req, res) => {
  throwIfInvalid(validateOrderNotesQuery(req.query));
  const result = await orderService.getOrderNotes(req.params.id, {
    includeCalled:
      String(req.query.includeCalled || "").toLowerCase() === "true" ||
      String(req.query.includeCalled || "") === "1",
    noteId: req.query.noteId || null,
    actorId: req.user.id,
    actorRole: req.user.role,
    pagination: req.query.pagination || null,
    cursor: req.query.cursor || null,
    pageSize: req.query.pageSize || req.query.limit || 10,
    fromDate: req.query.fromDate || null,
    toDate: req.query.toDate || null,
    timezone: req.clientTimezone,
  });
  if (Array.isArray(result)) {
    return ApiResponse.success(res, { notes: result });
  }
  return ApiResponse.success(res, result);
});

exports.createNote = asyncHandler(async (req, res) => {
  const validation = validateOrderNote(req.body);

  if (!validation.valid) {
    throw new ApiError(400, "Validation failed", validation.errors);
  }

  const order = await orderService.getOrderById(req.params.id);
  const notes = await orderService.addOrderNote(
    req.params.id,
    req.body,
    req.user.id,
    req.file,
    { timezone: req.clientTimezone, actorRole: req.user.role }
  );

  await logOrderActivity(req, order, {
    action: "create_note",
    details: `Added note to order ${order.orderNumber}`,
    skipOrderLog: true,
  });

  return ApiResponse.created(res, { notes }, "Note added successfully");
});

exports.acquireNoteEditLock = asyncHandler(async (req, res) => {
  const lock = await orderNoteEditLockService.acquireOrderNoteEditLock(
    req.params.id,
    req.params.noteId,
    req.user.id
  );
  return ApiResponse.success(res, { lock }, "Note edit lock acquired");
});

exports.heartbeatNoteEditLock = asyncHandler(async (req, res) => {
  const lock = await orderNoteEditLockService.heartbeatOrderNoteEditLock(
    req.params.id,
    req.params.noteId,
    req.user.id
  );
  return ApiResponse.success(res, { lock }, "Note edit lock refreshed");
});

exports.releaseNoteEditLock = asyncHandler(async (req, res) => {
  const result = await orderNoteEditLockService.releaseOrderNoteEditLock(
    req.params.id,
    req.params.noteId,
    req.user.id
  );
  return ApiResponse.success(res, result, "Note edit lock released");
});

exports.updateNote = asyncHandler(async (req, res) => {
  await orderNoteEditLockService.assertNotLockedByOther(
    req.params.id,
    req.params.noteId,
    req.user.id
  );
  const validation = validateOrderNote(req.body);

  if (!validation.valid) {
    throw new ApiError(400, "Validation failed", validation.errors);
  }

  const order = await orderService.getOrderById(req.params.id);
  const result = await orderService.updateOrderNote(
    req.params.id,
    req.params.noteId,
    req.body,
    req.user.id,
    req.file,
    { timezone: req.clientTimezone }
  );

  await logOrderActivity(req, order, {
    action: "update_note",
    details: `Saved callback note on order ${order.orderNumber}`,
    skipOrderLog: true,
  });

  return ApiResponse.success(res, result, "Note updated successfully");
});

exports.getActivityLogs = asyncHandler(async (req, res) => {
  const result = await orderService.getOrderActivityLogs(
    req.params.id,
    { ...req.query, timezone: req.clientTimezone }
  );
  if (Array.isArray(result)) {
    return ApiResponse.success(res, { logs: result });
  }
  return ApiResponse.success(res, result);
});

exports.getWorkflowStages = asyncHandler(async (req, res) => {
  const stages = await orderService.getWorkflowStages(req.params.id);
  return ApiResponse.success(res, { stages });
});

exports.updateWorkflowStage = asyncHandler(async (req, res) => {
  const validation = validateWorkflowStageUpdate(req.body);

  if (!validation.valid) {
    throw new ApiError(400, "Validation failed", validation.errors);
  }

  const order = await orderService.getOrderById(req.params.id);
  const stages = await orderService.updateOrderWorkflowStage(
    req.params.id,
    req.body.stageName,
    req.body.stageStatus
  );

  await logOrderActivity(req, order, {
    action: "workflow_update",
    details: `Updated "${req.body.stageName}" workflow stage to ${req.body.stageStatus} on order ${order.orderNumber}`,
  });

  await notificationService.notifyOrderStatusChange({
    orderNumber: order.orderNumber,
    details: `Workflow "${req.body.stageName}" updated to ${req.body.stageStatus}`,
    orderId: order.id,
  });

  return ApiResponse.success(res, { stages }, "Workflow stage updated");
});

exports.mailCompletedOrder = asyncHandler(async (req, res) => {
  throwIfInvalid(validateMailWithOptionalDate(req.body, "deliveryDate"));
  const result = await orderService.mailCompletedOrder(req.params.id, {
    emails: req.body.emails,
    email: req.body.email,
    additionalEmails: req.body.additionalEmails,
    deliveryDate: req.body.deliveryDate,
    timezone: req.clientTimezone,
  });

  const order = await orderService.getOrderById(req.params.id);

  await logOrderActivity(req, order, {
    action: "order_mail",
    details: `Records ready email sent to ${result.recipient} for order ${order.orderNumber}`,
  });

  return ApiResponse.success(res, result, "Email sent");
});

exports.sendCnrRecord = asyncHandler(async (req, res) => {
  throwIfInvalid(validateMailWithSentDate(req.body));
  const result = await orderService.sendCnrRecord(req.params.id, {
    emails: req.body.emails,
    email: req.body.email,
    additionalEmails: req.body.additionalEmails,
    sentDate: req.body.sentDate,
    timezone: req.clientTimezone,
  });

  const order = await orderService.getOrderById(req.params.id);

  await logOrderActivity(req, order, {
    action: "cnr_record_mail",
    details: `CNR Letter emailed to ${result.recipient} for order ${order.orderNumber}`,
  });

  return ApiResponse.success(res, result, "CNR record email sent");
});

exports.sendCertificateOfRecords = asyncHandler(async (req, res) => {
  throwIfInvalid(validateMailWithSentDate(req.body));
  const result = await orderService.sendCertificateOfRecords(req.params.id, {
    emails: req.body.emails,
    email: req.body.email,
    additionalEmails: req.body.additionalEmails,
    sentDate: req.body.sentDate,
    timezone: req.clientTimezone,
  });

  const order = await orderService.getOrderById(req.params.id);

  await logOrderActivity(req, order, {
    action: "certificate_of_records_mail",
    details: `Certificate of Records emailed to ${result.recipient} for order ${order.orderNumber}`,
  });

  return ApiResponse.success(res, result, "Certificate of records email sent");
});

exports.sendCopyServiceLetter = asyncHandler(async (req, res) => {
  throwIfInvalid(validateCopyServiceLetter(req.body));
  const result = await orderService.sendCopyServiceLetter(req.params.id, {
    email: req.body.email,
    additionalEmails: req.body.additionalEmails,
  });

  const order = await orderService.getOrderById(req.params.id);

  await logOrderActivity(req, order, {
    action: "copy_service_letter",
    details: `Copy service letter emailed to ${result.recipients.join(", ")} for order ${order.orderNumber}`,
  });

  return ApiResponse.success(res, result, "Copy service letter sent successfully");
});

exports.recordPickup = asyncHandler(async (req, res) => {
  throwIfInvalid(validateRecordPickup(req.body));
  const result = await orderService.recordOrderPickup(req.params.id, {
    pickupDate: req.body.pickupDate,
    pickupPersonName: req.body.pickupPersonName,
    notes: req.body.notes,
  });

  const order = await orderService.getOrderById(req.params.id);
  const noteSuffix = result.notes ? ` — ${result.notes}` : "";

  await logOrderActivity(req, order, {
    action: "order_pickup",
    details: `Pickup recorded on ${result.pickupDate} by ${result.pickupPersonName} for order ${order.orderNumber}${noteSuffix}`,
  });

  return ApiResponse.success(res, result, "Pickup recorded");
});

exports.recordFax = asyncHandler(async (req, res) => {
  throwIfInvalid(validateRecordFax(req.body));
  const result = await orderService.recordOrderFax(req.params.id, {
    faxNumber: req.body.faxNumber,
    sentDate: req.body.sentDate,
    notes: req.body.notes,
  });

  const order = await orderService.getOrderById(req.params.id);
  const noteSuffix = result.notes ? ` — ${result.notes}` : "";

  await logOrderActivity(req, order, {
    action: "order_fax",
    details: `CNR fax recorded to ${result.faxNumber} on ${result.sentDate} for order ${order.orderNumber}${noteSuffix}`,
  });

  return ApiResponse.success(res, result, "Fax recorded");
});
