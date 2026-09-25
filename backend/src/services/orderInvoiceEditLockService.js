const ApiError = require("../utils/ApiError");
const { getPool } = require("../config/database");
const { rethrowServiceError } = require("../utils/serviceErrorUtils");
const Order = require("../models/Order");
const OrderInvoiceEditLock = require("../models/OrderInvoiceEditLock");

const LOCK_TTL_MS = 2 * 60 * 1000;
const LOCKED_MESSAGE =
  "Another user is editing this invoice. Please come again later.";
const WRITEOFF_LOCKED_MESSAGE =
  "Another user is writing off this invoice. Please come again later.";
const MANUAL_PAYMENT_LOCKED_MESSAGE =
  "Another user is adding a payment to this order. Please come again later.";
const INVOICE_KINDS = new Set([
  "regular",
  "xray",
  "regular_writeoff",
  "xray_writeoff",
  "manual_payment",
]);

function lockMessage(invoiceKind) {
  const kind = String(invoiceKind || "");
  if (kind === "manual_payment") return MANUAL_PAYMENT_LOCKED_MESSAGE;
  if (kind.endsWith("_writeoff")) return WRITEOFF_LOCKED_MESSAGE;
  return LOCKED_MESSAGE;
}

function toOrderId(orderId) {
  const id = Number(orderId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new ApiError(400, "Invalid order id");
  }
  return id;
}

function toInvoiceKind(invoiceKind) {
  const kind = String(invoiceKind || "").trim().toLowerCase();
  if (!INVOICE_KINDS.has(kind)) {
    throw new ApiError(400, "Invalid invoice kind");
  }
  return kind;
}

function toEmployeeId(employeeId) {
  const id = Number(employeeId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new ApiError(401, "Your session expired. Please sign in again.");
  }
  return id;
}

function nextExpiry() {
  return new Date(Date.now() + LOCK_TTL_MS);
}

function isActiveLock(row) {
  if (!row) return false;
  if (row.is_active !== undefined && row.is_active !== null) {
    const flag = Buffer.isBuffer(row.is_active) ? row.is_active[0] : row.is_active;
    return Number(flag) === 1 || flag === true || flag === "1";
  }
  if (!row.expires_at) return false;
  const raw = row.expires_at;
  const expiresAt =
    raw instanceof Date
      ? raw.getTime()
      : Date.parse(`${String(raw).trim().replace(" ", "T")}Z`);
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function isHeldBy(row, employeeId) {
  return Number(row?.employee_id) === Number(employeeId);
}

async function ensureOrderExists(orderId) {
  const order = await Order.findByIdRaw(orderId);
  if (!order) {
    throw new ApiError(404, "Order not found");
  }
  return order;
}

async function acquireOrderInvoiceEditLock(orderId, invoiceKind, employeeId) {
  const id = toOrderId(orderId);
  const kind = toInvoiceKind(invoiceKind);
  const actorId = toEmployeeId(employeeId);

  await ensureOrderExists(id);

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const existing = await OrderInvoiceEditLock.findByOrderAndKind(
      connection,
      id,
      kind
    );
    if (existing && isActiveLock(existing) && !isHeldBy(existing, actorId)) {
      throw new ApiError(409, lockMessage(kind));
    }

    await OrderInvoiceEditLock.upsert(connection, {
      orderId: id,
      invoiceKind: kind,
      employeeId: actorId,
      expiresAt: nextExpiry(),
    });

    const held = await OrderInvoiceEditLock.findByOrderAndKind(
      connection,
      id,
      kind
    );
    if (held && isActiveLock(held) && !isHeldBy(held, actorId)) {
      throw new ApiError(409, lockMessage(kind));
    }

    await connection.commit();
    return { orderId: id, invoiceKind: kind, employeeId: actorId };
  } catch (error) {
    await connection.rollback();
    rethrowServiceError(error);
  } finally {
    connection.release();
  }
}

async function heartbeatOrderInvoiceEditLock(orderId, invoiceKind, employeeId) {
  const id = toOrderId(orderId);
  const kind = toInvoiceKind(invoiceKind);
  const actorId = toEmployeeId(employeeId);

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const existing = await OrderInvoiceEditLock.findByOrderAndKind(
      connection,
      id,
      kind
    );
    if (existing && isActiveLock(existing) && !isHeldBy(existing, actorId)) {
      throw new ApiError(409, lockMessage(kind));
    }

    await OrderInvoiceEditLock.upsert(connection, {
      orderId: id,
      invoiceKind: kind,
      employeeId: actorId,
      expiresAt: nextExpiry(),
    });

    const held = await OrderInvoiceEditLock.findByOrderAndKind(
      connection,
      id,
      kind
    );
    if (held && isActiveLock(held) && !isHeldBy(held, actorId)) {
      throw new ApiError(409, lockMessage(kind));
    }

    await connection.commit();
    return { orderId: id, invoiceKind: kind, employeeId: actorId };
  } catch (error) {
    await connection.rollback();
    rethrowServiceError(error);
  } finally {
    connection.release();
  }
}

async function releaseOrderInvoiceEditLock(orderId, invoiceKind, employeeId) {
  const id = toOrderId(orderId);
  const kind = toInvoiceKind(invoiceKind);
  const actorId = toEmployeeId(employeeId);
  await OrderInvoiceEditLock.deleteByHolder(id, kind, actorId);
  return { released: true };
}

async function assertNotLockedByOther(orderId, invoiceKind, employeeId) {
  const id = toOrderId(orderId);
  const kind = toInvoiceKind(invoiceKind);
  const actorId = toEmployeeId(employeeId);
  const existing = await OrderInvoiceEditLock.findActiveByOrderAndKind(
    id,
    kind
  );

  if (existing && !isHeldBy(existing, actorId)) {
    throw new ApiError(409, lockMessage(kind));
  }
}

module.exports = {
  LOCKED_MESSAGE,
  WRITEOFF_LOCKED_MESSAGE,
  MANUAL_PAYMENT_LOCKED_MESSAGE,
  acquireOrderInvoiceEditLock,
  heartbeatOrderInvoiceEditLock,
  releaseOrderInvoiceEditLock,
  assertNotLockedByOther,
};
