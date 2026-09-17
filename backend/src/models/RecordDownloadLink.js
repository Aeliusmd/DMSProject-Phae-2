const { getPool } = require("../config/database");

class RecordDownloadLink {
  static async create({ orderId, token, expiresAt }, connection = null) {
    const db = connection || getPool();

    const [result] = await db.execute(
      `INSERT INTO order_record_download_links (order_id, token, expires_at, created_at)
       VALUES (:orderId, :token, :expiresAt, NOW())`,
      { orderId, token, expiresAt }
    );

    return result.insertId;
  }

  static async findByToken(token, connection = null) {
    const db = connection || getPool();

    const [rows] = await db.execute(
      `SELECT id, order_id, token, expires_at, first_downloaded_at,
              download_count, created_at
       FROM order_record_download_links
       WHERE token = :token
       LIMIT 1`,
      { token }
    );

    return rows[0] || null;
  }

  static async findLatestByOrderId(orderId, connection = null) {
    const db = connection || getPool();
    const normalizedId = Number(orderId);
    if (!Number.isFinite(normalizedId) || normalizedId <= 0) {
      return null;
    }

    const [rows] = await db.execute(
      `SELECT id, order_id, token, expires_at, first_downloaded_at,
              download_count, created_at
       FROM order_record_download_links
       WHERE order_id = :orderId
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      { orderId: normalizedId }
    );

    return rows[0] || null;
  }

  static async markDownloaded(linkId, connection = null) {
    const db = connection || getPool();
    const id = Number(linkId);
    if (!Number.isFinite(id) || id <= 0) return false;

    const [result] = await db.execute(
      `UPDATE order_record_download_links
       SET first_downloaded_at = COALESCE(first_downloaded_at, NOW()),
           download_count = download_count + 1
       WHERE id = :id`,
      { id }
    );

    return Number(result.affectedRows || 0) > 0;
  }
}

module.exports = RecordDownloadLink;
