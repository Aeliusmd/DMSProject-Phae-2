const asyncHandler = require("../utils/asyncHandler");
const ApiResponse = require("../utils/ApiResponse");
const { throwIfInvalid } = require("../utils/validationUtils");
const { validateManualPayment } = require("../validators/paymentValidator");
const { validatePaymentSearchQuery, validatePaymentListQuery } = require("../validators/queryValidators");
const paymentService = require("../services/paymentService");
const orderInvoiceEditLockService = require("../services/orderInvoiceEditLockService");
const activityLogService = require("../services/activityLogService");

const MANUAL_PAYMENT_LOCK_KIND = "manual_payment";

function formatCurrency(amount) {
  const num = Number(amount);
  if (!Number.isFinite(num)) return "$0.00";

  return `$${num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

async function logManualPaymentActivity(req, saved = {}, payload = {}) {
  const order = saved.order || {};
  const invoiceType =
    payload.invoiceType === "xray" ? "X-Ray Invoice" : "Regular Invoice";
  const savedInvoice = (saved.invoices || []).find(
    (item) => item.type === payload.invoiceType
  );
  const amount = savedInvoice ? formatCurrency(savedInvoice.amount) : "$0.00";
  const details = activityLogService.appendOrderId(
    `Recorded manual payment for ${invoiceType} ${savedInvoice?.invoiceNumber || ""} on order ${order.orderNumber || order.id || ""} — Check #${payload.checkNumber || "—"}, Date ${payload.paymentDate || "—"}, Amount ${amount}${payload.note ? `, Note: ${payload.note}` : ""}`,
    order.id || null
  );

  await activityLogService.recordFromRequest(req, {
    context: "billing",
    module: activityLogService.MODULES.BILLING,
    action: "record_payment",
    details,
    facilityId: null,
    companyName: order.company || "System",
  });
}

exports.searchOrderInvoices = asyncHandler(async (req, res) => {
  throwIfInvalid(validatePaymentSearchQuery(req.query));
  const orderRef = req.query.orderId || req.query.q || "";
  const result = await paymentService.searchOrderInvoices(orderRef);
  return ApiResponse.success(res, result);
});

exports.acquireManualPaymentLock = asyncHandler(async (req, res) => {
  const lock = await orderInvoiceEditLockService.acquireOrderInvoiceEditLock(
    req.params.orderId,
    MANUAL_PAYMENT_LOCK_KIND,
    req.user.id
  );
  return ApiResponse.success(res, { lock }, "Payment edit lock acquired");
});

exports.heartbeatManualPaymentLock = asyncHandler(async (req, res) => {
  const lock = await orderInvoiceEditLockService.heartbeatOrderInvoiceEditLock(
    req.params.orderId,
    MANUAL_PAYMENT_LOCK_KIND,
    req.user.id
  );
  return ApiResponse.success(res, { lock }, "Payment edit lock refreshed");
});

exports.releaseManualPaymentLock = asyncHandler(async (req, res) => {
  const result = await orderInvoiceEditLockService.releaseOrderInvoiceEditLock(
    req.params.orderId,
    MANUAL_PAYMENT_LOCK_KIND,
    req.user.id
  );
  return ApiResponse.success(res, result, "Payment edit lock released");
});

exports.recordManualPayment = asyncHandler(async (req, res) => {
  throwIfInvalid(validateManualPayment(req.body));
  await orderInvoiceEditLockService.assertNotLockedByOther(
    req.body.orderId,
    MANUAL_PAYMENT_LOCK_KIND,
    req.user.id
  );
  const result = await paymentService.recordManualInvoicePayment(
    req.body,
    req.user?.id
  );
  await logManualPaymentActivity(req, result, req.body);
  return ApiResponse.success(res, result, "Manual payment recorded");
});

exports.getManualPayments = asyncHandler(async (req, res) => {
  throwIfInvalid(validatePaymentListQuery(req.query));
  const result = await paymentService.getManualPayments(req.query);

  if (Array.isArray(result)) {
    return ApiResponse.success(res, { payments: result });
  }

  return ApiResponse.success(res, {
    payments: result.payments || [],
    summary: result.summary || null,
    pagination: result.pagination || null,
  });
});

exports.getOnlinePayments = asyncHandler(async (req, res) => {
  throwIfInvalid(validatePaymentListQuery(req.query));
  const result = await paymentService.getOnlinePayments(req.query);

  if (Array.isArray(result)) {
    return ApiResponse.success(res, { payments: result });
  }

  return ApiResponse.success(res, {
    payments: result.payments || [],
    summary: result.summary || null,
    pagination: result.pagination || null,
  });
});

exports.getOrderPaymentDetail = asyncHandler(async (req, res) => {
  const detail = await paymentService.getOrderPaymentDetail(req.params.orderId);
  return ApiResponse.success(res, detail);
});

exports.downloadCompanyPortalWalletReceipt = asyncHandler(async (req, res) => {
  const pdfBuffer = await paymentService.generateCompanyPortalWalletReceiptPdf(
    req.params.orderId
  );

  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="wallet-payment-receipt-${req.params.orderId}.pdf"`,
    "Content-Length": pdfBuffer.length,
  });
  return res.send(pdfBuffer);
});
