const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const ApiError = require("../utils/ApiError");
const invoiceService = require("../services/invoiceService");
const orderInvoiceEditLockService = require("../services/orderInvoiceEditLockService");
const Invoice = require("../models/Invoice");
const {
  validateCreateInvoice,
  validateUpdateInvoice,
  validateXrayInvoice,
  validateInvoiceIds,
  validateOrderIds,
  validateRecipientEmails,
  validateWriteOffInvoices,
} = require("../validators/invoiceValidator");
const activityLogService = require("../services/activityLogService");
const notificationService = require("../services/notificationService");
const Order = require("../models/Order");

function throwIfInvalid(validation) {
  if (!validation.valid) {
    throw new ApiError(400, "Validation failed", validation.errors);
  }
}

function validateOptionalEmails(body) {
  if (body.emails === undefined || body.emails === null) {
    return { valid: true, errors: [] };
  }

  return validateRecipientEmails(body);
}

function formatCurrency(amount) {
  const num = Number(amount);
  if (!Number.isFinite(num)) return "$0.00";

  return `$${num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

async function logBillingActivity(
  req,
  { action, details, facilityId = null, companyName = null, orderId = null }
) {
  const resolvedDetails = orderId
    ? activityLogService.appendOrderId(details, orderId)
    : details;

  await activityLogService.recordFromRequest(req, {
    context: "billing",
    module: activityLogService.MODULES.BILLING,
    action,
    details: resolvedDetails,
    facilityId,
    companyName,
  });
}

async function resolveOrderBillingContext(orderId) {
  const order = await Order.findById(orderId);

  if (!order) {
    return { facilityId: null, companyName: "System", orderNumber: String(orderId) };
  }

  return {
    facilityId: order.facility_id || null,
    companyName: order.facility_name || order.serve_company_name || "System",
    orderNumber: order.order_number || String(orderId),
  };
}

exports.getAll = asyncHandler(async (req, res) => {
  const data = await invoiceService.getInvoices({
    ...req.query,
    timezone: req.clientTimezone,
  });
  return ApiResponse.success(res, data, "Invoices retrieved");
});

exports.getCompanyWise = asyncHandler(async (_req, res) => {
  const data = await invoiceService.getCompanyWise();
  return ApiResponse.success(res, data, "Company-wise invoices retrieved");
});

exports.getByCompany = asyncHandler(async (req, res) => {
  const data = await invoiceService.getByCompany(req.params.companyId, {
    ...req.query,
    timezone: req.clientTimezone,
  });
  return ApiResponse.success(res, data, "Company invoices retrieved");
});

exports.getById = asyncHandler(async (req, res) => {
  const invoice = await invoiceService.getInvoiceById(req.params.id);
  return ApiResponse.success(res, { invoice }, "Invoice retrieved");
});

exports.acquireInvoiceEditLock = asyncHandler(async (req, res) => {
  const lock = await orderInvoiceEditLockService.acquireOrderInvoiceEditLock(
    req.params.orderId,
    req.body?.kind,
    req.user.id
  );
  return ApiResponse.success(res, { lock }, "Invoice edit lock acquired");
});

exports.heartbeatInvoiceEditLock = asyncHandler(async (req, res) => {
  const lock = await orderInvoiceEditLockService.heartbeatOrderInvoiceEditLock(
    req.params.orderId,
    req.body?.kind,
    req.user.id
  );
  return ApiResponse.success(res, { lock }, "Invoice edit lock refreshed");
});

exports.releaseInvoiceEditLock = asyncHandler(async (req, res) => {
  const result = await orderInvoiceEditLockService.releaseOrderInvoiceEditLock(
    req.params.orderId,
    req.query?.kind || req.body?.kind,
    req.user.id
  );
  return ApiResponse.success(res, result, "Invoice edit lock released");
});

exports.create = asyncHandler(async (req, res) => {
  const orderId = Number(req.body?.orderId);
  if (Number.isFinite(orderId) && orderId > 0) {
    await orderInvoiceEditLockService.assertNotLockedByOther(
      orderId,
      "regular",
      req.user.id
    );
  }
  let allowZeroTotal = false;

  if (Number.isFinite(orderId)) {
    const order = await Order.findById(orderId);
    allowZeroTotal = Boolean(order && Number(order.certificate_no_records));

    // Line items can be $0 when the $5 unmatched-facility search fee is the
    // only charge — createInvoice folds that fee in after this validation.
    if (!allowZeroTotal) {
      const pendingFee =
        await invoiceService.resolvePendingFacilitySearchFee(orderId);
      allowZeroTotal = Boolean(pendingFee?.amount > 0);
    }
  }

  throwIfInvalid(validateCreateInvoice(req.body, { allowZeroTotal }));

  const invoice = await invoiceService.createInvoice(req.body, req.user?.id);

  await logBillingActivity(req, {
    action: "create_invoice",
    details: `Created invoice ${invoice.invoiceNumber} for order ${invoice.orderNumber} — Total ${formatCurrency(invoice.totalAmount)}, Paid ${formatCurrency(invoice.amountPaid)}, Due ${formatCurrency(invoice.amountDue)}, Status: ${invoice.status}`,
    facilityId: invoice.facilityId,
    companyName: invoice.facilityName,
    orderId: invoice.orderId,
  });

  await notificationService.notifyInvoiceEvent({
    title: `Invoice Generated — ${invoice.invoiceNumber}`,
    description: `${invoice.facilityName || "Order"} — ${formatCurrency(invoice.totalAmount)}`,
    invoiceId: invoice.id,
    orderId: invoice.orderId,
  });

  return ApiResponse.created(res, { invoice }, "Invoice created successfully");
});

exports.update = asyncHandler(async (req, res) => {
  const existing = await Invoice.findById(req.params.id);
  if (!existing) {
    throw new ApiError(404, "Invoice not found");
  }
  await orderInvoiceEditLockService.assertNotLockedByOther(
    existing.order_id,
    "regular",
    req.user.id
  );

  throwIfInvalid(validateUpdateInvoice(req.body));

  const invoice = await invoiceService.updateInvoice(req.params.id, req.body);

  await logBillingActivity(req, {
    action: "update_invoice",
    details: `Updated invoice ${invoice.invoiceNumber} for order ${invoice.orderNumber} — Total ${formatCurrency(invoice.totalAmount)}, Paid ${formatCurrency(invoice.amountPaid)}, Due ${formatCurrency(invoice.amountDue)}, Status: ${invoice.status}`,
    facilityId: invoice.facilityId,
    companyName: invoice.facilityName,
    orderId: invoice.orderId,
  });

  await notificationService.notifyInvoiceEvent({
    title: `Invoice Updated — ${invoice.invoiceNumber}`,
    description: `Status: ${invoice.status}, Due ${formatCurrency(invoice.amountDue)}`,
    invoiceId: invoice.id,
    orderId: invoice.orderId,
  });

  return ApiResponse.success(res, { invoice }, "Invoice updated successfully");
});

exports.send = asyncHandler(async (req, res) => {
  throwIfInvalid(validateInvoiceIds(req.body));
  throwIfInvalid(validateOptionalEmails(req.body));

  const result = await invoiceService.sendInvoices(req.body.invoiceIds, {
    emails: req.body.emails,
    timezone: req.clientTimezone,
  });

  await logBillingActivity(req, {
    action: "send_invoices",
    details: `Marked ${result.sentCount} invoice(s) as sent`,
  });

  await notificationService.notifyInvoiceEvent({
    title: `Invoice${result.sentCount === 1 ? "" : "s"} Marked Sent`,
    description: `${result.sentCount} invoice(s) marked as sent`,
  });

  return ApiResponse.success(res, result, "Invoices marked as sent successfully");
});

exports.resend = asyncHandler(async (req, res) => {
  throwIfInvalid(validateInvoiceIds(req.body));
  throwIfInvalid(validateOptionalEmails(req.body));

  const result = await invoiceService.resendInvoices(req.body.invoiceIds, {
    emails: req.body.emails,
    timezone: req.clientTimezone,
  });

  await logBillingActivity(req, {
    action: "resend_invoices",
    details: `Resent ${result.resentCount} invoice(s) by email`,
  });

  await notificationService.notifyInvoiceEvent({
    title: `Invoice${result.resentCount === 1 ? "" : "s"} Resent`,
    description: `${result.resentCount} invoice(s) resent by email`,
  });

  return ApiResponse.success(res, result, "Invoices resent successfully");
});

exports.sendXray = asyncHandler(async (req, res) => {
  throwIfInvalid(validateOrderIds(req.body));
  throwIfInvalid(validateOptionalEmails(req.body));

  const result = await invoiceService.sendXrayInvoices(req.body.orderIds, {
    emails: req.body.emails,
    timezone: req.clientTimezone,
  });

  await logBillingActivity(req, {
    action: "send_xray_invoices",
    details: `Emailed ${result.sentCount} X-Ray invoice(s)`,
  });

  return ApiResponse.success(res, result, "X-Ray invoices sent successfully");
});

exports.resendXray = asyncHandler(async (req, res) => {
  throwIfInvalid(validateOrderIds(req.body));
  throwIfInvalid(validateOptionalEmails(req.body));

  const result = await invoiceService.resendXrayInvoices(req.body.orderIds, {
    emails: req.body.emails,
    timezone: req.clientTimezone,
  });

  await logBillingActivity(req, {
    action: "resend_xray_invoices",
    details: `Resent ${result.resentCount} X-Ray invoice(s) by email`,
  });

  return ApiResponse.success(res, result, "X-Ray invoices resent successfully");
});

exports.emailByOrder = asyncHandler(async (req, res) => {
  const result = await invoiceService.emailInvoiceByOrderId(req.params.orderId, {
    timezone: req.clientTimezone,
  });
  const context = await resolveOrderBillingContext(result.orderId);

  await logBillingActivity(req, {
    action: "email_invoice",
    details: `Invoice emailed to ${result.recipient || "recipient"} for order ${context.orderNumber}`,
    facilityId: context.facilityId,
    companyName: context.companyName,
    orderId: result.orderId,
  });

  await notificationService.notifyInvoiceEvent({
    title: `Invoice Emailed — ${context.orderNumber}`,
    description: result.recipient
      ? `Invoice emailed to ${result.recipient}`
      : "Invoice emailed.",
    orderId: result.orderId,
  });

  return ApiResponse.success(res, result, "Invoice emailed successfully");
});

exports.emailXrayByOrder = asyncHandler(async (req, res) => {
  throwIfInvalid(validateOptionalEmails(req.body));

  const result = await invoiceService.emailXrayInvoiceByOrderId(
    req.params.orderId,
    { emails: req.body.emails, timezone: req.clientTimezone }
  );
  const context = await resolveOrderBillingContext(result.orderId);

  await logBillingActivity(req, {
    action: "email_xray_invoice",
    details: `X-Ray invoice emailed to ${result.recipient || "recipient"} for order ${context.orderNumber}`,
    facilityId: context.facilityId,
    companyName: context.companyName,
    orderId: result.orderId,
  });

  await notificationService.notifyInvoiceEvent({
    title: `X-Ray Invoice Emailed — ${context.orderNumber}`,
    description: result.recipient
      ? `X-Ray invoice emailed to ${result.recipient}`
      : "X-Ray invoice emailed.",
    orderId: result.orderId,
  });

  return ApiResponse.success(res, result, "X-Ray invoice emailed successfully");
});

exports.createXray = asyncHandler(async (req, res) => {
  const orderId = Number(req.body?.orderId);
  if (Number.isFinite(orderId) && orderId > 0) {
    await orderInvoiceEditLockService.assertNotLockedByOther(
      orderId,
      "xray",
      req.user.id
    );
  }

  throwIfInvalid(validateXrayInvoice(req.body));

  const xray = await invoiceService.createOrUpdateXrayInvoice(req.body, req.user?.id);
  const context = await resolveOrderBillingContext(orderId);
  const payment = formatCurrency(xray.xray?.payment || 0);

  await logBillingActivity(req, {
    action: "save_xray_invoice",
    details: `Saved X-Ray invoice for order ${context.orderNumber} — Payment ${payment}, Exam date ${req.body.examDate || "—"}`,
    facilityId: context.facilityId,
    companyName: context.companyName,
    orderId,
  });

  await notificationService.notifyInvoiceEvent({
    title: `X-Ray Invoice Saved — ${context.orderNumber}`,
    description: `Payment ${payment}`,
    orderId,
  });

  return ApiResponse.success(res, xray, "X-Ray invoice saved successfully");
});

exports.getXrayByOrder = asyncHandler(async (req, res) => {
  const xray = await invoiceService.getXrayInvoiceByOrderId(req.params.orderId);
  return ApiResponse.success(res, xray, "X-Ray invoice retrieved");
});

exports.writeOff = asyncHandler(async (req, res) => {
  throwIfInvalid(validateWriteOffInvoices(req.body));

  const result = await invoiceService.writeOffInvoices(
    req.body,
    req.user?.id,
    { timezone: req.clientTimezone }
  );

  for (const item of result.invoices || []) {
    const context = await resolveOrderBillingContext(item.orderId);

    await logBillingActivity(req, {
      action: "write_off",
      details: `Wrote off ${formatCurrency(item.writeOffAmount)} on order ${context.orderNumber} — Remaining due ${formatCurrency(item.amountDue)}, Status: ${item.status}`,
      facilityId: context.facilityId,
      companyName: context.companyName,
      orderId: item.orderId,
    });

    await notificationService.notifyInvoiceEvent({
      title: `Write Off — ${context.orderNumber}`,
      description: `${formatCurrency(item.writeOffAmount)} written off`,
      orderId: item.orderId,
    });
  }

  return ApiResponse.success(res, result, "Invoice(s) written off successfully");
});
