const path = require("path");

module.exports = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT) || 5000,
  clientUrl: process.env.CLIENT_URL || "http://localhost:3000",

  db: {
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "dms_db",
  },

  fileServer: process.env.FILE_SERVER
    ? path.resolve(process.env.FILE_SERVER)
    : "",
  subpoenaExtraction: {
    apiUrl: process.env.SUBPOENA_EXTRACTION_API_URL || "",
    timeoutMs: Number(process.env.SUBPOENA_EXTRACTION_TIMEOUT_MS) || 600000,
  },

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || "change-me-access-secret",
    refreshSecret: process.env.JWT_REFRESH_SECRET || "change-me-refresh-secret",
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
  },

  session: {
    trustedDeviceDays: Number(process.env.SESSION_TRUSTED_DAYS) || 7,
    defaultDays: Number(process.env.SESSION_DEFAULT_DAYS) || 7,
  },

  twoFactor: {
    codeLength: 6,
    expiresMinutes: Number(process.env.TWO_FACTOR_EXPIRES_MINUTES) || 10,
    resendCooldownSeconds: Number(process.env.TWO_FACTOR_RESEND_COOLDOWN) || 60,
    devLogCode: process.env.TWO_FACTOR_DEV_LOG_CODE === "true",
  },

  smtp: {
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true",
    user: (process.env.SMTP_USER || "").trim(),
    pass: (process.env.SMTP_PASS || "").replace(/\s+/g, ""),
    from: (process.env.SMTP_FROM || process.env.SMTP_USER || "").trim(),
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS) || 30000,
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS) || 30000,
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS) || 60000,
  },

  invoiceReminder: {
    intervalDays: Number(process.env.INVOICE_REMINDER_INTERVAL_DAYS) || 5,
    checkIntervalMs:
      Number(process.env.INVOICE_REMINDER_CHECK_INTERVAL_MS) || 60 * 60 * 1000,
  },

  stripe: {
    publishableKey: (process.env.STRIPE_PUBLISHABLE_KEY || "").trim(),
    secretKey: (process.env.STRIPE_SECRET_KEY || "").trim(),
    webhookSecret: (process.env.STRIPE_WEBHOOK_SECRET || "").trim(),
    currency: (process.env.STRIPE_CURRENCY || "usd").trim().toLowerCase(),
  },

  personalPortal: {
    processingFeeCents: Number(process.env.PERSONAL_PORTAL_FEE_CENTS) || 3500,
    researchFeeCents: Number(process.env.PERSONAL_PORTAL_RESEARCH_FEE_CENTS) || 500,
    lookupDays: Number(process.env.PERSONAL_PORTAL_LOOKUP_DAYS) || 7,
  },

  /** Fallback when X-Client-Timezone is absent (cron, webhooks, emails). */
  businessTimezone: (process.env.BUSINESS_TIMEZONE || "UTC").trim() || "UTC",

  authRateLimit: {
    enabled: process.env.AUTH_RATE_LIMIT_ENABLED !== "false",
    login: {
      windowMs:
        Number(process.env.AUTH_RATE_LIMIT_LOGIN_WINDOW_MS) || 15 * 60 * 1000,
      max: Number(process.env.AUTH_RATE_LIMIT_LOGIN_MAX) || 10,
    },
    register: {
      windowMs:
        Number(process.env.AUTH_RATE_LIMIT_REGISTER_WINDOW_MS) || 60 * 60 * 1000,
      max: Number(process.env.AUTH_RATE_LIMIT_REGISTER_MAX) || 5,
    },
    twoFactorVerify: {
      windowMs:
        Number(process.env.AUTH_RATE_LIMIT_2FA_VERIFY_WINDOW_MS) ||
        15 * 60 * 1000,
      max: Number(process.env.AUTH_RATE_LIMIT_2FA_VERIFY_MAX) || 10,
    },
    twoFactorResend: {
      windowMs:
        Number(process.env.AUTH_RATE_LIMIT_2FA_RESEND_WINDOW_MS) ||
        15 * 60 * 1000,
      max: Number(process.env.AUTH_RATE_LIMIT_2FA_RESEND_MAX) || 5,
    },
    refresh: {
      windowMs:
        Number(process.env.AUTH_RATE_LIMIT_REFRESH_WINDOW_MS) || 15 * 60 * 1000,
      max: Number(process.env.AUTH_RATE_LIMIT_REFRESH_MAX) || 120,
    },
  },
};
