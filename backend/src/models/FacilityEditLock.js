const { getPool } = require("../config/database");

class FacilityEditLock {
  static async findByFacilityId(connection, facilityId) {
    const db = connection || getPool();
    const [rows] = await db.execute(
      `SELECT facility_id, employee_id, locked_at, expires_at
       FROM facility_edit_locks
       WHERE facility_id = :facilityId
       LIMIT 1
       FOR UPDATE`,
      { facilityId }
    );
    return rows[0] || null;
  }

  static async upsert(connection, { facilityId, employeeId, expiresAt }) {
    const db = connection || getPool();
    await db.execute(
      `INSERT INTO facility_edit_locks
         (facility_id, employee_id, locked_at, expires_at)
       VALUES
         (:facilityId, :employeeId, UTC_TIMESTAMP(), :expiresAt)
       ON DUPLICATE KEY UPDATE
         employee_id = :employeeId,
         locked_at = UTC_TIMESTAMP(),
         expires_at = :expiresAt`,
      { facilityId, employeeId, expiresAt }
    );
  }

  static async findActiveByFacilityId(facilityId) {
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT facility_id, employee_id, locked_at, expires_at
       FROM facility_edit_locks
       WHERE facility_id = :facilityId
         AND expires_at > UTC_TIMESTAMP()
       LIMIT 1`,
      { facilityId }
    );
    return rows[0] || null;
  }

  static async deleteByHolder(facilityId, employeeId) {
    const pool = getPool();
    await pool.execute(
      `DELETE FROM facility_edit_locks
       WHERE facility_id = :facilityId
         AND employee_id = :employeeId`,
      { facilityId, employeeId }
    );
  }
}

module.exports = FacilityEditLock;
