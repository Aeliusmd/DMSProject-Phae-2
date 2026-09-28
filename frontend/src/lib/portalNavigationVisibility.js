/**
 * Toggle visibility for company portal, personal request portal,
 * and staff Company/Personal Orders pages. Code stays in place — only hidden.
 *
 * Set to `false` to show everything again.
 */
export const PORTAL_NAVIGATION_HIDDEN = false;

/**
 * Hide staff Company Orders / Personal Orders (sidebar, dedicated pages,
 * Orders source filter, Reports source filter, Payments).
 * Set to `false` to show them again — do not delete the pages.
 */
export const STAFF_PORTAL_ORDERS_HIDDEN = false;

/** Where external portal routes redirect when hidden. */
export const PORTAL_ROUTE_REDIRECT = "/login";

/** Where staff Company/Personal Orders redirect when hidden. */
export const STAFF_PORTAL_ORDERS_REDIRECT = "/orders";

/**
 * Hide Unprocessed Subpoenas dashboard button, stat card, and list page.
 * Backend APIs and batch-scan → new order flows stay active.
 * Set to `false` to show again — do not delete the page.
 */
export const UNPROCESSED_SUBPOENAS_HIDDEN = true;

/** Where /orders/unprocessed redirects when hidden. */
export const UNPROCESSED_SUBPOENAS_REDIRECT = "/dashboard";

const BLOCKED_ROUTE_PREFIXES = [
  "/landingpage",
  "/company-portal",
  "/personalrequest",
  "/Subpoenaupload",
  "/company-orders",
  "/personal-orders",
];

const STAFF_ORDER_ROUTE_PREFIXES = ["/company-orders", "/personal-orders"];

const UNPROCESSED_ROUTE_PREFIXES = ["/orders/unprocessed"];

const ALLOWED_ROUTE_PREFIXES_WHEN_HIDDEN = [
  "/personalrequest/download",
  "/download/records",
  "/pay",
];

const HIDDEN_STAFF_NAV_HREFS = new Set(["/company-orders", "/personal-orders"]);

const HIDDEN_UNPROCESSED_NAV_HREFS = new Set(["/orders/unprocessed"]);

export function isUnprocessedSubpoenasHidden() {
  return UNPROCESSED_SUBPOENAS_HIDDEN;
}

/** Hide Unprocessed Subpoenas quick action / nav links when flag is on. */
export function isUnprocessedSubpoenasNavHidden(href = "") {
  if (!isUnprocessedSubpoenasHidden()) {
    return false;
  }

  return HIDDEN_UNPROCESSED_NAV_HREFS.has(`${href || ""}`.split("?")[0]);
}

export function isPortalRouteAllowedWhenHidden(pathname = "") {
  const normalizedPath = `${pathname || ""}`.split("?")[0] || "/";

  return ALLOWED_ROUTE_PREFIXES_WHEN_HIDDEN.some(
    (prefix) =>
      normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  );
}

export function isStaffPortalOrdersHidden() {
  return STAFF_PORTAL_ORDERS_HIDDEN || PORTAL_NAVIGATION_HIDDEN;
}

export function isPortalRouteBlocked(pathname = "") {
  const normalizedPath = `${pathname || ""}`.split("?")[0] || "/";

  const isUnprocessedRoute = UNPROCESSED_ROUTE_PREFIXES.some(
    (prefix) =>
      normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  );

  if (isUnprocessedRoute && isUnprocessedSubpoenasHidden()) {
    return true;
  }

  const isStaffOrderRoute = STAFF_ORDER_ROUTE_PREFIXES.some(
    (prefix) =>
      normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  );

  if (isStaffOrderRoute && isStaffPortalOrdersHidden()) {
    return true;
  }

  if (!PORTAL_NAVIGATION_HIDDEN) {
    return false;
  }

  if (isPortalRouteAllowedWhenHidden(normalizedPath)) {
    return false;
  }

  return BLOCKED_ROUTE_PREFIXES.some(
    (prefix) =>
      normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  );
}

export function getBlockedRouteRedirect(pathname = "") {
  const normalizedPath = `${pathname || ""}`.split("?")[0] || "/";

  const isUnprocessedRoute = UNPROCESSED_ROUTE_PREFIXES.some(
    (prefix) =>
      normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  );

  if (isUnprocessedRoute) {
    return UNPROCESSED_SUBPOENAS_REDIRECT;
  }

  const isStaffOrderRoute = STAFF_ORDER_ROUTE_PREFIXES.some(
    (prefix) =>
      normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  );

  return isStaffOrderRoute
    ? STAFF_PORTAL_ORDERS_REDIRECT
    : PORTAL_ROUTE_REDIRECT;
}

/** Hide Company Orders / Personal Orders from the staff sidebar when flag is on. */
export function isStaffPortalOrdersNavHidden(href = "") {
  if (!isStaffPortalOrdersHidden()) {
    return false;
  }

  return HIDDEN_STAFF_NAV_HREFS.has(`${href || ""}`.split("?")[0]);
}
