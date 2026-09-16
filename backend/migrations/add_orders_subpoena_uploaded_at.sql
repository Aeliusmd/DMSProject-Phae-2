-- Track when the order subpoena PDF was uploaded or replaced.
-- Distinct from subpoena_date (business/form date on the subpoena).
-- Safe to run once. Skip if column already exists.

USE dms_db;

ALTER TABLE orders
  ADD COLUMN subpoena_uploaded_at DATETIME NULL
    COMMENT 'When the subpoena PDF file was uploaded or replaced'
    AFTER subpoena_storage_path;
