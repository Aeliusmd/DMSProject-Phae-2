const ACCESS_TOKEN_KEY = "dms_access_token";
const REFRESH_TOKEN_KEY = "dms_refresh_token";
const LEGACY_ACCESS_TOKEN_KEY = "dms_access_token";
const LEGACY_REFRESH_TOKEN_KEY = "dms_refresh_token";
const USER_KEY = "dms_user";
const ACCESS_EXPIRES_KEY = "dms_access_expires_at";
const IMPERSONATION_FLAG_KEY = "dms_impersonating";
const SESSION_USER_KEY = "dms_session_user";
const DEVICE_TRUST_TOKEN_KEY = "dms_device_trust_token"; // legacy single token
const DEVICE_TRUST_TOKENS_KEY = "dms_device_trust_tokens"; // multi-account list
const BROWSER_STAFF_OWNER_KEY = "dms_browser_staff_owner";

function isBrowser() {
  return typeof window !== "undefined";
}

function readDeviceTrustEntries() {
  if (!isBrowser()) return [];

  try {
    const raw = localStorage.getItem(DEVICE_TRUST_TOKENS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry) => {
            if (typeof entry === "string" && entry.trim()) {
              return { employeeId: null, token: entry.trim(), expiresAt: null };
            }
            const token = `${entry?.token || ""}`.trim();
            if (!token) return null;
            const employeeId =
              entry?.employeeId == null || entry?.employeeId === ""
                ? null
                : Number(entry.employeeId);
            return {
              employeeId: Number.isFinite(employeeId) ? employeeId : null,
              token,
              expiresAt: entry?.expiresAt || null,
            };
          })
          .filter(Boolean);
      }
    }

    // Migrate legacy single-token key.
    const legacy = localStorage.getItem(DEVICE_TRUST_TOKEN_KEY);
    if (legacy && legacy.trim()) {
      return [{ employeeId: null, token: legacy.trim(), expiresAt: null }];
    }
  } catch {
    // Ignore storage failures.
  }

  return [];
}

function writeDeviceTrustEntries(entries) {
  if (!isBrowser()) return;
  try {
    const cleaned = (Array.isArray(entries) ? entries : [])
      .map((entry) => ({
        employeeId:
          entry?.employeeId == null || !Number.isFinite(Number(entry.employeeId))
            ? null
            : Number(entry.employeeId),
        token: `${entry?.token || ""}`.trim(),
        expiresAt: entry?.expiresAt || null,
      }))
      .filter((entry) => entry.token);

    localStorage.setItem(DEVICE_TRUST_TOKENS_KEY, JSON.stringify(cleaned));
    // Keep legacy key in sync with the most recent token for older code paths.
    if (cleaned.length) {
      localStorage.setItem(DEVICE_TRUST_TOKEN_KEY, cleaned[cleaned.length - 1].token);
    } else {
      localStorage.removeItem(DEVICE_TRUST_TOKEN_KEY);
    }
  } catch {
    // Ignore storage failures.
  }
}

function clearLegacyLocalTokenStorage() {
  if (!isBrowser()) return;
  // Older builds stored tokens in localStorage; prefer sessionStorage.
  try {
    localStorage.removeItem(LEGACY_ACCESS_TOKEN_KEY);
    localStorage.removeItem(LEGACY_REFRESH_TOKEN_KEY);
  } catch {
    // Ignore storage failures.
  }
}

if (isBrowser()) {
  clearLegacyLocalTokenStorage();
}

export function isImpersonating() {
  if (!isBrowser()) return false;
  try {
    return sessionStorage.getItem(IMPERSONATION_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

export function getAccessToken() {
  if (!isBrowser()) return null;
  try {
    return sessionStorage.getItem(ACCESS_TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

export function getRefreshToken() {
  if (!isBrowser()) return null;
  try {
    return sessionStorage.getItem(REFRESH_TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

export function getAccessExpiresAt() {
  if (!isBrowser()) return null;
  const raw = sessionStorage.getItem(ACCESS_EXPIRES_KEY);
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parseUser(raw) {
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeStaffEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function toStaffIdentity(user) {
  if (!user) return null;

  const id = user.id ?? user.userId ?? null;
  const email = user.email || "";

  if (id == null && !email) return null;

  return { id, email };
}

export function isSameStaffUser(a, b) {
  const left = toStaffIdentity(a);
  const right = toStaffIdentity(b);

  if (!left || !right) return false;

  if (left.id != null && right.id != null && String(left.id) === String(right.id)) {
    return true;
  }

  const leftEmail = normalizeStaffEmail(left.email);
  const rightEmail = normalizeStaffEmail(right.email);

  return Boolean(leftEmail && rightEmail && leftEmail === rightEmail);
}

export function getBrowserStaffOwner() {
  if (!isBrowser()) return null;

  try {
    return toStaffIdentity(parseUser(localStorage.getItem(BROWSER_STAFF_OWNER_KEY)));
  } catch {
    return null;
  }
}

export function setBrowserStaffOwner(user) {
  if (!isBrowser()) return;

  const identity = toStaffIdentity(user);
  if (!identity) return;

  try {
    localStorage.setItem(BROWSER_STAFF_OWNER_KEY, JSON.stringify(identity));
  } catch {
    // Ignore storage failures.
  }
}

export function clearBrowserStaffOwner() {
  if (!isBrowser()) return;

  try {
    localStorage.removeItem(BROWSER_STAFF_OWNER_KEY);
  } catch {
    // Ignore storage failures.
  }
}

/** Staff account that owns this browser (admin during impersonation, not the employee). */
export function getStaffBrowserUser() {
  if (!isBrowser()) return null;

  const owner = getBrowserStaffOwner();
  if (owner) return owner;

  if (isImpersonating()) {
    return toStaffIdentity(parseUser(localStorage.getItem(USER_KEY)));
  }

  return toStaffIdentity(getStoredUser());
}

export function getStoredUser() {
  if (!isBrowser()) return null;

  if (isImpersonating()) {
    try {
      return parseUser(sessionStorage.getItem(SESSION_USER_KEY));
    } catch {
      return null;
    }
  }

  return parseUser(localStorage.getItem(USER_KEY));
}

export function setAuth({ user, accessToken, refreshToken, accessExpiresAt } = {}) {
  if (!isBrowser()) return;

  clearLegacyLocalTokenStorage();

  if (user) {
    const serialized = JSON.stringify(user);

    if (isImpersonating()) {
      sessionStorage.setItem(SESSION_USER_KEY, serialized);
    } else {
      localStorage.setItem(USER_KEY, serialized);
    }
  }

  // Only overwrite tokens when a non-empty string is provided so callers like
  // profile update / getCurrentUser can refresh the user without wiping auth.
  if (typeof accessToken === "string" && accessToken) {
    sessionStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  }

  if (typeof refreshToken === "string" && refreshToken) {
    sessionStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  }

  if (accessExpiresAt) {
    sessionStorage.setItem(ACCESS_EXPIRES_KEY, String(accessExpiresAt));
  }
}

export function beginImpersonationSession({
  user,
  accessToken,
  refreshToken,
  accessExpiresAt,
} = {}) {
  if (!isBrowser()) return;

  sessionStorage.setItem(IMPERSONATION_FLAG_KEY, "1");
  setAuth({ user, accessToken, refreshToken, accessExpiresAt });
}

export function clearAuth() {
  if (!isBrowser()) return;

  const impersonating = isImpersonating();

  // Wipe order drafts with the auth session so the next user on this tab
  // cannot restore another person's unsaved edit.
  try {
    const prefixes = [
      "dms:order-draft-session:",
      "dms:order-list-filters:",
      "dms:order-list-filters-pending:",
    ];
    const keysToRemove = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const key = window.sessionStorage.key(i);
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => window.sessionStorage.removeItem(key));
  } catch {
    // Ignore storage failures.
  }

  clearLegacyLocalTokenStorage();

  try {
    sessionStorage.removeItem(ACCESS_TOKEN_KEY);
    sessionStorage.removeItem(REFRESH_TOKEN_KEY);
    sessionStorage.removeItem(ACCESS_EXPIRES_KEY);
    sessionStorage.removeItem(IMPERSONATION_FLAG_KEY);
    sessionStorage.removeItem(SESSION_USER_KEY);
  } catch {
    // Ignore storage failures.
  }

  if (!impersonating) {
    localStorage.removeItem(USER_KEY);
    clearBrowserStaffOwner();
  }
}

export function getDeviceTrustToken() {
  const tokens = getDeviceTrustTokens();
  return tokens.length ? tokens[tokens.length - 1] : null;
}

export function getDeviceTrustTokens() {
  const now = Date.now();
  const entries = readDeviceTrustEntries();
  const validEntries = entries.filter((entry) => {
    if (!entry.expiresAt) return true;
    const expiresMs = new Date(entry.expiresAt).getTime();
    return !Number.isFinite(expiresMs) || expiresMs > now;
  });

  if (validEntries.length !== entries.length) {
    writeDeviceTrustEntries(validEntries);
  }

  return [...new Set(validEntries.map((entry) => entry.token))];
}

export function setDeviceTrustToken(token, { employeeId = null, expiresAt = null } = {}) {
  if (!isBrowser()) return;
  const nextToken = typeof token === "string" ? token.trim() : "";
  if (!nextToken) return;

  const normalizedEmployeeId =
    employeeId == null || employeeId === ""
      ? null
      : Number(employeeId);
  const hasEmployeeId = Number.isFinite(normalizedEmployeeId);

  let entries = readDeviceTrustEntries().filter((entry) => entry.token !== nextToken);

  if (hasEmployeeId) {
    entries = entries.filter(
      (entry) => Number(entry.employeeId) !== normalizedEmployeeId
    );
  }

  entries.push({
    employeeId: hasEmployeeId ? normalizedEmployeeId : null,
    token: nextToken,
    expiresAt: expiresAt || null,
  });

  writeDeviceTrustEntries(entries);
}

export function removeDeviceTrustTokens(tokens = []) {
  if (!isBrowser()) return;
  const removeSet = new Set(
    (Array.isArray(tokens) ? tokens : [])
      .map((token) => `${token || ""}`.trim())
      .filter(Boolean)
  );
  if (!removeSet.size) return;

  writeDeviceTrustEntries(
    readDeviceTrustEntries().filter((entry) => !removeSet.has(entry.token))
  );
}

export function clearDeviceTrustToken() {
  if (!isBrowser()) return;
  try {
    localStorage.removeItem(DEVICE_TRUST_TOKEN_KEY);
    localStorage.removeItem(DEVICE_TRUST_TOKENS_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export function isAuthenticated() {
  return Boolean(getStoredUser());
}
