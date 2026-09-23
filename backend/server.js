require("dotenv").config();
process.env.TZ = "UTC";

const app = require("./src/app");
const config = require("./src/config");
const { connectDatabase } = require("./src/config/database");
const { ensureUploadDirs, uploadsRoot } = require("./src/config/uploads");
const { ensureFileServerReady } = require("./src/utils/fileStorage");
const { ensureAppSettingsTable } = require("./src/services/appSettingsService");
const logger = require("./src/utils/logger");
const { startEmployeeReactivationJob } = require("./src/jobs/employeeReactivationJob");
const { startInvoiceReminderJob } = require("./src/jobs/invoiceReminderJob");

const PORT = config.port;

async function startServer() {
  try {
    await connectDatabase();
    await ensureAppSettingsTable();
    ensureUploadDirs();

    if (config.fileServer) {
      try {
        const root = ensureFileServerReady();
        logger.info(`FILE_SERVER ready: ${root}`);
        logger.info(`Uploads root: ${uploadsRoot}`);
      } catch (err) {
        logger.warn(`FILE_SERVER warning: ${err.message}`);
      }
    } else {
      logger.warn(
        "FILE_SERVER is not set — using local backend/uploads; batch scan and company portal will fail until configured"
      );
    }

    app.listen(PORT, () => {
      logger.info(`DMS API running in ${config.nodeEnv} mode on port ${PORT}`);
      startEmployeeReactivationJob();
      startInvoiceReminderJob();
    });
  } catch (error) {
    logger.error("Failed to start server", {
      error: error.message,
      code: error.code,
    });
    process.exit(1);
  }
}

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", {
    error: error.message,
    stack: error.stack,
  });
});

startServer();
