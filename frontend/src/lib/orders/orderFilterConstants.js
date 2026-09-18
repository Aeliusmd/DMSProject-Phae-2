export const ORDER_PERIOD_OPTIONS = [
  { value: "", label: "All Time" },
  { value: "1w", label: "Past 1 Week" },
  { value: "2w", label: "Past 2 Weeks" },
  { value: "3w", label: "Past 3 Weeks" },
  { value: "4w", label: "Past 4 Weeks" },
  { value: "2m", label: "Past 2 Months" },
  { value: "3m", label: "Past 3 Months" },
];

export function normalizeOrderDateSortDir(value) {
  const normalized = `${value || ""}`.trim().toLowerCase();
  return normalized === "asc" || normalized === "desc" ? normalized : "";
}

/** Order list source filter. Default is internal (normal system orders). */
export const ORDER_SOURCE_OPTIONS = [
  { value: "internal", label: "Internal Orders" },
  { value: "company_portal", label: "External Company Orders" },
  { value: "personal_portal", label: "Personal Orders" },
];

export const ORDER_SOURCE_INTERNAL = "internal";
export const ORDER_SOURCE_COMPANY = "company_portal";
export const ORDER_SOURCE_PERSONAL = "personal_portal";

export function getOrderSourceOptions({ hidePortalOrders = false } = {}) {
  if (!hidePortalOrders) return ORDER_SOURCE_OPTIONS;
  return ORDER_SOURCE_OPTIONS.filter(
    (option) => option.value === ORDER_SOURCE_INTERNAL
  );
}

export const INTERNAL_ORDER_STATUS_OPTIONS = [
  { value: "", label: "All Status" },
  { value: "active", label: "Active" },
  { value: "ready", label: "Ready" },
  { value: "ready_pickup", label: "Ready to Pickup" },
  { value: "completed", label: "Completed" },
  { value: "writeoffs", label: "Write Offs" },
  { value: "no_subpoena", label: "No Subpoena" },
  { value: "no_records", label: "No Records" },
  { value: "unpaid", label: "Unpaid" },
  { value: "paid", label: "Paid" },
  { value: "cancelled", label: "Cancelled" },
  { value: "deleted", label: "Deleted" },
];

export const COMPANY_ORDER_STATUS_OPTIONS = [
  { value: "", label: "All Statuses" },
  { value: "in_process", label: "In Process" },
  { value: "invoice", label: "Invoice" },
  { value: "paid", label: "Paid" },
  { value: "released", label: "Released" },
  { value: "no_facility", label: "No Facility" },
];

export const PERSONAL_ORDER_STATUS_OPTIONS = [
  { value: "", label: "All Statuses" },
  { value: "in_process", label: "In Process" },
  { value: "invoice", label: "Invoice" },
  { value: "paid", label: "Paid" },
  { value: "released", label: "Released" },
];

export function getStatusOptionsForOrderSource(orderSource) {
  if (isCompanyOrderSource(orderSource)) return COMPANY_ORDER_STATUS_OPTIONS;
  if (isPersonalOrderSource(orderSource)) return PERSONAL_ORDER_STATUS_OPTIONS;
  return INTERNAL_ORDER_STATUS_OPTIONS;
}

/**
 * Normalize UI order-source values for the /orders API.
 * Internal (default) must send nothing so the backend excludes portal rows.
 */
export function toApiCreationSource(orderSource) {
  const value = `${orderSource || ""}`.trim().toLowerCase();
  if (value === ORDER_SOURCE_COMPANY || value === ORDER_SOURCE_PERSONAL) {
    return value;
  }
  return "";
}

export function isCompanyOrderSource(orderSource) {
  return toApiCreationSource(orderSource) === ORDER_SOURCE_COMPANY;
}

export function isPersonalOrderSource(orderSource) {
  return toApiCreationSource(orderSource) === ORDER_SOURCE_PERSONAL;
}

export function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getOrderPeriodStartDate(period) {
  if (!period) return null;

  const start = new Date();
  start.setHours(0, 0, 0, 0);

  switch (period) {
    case "1w":
      start.setDate(start.getDate() - 7);
      break;
    case "2w":
      start.setDate(start.getDate() - 14);
      break;
    case "3w":
      start.setDate(start.getDate() - 21);
      break;
    case "4w":
      start.setDate(start.getDate() - 28);
      break;
    case "2m":
      start.setMonth(start.getMonth() - 2);
      break;
    case "3m":
      start.setMonth(start.getMonth() - 3);
      break;
    default:
      return null;
  }

  return formatLocalDate(start);
}
