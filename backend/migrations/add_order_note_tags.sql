-- Order note worker tags (additive; does not alter order_notes columns).
-- Safe to run once.

USE dms_db;

CREATE TABLE IF NOT EXISTS order_note_tags (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  note_id BIGINT UNSIGNED NOT NULL,
  tagged_employee_id BIGINT UNSIGNED NOT NULL,
  tagged_by BIGINT UNSIGNED NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  read_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_order_note_tags_note_employee (note_id, tagged_employee_id),
  KEY idx_order_note_tags_employee_unread (tagged_employee_id, is_read, created_at),
  CONSTRAINT fk_order_note_tags_note
    FOREIGN KEY (note_id) REFERENCES order_notes (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_order_note_tags_employee
    FOREIGN KEY (tagged_employee_id) REFERENCES matrix_employees (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_order_note_tags_tagged_by
    FOREIGN KEY (tagged_by) REFERENCES matrix_employees (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
