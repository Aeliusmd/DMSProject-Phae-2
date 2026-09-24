const ApiError = require("../utils/ApiError");
const { getPool } = require("../config/database");
const { rethrowServiceError } = require("../utils/serviceErrorUtils");
const Order = require("../models/Order");
const OrderNoteEditLock = require("../models/OrderNoteEditLock");

const LOCK_TTL_MS = 2 * 60 * 1000;
const LOCKED_MESSAGE =
  "Another user is editing this note. Please come again later.";

function toOrderId(orderId) {
  const id = Number(orderId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new ApiError(400, "Invalid order id");
  }
  return id;
}

function toNoteId(noteId) {
  const id = Number(noteId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new ApiError(400, "Invalid note id");
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

async function loadNoteForOrder(orderId, noteId) {
  const order = await Order.findByIdRaw(orderId);
  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  const note = await Order.findNoteById(noteId);
  if (!note || String(note.order_id) !== String(orderId)) {
    throw new ApiError(404, "Note not found");
  }

  return note;
}

async function acquireOrderNoteEditLock(orderId, noteId, employeeId) {
  const id = toOrderId(orderId);
  const noteKey = toNoteId(noteId);
  const actorId = toEmployeeId(employeeId);

  await loadNoteForOrder(id, noteKey);

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const existing = await OrderNoteEditLock.findByNoteId(connection, noteKey);
    if (existing && isActiveLock(existing) && !isHeldBy(existing, actorId)) {
      throw new ApiError(409, LOCKED_MESSAGE);
    }

    await OrderNoteEditLock.upsert(connection, {
      noteId: noteKey,
      orderId: id,
      employeeId: actorId,
      expiresAt: nextExpiry(),
    });

    const held = await OrderNoteEditLock.findByNoteId(connection, noteKey);
    if (held && isActiveLock(held) && !isHeldBy(held, actorId)) {
      throw new ApiError(409, LOCKED_MESSAGE);
    }

    await connection.commit();
    return { orderId: id, noteId: noteKey, employeeId: actorId };
  } catch (error) {
    await connection.rollback();
    rethrowServiceError(error);
  } finally {
    connection.release();
  }
}

async function heartbeatOrderNoteEditLock(orderId, noteId, employeeId) {
  const id = toOrderId(orderId);
  const noteKey = toNoteId(noteId);
  const actorId = toEmployeeId(employeeId);

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const existing = await OrderNoteEditLock.findByNoteId(connection, noteKey);
    if (existing && isActiveLock(existing) && !isHeldBy(existing, actorId)) {
      throw new ApiError(409, LOCKED_MESSAGE);
    }

    await OrderNoteEditLock.upsert(connection, {
      noteId: noteKey,
      orderId: id,
      employeeId: actorId,
      expiresAt: nextExpiry(),
    });

    const held = await OrderNoteEditLock.findByNoteId(connection, noteKey);
    if (held && isActiveLock(held) && !isHeldBy(held, actorId)) {
      throw new ApiError(409, LOCKED_MESSAGE);
    }

    await connection.commit();
    return { orderId: id, noteId: noteKey, employeeId: actorId };
  } catch (error) {
    await connection.rollback();
    rethrowServiceError(error);
  } finally {
    connection.release();
  }
}

async function releaseOrderNoteEditLock(orderId, noteId, employeeId) {
  toOrderId(orderId);
  const noteKey = toNoteId(noteId);
  const actorId = toEmployeeId(employeeId);
  await OrderNoteEditLock.deleteByHolder(noteKey, actorId);
  return { released: true };
}

async function assertNotLockedByOther(orderId, noteId, employeeId) {
  const id = toOrderId(orderId);
  const noteKey = toNoteId(noteId);
  const actorId = toEmployeeId(employeeId);
  const existing = await OrderNoteEditLock.findActiveByNoteId(noteKey);

  if (existing && Number(existing.order_id) !== id) {
    throw new ApiError(404, "Note not found");
  }

  if (existing && !isHeldBy(existing, actorId)) {
    throw new ApiError(409, LOCKED_MESSAGE);
  }
}

module.exports = {
  LOCKED_MESSAGE,
  acquireOrderNoteEditLock,
  heartbeatOrderNoteEditLock,
  releaseOrderNoteEditLock,
  assertNotLockedByOther,
};
