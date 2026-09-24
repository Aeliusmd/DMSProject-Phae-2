const { getPool } = require("../config/database");

class OrderInvoiceEditLock {
  static async findByOrderAndKind(connection, orderId, invoiceKind) {
    const db = connection || getPool();
    const [rows] = await db.execute(
      `SELECT order_id, invoice_kind, employee_id, locked_at, expires_at,
              (expires_at > UTC_TIMESTAMP()) AS is_active
       FROM order_invoice_edit_locks
       WHERE order_id = :orderId
         AND invoice_kind = :invoiceKind
       LIMIT 1
       FOR UPDATE`,
      { orderId, invoiceKind }
    );
    return rows[0] || null;
  }

  static async upsert(
    connection,
    { orderId, invoiceKind, employeeId, expiresAt }
  ) {
    const db = connection || getPool();
    await db.execute(
      `INSERT INTO order_invoice_edit_locks
         (order_id, invoice_kind, employee_id, locked_at, expires_at)
       VALUES
         (:orderId, :invoiceKind, :employeeId, UTC_TIMESTAMP(), :expiresAt)
       ON DUPLICATE KEY UPDATE
         employee_id = IF(expires_at <= UTC_TIMESTAMP() OR employee_id = :employeeId, :employeeId, employee_id),
         locked_at = IF(expires_at <= UTC_TIMESTAMP() OR employee_id = :employeeId, UTC_TIMESTAMP(), locked_at),
         expires_at = IF(expires_at <= UTC_TIMESTAMP() OR employee_id = :employeeId, :expiresAt, expires_at)`,
      { orderId, invoiceKind, employeeId, expiresAt }
    );
  }

  static async findActiveByOrderAndKind(orderId, invoiceKind) {
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT order_id, invoice_kind, employee_id, locked_at, expires_at
       FROM order_invoice_edit_locks
       WHERE order_id = :orderId
         AND invoice_kind = :invoiceKind
         AND expires_at > UTC_TIMESTAMP()
       LIMIT 1`,
      { orderId, invoiceKind }
    );
    return rows[0] || null;
  }

  static async deleteByHolder(orderId, invoiceKind, employeeId) {
    const pool = getPool();
    await pool.execute(
      `DELETE FROM order_invoice_edit_locks
       WHERE order_id = :orderId
         AND invoice_kind = :invoiceKind
         AND employee_id = :employeeId`,
      { orderId, invoiceKind, employeeId }
    );
  }
}

module.exports = OrderInvoiceEditLock;
