"use client";

import { useEffect, useMemo, useState } from "react";
import FilterSelect from "@/components/ui/FilterSelect";
import { getApiErrorMessage } from "@/lib/apiErrorUtils";
import { getFacilities } from "@/lib/facilities/facilityApi";
import { ORDER_PERIOD_OPTIONS } from "@/lib/orders/orderFilterConstants";

const MAX_SEARCH_LENGTH = 200;

export const defaultPersonalOrderFilters = {
  facility: "",
  status: "",
  year: "",
  period: "",
  search: "",
  sortDir: "",
};

const STATUS_OPTIONS = [
  { value: "", label: "All Statuses" },
  { value: "in_process", label: "In Process" },
  { value: "invoice", label: "Invoice" },
  { value: "paid", label: "Paid" },
  { value: "released", label: "Released" },
];

const SELECT_CLASS =
  "h-[36px] rounded-[6px] border border-[#E2E8F0] bg-white px-3 text-[13px] text-[#111827] outline-none focus:border-[#0097B2] disabled:cursor-not-allowed disabled:opacity-60";

function clampSearch(value) {
  return `${value || ""}`.trim().slice(0, MAX_SEARCH_LENGTH);
}

export default function PersonalOrderFilterBar({ filters, onFiltersChange }) {
  const [draftFilters, setDraftFilters] = useState(defaultPersonalOrderFilters);
  const [searchDraft, setSearchDraft] = useState("");
  const [facilities, setFacilities] = useState([]);
  const [facilitiesLoadError, setFacilitiesLoadError] = useState("");

  const appliedFilters = filters || defaultPersonalOrderFilters;

  const yearOptions = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return Array.from({ length: 8 }, (_, index) => String(currentYear - index));
  }, []);

  useEffect(() => {
    setDraftFilters({
      facility: appliedFilters.facility || "",
      status: appliedFilters.status || "",
      year: appliedFilters.year || "",
      period: appliedFilters.period || "",
    });
    setSearchDraft(appliedFilters.search || "");
  }, [
    appliedFilters.facility,
    appliedFilters.status,
    appliedFilters.year,
    appliedFilters.period,
    appliedFilters.search,
  ]);

  useEffect(() => {
    let active = true;
    getFacilities()
      .then((data) => {
        if (!active) return;
        setFacilities(data);
        setFacilitiesLoadError("");
      })
      .catch((err) => {
        if (!active) return;
        setFacilities([]);
        setFacilitiesLoadError(
          getApiErrorMessage(err, "Failed to load facilities")
        );
      });
    return () => {
      active = false;
    };
  }, []);

  const facilitySelectOptions = useMemo(
    () => [
      { value: "", label: "All facilities" },
      ...(facilities || []).map((facility) => ({
        value: String(facility.id),
        label:
          facility.facility ||
          facility.facilityName ||
          facility.name ||
          `Facility ${facility.id}`,
      })),
    ],
    [facilities]
  );

  const yearSelectOptions = useMemo(
    () => [
      { value: "", label: "All years" },
      ...yearOptions.map((year) => ({ value: year, label: year })),
    ],
    [yearOptions]
  );

  return (
    <section className="relative z-20 overflow-visible rounded-[9px] border border-[#E2E8F0] bg-white px-4 py-3 shadow-sm">
      <div className="flex flex-wrap items-end gap-3 overflow-visible">
        <label className="flex min-w-[180px] flex-1 flex-col gap-1 text-[11px] font-semibold text-[#64748B]">
          Facility
          <FilterSelect
            value={draftFilters.facility}
            onChange={(next) =>
              setDraftFilters((prev) => ({ ...prev, facility: next }))
            }
            options={facilitySelectOptions}
            disabled={Boolean(facilitiesLoadError)}
            aria-label="Facility"
            className={SELECT_CLASS}
          />
        </label>

        <label className="flex min-w-[120px] flex-col gap-1 text-[11px] font-semibold text-[#64748B]">
          Year
          <FilterSelect
            value={draftFilters.year}
            onChange={(next) =>
              setDraftFilters((prev) => ({ ...prev, year: next }))
            }
            options={yearSelectOptions}
            aria-label="Year"
            className={SELECT_CLASS}
          />
        </label>

        <label className="flex min-w-[150px] flex-col gap-1 text-[11px] font-semibold text-[#64748B]">
          Period
          <FilterSelect
            value={draftFilters.period}
            onChange={(next) =>
              setDraftFilters((prev) => ({ ...prev, period: next }))
            }
            options={ORDER_PERIOD_OPTIONS}
            aria-label="Period"
            className={SELECT_CLASS}
          />
        </label>

        <label className="flex min-w-[160px] flex-col gap-1 text-[11px] font-semibold text-[#64748B]">
          Status
          <FilterSelect
            value={draftFilters.status}
            onChange={(next) =>
              setDraftFilters((prev) => ({ ...prev, status: next }))
            }
            options={STATUS_OPTIONS}
            aria-label="Status"
            className={SELECT_CLASS}
          />
        </label>

        <button
          type="button"
          onClick={() =>
            onFiltersChange?.({
              ...draftFilters,
              // Keep column sort (↑/↓); draft does not edit sortDir.
              sortDir:
                appliedFilters.sortDir === "asc" ||
                appliedFilters.sortDir === "desc"
                  ? appliedFilters.sortDir
                  : "",
              search: appliedFilters.search || "",
            })
          }
          className="h-[36px] rounded-[6px] bg-[#0097B2] px-4 text-[13px] font-semibold text-white hover:bg-[#0086A0]"
        >
          Apply
        </button>

        <button
          type="button"
          onClick={() => {
            setDraftFilters(defaultPersonalOrderFilters);
            setSearchDraft("");
            onFiltersChange?.(defaultPersonalOrderFilters);
          }}
          className="h-[36px] rounded-[6px] border border-[#E2E8F0] bg-white px-4 text-[13px] font-semibold text-[#334155] hover:bg-[#F8FAFC]"
        >
          Reset
        </button>

        <div className="flex min-w-[240px] flex-[2] items-end gap-2">
          <label className="flex flex-1 flex-col gap-1 text-[11px] font-semibold text-[#64748B]">
            Search
            <input
              value={searchDraft}
              maxLength={MAX_SEARCH_LENGTH}
              onChange={(e) => setSearchDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onFiltersChange?.({
                    ...appliedFilters,
                    search: clampSearch(searchDraft),
                  });
                }
              }}
              placeholder="Confirmation #, name, email…"
              className="h-[36px] rounded-[6px] border border-[#E2E8F0] px-3 text-[13px] outline-none focus:border-[#0097B2]"
            />
          </label>
          <button
            type="button"
            onClick={() =>
              onFiltersChange?.({
                ...appliedFilters,
                search: clampSearch(searchDraft),
              })
            }
            className="h-[36px] rounded-[6px] border border-[#E2E8F0] bg-white px-4 text-[13px] font-semibold text-[#334155] hover:bg-[#F8FAFC]"
          >
            Search
          </button>
        </div>
      </div>

      {facilitiesLoadError ? (
        <p className="mt-2 text-[11px] text-red-500">{facilitiesLoadError}</p>
      ) : null}
    </section>
  );
}
