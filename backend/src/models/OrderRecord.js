/**
 * Scanned records for an order (order_records table).
 * Multiple rows per (order_id, record_type) are allowed — one PDF per row, no merging.
 * A row with NULL storage_path means the type is requested but no file is uploaded yet.
 */

const fs = require("fs");
const { getPool } = require("../config/database");
const fileStorage = require("../utils/fileStorage");

const RECORD_COLUMNS = `id, order_id, record_type, storage_path, original_file_name,
              page_count, uploaded_by, uploaded_at, created_at, updated_at`;

function resolveStorageAbsolutePath(storagePath) {
  return fileStorage.resolveStoredAbsolutePath(storagePath);
}

function deleteStoredFile(storagePath) {
  if (!storagePath) return;

  const absolutePath = resolveStorageAbsolutePath(storagePath);
  if (absolutePath && fs.existsSync(absolutePath)) {
    fs.unlinkSync(absolutePath);
  }
}

class OrderRecord {
  static async findByOrderId(orderId, connection = null) {
    const db = connection || getPool();

    const [rows] = await db.execute(
      `SELECT ${RECORD_COLUMNS}
       FROM order_records
       WHERE order_id = :orderId
       ORDER BY FIELD(record_type, 'medical', 'billing', 'employment', 'xrays', 'other'),
                id ASC`,
      { orderId }
    );

    return rows;
  }

  static async findByOrderIds(orderIds = [], connection = null) {
    if (!orderIds.length) return [];

    const db = connection || getPool();
    const placeholders = orderIds.map((_, index) => `:id${index}`).join(", ");
    const params = orderIds.reduce((acc, id, index) => {
      acc[`id${index}`] = id;
      return acc;
    }, {});

    const [rows] = await db.execute(
      `SELECT ${RECORD_COLUMNS}
       FROM order_records
       WHERE order_id IN (${placeholders})
       ORDER BY order_id,
                FIELD(record_type, 'medical', 'billing', 'employment', 'xrays', 'other'),
                id ASC`,
      params
    );

    return rows;
  }

  static async findById(recordId, connection = null) {
    const db = connection || getPool();
    const [rows] = await db.execute(
      `SELECT ${RECORD_COLUMNS}
       FROM order_records
       WHERE id = :recordId
       LIMIT 1`,
      { recordId }
    );
    return rows[0] || null;
  }

  static async findByOrderAndType(orderId, recordType, connection = null) {
    const rows = await OrderRecord.findByOrderAndTypeAll(
      orderId,
      recordType,
      connection
    );
    return rows.find((row) => row.storage_path) || rows[0] || null;
  }

  static async findByOrderAndTypeAll(orderId, recordType, connection = null) {
    const db = connection || getPool();

    const [rows] = await db.execute(
      `SELECT ${RECORD_COLUMNS}
       FROM order_records
       WHERE order_id = :orderId AND record_type = :recordType
       ORDER BY id ASC`,
      { orderId, recordType }
    );

    return rows;
  }

  static async syncForOrder(connection, orderId, recordTypes = []) {
    const normalized = [...new Set(recordTypes.filter(Boolean))];
    const existing = await OrderRecord.findByOrderId(orderId, connection);

    const removed = existing.filter(
      (record) => !normalized.includes(record.record_type)
    );

    for (const record of removed) {
      deleteStoredFile(record.storage_path);
    }

    if (!normalized.length) {
      await connection.execute(
        `DELETE FROM order_records WHERE order_id = :orderId`,
        { orderId }
      );
      return;
    }

    const placeholders = normalized.map((_, index) => `:type${index}`).join(", ");
    const params = normalized.reduce((acc, type, index) => {
      acc[`type${index}`] = type;
      return acc;
    }, { orderId });

    await connection.execute(
      `DELETE FROM order_records
       WHERE order_id = :orderId
         AND record_type NOT IN (${placeholders})`,
      params
    );

    const remaining = await OrderRecord.findByOrderId(orderId, connection);
    const existingTypes = new Set(remaining.map((row) => row.record_type));

    for (const recordType of normalized) {
      if (existingTypes.has(recordType)) continue;

      await connection.execute(
        `INSERT INTO order_records (order_id, record_type, created_at, updated_at)
         VALUES (:orderId, :recordType, NOW(), NOW())`,
        { orderId, recordType }
      );
    }
  }

  static async insertScan(
    connection,
    { orderId, recordType, storagePath, originalFileName, pageCount, uploadedBy }
  ) {
    const existing = await OrderRecord.findByOrderAndTypeAll(
      orderId,
      recordType,
      connection
    );
    const placeholder = existing.find((row) => !row.storage_path);

    if (placeholder) {
      await connection.execute(
        `UPDATE order_records
         SET storage_path = :storagePath,
             original_file_name = :originalFileName,
             page_count = :pageCount,
             uploaded_by = :uploadedBy,
             uploaded_at = NOW(),
             updated_at = NOW()
         WHERE id = :id`,
        {
          id: placeholder.id,
          storagePath,
          originalFileName: originalFileName || null,
          pageCount: pageCount ?? null,
          uploadedBy: uploadedBy || null,
        }
      );
      return;
    }

    await connection.execute(
      `INSERT INTO order_records (
         order_id, record_type, storage_path, original_file_name, page_count,
         uploaded_by, uploaded_at, created_at, updated_at
       ) VALUES (
         :orderId, :recordType, :storagePath, :originalFileName, :pageCount,
         :uploadedBy, NOW(), NOW(), NOW()
       )`,
      {
        orderId,
        recordType,
        storagePath,
        originalFileName: originalFileName || null,
        pageCount: pageCount ?? null,
        uploadedBy: uploadedBy || null,
      }
    );
  }

  static async clearScan(connection, orderId, recordType) {
    const existing = await OrderRecord.findByOrderAndTypeAll(
      orderId,
      recordType,
      connection
    );

    for (const row of existing) {
      deleteStoredFile(row.storage_path);
    }

    await connection.execute(
      `DELETE FROM order_records
       WHERE order_id = :orderId AND record_type = :recordType`,
      { orderId, recordType }
    );

    await connection.execute(
      `INSERT INTO order_records (order_id, record_type, created_at, updated_at)
       VALUES (:orderId, :recordType, NOW(), NOW())`,
      { orderId, recordType }
    );

    return existing;
  }
}

module.exports = OrderRecord;
