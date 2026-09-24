CREATE TABLE IF NOT EXISTS order_note_edit_locks (
  note_id BIGINT UNSIGNED NOT NULL,
  order_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  locked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  PRIMARY KEY (note_id),
  KEY idx_order_note_edit_locks_order (order_id),
  KEY idx_order_note_edit_locks_expires (expires_at)
);
