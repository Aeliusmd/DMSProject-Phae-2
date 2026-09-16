import { resolveFacilityDoctor } from "@/lib/facilities/facilityApi";

export function hasSubpoenaExtractedDoctor(
  extractionMeta = {},
  formSnapshot = {}
) {
  const extracted = `${extractionMeta.extractedDoctorName || ""}`.trim();
  if (extracted) return true;

  return Boolean(
    `${formSnapshot.specificDoctor || ""}`.trim() &&
      !formSnapshot.specificDoctorIsDefault
  );
}

export function normalizeDoctorResolution(
  resolved,
  { extractedDoctorName = "", priorDoctorCreated = false } = {}
) {
  const extracted = `${extractedDoctorName || ""}`.trim();

  if (!extracted) {
    return resolved;
  }

  if (!`${resolved?.specificDoctor || ""}`.trim()) {
    return {
      ...resolved,
      specificDoctorIsDefault: false,
      doctorCreated: false,
      missingDefaultDoctor: true,
    };
  }

  return {
    ...resolved,
    specificDoctorIsDefault: false,
    doctorCreated: Boolean(priorDoctorCreated || resolved.doctorCreated),
    missingDefaultDoctor: false,
  };
}

export function mapResolvedDoctorFields(resolved = {}) {
  return {
    specificDoctor: resolved.specificDoctor || "",
    specificDoctorId: resolved.specificDoctorId || "",
    specificDoctorIsDefault: Boolean(resolved.specificDoctorIsDefault),
    missingDefaultDoctor: Boolean(resolved.missingDefaultDoctor),
    doctorCreated: Boolean(resolved.doctorCreated),
    doctorMissing: Boolean(resolved.doctorMissing),
  };
}

export async function resolvePendingDoctor({
  facilityId,
  doctorId = "",
  doctorName = "",
  allowCreate = true,
  useDefaultWhenMissing,
} = {}) {
  const id = `${facilityId || ""}`.trim();

  if (!id) {
    return {
      specificDoctor: "",
      specificDoctorId: "",
      specificDoctorIsDefault: false,
      doctorCreated: false,
      missingDefaultDoctor: false,
      doctorMissing: false,
    };
  }

  const trimmedName = `${doctorName || ""}`.trim();
  const trimmedDoctorId = `${doctorId || ""}`.trim();
  const shouldUseDefault =
    useDefaultWhenMissing != null
      ? Boolean(useDefaultWhenMissing)
      : !trimmedName && !trimmedDoctorId;

  const result = await resolveFacilityDoctor(id, {
    doctorId: trimmedDoctorId || undefined,
    doctorName: trimmedName || undefined,
    useDefaultWhenMissing: shouldUseDefault,
    allowCreate,
  });

  return {
    specificDoctor: result.doctorName || "",
    specificDoctorId: result.doctor?.id ? String(result.doctor.id) : "",
    specificDoctorIsDefault: Boolean(result.usedDefault),
    doctorCreated: Boolean(result.created),
    missingDefaultDoctor: Boolean(result.missingDefault),
    doctorMissing: Boolean(result.doctorMissing),
  };
}

export async function resolvePendingDoctorForOrder({
  facilityId,
  doctorId = "",
  doctorName = "",
  extractedDoctorName = "",
  priorDoctorCreated = false,
  // Order form never auto-creates; user adds via facility profile or uses default.
  allowCreate = false,
  useDefaultWhenMissing,
} = {}) {
  return mapResolvedDoctorFields(
    normalizeDoctorResolution(
      await resolvePendingDoctor({
        facilityId,
        doctorId,
        doctorName,
        allowCreate,
        useDefaultWhenMissing,
      }),
      { extractedDoctorName, priorDoctorCreated }
    )
  );
}

/** Re-match doctor after returning from facility profile / add-doctor (avoid stale doctorId). */
export function buildDoctorResolveAfterFacilityReturn({
  formSnapshot = {},
  extractionMeta = {},
  options = {},
} = {}) {
  const isPersonalPortal = formSnapshot.creationSource === "personal_portal";
  const typedDoctor = `${formSnapshot.specificDoctor || ""}`.trim();
  const requestedDoctor = `${
    formSnapshot.requestedTreatingDoctor ||
    formSnapshot.newFacilityRequest?.treatingDoctor ||
    ""
  }`.trim();
  const extractedDoctorName = `${extractionMeta.extractedDoctorName || ""}`.trim();
  const hadDoctorMissing = Boolean(formSnapshot.doctorNotInSystem);
  const forceByName =
    options.forceByName !== false &&
    (hadDoctorMissing ||
      !`${formSnapshot.specificDoctorId || ""}`.trim() ||
      (isPersonalPortal && typedDoctor && !formSnapshot.specificDoctorIsDefault));

  const doctorId = forceByName ? "" : `${formSnapshot.specificDoctorId || ""}`.trim();

  let doctorName = typedDoctor || extractedDoctorName;
  if (isPersonalPortal) {
    doctorName = forceByName && typedDoctor ? typedDoctor : requestedDoctor || typedDoctor;
  }

  const personalHasDoctorHint = isPersonalPortal && Boolean(doctorName);

  return {
    doctorId,
    doctorName,
    extractedDoctorName: isPersonalPortal ? requestedDoctor : extractedDoctorName,
    priorDoctorCreated: Boolean(extractionMeta.doctorCreated),
    allowCreate: false,
    useDefaultWhenMissing: isPersonalPortal ? !personalHasDoctorHint : !doctorName,
  };
}

export function applyResolvedDoctorToForm(nextForm, doctorResolved) {
  return {
    ...nextForm,
    specificDoctor: doctorResolved.specificDoctor,
    specificDoctorId: doctorResolved.specificDoctorId,
    specificDoctorIsDefault: doctorResolved.specificDoctorIsDefault,
    doctorNotInSystem: Boolean(doctorResolved.doctorMissing),
  };
}
