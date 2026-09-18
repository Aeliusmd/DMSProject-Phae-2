-- Patient master + DMS order numbers from patient + record-type codes
-- (medical=1, billing=2, employment=3, xrays=4, other=5).
-- Examples: 0001-1, 0001-2, 0001-1-2, 0001-1-2-3-4-5
-- next_order_sequence remains an internal uniqueness counter / fallback.
-- Run against your app DB (e.g. dms_db / dms_db_test).

CREATE TABLE IF NOT EXISTS patients (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  patient_number INT UNSIGNED NOT NULL,
  first_name VARCHAR(100) NULL,
  middle_name VARCHAR(100) NULL,
  last_name VARCHAR(100) NULL,
  dob DATE NULL,
  ssn_last_four VARCHAR(20) NULL,
  next_order_sequence INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_patients_patient_number (patient_number),
  KEY idx_patients_ssn_dob (ssn_last_four, dob),
  KEY idx_patients_name_dob (last_name, first_name, dob)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS patient_number_counter (
  id TINYINT UNSIGNED NOT NULL DEFAULT 1,
  next_patient_number INT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO patient_number_counter (id, next_patient_number)
VALUES (1, 1)
ON DUPLICATE KEY UPDATE id = id;

ALTER TABLE orders
  ADD COLUMN patient_id BIGINT UNSIGNED NULL
    COMMENT 'FK to patients.id for DMS patient-sequence order numbers'
    AFTER id,
  ADD COLUMN patient_order_sequence INT UNSIGNED NULL
    COMMENT 'Per-patient order sequence (the -N in 0001-N)'
    AFTER patient_id;

ALTER TABLE orders
  ADD UNIQUE KEY uq_orders_patient_sequence (patient_id, patient_order_sequence),
  ADD KEY idx_orders_patient_id (patient_id),
  ADD CONSTRAINT fk_orders_patient
    FOREIGN KEY (patient_id) REFERENCES patients(id);
