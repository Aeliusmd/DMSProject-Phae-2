import { getStoredUser } from "@/lib/auth/authStorage";

const STORAGE_PREFIX = "dms:order-list-filters:";
const PENDING_PREFIX = "dms:order-list-filters-pending:";

export const ORDER_LIST_FILTER_KEYS = {
  orders: "orders",
  personalOrders: "personal-orders",
  companyOrders: "company-orders",
  reports: "reports",
};

const RETURN_TO_LIST_KEY = {
  orders: ORDER_LIST_FILTER_KEYS.orders,
  "personal-orders": ORDER_LIST_FILTER_KEYS.personalOrders,
  "company-orders": ORDER_LIST_FILTER_KEYS.companyOrders,
  reports: ORDER_LIST_FILTER_KEYS.reports,
};

function ownerKey() {
  const user = getStoredUser();
  const userId = user?.id ?? user?.userId ?? user?.employeeId;
  return userId != null && `${userId}`.trim() ? `${userId}`.trim() : "anon";
}

function storageKey(listKey) {
  return `${STORAGE_PREFIX}${ownerKey()}:${listKey}`;
}

function pendingKey(listKey) {
  return `${PENDING_PREFIX}${ownerKey()}:${listKey}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeFilters(filters, defaults) {
  const next = { ...defaults };
  if (!isPlainObject(filters)) return next;

  for (const key of Object.keys(defaults)) {
    if (filters[key] == null) continue;
    next[key] =
      typeof defaults[key] === "string" ? `${filters[key]}` : filters[key];
  }
  return next;
}

export function areOrderListFiltersEqual(left, right, defaults) {
  const a = normalizeFilters(left, defaults);
  const b = normalizeFilters(right, defaults);
  return Object.keys(defaults).every(
    (key) => `${a[key] ?? ""}` === `${b[key] ?? ""}`
  );
}

export function listKeyFromReturnTo(returnTo = "orders") {
  const normalized = `${returnTo || "orders"}`.trim().replace(/^\/+/, "");
  return RETURN_TO_LIST_KEY[normalized] || ORDER_LIST_FILTER_KEYS.orders;
}

/** Call when opening an order for edit so returning to the list can restore filters. */
export function markOrderListFiltersForRestore(
  returnToOrListKey = "orders",
  filters = null,
  defaults = null
) {
  if (typeof window === "undefined") return;

  const listKey =
    RETURN_TO_LIST_KEY[`${returnToOrListKey || ""}`.trim()] ||
    Object.values(ORDER_LIST_FILTER_KEYS).find(
      (key) => key === returnToOrListKey
    ) ||
    listKeyFromReturnTo(returnToOrListKey);

  try {
    window.sessionStorage.setItem(pendingKey(listKey), "1");
  } catch {
    // no-op
  }

  // Flush latest filters/sort immediately so a fast navigation cannot miss the
  // async write from the list page useEffect.
  if (filters && isPlainObject(filters)) {
    if (defaults && isPlainObject(defaults)) {
      writeOrderListFilters(listKey, filters, defaults);
    } else {
      try {
        window.sessionStorage.setItem(
          storageKey(listKey),
          JSON.stringify({
            filters,
            savedAt: Date.now(),
          })
        );
      } catch {
        // no-op
      }
    }
  }
}

export function clearPendingOrderListFilterRestores() {
  if (typeof window === "undefined") return;

  try {
    const keysToRemove = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const key = window.sessionStorage.key(i);
      if (key && key.startsWith(PENDING_PREFIX)) keysToRemove.push(key);
    }
    keysToRemove.forEach((key) => window.sessionStorage.removeItem(key));
  } catch {
    // no-op
  }
}

/**
 * Restore filters only when returning from order edit (pending flag set).
 * Visiting Orders from another page or after logout starts fresh.
 * Strict Mode safe: pending "1" → "consumed" so a double-mount still restores.
 */
export function consumeOrderListFilters(listKey, defaults) {
  if (typeof window === "undefined") return { ...defaults };

  const pending = pendingKey(listKey);
  const stored = storageKey(listKey);

  try {
    const pendingState = window.sessionStorage.getItem(pending);
    const shouldRestore =
      pendingState === "1" || pendingState === "consumed";

    if (!shouldRestore) {
      window.sessionStorage.removeItem(stored);
      return { ...defaults };
    }

    if (pendingState === "1") {
      window.sessionStorage.setItem(pending, "consumed");
    }

    const raw = window.sessionStorage.getItem(stored);
    if (!raw) {
      window.sessionStorage.removeItem(pending);
      return { ...defaults };
    }

    const parsed = JSON.parse(raw);
    const restored = normalizeFilters(parsed?.filters, defaults);

    // Drop the one-shot flag after this navigation settles (after Strict remount).
    window.setTimeout(() => {
      try {
        if (window.sessionStorage.getItem(pending) === "consumed") {
          window.sessionStorage.removeItem(pending);
        }
      } catch {
        // no-op
      }
    }, 0);

    return restored;
  } catch {
    return { ...defaults };
  }
}

export function writeOrderListFilters(listKey, filters, defaults) {
  if (typeof window === "undefined") return;

  const key = storageKey(listKey);
  const normalized = normalizeFilters(filters, defaults);

  try {
    if (areOrderListFiltersEqual(normalized, defaults, defaults)) {
      window.sessionStorage.removeItem(key);
      return;
    }

    window.sessionStorage.setItem(
      key,
      JSON.stringify({
        filters: normalized,
        savedAt: Date.now(),
      })
    );
  } catch {
    // Ignore quota / private-mode failures; filters still work in-memory.
  }
}

export function clearOrderListFilters(listKey) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(storageKey(listKey));
    window.sessionStorage.removeItem(pendingKey(listKey));
  } catch {
    // no-op
  }
}

/** Clear all list filters + pending restore flags (logout). */
export function clearAllOrderListFilters() {
  if (typeof window === "undefined") return;

  try {
    const keysToRemove = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const key = window.sessionStorage.key(i);
      if (
        key &&
        (key.startsWith(STORAGE_PREFIX) || key.startsWith(PENDING_PREFIX))
      ) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => window.sessionStorage.removeItem(key));
  } catch {
    // no-op
  }
}

/** True when path should keep a pending edit→list filter restore. */
export function shouldKeepPendingOrderListFilterRestore(pathname = "") {
  const path = `${pathname || ""}`.split("?")[0];
  return (
    path === "/orders" ||
    path === "/personal-orders" ||
    path === "/company-orders" ||
    path === "/reports" ||
    path === "/orders/new" ||
    path.startsWith("/orders/new/")
  );
}
