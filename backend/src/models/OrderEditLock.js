const { getPool } = require("../config/database");

class OrderEditLock {
  static async findByOrderId(connection, orderId) {
    const db = connection || getPool();
    const [rows] = await db.execute(
      `SELECT order_id, employee_id, locked_at, expires_at
       FROM order_edit_locks
       WHERE order_id = :orderId
       LIMIT 1
       FOR UPDATE`,
      { orderId }
    );
    return rows[0] || null;
  }

  static async upsert(connection, { orderId, employeeId, expiresAt }) {
    const db = connection || getPool();
    await db.execute(
      `INSERT INTO order_edit_locks
         (order_id, employee_id, locked_at, expires_at)
       VALUES
         (:orderId, :employeeId, UTC_TIMESTAMP(), :expiresAt)
       ON DUPLICATE KEY UPDATE
         employee_id = :employeeId,
         locked_at = UTC_TIMESTAMP(),
         expires_at = :expiresAt`,
      { orderId, employeeId, expiresAt }
    );
  }

  static async findActiveByOrderId(orderId) {
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT order_id, employee_id, locked_at, expires_at
       FROM order_edit_locks
       WHERE order_id = :orderId
         AND expires_at > UTC_TIMESTAMP()
       LIMIT 1`,
      { orderId }
    );
    return rows[0] || null;
  }

  static async deleteByHolder(orderId, employeeId) {
    const pool = getPool();
    await pool.execute(
      `DELETE FROM order_edit_locks
       WHERE order_id = :orderId
         AND employee_id = :employeeId`,
      { orderId, employeeId }
    );
  }
}

module.exports = OrderEditLock;
