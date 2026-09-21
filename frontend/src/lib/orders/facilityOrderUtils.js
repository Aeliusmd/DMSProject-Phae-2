import { getStoredUser } from "@/lib/auth/authStorage";
import { getFacility, resolveFacility } from "@/lib/facilities/facilityApi";
import { sanitizeZip } from "@/lib/validations/zipUtils";

const DRAFT_FORM_OMIT_KEYS = new Set([
  "subpoenaFile",
  "additionalDocumentFile",
  // Pending File objects can't be restored; don't keep prior upload metadata
  // that would look like a document is still attached on a fresh New Order.
  "documents",
]);

const DRAFT_STORAGE_PREFIX = "dms:order-draft-session:";

function draftOwnerKey() {
  const user = getStoredUser();
  const userId = user?.id ?? user?.userId ?? user?.employeeId;
  return userId != null && `${userId}`.trim() ? `${userId}`.trim() : "anon";
}

// Scoped per signed-in user so Person A's unsaved edit cannot restore for Person B
// on the same browser tab.
const draftSessionStorageKey = (scope) =>
  `${DRAFT_STORAGE_PREFIX}${draftOwnerKey()}:${scope}`;

// An in-progress order stays recoverable while the user steps away to create or
// complete a facility, but a forgotten draft must not leak into a later order.
const DRAFT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export function isRestorableDraftOrderSession(draft) {
  if (!draft?.formSnapshot) return false;

  const savedAt = Number(draft.savedAt || 0);
  if (!savedAt) return false;

  return Date.now() - savedAt <= DRAFT_MAX_AGE_MS;
}

export function getDraftOrderScope({ orderId = "", subpoenaId = "" } = {}) {
  const order = `${orderId || ""}`.trim();
  if (order) return `order:${order}`;

  const subpoena = `${subpoenaId || ""}`.trim();
  if (subpoena) return `subpoena:${subpoena}`;

  return "new";
}

export function serializeFormForDraft(formData = {}) {
  const snapshot = {};

  for (const [key, value] of Object.entries(formData || {})) {
    if (DRAFT_FORM_OMIT_KEYS.has(key)) continue;
    if (value instanceof File) continue;
    snapshot[key] = value;
  }

  return snapshot;
}

/** Personal portal: licence # and document flags come from personal_request_orders, not DMS orders. */
export function mergePersonalPortalFieldsFromOrder(form = {}, order = {}) {
  if (`${order.creationSource || ""}`.trim() !== "personal_portal") {
    return form;
  }

  const license = `${order.driverLicenseNumber || order.driver_license_number || ""}`.trim();

  return {
    ...form,
    driverLicenseNumber: license || `${form.driverLicenseNumber || ""}`.trim(),
    hasDriverLicenseDocument: Boolean(
      order.hasDriverLicenseDocument ?? form.hasDriverLicenseDocument
    ),
    hasPersonalDocument: Boolean(
      order.hasPersonalDocument ??
        order.hasDriverLicenseDocument ??
        form.hasPersonalDocument
    ),
  };
}

export function hasDraftableOrderContent(formData = {}) {
  const data = formData || {};

  if (`${data.facility || ""}`.trim() || `${data.facilityName || ""}`.trim()) {
    return true;
  }

  if (`${data.subpoenaExtractId || ""}`.trim()) {
    return true;
  }

  const textFields = [
    "firstName",
    "lastName",
    "caseNumber",
    "orderNumber",
    "specificDoctor",
    "specificRecord",
    "serveCompanyName",
    "providerId",
  ];

  return textFields.some((field) => `${data[field] || ""}`.trim());
}

export function rememberDraftOrderSession(
  scope,
  { facilityId, facilityName, formSnapshot = null, extractionMeta = null } = {}
) {
  const draftScope = `${scope || ""}`.trim();

  if (!draftScope || typeof window === "undefined") {
    return;
  }

  try {
    const existing = readDraftOrderSession(draftScope, { allowIncomplete: true }) || {};
    const snapshot = formSnapshot || existing.formSnapshot || null;
    const resolvedFacilityId = `${facilityId || existing.facilityId || snapshot?.facility || ""}`.trim();
    const resolvedFacilityName = `${facilityName || existing.facilityName || snapshot?.facilityName || ""}`.trim();

    if (!resolvedFacilityId && !snapshot) {
      return;
    }

    window.sessionStorage.setItem(
      draftSessionStorageKey(draftScope),
      JSON.stringify({
        facilityId: resolvedFacilityId,
        facilityName: resolvedFacilityName,
        formSnapshot: snapshot,
        extractionMeta: extractionMeta || existing.extractionMeta || null,
        savedAt: Date.now(),
      })
    );
  } catch {
    // Ignore storage failures in private browsing.
  }
}

export function readDraftOrderSession(scope, { allowIncomplete = false } = {}) {
  const draftScope = `${scope || ""}`.trim();

  if (!draftScope || typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.sessionStorage.getItem(draftSessionStorageKey(draftScope));
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const snapshot = parsed?.formSnapshot || null;
    const facilityId = `${parsed?.facilityId || snapshot?.facility || ""}`.trim();
    const facilityName = `${parsed?.facilityName || snapshot?.facilityName || ""}`.trim();

    if (!facilityId && !snapshot) return null;
    if (!allowIncomplete && !facilityId && !snapshot) return null;

    return {
      facilityId,
      facilityName,
      formSnapshot: snapshot,
      extractionMeta: parsed?.extractionMeta || null,
      savedAt: parsed?.savedAt || null,
    };
  } catch {
    return null;
  }
}

export function clearDraftOrderSession(scope) {
  const draftScope = `${scope || ""}`.trim();

  if (!draftScope || typeof window === "undefined") {
    return;
  }

  try {
    window.sessionStorage.removeItem(draftSessionStorageKey(draftScope));
  } catch {
    // Ignore storage failures.
  }
}

/** Clears all in-progress order drafts (e.g. on login or logout). */
export function clearAllDraftOrderSessions() {
  if (typeof window === "undefined") return;

  try {
    const keysToRemove = [];
    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const key = window.sessionStorage.key(i);
      if (key && key.startsWith(DRAFT_STORAGE_PREFIX)) keysToRemove.push(key);
    }
    keysToRemove.forEach((key) => window.sessionStorage.removeItem(key));
  } catch {
    // Ignore storage failures.
  }
}

export function rememberDraftOrderFacility(orderId, { facilityId, facilityName }) {
  rememberDraftOrderSession(getDraftOrderScope({ orderId }), {
    facilityId,
    facilityName,
  });
}

export function readDraftOrderFacility(orderId) {
  return readDraftOrderSession(getDraftOrderScope({ orderId }));
}

export function clearDraftOrderFacility(orderId) {
  clearDraftOrderSession(getDraftOrderScope({ orderId }));
}

export function isSameFacilityLabel(left, right) {
  return (
    `${left || ""}`.trim().localeCompare(`${right || ""}`.trim(), undefined, {
      sensitivity: "accent",
    }) === 0
  );
}

export async function resolvePendingFacility({
  facilityName,
  facilityId = "",
  address = "",
  city = "",
  state = "",
  zip = "",
  zipCode = "",
  allowCreate = true,
} = {}) {
  const trimmedName = `${facilityName || ""}`.trim();
  const existingId = `${facilityId || ""}`.trim();

  if (existingId) {
    const facility = await getFacility(existingId);
    if (!facility) {
      if (!trimmedName) {
        return {
          facilityId: "",
          facilityName: "",
          facilityCreated: false,
          facilityReactivated: false,
          facilityProfileIncomplete: false,
        };
      }
    } else {
      const canonicalName =
        facility.facilityName || facility.facility || trimmedName;

      if (!trimmedName || isSameFacilityLabel(trimmedName, canonicalName)) {
        return {
          facilityId: String(facility.id),
          facilityName: canonicalName || trimmedName,
          facilityCreated: Boolean(facility.isAutoCreated),
          facilityReactivated: false,
          facilityProfileIncomplete: Boolean(facility.isProfileIncomplete),
        };
      }
    }
  }

  if (!trimmedName) {
    return {
      facilityId: "",
      facilityName: "",
      facilityCreated: false,
      facilityReactivated: false,
      facilityProfileIncomplete: false,
    };
  }

  if (!allowCreate) {
    return {
      facilityId: "",
      facilityName: trimmedName,
      facilityCreated: false,
      facilityReactivated: false,
      facilityProfileIncomplete: false,
    };
  }

  const { facility, created, reactivated } = await resolveFacility({
    facilityName: trimmedName,
    address: `${address || ""}`.trim() || undefined,
    city: `${city || ""}`.trim() || undefined,
    state: `${state || ""}`.trim() || undefined,
    zipCode: sanitizeZip(`${zipCode || zip || ""}`) || undefined,
    zip: sanitizeZip(`${zip || zipCode || ""}`) || undefined,
  });

  return {
    facilityId: String(facility.id),
    facilityName: facility.facility || facility.facilityName || trimmedName,
    facilityCreated: created,
    facilityReactivated: Boolean(reactivated),
    facilityProfileIncomplete: Boolean(facility.isProfileIncomplete),
  };
}

export function shouldUseBatchExtractedFacilityForEdit(_order = {}) {
  // Batch-scan orders keep the selected facility; extracted is informational only.
  return false;
}

export async function resolveBatchMismatchFacilityForEdit(order = {}) {
  if (!shouldUseBatchExtractedFacilityForEdit(order)) {
    return null;
  }

  return resolvePendingFacility({
    facilityId: order.extractedFacilityId,
    facilityName: order.extractedFacilityName || "",
    allowCreate: false,
  });
}

export async function refreshFacilityProfileStatus(facilityId) {
  const id = `${facilityId || ""}`.trim();
  if (!id) {
    return {
      facilityProfileIncomplete: false,
      facilityCreated: false,
      facilityReactivated: false,
    };
  }

  const facility = await getFacility(id);
  return {
    facilityProfileIncomplete: Boolean(facility?.isProfileIncomplete),
    facilityCreated: Boolean(facility?.isAutoCreated),
    facilityReactivated: false,
  };
}
