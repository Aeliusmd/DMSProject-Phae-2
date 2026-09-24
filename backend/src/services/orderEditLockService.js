const ApiError = require("../utils/ApiError");
const { getPool } = require("../config/database");
const { rethrowServiceError } = require("../utils/serviceErrorUtils");
const Order = require("../models/Order");
const OrderEditLock = require("../models/OrderEditLock");

const LOCK_TTL_MS = 2 * 60 * 1000;
const LOCKED_MESSAGE =
  "Another user is editing this order. Please come again later.";

function toOrderId(orderId) {
  const id = Number(orderId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new ApiError(400, "Invalid order id");
  }
  return id;
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
  if (!row?.expires_at) return false;
  return new Date(row.expires_at).getTime() > Date.now();
}

function isHeldBy(row, employeeId) {
  return Number(row?.employee_id) === Number(employeeId);
}

async function acquireOrderEditLock(orderId, employeeId) {
  const id = toOrderId(orderId);
  const actorId = toEmployeeId(employeeId);

  const order = await Order.findByIdRaw(id);
  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const existing = await OrderEditLock.findByOrderId(connection, id);
    if (existing && isActiveLock(existing) && !isHeldBy(existing, actorId)) {
      throw new ApiError(409, LOCKED_MESSAGE);
    }

    await OrderEditLock.upsert(connection, {
      orderId: id,
      employeeId: actorId,
      expiresAt: nextExpiry(),
    });

    await connection.commit();
    return { orderId: id, employeeId: actorId };
  } catch (error) {
    await connection.rollback();
    rethrowServiceError(error);
  } finally {
    connection.release();
  }
}

async function heartbeatOrderEditLock(orderId, employeeId) {
  const id = toOrderId(orderId);
  const actorId = toEmployeeId(employeeId);

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const existing = await OrderEditLock.findByOrderId(connection, id);
    if (existing && isActiveLock(existing) && !isHeldBy(existing, actorId)) {
      throw new ApiError(409, LOCKED_MESSAGE);
    }

    await OrderEditLock.upsert(connection, {
      orderId: id,
      employeeId: actorId,
      expiresAt: nextExpiry(),
    });

    await connection.commit();
    return { orderId: id, employeeId: actorId };
  } catch (error) {
    await connection.rollback();
    rethrowServiceError(error);
  } finally {
    connection.release();
  }
}

async function releaseOrderEditLock(orderId, employeeId) {
  const id = toOrderId(orderId);
  const actorId = toEmployeeId(employeeId);
  await OrderEditLock.deleteByHolder(id, actorId);
  return { released: true };
}

async function assertNotLockedByOther(orderId, employeeId) {
  const id = toOrderId(orderId);
  const actorId = toEmployeeId(employeeId);
  const existing = await OrderEditLock.findActiveByOrderId(id);

  if (existing && !isHeldBy(existing, actorId)) {
    throw new ApiError(409, LOCKED_MESSAGE);
  }
}

module.exports = {
  LOCKED_MESSAGE,
  acquireOrderEditLock,
  heartbeatOrderEditLock,
  releaseOrderEditLock,
  assertNotLockedByOther,
};
