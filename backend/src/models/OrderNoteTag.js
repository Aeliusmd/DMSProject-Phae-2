const { getPool } = require("../config/database");

class OrderNoteTag {
  static async createMany(tags = []) {
    if (!Array.isArray(tags) || tags.length === 0) {
      return 0;
    }

    const pool = getPool();
    let inserted = 0;

    for (const tag of tags) {
      const noteId = Number(tag.noteId);
      const taggedEmployeeId = Number(tag.taggedEmployeeId);
      if (!Number.isFinite(noteId) || noteId <= 0) continue;
      if (!Number.isFinite(taggedEmployeeId) || taggedEmployeeId <= 0) continue;

      const [result] = await pool.execute(
        `INSERT IGNORE INTO order_note_tags
          (note_id, tagged_employee_id, tagged_by, is_read, created_at)
         VALUES
          (:noteId, :taggedEmployeeId, :taggedBy, 0, NOW())`,
        {
          noteId,
          taggedEmployeeId,
          taggedBy: tag.taggedBy || null,
        }
      );
      inserted += Number(result.affectedRows || 0);
    }

    return inserted;
  }

  static async countUnreadForEmployee(employeeId) {
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT COUNT(*) AS unread_count
       FROM order_note_tags
       WHERE tagged_employee_id = :employeeId
         AND is_read = 0`,
      { employeeId }
    );
    return Number(rows[0]?.unread_count || 0);
  }

  static async findInboxForEmployee(employeeId, { limit = 50, offset = 0 } = {}) {
    const pool = getPool();
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const safeOffset = Math.max(Number(offset) || 0, 0);

    const [rows] = await pool.execute(
      `SELECT t.id AS tag_id,
              t.note_id,
              t.tagged_employee_id,
              t.tagged_by,
              t.is_read,
              t.read_at,
              t.created_at AS tagged_at,
              n.note,
              n.note_date,
              n.author_name,
              n.created_by AS note_created_by,
              n.attachment_path,
              o.id AS order_id,
              o.order_number,
              o.case_number,
              o.applicant_first_name,
              o.applicant_middle_name,
              o.applicant_last_name,
              sender.name AS tagged_by_name
       FROM order_note_tags t
       INNER JOIN order_notes n ON n.id = t.note_id
       INNER JOIN orders o ON o.id = n.order_id
       LEFT JOIN matrix_employees sender ON sender.id = t.tagged_by
       WHERE t.tagged_employee_id = :employeeId
       ORDER BY t.is_read ASC, t.created_at DESC, t.id DESC
       LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      { employeeId }
    );

    return rows;
  }

  static async markAsRead(tagId, employeeId) {
    const pool = getPool();
    const [result] = await pool.execute(
      `UPDATE order_note_tags
       SET is_read = 1,
           read_at = COALESCE(read_at, NOW())
       WHERE id = :tagId
         AND tagged_employee_id = :employeeId
         AND is_read = 0`,
      { tagId, employeeId }
    );
    return Number(result.affectedRows || 0) > 0;
  }

  static async markAllAsRead(employeeId) {
    const pool = getPool();
    const [result] = await pool.execute(
      `UPDATE order_note_tags
       SET is_read = 1,
           read_at = COALESCE(read_at, NOW())
       WHERE tagged_employee_id = :employeeId
         AND is_read = 0`,
      { employeeId }
    );
    return Number(result.affectedRows || 0);
  }

  static async findByNoteId(noteId) {
    const pool = getPool();
    const [rows] = await pool.execute(
      `SELECT t.id, t.note_id, t.tagged_employee_id, t.tagged_by, t.is_read,
              t.read_at, t.created_at, e.name AS tagged_employee_name, e.role
       FROM order_note_tags t
       LEFT JOIN matrix_employees e ON e.id = t.tagged_employee_id
       WHERE t.note_id = :noteId
       ORDER BY e.name ASC, t.id ASC`,
      { noteId }
    );
    return rows;
  }
}

module.exports = OrderNoteTag;
