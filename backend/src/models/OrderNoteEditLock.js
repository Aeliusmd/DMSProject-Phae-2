const { getPool } = require("../config/database");

class OrderNoteEditLock {
  static async findByNoteId(connection, noteId) {
    const db = connection || getPool();
    const [rows] = await db.execute(
      `SELECT note_id, order_id, employee_id, locked_at, expires_at
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
         order_id = :orderId,
         employee_id = :employeeId,
         locked_at = UTC_TIMESTAMP(),
         expires_at = :expiresAt`,
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
