const ApiError = require("../utils/ApiError");
const { getPool } = require("../config/database");
const { rethrowServiceError } = require("../utils/serviceErrorUtils");
const Facility = require("../models/Facility");
const FacilityEditLock = require("../models/FacilityEditLock");

const LOCK_TTL_MS = 2 * 60 * 1000;
const LOCKED_MESSAGE =
  "Another user is editing this facility. Please come again later.";

function toFacilityId(facilityId) {
  const id = Number(facilityId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new ApiError(400, "Invalid facility id");
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

async function acquireFacilityEditLock(facilityId, employeeId) {
  const id = toFacilityId(facilityId);
  const actorId = toEmployeeId(employeeId);

  const facility = await Facility.findById(id);
  if (!facility) {
    throw new ApiError(404, "Facility not found");
  }

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const existing = await FacilityEditLock.findByFacilityId(connection, id);
    if (existing && isActiveLock(existing) && !isHeldBy(existing, actorId)) {
      throw new ApiError(409, LOCKED_MESSAGE);
    }

    await FacilityEditLock.upsert(connection, {
      facilityId: id,
      employeeId: actorId,
      expiresAt: nextExpiry(),
    });

    await connection.commit();
    return { facilityId: id, employeeId: actorId };
  } catch (error) {
    await connection.rollback();
    rethrowServiceError(error);
  } finally {
    connection.release();
  }
}

async function heartbeatFacilityEditLock(facilityId, employeeId) {
  const id = toFacilityId(facilityId);
  const actorId = toEmployeeId(employeeId);

  const pool = getPool();
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const existing = await FacilityEditLock.findByFacilityId(connection, id);
    if (existing && isActiveLock(existing) && !isHeldBy(existing, actorId)) {
      throw new ApiError(409, LOCKED_MESSAGE);
    }

    await FacilityEditLock.upsert(connection, {
      facilityId: id,
      employeeId: actorId,
      expiresAt: nextExpiry(),
    });

    await connection.commit();
    return { facilityId: id, employeeId: actorId };
  } catch (error) {
    await connection.rollback();
    rethrowServiceError(error);
  } finally {
    connection.release();
  }
}

async function releaseFacilityEditLock(facilityId, employeeId) {
  const id = toFacilityId(facilityId);
  const actorId = toEmployeeId(employeeId);
  await FacilityEditLock.deleteByHolder(id, actorId);
  return { released: true };
}

async function assertNotLockedByOther(facilityId, employeeId) {
  const id = toFacilityId(facilityId);
  const actorId = toEmployeeId(employeeId);
  const existing = await FacilityEditLock.findActiveByFacilityId(id);

  if (existing && !isHeldBy(existing, actorId)) {
    throw new ApiError(409, LOCKED_MESSAGE);
  }
}

module.exports = {
  LOCKED_MESSAGE,
  acquireFacilityEditLock,
  heartbeatFacilityEditLock,
  releaseFacilityEditLock,
  assertNotLockedByOther,
};
