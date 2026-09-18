"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import DashboardShell from "@/components/layout/DashboardShell";
import OrdersTable from "@/components/orders/OrdersTable";
import { getStoredUser } from "@/lib/auth/authStorage";
import { canAccessActivityReport } from "@/lib/auth/roles";
import { getFacilities } from "@/lib/facilities/facilityApi";
import { getApiErrorMessage } from "@/lib/apiErrorUtils";
import { RUSH_LEVEL_LEGEND } from "@/lib/orders/rushUtils";
import {
  ORDER_SOURCE_INTERNAL,
  getOrderSourceOptions,
  getStatusOptionsForOrderSource,
  isCompanyOrderSource,
  isPersonalOrderSource,
  toApiCreationSource,
} from "@/lib/orders/orderFilterConstants";
import {
  ORDER_LIST_FILTER_KEYS,
  consumeOrderListFilters,
  writeOrderListFilters,
} from "@/lib/orders/orderListFilterStorage";
import { STAFF_PORTAL_ORDERS_HIDDEN } from "@/lib/portalNavigationVisibility";

const RUSH_LEVEL_OPTIONS = [
  { value: "", label: "All Rush Levels" },
  ...RUSH_LEVEL_LEGEND.map(({ label }) => ({ value: label, label })),
];

const defaultDraftFilters = {
  facility: "",
  status: "",
  rushLevel: "",
  fromDate: "",
  toDate: "",
  sortDir: "asc",
  creationSource: ORDER_SOURCE_INTERNAL,
};

const defaultAppliedFilters = {
  ...defaultDraftFilters,
  search: "",
};

function toDraftFromApplied(applied = defaultAppliedFilters) {
  return {
    facility: applied.facility || "",
    status: applied.status || "",
    rushLevel: applied.rushLevel || "",
    fromDate: applied.fromDate || "",
    toDate: applied.toDate || "",
    sortDir: applied.sortDir === "desc" ? "desc" : "asc",
    creationSource: applied.creationSource || ORDER_SOURCE_INTERNAL,
  };
}

function createInitialReportFilterState() {
  const applied = consumeOrderListFilters(
    ORDER_LIST_FILTER_KEYS.reports,
    defaultAppliedFilters
  );
  return {
    applied,
    draft: toDraftFromApplied(applied),
    searchDraft: applied.search || "",
  };
}

export default function ReportsPage() {
  const user = getStoredUser();
  const showActivityReportLink = canAccessActivityReport(user);

  const [facilities, setFacilities] = useState([]);
  const [facilitiesLoading, setFacilitiesLoading] = useState(true);
  const [facilitiesError, setFacilitiesError] = useState("");

  const [initialFilterState] = useState(createInitialReportFilterState);
  const [draftFilters, setDraftFilters] = useState(initialFilterState.draft);
  const [searchDraft, setSearchDraft] = useState(initialFilterState.searchDraft);
  const [appliedFilters, setAppliedFilters] = useState(initialFilterState.applied);
  const [summary, setSummary] = useState({
    total: 0,
    startRecord: 0,
    endRecord: 0,
    currentPage: 1,
    totalPages: 1,
    loading: true,
  });

  useEffect(() => {
    writeOrderListFilters(
      ORDER_LIST_FILTER_KEYS.reports,
      appliedFilters,
      defaultAppliedFilters
    );
  }, [appliedFilters]);

  const sourceOptions = getOrderSourceOptions({
    hidePortalOrders: STAFF_PORTAL_ORDERS_HIDDEN,
  });
  const showSourceFilter = !STAFF_PORTAL_ORDERS_HIDDEN && sourceOptions.length > 1;
  const draftOrderSource = STAFF_PORTAL_ORDERS_HIDDEN
    ? ORDER_SOURCE_INTERNAL
    : draftFilters.creationSource || ORDER_SOURCE_INTERNAL;
  const statusOptions = getStatusOptionsForOrderSource(draftOrderSource);

  useEffect(() => {
    let active = true;
    setFacilitiesLoading(true);

    getFacilities()
      .then((data) => {
        if (!active) return;
        const list = Array.isArray(data) ? data : [];
        setFacilities(list);
        setFacilitiesError("");
      })
      .catch((err) => {
        if (!active) return;
        setFacilities([]);
        setFacilitiesError(getApiErrorMessage(err, "Failed to load facilities"));
      })
      .finally(() => {
        if (active) setFacilitiesLoading(false);
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
      if (name === "creationSource") {
        next.status = "";
      }
      return next;
    });
  };

  const handleApplyFilters = () => {
    setAppliedFilters((prev) => ({
      ...draftFilters,
      search: prev.search || "",
    }));
  };

  const handleSearch = () => {
    setAppliedFilters((prev) => ({
      ...prev,
      search: searchDraft.trim(),
    }));
  };

  const handleSearchKeyDown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleSearch();
    }
  };

  const handleReset = () => {
    const nextDraft = {
      ...defaultDraftFilters,
    };

    setDraftFilters(nextDraft);
    setSearchDraft("");
    setAppliedFilters({
      ...nextDraft,
      search: "",
    });
  };

  const appliedOrderSource = STAFF_PORTAL_ORDERS_HIDDEN
    ? ORDER_SOURCE_INTERNAL
    : appliedFilters.creationSource || ORDER_SOURCE_INTERNAL;
  const companyPortalMode = isCompanyOrderSource(appliedOrderSource);
  const personalMode = isPersonalOrderSource(appliedOrderSource);
  const apiCreationSource = toApiCreationSource(appliedOrderSource) || null;

  const tableFilters = useMemo(
    () => ({
      facility: appliedFilters.facility,
      company: "",
      year: "",
      period: "",
      status: appliedFilters.status,
      rushLevel: appliedFilters.rushLevel,
      search: appliedFilters.search,
      createdFrom: appliedFilters.fromDate,
      createdTo: appliedFilters.toDate,
      creationSource: appliedOrderSource,
    }),
    [appliedFilters, appliedOrderSource]
  );

  const handleSummaryChange = useCallback((next) => {
    setSummary(next);
  }, []);

  const facilityLabel = (facility) =>
    facility.facility ||
    facility.facilityName ||
    facility.name ||
    `#${facility.id}`;

  const selectedFacilityName = useMemo(() => {
    const match = facilities.find(
      (facility) => String(facility.id) === String(appliedFilters.facility)
    );
    return match ? facilityLabel(match) : "";
  }, [facilities, appliedFilters.facility]);

  const sourceLabel =
    sourceOptions.find((opt) => opt.value === appliedOrderSource)
      ?.label || "Internal Orders";

  return (
    <DashboardShell>
      <div className="flex min-h-0 min-w-0 flex-col gap-3">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-[18px] font-semibold text-[#111827] sm:text-[20px]">
                Reports
              </h1>

              {selectedFacilityName ? (
                <p className="mt-[2px] text-[14px] font-semibold text-[#0F172A]">
                  {selectedFacilityName} has{" "}
                  <span className="text-[#0097B2]">
                    {summary.loading ? "..." : summary.total}
                  </span>{" "}
                  {summary.total === 1 ? "order" : "orders"}
                  <span className="ml-1 text-[12px] font-medium text-[#64748B]">
                    ({sourceLabel})
                  </span>
                </p>
              ) : (
                <p className="mt-[2px] text-[14px] font-semibold text-[#0F172A]">
                  All facilities have{" "}
                  <span className="text-[#0097B2]">
                    {summary.loading ? "..." : summary.total}
                  </span>{" "}
                  {summary.total === 1 ? "order" : "orders"}
                  <span className="ml-1 text-[12px] font-medium text-[#64748B]">
                    ({sourceLabel})
                  </span>
                </p>
              )}

              {summary.total > 0 && (
                <p className="mt-[2px] text-[12px] text-[#64748B]">
                  Showing {summary.startRecord}-{summary.endRecord} of{" "}
                  {summary.total} (page {summary.currentPage} of{" "}
                  {summary.totalPages})
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <div className="flex flex-wrap items-center gap-3 text-[10px]">
                {RUSH_LEVEL_LEGEND.map(({ color, label }) => (
                  <RushLegendDot key={label} color={color} label={label} />
                ))}
              </div>

              {showActivityReportLink && (
                <Link
                  href="/reports/activity-report"
                  className="inline-flex h-[30px] items-center justify-center gap-2 rounded-[6px] bg-[#0097B2] px-3 text-[11px] font-semibold text-white hover:bg-[#0086A0]"
                >
                  <ReportIcon />
                  Activity Report
                </Link>
              )}
            </div>
          </div>
        </div>

        <section className="min-w-0 rounded-[9px] border border-[#E2E8F0] bg-white px-3 py-4 shadow-sm sm:px-4">
          <h2 className="mb-3 text-[13px] font-semibold text-[#111827]">
            Filters
          </h2>

          <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-[repeat(auto-fit,minmax(140px,1fr))]">
            {showSourceFilter ? (
            <div className="min-w-0">
              <label className="mb-1 block text-[10px] font-semibold text-[#64748B]">
                Order Source
              </label>
              <select
                value={draftOrderSource}
                onChange={(e) =>
                  updateDraftFilter("creationSource", e.target.value)
                }
                className="h-[34px] w-full rounded-[6px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-[12px] text-[#111827] outline-none focus:border-[#0097B2] focus:ring-2 focus:ring-[#0097B2]/10"
              >
                {sourceOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            ) : null}

            <div className="min-w-0">
              <label className="mb-1 block text-[10px] font-semibold text-[#64748B]">
                Facility
              </label>
              <select
                value={draftFilters.facility}
                onChange={(e) => updateDraftFilter("facility", e.target.value)}
                disabled={facilitiesLoading || Boolean(facilitiesError)}
                className="h-[34px] w-full rounded-[6px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-[12px] text-[#111827] outline-none focus:border-[#0097B2] focus:ring-2 focus:ring-[#0097B2]/10 disabled:opacity-60"
              >
                <option value="">
                  {facilitiesLoading
                    ? "Loading..."
                    : facilitiesError
                      ? "Facilities unavailable"
                      : "All Facility"}
                </option>
                {!facilitiesLoading &&
                  !facilitiesError &&
                  facilities.map((facility) => (
                    <option key={facility.id} value={String(facility.id)}>
                      {facilityLabel(facility)}
                    </option>
                  ))}
              </select>
            </div>

            <div className="min-w-0">
              <label className="mb-1 block text-[10px] font-semibold text-[#64748B]">
                Status
              </label>
              <select
                value={draftFilters.status}
                onChange={(e) => updateDraftFilter("status", e.target.value)}
                className="h-[34px] w-full rounded-[6px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-[12px] text-[#111827] outline-none focus:border-[#0097B2] focus:ring-2 focus:ring-[#0097B2]/10"
              >
                {statusOptions.map((option) => (
                  <option key={option.value || "all"} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="min-w-0">
              <label className="mb-1 block text-[10px] font-semibold text-[#64748B]">
                Rush Level
              </label>
              <select
                value={draftFilters.rushLevel}
                onChange={(e) => updateDraftFilter("rushLevel", e.target.value)}
                className="h-[34px] w-full rounded-[6px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-[12px] text-[#111827] outline-none focus:border-[#0097B2] focus:ring-2 focus:ring-[#0097B2]/10"
              >
                {RUSH_LEVEL_OPTIONS.map((option) => (
                  <option key={option.value || "all"} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="min-w-0">
              <label className="mb-1 block text-[10px] font-semibold text-[#64748B]">
                From (Created)
              </label>
              <input
                type="date"
                value={draftFilters.fromDate}
                max={draftFilters.toDate || undefined}
                onChange={(e) => updateDraftFilter("fromDate", e.target.value)}
                className="h-[34px] w-full rounded-[6px] border border-[#E2E8F0] bg-[#F8FAFC] px-2 text-[12px] text-[#111827] outline-none focus:border-[#0097B2] focus:ring-2 focus:ring-[#0097B2]/10"
              />
            </div>

            <div className="min-w-0">
              <label className="mb-1 block text-[10px] font-semibold text-[#64748B]">
                To (Created)
              </label>
              <input
                type="date"
                value={draftFilters.toDate}
                min={draftFilters.fromDate || undefined}
                onChange={(e) => updateDraftFilter("toDate", e.target.value)}
                className="h-[34px] w-full rounded-[6px] border border-[#E2E8F0] bg-[#F8FAFC] px-2 text-[12px] text-[#111827] outline-none focus:border-[#0097B2] focus:ring-2 focus:ring-[#0097B2]/10"
              />
            </div>

            <div className="min-w-0">
              <label className="mb-1 block text-[10px] font-semibold text-[#64748B]">
                Sort by Created
              </label>
              <button
                type="button"
                onClick={() =>
                  updateDraftFilter(
                    "sortDir",
                    draftFilters.sortDir === "asc" ? "desc" : "asc"
                  )
                }
                className="flex h-[34px] w-full items-center justify-between rounded-[6px] border border-[#E2E8F0] bg-white px-3 text-[12px] font-medium text-[#334155] hover:bg-[#F8FAFC]"
              >
                <span>
                  {draftFilters.sortDir === "asc"
                    ? "Oldest → Newest"
                    : "Newest → Oldest"}
                </span>
                <SortIcon />
              </button>
            </div>

            <div className="flex min-w-0 items-end">
              <button
                type="button"
                onClick={handleApplyFilters}
                className="inline-flex h-[34px] w-full items-center justify-center whitespace-nowrap rounded-[6px] bg-[#0097B2] px-4 text-[12px] font-semibold leading-none text-white hover:bg-[#0086A0]"
              >
                Apply Filters
              </button>
            </div>

            <div className="flex min-w-0 items-end">
              <button
                type="button"
                onClick={handleReset}
                className="inline-flex h-[34px] w-full items-center justify-center rounded-[6px] border border-[#E2E8F0] bg-white px-4 text-[12px] font-medium leading-none text-[#334155] hover:bg-[#F8FAFC]"
              >
                Reset
              </button>
            </div>
          </div>

          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <label className="mb-1 block text-[10px] font-semibold text-[#64748B]">
                Search
              </label>
              <div className="flex h-[34px] min-w-0 items-center gap-2 rounded-[6px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-[#94A3B8]">
                <SearchIcon />
                <input
                  value={searchDraft}
                  onChange={(e) => setSearchDraft(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="Search order ID, case, applicant..."
                  className="min-w-0 flex-1 bg-transparent text-[12px] text-[#111827] outline-none placeholder:text-[#94A3B8]"
                />
              </div>
            </div>

            <button
              type="button"
              onClick={handleSearch}
              className="inline-flex h-[34px] items-center justify-center whitespace-nowrap rounded-[6px] bg-[#0097B2] px-5 text-[12px] font-semibold leading-none text-white hover:bg-[#0086A0]"
            >
              Search
            </button>
          </div>

          {facilitiesError && (
            <p className="mt-3 rounded-[6px] border border-[#FEE2E2] bg-[#FEF2F2] px-3 py-2 text-[11px] font-medium text-red-600">
              {facilitiesError}
            </p>
          )}
        </section>

        <OrdersTable
          filters={tableFilters}
          excludeCompleted
          createdSortDir={appliedFilters.sortDir}
          onCreatedSortDirChange={(nextDir) => {
            const sortDir = nextDir === "desc" ? "desc" : "asc";
            setDraftFilters((prev) => ({ ...prev, sortDir }));
            setAppliedFilters((prev) => ({ ...prev, sortDir }));
          }}
          fitToWindow
          showDoctorColumn
          useServerPagination
          onSummaryChange={handleSummaryChange}
          creationSource={apiCreationSource}
          companyPortalMode={companyPortalMode}
          personalMode={personalMode}
          listReturnTo="reports"
        />
      </div>
    </DashboardShell>
  );
}

function RushLegendDot({ color, label }) {
  return (
    <span className="inline-flex items-center gap-1 text-[#64748B]">
      <span
        className="h-[6px] w-[6px] rounded-full"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
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

function SortIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path
        d="M8 9l4-4 4 4M8 15l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ReportIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path
        d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path d="M14 3v6h6" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}
