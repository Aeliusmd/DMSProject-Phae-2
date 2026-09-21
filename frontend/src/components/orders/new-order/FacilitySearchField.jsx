"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { getApiErrorMessage } from "@/lib/apiErrorUtils";
import { searchFacilities } from "@/lib/facilities/facilityApi";

export default function FacilitySearchField({
  label = "Facility",
  value = "",
  facilityId = "",
  onInputChange,
  onSelect,
  onBlur,
  onCommit,
  facilityProfileIncomplete = false,
  facilityCreated = false,
  facilityReactivated = false,
  returnToOrderPath = "",
  onBeforeFacilityProfileNavigate,
  resolving = false,
  hint = "",
  required = false,
  error = "",
  allowCreateFacility = true,
  createDisabledMessage = "",
}) {
  const listboxId = useId();
  const rootRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [searchError, setSearchError] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const skipBlurCommitRef = useRef(false);

  const commitFacility = onCommit || onBlur;
  const trimmedValue = value.trim();
  const hasError = Boolean(error);
  const showSuggestions = open && trimmedValue.length >= 2;
  const facilityInfoHref = facilityId
    ? returnToOrderPath
      ? `/facilities/${facilityId}/info?returnTo=${encodeURIComponent(returnToOrderPath)}`
      : `/facilities/${facilityId}/info`
    : "";
  const newFacilityHref = (() => {
    const params = new URLSearchParams();
    if (trimmedValue) params.set("facilityName", trimmedValue);
    if (returnToOrderPath) params.set("returnTo", returnToOrderPath);
    const query = params.toString();
    return `/facilities/new${query ? `?${query}` : ""}`;
  })();

  const hasExactMatch = suggestions.some((facility) => {
    const name = `${facility.facility || facility.facilityName || ""}`.trim();
    return name.toLowerCase() === trimmedValue.toLowerCase();
  });

  const showAddOption =
    allowCreateFacility && Boolean(trimmedValue) && !hasExactMatch;

  const listItems = showAddOption
    ? [{ type: "add", label: trimmedValue }, ...suggestions.map((f) => ({ type: "facility", facility: f }))]
    : suggestions.map((f) => ({ type: "facility", facility: f }));

  useEffect(() => {
    const query = trimmedValue;

    if (!open || query.length < 2) {
      setSuggestions([]);
      setLoading(false);
      setSearchError("");
      return undefined;
    }

    let active = true;
    setLoading(true);
    setSearchError("");

    const timer = setTimeout(() => {
      searchFacilities(query)
        .then((facilities) => {
          if (!active) return;
          setSuggestions(facilities);
        })
        .catch((err) => {
          if (!active) return;
          setSuggestions([]);
          setSearchError(getApiErrorMessage(err, "Failed to search facilities"));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 300);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [trimmedValue, open]);

  useEffect(() => {
    setHighlightIndex(-1);
  }, [suggestions, trimmedValue, showAddOption]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selectFacility = (facility) => {
    skipBlurCommitRef.current = true;
    onSelect(facility);
    setOpen(false);
    setHighlightIndex(-1);
  };

  const confirmTypedFacility = (typedValue = trimmedValue) => {
    const nextValue = `${typedValue || ""}`.trim();
    setOpen(false);
    setHighlightIndex(-1);

    if (!nextValue) {
      return;
    }

    if (!allowCreateFacility) {
      return;
    }

    skipBlurCommitRef.current = true;

    if (onCommit) {
      onCommit(nextValue);
      return;
    }

    commitFacility?.();
  };

  const activateListItem = (item) => {
    if (item.type === "add") {
      confirmTypedFacility();
      return;
    }

    selectFacility(item.facility);
  };

  const handleKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      if (!showSuggestions || loading || listItems.length === 0) return;
      e.preventDefault();
      setHighlightIndex((index) => Math.min(index + 1, listItems.length - 1));
      return;
    }

    if (e.key === "ArrowUp") {
      if (!showSuggestions || loading || listItems.length === 0) return;
      e.preventDefault();
      setHighlightIndex((index) => Math.max(index - 1, 0));
      return;
    }

    if (e.key === "Escape") {
      setOpen(false);
      setHighlightIndex(-1);
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();

      if (showSuggestions && !loading && highlightIndex >= 0 && listItems[highlightIndex]) {
        activateListItem(listItems[highlightIndex]);
        return;
      }

      confirmTypedFacility(e.currentTarget.value);
    }
  };

  return (
    <div ref={rootRef} className="relative min-w-0">
      <label className="mb-[6px] block text-[11px] font-semibold text-[#475569]">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </label>

      <input
        type="text"
        value={value}
        onChange={(e) => {
          onInputChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={(e) => {
          if (rootRef.current?.contains(e.relatedTarget)) return;

          if (skipBlurCommitRef.current) {
            skipBlurCommitRef.current = false;
            return;
          }

          if (onCommit) {
            const nextValue = e.currentTarget.value.trim();
            if (nextValue && allowCreateFacility) {
              onCommit(nextValue);
            }
            return;
          }

          onBlur?.();
        }}
        onKeyDown={handleKeyDown}
        placeholder={
          allowCreateFacility
            ? "Search or type facility name"
            : "Search and select an existing facility"
        }
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

      {resolving && (
        <p className="mt-[4px] text-[10px] text-[#64748B]">Resolving facility...</p>
      )}

      {facilityId && !facilityProfileIncomplete && !resolving && allowCreateFacility && (
        <p className="mt-[4px] text-[10px] font-medium text-[#059669]">
          {facilityReactivated
            ? "Previously deleted facility restored and selected"
            : facilityCreated
              ? "Facility added"
              : "Existing facility selected"}
        </p>
      )}

      {facilityId && facilityProfileIncomplete && !resolving && allowCreateFacility && (
        <div className="mt-2 rounded-[6px] border border-[#FDE68A] bg-[#FFFBEB] px-3 py-2">
          <p className="text-[11px] font-semibold text-[#B45309]">
            {facilityReactivated
              ? "Previously deleted facility was restored"
              : facilityCreated
                ? "Facility was automatically created"
                : "Facility profile is incomplete"}
          </p>
          <p className="mt-1 text-[10px] leading-snug text-[#92400E]">
            {facilityReactivated
              ? "This facility was soft-deleted earlier and has been reactivated for this order. Complete the facility details before continuing."
              : "Complete the facility details before continuing this order."}
          </p>
          <Link
            href={facilityInfoHref}
            onClick={() => onBeforeFacilityProfileNavigate?.()}
            className="mt-2 inline-flex text-[11px] font-semibold text-[#007F96] underline"
          >
            Open facility profile to complete
          </Link>
        </div>
      )}

      {!facilityId && trimmedValue && !resolving && allowCreateFacility && (
        <p className="mt-[4px] text-[10px] text-[#94A3B8]">
          Press Enter or pick from the list to add this facility
        </p>
      )}

      {!facilityId && trimmedValue && !resolving && !allowCreateFacility && (
        <p className="mt-[4px] text-[10px] text-[#94A3B8]">
          Select an existing facility from the list, or use Add this facility to
          system below
        </p>
      )}

      {hint && (
        <p className="mt-[4px] text-[10px] font-medium text-[#059669]">{hint}</p>
      )}

      {error && (
        <p className="mt-[5px] text-[11px] font-medium text-red-500">
          {error}
        </p>
      )}

      {showSuggestions && (
        <ul
          id={listboxId}
          className="absolute z-20 mt-1 max-h-[220px] w-full overflow-auto rounded-[6px] border border-[#E2E8F0] bg-white py-1 shadow-lg"
        >
          {loading && (
            <li className="px-3 py-2 text-[12px] text-[#94A3B8]">
              Searching...
            </li>
          )}

          {!loading && searchError && (
            <li className="px-3 py-2 text-[12px] text-red-500">{searchError}</li>
          )}

          {!loading && !searchError && showAddOption && (
            <li>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => confirmTypedFacility(trimmedValue)}
                className={`block w-full px-3 py-2 text-left ${
                  highlightIndex === 0 ? "bg-[#F0FBFD]" : "hover:bg-[#F0FBFD]"
                }`}
              >
                <span className="block text-[12px] font-semibold text-[#007F96]">
                  Add &ldquo;{trimmedValue}&rdquo; as facility
                </span>
                <span className="block text-[10px] text-[#94A3B8]">
                  Press Enter to confirm
                </span>
              </button>

              <Link
                href={newFacilityHref}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onBeforeFacilityProfileNavigate?.()}
                className="block px-3 pb-2 text-[10px] font-semibold text-[#007F96] underline"
              >
                Or create the full facility profile now
              </Link>
            </li>
          )}

          {!loading &&
            !searchError &&
            suggestions.map((facility, index) => {
              const itemIndex = showAddOption ? index + 1 : index;

              return (
                <li key={facility.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => selectFacility(facility)}
                    className={`block w-full px-3 py-2 text-left ${
                      highlightIndex === itemIndex
                        ? "bg-[#F0FBFD]"
                        : "hover:bg-[#F0FBFD]"
                    }`}
                  >
                    <span className="block text-[12px] font-semibold text-[#111827]">
                      {facility.facility || facility.facilityName}
                    </span>
                    {(facility.city || facility.state) && (
                      <span className="block text-[10px] text-[#94A3B8]">
                        {[facility.city, facility.state].filter(Boolean).join(", ")}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}

          {!loading && !searchError && suggestions.length === 0 && !showAddOption && (
            <li className="px-3 py-2 text-[12px] text-[#94A3B8]">
              {allowCreateFacility
                ? "No matching facilities — continue typing to add a new one"
                : "No matching facilities — select an existing facility or restore this order to In Process"}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
