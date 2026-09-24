CREATE TABLE IF NOT EXISTS order_edit_locks (
  order_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  locked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  PRIMARY KEY (order_id),
  KEY idx_order_edit_locks_expires (expires_at)
);
