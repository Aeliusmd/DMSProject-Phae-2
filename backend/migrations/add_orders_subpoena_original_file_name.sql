-- Store the user-uploaded subpoena filename separately from the unique disk path.
-- Safe to run once. Skip if column already exists.

USE dms_db;

ALTER TABLE orders
  ADD COLUMN subpoena_original_file_name VARCHAR(255) NULL
    COMMENT 'Original uploaded subpoena file name for display/download'
    AFTER subpoena_storage_path;
