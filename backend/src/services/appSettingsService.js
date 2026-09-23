const path = require("path");
const { getPool } = require("../config/database");
const config = require("../config");
const logger = require("../utils/logger");

const FILE_SERVER_BASE_PATH_KEY = "file_server_base_path";

let cachedFileServerBasePath = null;

function envFileServerBasePath() {
  if (config.fileServer) {
    return path.resolve(config.fileServer);
  }
  return "";
}

function getFileServerBasePath() {
  if (cachedFileServerBasePath) {
    return cachedFileServerBasePath;
  }
  return envFileServerBasePath();
}

function setCachedFileServerBasePath(value) {
  const trimmed = String(value || "").trim();
  cachedFileServerBasePath = trimmed ? path.resolve(trimmed) : "";
}

async function ensureAppSettingsTable() {
  const pool = getPool();

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      setting_key VARCHAR(100) NOT NULL,
      setting_value VARCHAR(1000) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_app_settings_key (setting_key)
    )
  `);

  const seedValue = envFileServerBasePath();
  if (!seedValue) {
    return getFileServerBasePath();
  }

  await pool.execute(
    `INSERT INTO app_settings (setting_key, setting_value)
     VALUES (:settingKey, :settingValue)
     ON DUPLICATE KEY UPDATE setting_key = setting_key`,
    {
      settingKey: FILE_SERVER_BASE_PATH_KEY,
      settingValue: seedValue,
    }
  );

  const [rows] = await pool.execute(
    `SELECT setting_value
     FROM app_settings
     WHERE setting_key = :settingKey
     LIMIT 1`,
    { settingKey: FILE_SERVER_BASE_PATH_KEY }
  );

  const stored = rows[0]?.setting_value || seedValue;
  setCachedFileServerBasePath(stored);
  logger.info(`app_settings ${FILE_SERVER_BASE_PATH_KEY}: ${getFileServerBasePath()}`);
  return getFileServerBasePath();
}

module.exports = {
  FILE_SERVER_BASE_PATH_KEY,
  getFileServerBasePath,
  ensureAppSettingsTable,
};
