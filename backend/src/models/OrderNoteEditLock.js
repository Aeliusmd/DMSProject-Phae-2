const { getPool } = require("../config/database");

class OrderNoteEditLock {
  static async findByNoteId(connection, noteId) {
    const db = connection || getPool();
    const [rows] = await db.execute(
      `SELECT note_id, order_id, employee_id, locked_at, expires_at,
              (expires_at > UTC_TIMESTAMP()) AS is_active
       FROM order_note_edit_locks
       WHERE note_id = :noteId
       LIMIT 1
       FOR UPDATE`,
      { noteId }
    );
    return rows[0] || null;
  }

  static async upsert(connection, { noteId, orderId, employeeId, expiresAt }) {
    const db = connection || getPool();
    await db.execute(
      `INSERT INTO order_note_edit_locks
         (note_id, order_id, employee_id, locked_at, expires_at)
       VALUES
         (:noteId, :orderId, :employeeId, UTC_TIMESTAMP(), :expiresAt)
       ON DUPLICATE KEY UPDATE
         order_id = IF(expires_at <= UTC_TIMESTAMP() OR employee_id = :employeeId, :orderId, order_id),
         employee_id = IF(expires_at <= UTC_TIMESTAMP() OR employee_id = :employeeId, :employeeId, employee_id),
         locked_at = IF(expires_at <= UTC_TIMESTAMP() OR employee_id = :employeeId, UTC_TIMESTAMP(), locked_at),
         expires_at = IF(expires_at <= UTC_TIMESTAMP() OR employee_id = :employeeId, :expiresAt, expires_at)`,
      { noteId, orderId, employeeId, expiresAt }
    );
  }

  static async findActiveByNoteId(noteId) {
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT note_id, order_id, employee_id, locked_at, expires_at
       FROM order_note_edit_locks
       WHERE note_id = :noteId
         AND expires_at > UTC_TIMESTAMP()
       LIMIT 1`,
      { noteId }
    );
    return rows[0] || null;
  }

  static async deleteByHolder(noteId, employeeId) {
    const pool = getPool();
    await pool.execute(
      `DELETE FROM order_note_edit_locks
       WHERE note_id = :noteId
         AND employee_id = :employeeId`,
      { noteId, employeeId }
    );
  }
}

module.exports = OrderNoteEditLock;
