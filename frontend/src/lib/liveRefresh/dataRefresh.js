const DATA_CHANGED_EVENT = "dms:data-changed";
const STORAGE_KEY = "dms:data-rev";
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function normalizePath(path = "") {
  return String(path).split("?")[0].toLowerCase();
}

export function shouldAnnounceMutation(path = "", method = "GET") {
  if (!MUTATION_METHODS.has(String(method || "GET").toUpperCase())) {
    return false;
  }

  const normalized = normalizePath(path);
  if (!normalized || normalized.startsWith("/auth/")) return false;
  if (normalized.includes("edit-lock")) return false;
  if (normalized.includes("/heartbeat")) return false;
  if (normalized.startsWith("/notifications")) return false;
  return true;
}

export function getDataRevision() {
  if (typeof window === "undefined") return 0;

  try {
    return Number(window.localStorage.getItem(STORAGE_KEY) || 0) || 0;
  } catch {
    return 0;
  }
}

export function notifyDataChanged() {
  if (typeof window === "undefined") return;

  const rev = Date.now();

  try {
    window.localStorage.setItem(STORAGE_KEY, String(rev));
  } catch {
    // localStorage may be unavailable; the in-window event still works.
  }

  window.dispatchEvent(new CustomEvent(DATA_CHANGED_EVENT, { detail: { rev } }));
}

export { DATA_CHANGED_EVENT, STORAGE_KEY };
