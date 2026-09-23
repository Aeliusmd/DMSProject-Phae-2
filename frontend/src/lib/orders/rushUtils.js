/**
 * Rush levels are based on order created date (calendar days, local date).
 * Rush 1: 14 through 20 days
 * Rush 2: 21 through 27 days
 * Rush 3: 28 days or more
 * Before 14 days: no rush level
 */
export const RUSH_1_MIN_DAYS = 14;
export const RUSH_2_MIN_DAYS = 21;
export const RUSH_3_MIN_DAYS = 28;

export const RUSH_1_MAX_DAYS = RUSH_2_MIN_DAYS - 1; // 20
export const RUSH_2_MAX_DAYS = RUSH_3_MIN_DAYS - 1; // 27

function parseOrderDate(value) {
  if (!value) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  const datePart = String(value).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    const [year, month, day] = datePart.split("-").map(Number);
    const parsed = new Date(year, month - 1, day);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

function getOrderAgeDays(createdAt) {
  const reference = parseOrderDate(createdAt);
  if (!reference) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const diffDays = Math.floor(
    (today.getTime() - reference.getTime()) / (1000 * 60 * 60 * 24)
  );

  return diffDays < 0 ? null : diffDays;
}

export function getOrderAgeInDays(orderOrDate) {
  if (!orderOrDate) return null;

  if (
    typeof orderOrDate === "string" ||
    orderOrDate instanceof Date ||
    typeof orderOrDate === "number"
  ) {
    return getOrderAgeDays(orderOrDate);
  }

  return getOrderAgeDays(getOrderAgeDate(orderOrDate));
}

function rushLevelRangeLabel(rush) {
  if (rush === "Rush 1") return "14–20 days since order created date";
  if (rush === "Rush 2") return "21–27 days since order created date";
  if (rush === "Rush 3") return "28+ days since order created date";
  return "";
}

export function buildRushBadgeTooltip(orderOrDate, rushLabel = null) {
  const days = getOrderAgeInDays(orderOrDate);
  const rush =
    formatRushLevel(rushLabel) ||
    (typeof orderOrDate === "object" && !(orderOrDate instanceof Date)
      ? resolveRushLabel(orderOrDate)
      : calculateOrderRushLevel(orderOrDate));

  if (!rush && days == null) return "";

  const parts = [];

  if (rush) {
    parts.push(rush);
    const rangeLabel = rushLevelRangeLabel(rush);
    if (rangeLabel) parts.push(rangeLabel);
  }

  if (days != null) {
    parts.push(
      days === 1
        ? "1 day since order created date"
        : `${days} days since order created date`
    );
  }

  return parts.join(" — ");
}

export function calculateOrderRushLevel(createdAt) {
  const diffDays = getOrderAgeDays(createdAt);
  if (diffDays == null) return null;

  if (diffDays >= RUSH_3_MIN_DAYS) return "Rush 3";
  if (diffDays >= RUSH_2_MIN_DAYS) return "Rush 2";
  if (diffDays >= RUSH_1_MIN_DAYS) return "Rush 1";
  return null;
}

export function getOrderAgeDate(order) {
  if (!order) return null;

  if (
    typeof order === "string" ||
    order instanceof Date ||
    typeof order === "number"
  ) {
    return order;
  }

  return order.createdAt || order.created_at || null;
}

export function formatRushLevel(value) {
  if (value == null || value === "") return null;

  const normalized = String(value).trim();
  if (normalized.startsWith("Rush ")) return normalized;

  const level = Number(value);
  if (level === 1) return "Rush 1";
  if (level === 2) return "Rush 2";
  if (level === 3) return "Rush 3";

  return null;
}

export function resolveRushLabel(order) {
  if (!order) return null;

  return (
    formatRushLevel(order.rushLabel) ||
    formatRushLevel(order.rushLevel) ||
    calculateOrderRushLevel(getOrderAgeDate(order)) ||
    null
  );
}

export function deriveDisplayOrderStatus(status, createdAt) {
  if (status === "Ready" || status === "Ready to Pickup") {
    return status;
  }

  const rush = calculateOrderRushLevel(createdAt);
  if (status === "Active" && (rush === "Rush 2" || rush === "Rush 3")) {
    return "Ready";
  }

  return status || "Active";
}

/** @deprecated Use calculateOrderRushLevel */
export function calculateRushLevel(createdAt) {
  return calculateOrderRushLevel(createdAt);
}

export const RUSH_LEVEL_STYLES = {
  "Rush 1": "border-[#FDE68A] bg-[#FEF3C7] text-[#B45309]",
  "Rush 2": "border-[#FDBA74] bg-[#FFEDD5] text-[#EA580C]",
  "Rush 3": "border-[#FCA5A5] bg-[#FEE2E2] text-[#DC2626]",
};

export const RUSH_LEVEL_LEGEND = [
  { color: "#EAB308", label: "Rush 1" },
  { color: "#F97316", label: "Rush 2" },
  { color: "#EF4444", label: "Rush 3" },
];
