"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { getApiErrorMessage } from "@/lib/apiErrorUtils";
import { searchOrderDoctors } from "@/lib/orders/orderApi";

function namesMatch(left = "", right = "") {
  return (
    `${left || ""}`.trim().localeCompare(`${right || ""}`.trim(), undefined, {
      sensitivity: "accent",
    }) === 0
  );
}

function DoctorStatusNote({
  tone = "info",
  title,
  message,
  linkHref = "",
  linkLabel = "",
  onLinkClick,
  actionLabel = "",
  onAction,
  actionDisabled = false,
}) {
  const styles = {
    info: {
      wrap: "border-[#BAE6FD] bg-[#F0F9FF]",
      title: "text-[#0369A1]",
      message: "text-[#0C4A6E]",
      link: "text-[#007F96]",
    },
    success: {
      wrap: "border-[#BBF7D0] bg-[#F0FDF4]",
      title: "text-[#047857]",
      message: "text-[#065F46]",
      link: "text-[#047857]",
    },
    warning: {
      wrap: "border-[#FDE68A] bg-[#FFFBEB]",
      title: "text-[#B45309]",
      message: "text-[#92400E]",
      link: "text-[#007F96]",
    },
  }[tone];

  return (
    <div className={`mt-2 rounded-[6px] border px-3 py-2 ${styles.wrap}`}>
      {title ? (
        <p className={`text-[11px] font-semibold ${styles.title}`}>{title}</p>
      ) : null}
      {message ? (
        <p className={`${title ? "mt-1" : ""} text-[10px] leading-snug ${styles.message}`}>
          {message}
        </p>
      ) : null}
      {linkHref || actionLabel ? (
        <div
          className={`${title || message ? "mt-2" : ""} flex flex-wrap items-center gap-x-3 gap-y-1`}
        >
          {linkHref ? (
            <Link
              href={linkHref}
              onClick={() => onLinkClick?.()}
              className={`inline-flex text-[11px] font-semibold underline ${styles.link}`}
            >
              {linkLabel}
            </Link>
          ) : null}
          {actionLabel ? (
            <button
              type="button"
              disabled={actionDisabled}
              onClick={() => onAction?.()}
              className={`inline-flex text-[11px] font-semibold underline disabled:cursor-not-allowed disabled:opacity-50 ${styles.link}`}
            >
              {actionLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function DoctorSearchField({
  label = "Specific Doctor",
  name = "specificDoctor",
  value = "",
  facilityId = "",
  facilityName = "",
  specificDoctorIsDefault = false,
  specificDoctorId = "",
  extractedDoctorName = "",
  onChange,
  onBlur,
  placeholder = "Doctor name",
  required = false,
  error = "",
  missingDefaultDoctor = false,
  doctorCreated = false,
  resolvingDoctor = false,
  returnToOrderPath = "",
  onBeforeFacilityProfileNavigate,
  onUseDefaultDoctor,
  isPersonalPortal = false,
  doctorNotInSystem = false,
  facilityNotInSystem = false,
  orderEndedNoFacility = false,
  onDoctorBlur,
}) {
  const listboxId = useId();
  const rootRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [searchError, setSearchError] = useState("");
  const [searchSettled, setSearchSettled] = useState(false);
  const [queryMatchesFacility, setQueryMatchesFacility] = useState(false);

  const requestedDoctor = `${extractedDoctorName || ""}`.trim();
  const doctorNameForAdd = requestedDoctor || `${value || ""}`.trim();
  const facilityDoctorsHref = facilityId
    ? (() => {
        const params = new URLSearchParams();
        if (returnToOrderPath) params.set("returnTo", returnToOrderPath);
        params.set("focus", "doctors");
        if (doctorNameForAdd) params.set("doctorName", doctorNameForAdd);
        return `/facilities/${facilityId}/info?${params.toString()}`;
      })()
    : "";

  const statusNote = useMemo(() => {
    if (resolvingDoctor) {
      return {
        tone: "info",
        title: "Updating doctor for this facility",
        message: isPersonalPortal
          ? "Matching the requested treating doctor, or applying the facility default when none was requested."
          : "Checking the selected facility and applying its default doctor when available.",
      };
    }

    if (!facilityId || orderEndedNoFacility) {
      return null;
    }

    const trimmedValue = `${value || ""}`.trim();
    const trimmedExtracted = requestedDoctor;
    const facilityLabel = `${facilityName || "this facility"}`.trim();
    const canUseDefault = typeof onUseDefaultDoctor === "function";

    const typedNameMissingOnFacility =
      trimmedValue.length >= 1 &&
      !specificDoctorIsDefault &&
      !`${specificDoctorId || ""}`.trim() &&
      !resolvingDoctor &&
      searchSettled &&
      !queryMatchesFacility;

    const doctorMissing =
      doctorNotInSystem ||
      (isPersonalPortal && typedNameMissingOnFacility) ||
      (!isPersonalPortal && typedNameMissingOnFacility && Boolean(trimmedValue));

    if (isPersonalPortal && facilityNotInSystem) {
      return {
        tone: "warning",
        title: "Add facility before doctor",
        message: trimmedExtracted
          ? `Requested treating doctor: ${trimmedExtracted}. Add the facility to the system first, then add this doctor on the facility profile.`
          : "Add the facility to the system first. If a treating doctor was requested, you can add them after the facility is linked.",
      };
    }

    if (doctorMissing && (trimmedExtracted || trimmedValue)) {
      const missingName =
        typedNameMissingOnFacility && trimmedValue
          ? trimmedValue
          : trimmedExtracted || trimmedValue;
      return {
        tone: "warning",
        title: isPersonalPortal
          ? "Specific doctor not in facility"
          : "Doctor not on this facility yet",
        message: isPersonalPortal
          ? `${missingName} is not on ${facilityLabel} yet (this facility has no matching doctor).`
          : `${missingName} is not linked to ${facilityLabel}. Add them on the facility profile, or use the facility default doctor.`,
        linkHref: facilityDoctorsHref,
        linkLabel: "Add this doctor to facility",
        actionLabel: canUseDefault ? "Use facility default doctor" : "",
        onAction: onUseDefaultDoctor,
      };
    }

    if (missingDefaultDoctor) {
      return {
        tone: "warning",
        title: "No default doctor for this facility",
        message: isPersonalPortal
          ? trimmedExtracted
            ? `Requested treating doctor is not on ${facilityLabel}. Add that doctor, or add/select a default doctor, then return here.`
            : `No treating doctor was requested. Add a default doctor on the facility profile, then return here to continue.`
          : trimmedExtracted || trimmedValue
            ? `No default doctor is set for ${facilityLabel}. Add the doctor from the subpoena/typing on the facility profile, or add a default doctor there.`
            : `No doctor is required. You can leave this blank, or add a default doctor on the facility profile to use later.`,
        linkHref: facilityDoctorsHref,
        linkLabel: "Open facility profile to add doctors",
      };
    }

    if (!trimmedValue) {
      if (!isPersonalPortal) {
        return trimmedExtracted
          ? {
              tone: "info",
              title: "Doctor optional",
              message: `Subpoena listed ${trimmedExtracted}. Add that doctor on the facility profile, use the facility default, or leave blank.`,
              linkHref: facilityDoctorsHref,
              linkLabel: "Add this doctor to facility",
              actionLabel: canUseDefault ? "Use facility default doctor" : "",
              onAction: onUseDefaultDoctor,
            }
          : null;
      }

      if (!trimmedExtracted && !missingDefaultDoctor) {
        return null;
      }

      return {
        tone: "warning",
        title: "No doctor selected",
        message: `Choose a doctor for ${facilityLabel}, or add one on the facility profile.`,
        linkHref: facilityDoctorsHref,
        linkLabel: "Open facility profile to add doctors",
      };
    }

    if (doctorCreated && trimmedExtracted && !isPersonalPortal) {
      return {
        tone: "success",
        title: "Doctor added from subpoena",
        message: `${trimmedValue} was created for ${facilityLabel} based on the uploaded subpoena.`,
        linkHref: facilityDoctorsHref,
        linkLabel: "Add another doctor",
      };
    }

    if (specificDoctorIsDefault) {
      return {
        tone: "info",
        title: "Using facility default doctor",
        message: isPersonalPortal
          ? `${trimmedValue} is the default doctor for ${facilityLabel}. No treating doctor was requested.`
          : `${trimmedValue} is the default doctor for ${facilityLabel}.`,
        linkHref: facilityDoctorsHref,
        linkLabel: "Add another doctor",
      };
    }

    if (trimmedExtracted) {
      if (namesMatch(trimmedValue, trimmedExtracted) && !doctorMissing) {
        return {
          tone: "info",
          title: isPersonalPortal
            ? "Matched requested treating doctor"
            : "Matched from subpoena",
          message: isPersonalPortal
            ? `${trimmedValue} matches the treating doctor from the personal request.`
            : `${trimmedValue} was identified on the uploaded subpoena.`,
          linkHref: facilityDoctorsHref,
          linkLabel: "Add another doctor",
        };
      }

      if (!doctorMissing) {
        return {
          tone: "info",
          title: "Doctor updated from facility profile",
          message: isPersonalPortal
            ? `The request listed ${trimmedExtracted}. The facility profile now shows ${trimmedValue}.`
            : `The subpoena listed ${trimmedExtracted}. The facility profile now shows ${trimmedValue}.`,
          linkHref: facilityDoctorsHref,
          linkLabel: "Add another doctor",
        };
      }
    }

    if (doctorMissing) {
      return null;
    }

    if (
      isPersonalPortal &&
      trimmedValue &&
      !specificDoctorIsDefault &&
      !`${specificDoctorId || ""}`.trim() &&
      !searchSettled
    ) {
      return null;
    }

    if (
      isPersonalPortal &&
      trimmedValue &&
      !specificDoctorIsDefault &&
      !`${specificDoctorId || ""}`.trim() &&
      searchSettled &&
      !queryMatchesFacility
    ) {
      return null;
    }

    return {
      tone: "info",
      title: "Doctor selected",
      message: `${trimmedValue} is linked to ${facilityLabel}.`,
      linkHref: facilityDoctorsHref,
      linkLabel: "Add another doctor",
    };
  }, [
    resolvingDoctor,
    facilityId,
    facilityName,
    value,
    requestedDoctor,
    missingDefaultDoctor,
    doctorCreated,
    specificDoctorIsDefault,
    specificDoctorId,
    facilityDoctorsHref,
    isPersonalPortal,
    doctorNotInSystem,
    facilityNotInSystem,
    orderEndedNoFacility,
    searchSettled,
    queryMatchesFacility,
    onUseDefaultDoctor,
  ]);

  useEffect(() => {
    const query = value.trim();
    const shouldSearch =
      Boolean(facilityId) &&
      query.length >= 1 &&
      (open ||
        (!specificDoctorIsDefault &&
          !facilityNotInSystem &&
          (isPersonalPortal || !`${specificDoctorId || ""}`.trim())));

    if (!shouldSearch) {
      if (!query.length) {
        setSuggestions([]);
        setLoading(false);
        setSearchError("");
        setSearchSettled(false);
        setQueryMatchesFacility(false);
      }
      return undefined;
    }

    let active = true;
    setLoading(true);
    setSearchError("");
    setSearchSettled(false);

    const timer = setTimeout(() => {
      searchOrderDoctors(query, { facility: facilityId })
        .then((doctors) => {
          if (!active) return;
          if (open) {
            setSuggestions(doctors);
          }
          setQueryMatchesFacility(
            doctors.some((doctor) => namesMatch(doctor, query))
          );
          setSearchSettled(true);
        })
        .catch((err) => {
          if (!active) return;
          if (open) {
            setSuggestions([]);
          }
          setSearchError(getApiErrorMessage(err, "Failed to search doctors"));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 300);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    value,
    open,
    facilityId,
    isPersonalPortal,
    facilityNotInSystem,
    specificDoctorIsDefault,
    specificDoctorId,
  ]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const hasError = Boolean(error);
  const showSuggestions = open && value.trim().length >= 1;

  const emitChange = (nextValue) => {
    onChange?.({
      target: {
        name,
        value: nextValue,
      },
    });
  };

  return (
    <div ref={rootRef} className="relative min-w-0">
      <label className="mb-[6px] block text-[11px] font-semibold text-[#475569]">
        {label}
        {required ? <span className="text-red-500"> *</span> : null}
      </label>

      <input
        type="text"
        name={name}
        value={value}
        onChange={(event) => {
          emitChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={(event) => {
          onBlur?.(event);
          onDoctorBlur?.(event);
        }}
        placeholder={placeholder}
        className={`h-[38px] w-full rounded-[6px] border bg-white px-3 text-[13px] text-[#111827] outline-none placeholder:text-[#94A3B8] focus:ring-2 ${
          hasError
            ? "border-red-500 focus:border-red-500 focus:ring-red-500/10"
            : "border-[#E2E8F0] focus:border-[#0097B2] focus:ring-[#0097B2]/10"
        }`}
        role="combobox"
        aria-expanded={showSuggestions}
        aria-controls={listboxId}
        autoComplete="off"
      />

      {statusNote ? (
        <DoctorStatusNote
          tone={statusNote.tone}
          title={statusNote.title}
          message={statusNote.message}
          linkHref={statusNote.linkHref}
          linkLabel={statusNote.linkLabel}
          onLinkClick={onBeforeFacilityProfileNavigate}
          actionLabel={statusNote.actionLabel}
          onAction={statusNote.onAction}
          actionDisabled={resolvingDoctor}
        />
      ) : null}

      {error ? (
        <p className="mt-[5px] text-[11px] font-medium text-red-500">{error}</p>
      ) : null}

      {showSuggestions && (
        <ul
          id={listboxId}
          className="absolute z-20 mt-1 max-h-[220px] w-full overflow-auto rounded-[6px] border border-[#E2E8F0] bg-white py-1 shadow-lg"
        >
          {loading && (
            <li className="px-3 py-2 text-[12px] text-[#94A3B8]">Searching...</li>
          )}

          {!loading && searchError && (
            <li className="px-3 py-2 text-[12px] text-red-500">{searchError}</li>
          )}

          {!loading &&
            !searchError &&
            suggestions.map((doctor) => (
              <li key={doctor}>
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    emitChange(doctor);
                    setOpen(false);
                  }}
                  className="block w-full px-3 py-2 text-left text-[12px] font-medium text-[#111827] hover:bg-[#F0FBFD]"
                >
                  {doctor}
                </button>
              </li>
            ))}

          {!loading && !searchError && suggestions.length === 0 && (
            <li className="px-3 py-2 text-[12px] text-[#94A3B8]">
              {facilityDoctorsHref ? (
                <>
                  No matching doctors —{" "}
                  <Link
                    href={facilityDoctorsHref}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onBeforeFacilityProfileNavigate?.()}
                    className="font-semibold text-[#007F96] underline"
                  >
                    Add this doctor to facility
                  </Link>
                  {!isPersonalPortal && onUseDefaultDoctor ? (
                    <>
                      {" "}
                      or{" "}
                      <button
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => {
                          setOpen(false);
                          onUseDefaultDoctor();
                        }}
                        className="font-semibold text-[#007F96] underline"
                      >
                        use default
                      </button>
                    </>
                  ) : null}
                </>
              ) : (
                "No matching doctors"
              )}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
