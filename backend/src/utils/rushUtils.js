/**
 * Rush levels are based on order created date (calendar days, local date).
 * Rush 1: 14 through 20 days
 * Rush 2: 21 through 27 days
 * Rush 3: 28 days or more
 * Before 14 days: no rush level
 */
const RUSH_1_MIN_DAYS = 14;
const RUSH_2_MIN_DAYS = 21;
const RUSH_3_MIN_DAYS = 28;

/** Last inclusive day of each band (for SQL filters). */
const RUSH_1_MAX_DAYS = RUSH_2_MIN_DAYS - 1; // 20
const RUSH_2_MAX_DAYS = RUSH_3_MIN_DAYS - 1; // 27

/** Active orders at Rush 2+ are treated as Ready (matches deriveDisplayOrderStatus). */
const RUSH_READY_MIN_DAYS = RUSH_2_MIN_DAYS;

const ORDER_AGE_SQL = "DATE(created_at)";
const ORDER_AGE_SQL_ALIAS = "DATE(o.created_at)";

function parseDateOnly(value) {
  if (!value) return null;

  const datePart = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;

  const [year, month, day] = datePart.split("-").map(Number);
  const parsed = new Date(year, month - 1, day);

  if (Number.isNaN(parsed.getTime())) return null;

  return parsed;
}

function toLocalOrderDate(value) {
  if (!value) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  const parsed = parseDateOnly(value);
  if (parsed) return parsed;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function getOrderAgeDays(createdAt) {
  const reference = toLocalOrderDate(createdAt);
  if (!reference) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const diffDays = Math.floor(
    (today.getTime() - reference.getTime()) / (1000 * 60 * 60 * 24)
  );

  return diffDays < 0 ? null : diffDays;
}

function calculateOrderRushLevel(createdAt) {
  const diffDays = getOrderAgeDays(createdAt);
  if (diffDays == null) {
    return { level: null, label: null };
  }

  if (diffDays >= RUSH_3_MIN_DAYS) {
    return { level: 3, label: "Rush 3" };
  }

  if (diffDays >= RUSH_2_MIN_DAYS) {
    return { level: 2, label: "Rush 2" };
  }

  if (diffDays >= RUSH_1_MIN_DAYS) {
    return { level: 1, label: "Rush 1" };
  }

  return { level: null, label: null };
}

/** @deprecated Use calculateOrderRushLevel */
function calculateRushLevel(createdAt) {
  return calculateOrderRushLevel(createdAt).label;
}

module.exports = {
  RUSH_1_MIN_DAYS,
  RUSH_2_MIN_DAYS,
  RUSH_3_MIN_DAYS,
  RUSH_1_MAX_DAYS,
  RUSH_2_MAX_DAYS,
  RUSH_READY_MIN_DAYS,
  ORDER_AGE_SQL,
  ORDER_AGE_SQL_ALIAS,
  calculateOrderRushLevel,
  calculateRushLevel,
  parseDateOnly,
};
