"use client";

import { useEffect, useMemo, useState } from "react";
import FilterSelect from "@/components/ui/FilterSelect";
import { getApiErrorMessage } from "@/lib/apiErrorUtils";
import { getFacilities } from "@/lib/facilities/facilityApi";
import { getOrderFilterCompanies } from "@/lib/orders/orderApi";
import {
  ORDER_PERIOD_OPTIONS,
  ORDER_SOURCE_COMPANY,
  ORDER_SOURCE_INTERNAL,
  ORDER_SOURCE_PERSONAL,
  getOrderSourceOptions,
  getStatusOptionsForOrderSource,
  isPersonalOrderSource,
  normalizeOrderDateSortDir,
} from "@/lib/orders/orderFilterConstants";
import { STAFF_PORTAL_ORDERS_HIDDEN } from "@/lib/portalNavigationVisibility";

export const defaultOrderFilters = {
  facility: "",
  company: "",
  year: "",
  period: "",
  status: "",
  search: "",
  sortDir: "",
  creationSource: ORDER_SOURCE_INTERNAL,
};

const SELECT_CLASS =
  "h-[34px] w-full min-w-0 rounded-[6px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-[12px] text-[#64748B] outline-none focus:border-[#0097B2] focus:ring-2 focus:ring-[#0097B2]/10 disabled:cursor-not-allowed disabled:opacity-60";

export default function OrderFilterBar({
  filters,
  onFiltersChange,
  showOrderSourceFilter = false,
  /** When source filter is hidden (e.g. Company Orders page), lock status options. */
  statusOptionsVariant = "internal",
}) {
  const [draftFilters, setDraftFilters] = useState(defaultOrderFilters);
  const [searchDraft, setSearchDraft] = useState("");
  const [facilities, setFacilities] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [facilitiesLoadError, setFacilitiesLoadError] = useState("");
  const [companiesLoadError, setCompaniesLoadError] = useState("");

  const appliedFilters = filters || defaultOrderFilters;
  const sourceOptions = getOrderSourceOptions({
    hidePortalOrders: STAFF_PORTAL_ORDERS_HIDDEN,
  });
  const showSourceFilter =
    showOrderSourceFilter &&
    !STAFF_PORTAL_ORDERS_HIDDEN &&
    sourceOptions.length > 1;
  const draftOrderSource = showSourceFilter
    ? draftFilters.creationSource || ORDER_SOURCE_INTERNAL
    : statusOptionsVariant === "company"
      ? ORDER_SOURCE_COMPANY
      : statusOptionsVariant === "personal"
        ? ORDER_SOURCE_PERSONAL
        : ORDER_SOURCE_INTERNAL;
  const isPersonalDraft = isPersonalOrderSource(draftOrderSource);
  const statusOptions = getStatusOptionsForOrderSource(draftOrderSource);

  const yearOptions = useMemo(() => {
    const currentYear = new Date().getFullYear();

    return Array.from({ length: 8 }, (_, index) => String(currentYear - index));
  }, []);

  const facilitySelectOptions = useMemo(
    () => [
      {
        value: "",
        label: facilitiesLoadError ? "Facilities unavailable" : "All Facility",
      },
      ...(facilities || []).map((facility) => ({
        value: String(facility.id),
        label:
          facility.facility || facility.facilityName || facility.name || `Facility ${facility.id}`,
      })),
    ],
    [facilities, facilitiesLoadError]
  );

  const companySelectOptions = useMemo(
    () => [
      {
        value: "",
        label: companiesLoadError ? "Companies unavailable" : "All Company",
      },
      ...(companies || []).map((company) => ({
        value: company,
        label: company,
      })),
    ],
    [companies, companiesLoadError]
  );

  const yearSelectOptions = useMemo(
    () => [
      { value: "", label: "All Year" },
      ...yearOptions.map((year) => ({ value: year, label: year })),
    ],
    [yearOptions]
  );

  useEffect(() => {
    setDraftFilters({
      facility: appliedFilters.facility || "",
      company: appliedFilters.company || "",
      year: appliedFilters.year || "",
      period: appliedFilters.period || "",
      status: appliedFilters.status || "",
      sortDir: normalizeOrderDateSortDir(appliedFilters.sortDir),
      creationSource:
        appliedFilters.creationSource || ORDER_SOURCE_INTERNAL,
    });
    setSearchDraft(appliedFilters.search || "");
  }, [
    appliedFilters.facility,
    appliedFilters.company,
    appliedFilters.year,
    appliedFilters.period,
    appliedFilters.status,
    appliedFilters.sortDir,
    appliedFilters.search,
    appliedFilters.creationSource,
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

    getOrderFilterCompanies()
      .then((data) => {
        if (!active) return;
        setCompanies(data);
        setCompaniesLoadError("");
      })
      .catch((err) => {
        if (!active) return;
        setCompanies([]);
        setCompaniesLoadError(
          getApiErrorMessage(err, "Failed to load companies")
        );
      });

    return () => {
      active = false;
    };
  }, []);

  const updateDraftFilter = (name, value) => {
    setDraftFilters((prev) => {
      const next = {
        ...prev,
        [name]: value,
      };

      // Switching source clears status so incompatible values are not applied.
      if (name === "creationSource") {
        next.status = "";
        if (value === ORDER_SOURCE_PERSONAL) {
          next.company = "";
        }
      }

      return next;
    });
  };

  const handleApplyFilters = () => {
    onFiltersChange?.({
      ...draftFilters,
      // Keep current table sort; sort is controlled from Order Date column arrows.
      sortDir: normalizeOrderDateSortDir(appliedFilters.sortDir),
      company: isPersonalOrderSource(draftFilters.creationSource)
        ? ""
        : draftFilters.company,
      search: appliedFilters.search || "",
    });
  };

  const handleSearch = () => {
    onFiltersChange?.({
      ...appliedFilters,
      search: searchDraft.trim(),
    });
  };

  const handleSearchKeyDown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleSearch();
    }
  };

  const handleReset = () => {
    setDraftFilters(defaultOrderFilters);
    setSearchDraft("");
    onFiltersChange?.(defaultOrderFilters);
  };

  return (
    <section className="relative z-20 min-w-0 overflow-visible rounded-[9px] border border-[#E2E8F0] bg-white px-3 py-4 shadow-sm sm:px-4">
      <h2 className="mb-3 text-[13px] font-semibold text-[#111827]">
        Filters
      </h2>

      <div className="grid min-w-0 grid-cols-1 gap-3 overflow-visible sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-[repeat(auto-fit,minmax(140px,1fr))]">
        {showSourceFilter ? (
          <FilterSelect
            value={draftOrderSource}
            onChange={(next) => updateDraftFilter("creationSource", next)}
            options={sourceOptions}
            aria-label="Order source"
            className={SELECT_CLASS}
          />
        ) : null}

        <div className="min-w-0">
          <FilterSelect
            value={draftFilters.facility}
            onChange={(next) => updateDraftFilter("facility", next)}
            options={facilitySelectOptions}
            disabled={Boolean(facilitiesLoadError)}
            aria-label="Facility"
            className={SELECT_CLASS}
          />
          {facilitiesLoadError && (
            <p className="mt-1 text-[10px] font-medium text-red-600">
              {facilitiesLoadError}
            </p>
          )}
        </div>

        {!isPersonalDraft ? (
          <div className="min-w-0">
            <FilterSelect
              value={draftFilters.company}
              onChange={(next) => updateDraftFilter("company", next)}
              options={companySelectOptions}
              disabled={Boolean(companiesLoadError)}
              aria-label="Company"
              className={SELECT_CLASS}
            />
            {companiesLoadError && (
              <p className="mt-1 text-[10px] font-medium text-red-600">
                {companiesLoadError}
              </p>
            )}
          </div>
        ) : null}

        <FilterSelect
          value={draftFilters.year}
          onChange={(next) => updateDraftFilter("year", next)}
          options={yearSelectOptions}
          aria-label="Year"
          className={SELECT_CLASS}
        />

        <FilterSelect
          value={draftFilters.period || ""}
          onChange={(next) => updateDraftFilter("period", next)}
          options={ORDER_PERIOD_OPTIONS}
          aria-label="Period"
          className={SELECT_CLASS}
        />

        <FilterSelect
          value={draftFilters.status}
          onChange={(next) => updateDraftFilter("status", next)}
          options={statusOptions}
          aria-label="Status"
          className={SELECT_CLASS}
        />

        <button
          type="button"
          onClick={handleApplyFilters}
          className="h-[34px] w-full whitespace-nowrap rounded-[6px] bg-[#0097B2] px-4 text-[12px] font-semibold text-white hover:bg-[#0086A0] 2xl:w-auto"
        >
          Apply Filters
        </button>

        <button
          type="button"
          onClick={handleReset}
          className="h-[34px] w-full whitespace-nowrap rounded-[6px] border border-[#E2E8F0] bg-white px-4 text-[12px] font-medium text-[#334155] hover:bg-[#F8FAFC] 2xl:w-auto"
        >
          Reset
        </button>
      </div>

      <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-[6px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-[#94A3B8]">
          <SearchIcon />
          <input
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="Search order ID, facility, company, case, applicant..."
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[#111827] outline-none placeholder:text-[#94A3B8]"
          />
        </div>

        <button
          type="button"
          onClick={handleSearch}
          className="h-[34px] w-full whitespace-nowrap rounded-[6px] bg-[#0097B2] px-5 text-[12px] font-semibold text-white hover:bg-[#0086A0] sm:w-auto"
        >
          Search
        </button>
      </div>
    </section>
  );
}

function SearchIcon() {
  return (
    <svg
      className="shrink-0"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.7" />
      <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}
