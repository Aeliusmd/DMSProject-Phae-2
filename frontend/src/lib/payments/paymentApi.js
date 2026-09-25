import { PAYMENT_TYPE_LABELS } from "./paymentMockData";
import { request, authFetch } from "@/lib/auth/authApi";
import { STAFF_PORTAL_ORDERS_HIDDEN } from "@/lib/portalNavigationVisibility";

function formatMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "$0.00";

  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function parseDateValue(value) {
  if (!value) return null;
  const datePart = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
  const [year, month, day] = datePart.split("-").map(Number);
  const parsed = new Date(year, month - 1, day);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getPaymentDate(payment, channel) {
  const raw =
    channel === "manual" ? payment.paymentDate : payment.transactionDate;
  return parseDateValue(raw);
}

function filterPaymentsByDate(payments, channel, dateFrom, dateTo) {
  const from = parseDateValue(dateFrom);
  const to = parseDateValue(dateTo);

  if (!from && !to) return payments;

  return payments.filter((payment) => {
    const paymentDate = getPaymentDate(payment, channel);
    if (!paymentDate) return false;
    if (from && paymentDate < from) return false;
    if (to && paymentDate > to) return false;
    return true;
  });
}

function computeOrderTotals(order) {
  const invoiced = order.invoices.reduce(
    (sum, invoice) => sum + Number(invoice.amount || 0),
    0
  );
  const paid = order.invoices.reduce(
    (sum, invoice) => sum + Number(invoice.paid || 0),
    0
  );
  const due = order.invoices.reduce(
    (sum, invoice) => sum + Number(invoice.due || 0),
    0
  );

  return {
    invoiced,
    paid,
    due,
    invoicedDisplay: formatMoney(invoiced),
    paidDisplay: formatMoney(paid),
    dueDisplay: formatMoney(due),
  };
}

function enrichOrder(order) {
  const totals = computeOrderTotals(order);

  return {
    ...order,
    totals,
    invoices: order.invoices.map((invoice) => ({
      ...invoice,
      typeLabel: PAYMENT_TYPE_LABELS[invoice.type] || invoice.type,
      amountDisplay: formatMoney(invoice.amount),
      paidDisplay: formatMoney(invoice.paid),
      dueDisplay: formatMoney(invoice.due),
    })),
    manualPayments: order.manualPayments.map((payment) => ({
      ...payment,
      typeLabel: PAYMENT_TYPE_LABELS[payment.paymentType] || payment.paymentType,
      amountDisplay: formatMoney(payment.amount),
    })),
    onlinePayments: order.onlinePayments.map((payment) => ({
      ...payment,
      typeLabel: PAYMENT_TYPE_LABELS[payment.paymentType] || payment.paymentType,
      amountDisplay: formatMoney(payment.amount),
      processingFeeDisplay: formatMoney(payment.processingFee),
      netAmountDisplay: formatMoney(payment.netAmount),
    })),
  };
}

function buildPaymentListRow(order, payment, channel) {
  const matchedInvoice = (order.invoices || []).find(
    (invoice) =>
      String(invoice.invoiceNo || "").toLowerCase() ===
      String(payment.invoiceNo || "").toLowerCase()
  );

  return {
    id: payment.id,
    orderId: order.orderId,
    orderNo: order.orderNo,
    company: order.company,
    applicant: order.applicant,
    caseNo: order.caseNo,
    invoiceNo: payment.invoiceNo || matchedInvoice?.invoiceNo || "",
    invoiceId: matchedInvoice?.id || "",
    paymentType: payment.paymentType,
    paymentTypeLabel:
      PAYMENT_TYPE_LABELS[payment.paymentType] || payment.paymentType,
    amount: payment.amount,
    amountDisplay: formatMoney(payment.amount),
    paymentDate:
      channel === "manual" ? payment.paymentDate : payment.transactionDate,
    status: payment.status,
    method: channel === "manual" ? payment.method : payment.paymentMethod,
    channel,
  };
}

function filterPaymentsByOrderId(rows, orderIdQuery) {
  if (!orderIdQuery?.trim()) return rows;

  const query = orderIdQuery.trim().toLowerCase();

  return rows.filter(
    (row) =>
      String(row.orderNo || "")
        .toLowerCase()
        .includes(query) ||
      String(row.orderId || "")
        .toLowerCase()
        .includes(query)
  );
}

function filterPaymentsByInvoiceId(rows, invoiceQuery) {
  if (!invoiceQuery?.trim()) return rows;

  const query = invoiceQuery.trim().toLowerCase();

  return rows.filter(
    (row) =>
      String(row.invoiceNo || "")
        .toLowerCase()
        .includes(query) ||
      String(row.invoiceId || "")
        .toLowerCase()
        .includes(query)
  );
}

function buildManualSummary(rows) {
  const totalAmount = rows.reduce(
    (sum, row) => sum + Number(row.amount || 0),
    0
  );

  return {
    totalPayments: rows.length,
    totalAmount: formatMoney(totalAmount),
    checkCount: rows.filter((row) => row.method === "Check").length,
    wireCount: rows.filter((row) => row.method === "Wire Transfer").length,
    pendingCount: rows.filter((row) => row.status === "Pending Review").length,
  };
}

function buildOnlineSummary(rows) {
  const succeeded = rows.filter((row) => row.status === "Succeeded");
  const totalCollected = succeeded.reduce(
    (sum, row) => sum + Number(row.amount || 0),
    0
  );

  return {
    totalTransactions: rows.length,
    totalCollected: formatMoney(totalCollected),
    succeededCount: succeeded.length,
    pendingCount: rows.filter((row) => row.status === "Pending").length,
    failedCount: rows.filter((row) => row.status === "Failed").length,
  };
}

/**
 * List payment rows for manual or online tab (keyset, 10/page).
 */
export async function getPayments({
  type = "manual",
  dateFrom,
  dateTo,
  orderSearch,
  invoiceSearch,
  cursor = null,
  pageSize = 10,
  pagination = "keyset",
  includeSummary = true,
  signal,
} = {}) {
  const channel = type === "online" ? "online" : "manual";
  const params = new URLSearchParams();

  params.set("pagination", pagination || "keyset");
  params.set("pageSize", String(pageSize || 10));
  params.set("includeSummary", includeSummary ? "1" : "0");
  if (cursor) params.set("cursor", String(cursor));
  if (dateFrom) params.set("dateFrom", dateFrom);
  if (dateTo) params.set("dateTo", dateTo);
  if (orderSearch?.trim()) params.set("orderSearch", orderSearch.trim());
  if (invoiceSearch?.trim()) params.set("invoiceSearch", invoiceSearch.trim());
  if (STAFF_PORTAL_ORDERS_HIDDEN) params.set("excludePortalOrders", "1");

  const path =
    channel === "manual"
      ? `/payments/manual?${params.toString()}`
      : `/payments/online?${params.toString()}`;

  const data = await request(path, {
    auth: true,
    cache: "no-store",
    signal,
  });

  const rows = data?.data?.payments || [];
  const paginationMeta = data?.data?.pagination || {
    type: "keyset",
    pageSize: pageSize || 10,
    hasMore: false,
    nextCursor: null,
  };
  const summary = data?.data?.summary ?? null;

  return {
    payments: rows,
    summary,
    pagination: paginationMeta,
    count:
      summary != null
        ? Number(summary.totalPayments ?? summary.totalTransactions ?? rows.length) || 0
        : null,
  };
}

export async function searchOrderInvoices(orderId) {
  const params = new URLSearchParams();
  params.set("orderId", String(orderId).trim());

  const data = await request(
    `/payments/orders/invoices/search?${params.toString()}`,
    {
      auth: true,
      cache: "no-store",
    }
  );

  return data?.data || { order: null, invoices: [] };
}

export async function acquireOrderManualPaymentLock(orderId) {
  const data = await request(`/payments/orders/${orderId}/edit-lock`, {
    method: "POST",
    auth: true,
  });
  return data?.data?.lock || null;
}

export async function heartbeatOrderManualPaymentLock(orderId) {
  const data = await request(`/payments/orders/${orderId}/edit-lock/heartbeat`, {
    method: "POST",
    auth: true,
  });
  return data?.data?.lock || null;
}

export async function releaseOrderManualPaymentLock(orderId) {
  try {
    await authFetch(`/payments/orders/${orderId}/edit-lock`, {
      method: "DELETE",
      keepalive: true,
    });
  } catch {
    // Leaving the payment form should not fail if release cannot complete.
  }
}

export async function recordManualPayment(payload = {}) {
  const data = await request("/payments/manual", {
    method: "POST",
    auth: true,
    body: payload,
  });

  return data?.data || { order: null, invoices: [] };
}

function mapDetailManualPayment(payment) {
  return {
    ...payment,
    typeLabel: payment.paymentTypeLabel || PAYMENT_TYPE_LABELS[payment.paymentType] || payment.paymentType,
    amountDisplay: payment.amountDisplay || formatMoney(payment.amount),
    referenceNo: payment.referenceNo || payment.paymentCheckNumber || "",
    notes: payment.notes || "",
  };
}

/**
 * Full order payment detail for the detail page.
 */
export async function getOrderPaymentDetail(orderId, { channel } = {}) {
  const activeChannel = channel === "online" ? "online" : "manual";

  const data = await request(`/payments/orders/${orderId}/detail`, {
    auth: true,
    cache: "no-store",
  });

  const detail = data?.data;
  if (!detail) return null;

  const manualPayments = (detail.manualPayments || []).map(mapDetailManualPayment);
  const onlinePayments = (detail.onlinePayments || []).map((payment) => ({
    ...payment,
    typeLabel:
      payment.paymentTypeLabel ||
      PAYMENT_TYPE_LABELS[payment.paymentType] ||
      payment.paymentType,
    amountDisplay: payment.amountDisplay || formatMoney(payment.amount),
    processingFeeDisplay:
      payment.processingFeeDisplay || formatMoney(payment.processingFee),
    netAmountDisplay:
      payment.netAmountDisplay || formatMoney(payment.netAmount),
  }));

  return {
    ...detail,
    activeChannel,
    channelPayments: activeChannel === "online" ? onlinePayments : manualPayments,
    manualPayments,
    onlinePayments,
  };
}

export async function fetchCompanyPortalWalletReceiptBlob(orderId) {
  const response = await authFetch(
    `/payments/orders/${orderId}/company-portal-wallet-receipt`,
    { method: "GET" }
  );

  if (!response.ok) {
    throw new Error("Unable to download wallet payment receipt");
  }

  return response.blob();
}

export { formatMoney, PAYMENT_TYPE_LABELS, buildManualSummary, buildOnlineSummary, filterPaymentsByOrderId, filterPaymentsByInvoiceId };
