-- Track whether emailed records were downloaded via the secure link.
-- Additive only: does not change send/email behavior.
-- Safe to run once.

USE dms_db;

ALTER TABLE orders
  ADD COLUMN records_downloaded_at DATETIME NULL
    COMMENT 'First time recipient downloaded emailed records via secure link'
    AFTER ready_date;

ALTER TABLE order_record_download_links
  ADD COLUMN first_downloaded_at DATETIME NULL
    COMMENT 'First successful file download via this token'
    AFTER expires_at,
  ADD COLUMN download_count INT UNSIGNED NOT NULL DEFAULT 0
    COMMENT 'Number of successful file downloads via this token'
    AFTER first_downloaded_at;
