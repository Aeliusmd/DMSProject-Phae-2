CREATE TABLE IF NOT EXISTS facility_edit_locks (
  facility_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  locked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  PRIMARY KEY (facility_id),
  KEY idx_facility_edit_locks_expires (expires_at)
);
