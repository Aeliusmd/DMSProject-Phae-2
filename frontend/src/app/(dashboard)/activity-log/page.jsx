"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import DashboardShell from "@/components/layout/DashboardShell";
import ActivityLogTable from "@/components/activity-log/ActivityLogTable";
import EmployeeMilestoneModal from "@/components/employees/EmployeeMilestoneModal";
import { getCurrentUser } from "@/lib/auth/authApi";
import { getStoredUser } from "@/lib/auth/authStorage";
import { usesOwnActivityLogsOnly, isEmployee } from "@/lib/auth/roles";
import {
  getActivityLogsPaginated,
  getMyActivityLogsPaginated,
} from "@/lib/activityLog/activityLogApi";
import { useDataRefresh } from "@/lib/liveRefresh/useDataRefresh";

const ACTIVITY_LOGS_PER_PAGE = 10;

const adminFilters = [
  "All Modules",
  "Orders",
  "Billing",
  "Employees",
  "Facilities",
  "Processing",
  "Reports",
  "Security",
];

const employeeFilters = [
  "All Modules",
  "Orders",
  "Billing",
  "Processing",
];

function getTodayDateInput() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export default function ActivityLogPage() {
  const todayDate = getTodayDateInput();
  const [user, setUser] = useState(() => getStoredUser());
  const ownLogsOnly = usesOwnActivityLogsOnly(user);
  const filters = ownLogsOnly ? employeeFilters : adminFilters;
  const [activityLogs, setActivityLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [draftActiveFilter, setDraftActiveFilter] = useState("All Modules");
  const [appliedActiveFilter, setAppliedActiveFilter] = useState("All Modules");
  const [draftDateFilters, setDraftDateFilters] = useState({
    fromDate: todayDate,
    toDate: todayDate,
  });
  const [appliedDateFilters, setAppliedDateFilters] = useState({
    fromDate: todayDate,
    toDate: todayDate,
  });
  const [dateFilterError, setDateFilterError] = useState("");
  const [performerSearchDraft, setPerformerSearchDraft] = useState("");
  const [appliedPerformerSearch, setAppliedPerformerSearch] = useState("");
  const [milestoneOpen, setMilestoneOpen] = useState(false);
  const showMyMilestone = isEmployee(user);
  const [currentPage, setCurrentPage] = useState(1);
  const [cursorHistory, setCursorHistory] = useState([null]);
  const cursorHistoryRef = useRef([null]);
  const nextCursorRef = useRef(null);
  const [pagination, setPagination] = useState({
    pageSize: ACTIVITY_LOGS_PER_PAGE,
    hasMore: false,
    nextCursor: null,
  });

  useEffect(() => {
    let cancelled = false;

    getCurrentUser()
      .then((currentUser) => {
        if (!cancelled && currentUser) {
          setUser(currentUser);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    cursorHistoryRef.current = cursorHistory;
  }, [cursorHistory]);

  const resetPagination = useCallback(() => {
    const nextHistory = [null];
    cursorHistoryRef.current = nextHistory;
    setCurrentPage(1);
    setCursorHistory(nextHistory);
    setPagination({
      pageSize: ACTIVITY_LOGS_PER_PAGE,
      hasMore: false,
      nextCursor: null,
    });
    nextCursorRef.current = null;
  }, []);

  const loadLogs = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLogsLoading(true);
      setPageError("");
    }

    try {
      let cursor = cursorHistoryRef.current[currentPage - 1] ?? null;
      if (cursor == null && currentPage === 2 && nextCursorRef.current != null) {
        cursor = nextCursorRef.current;
      }

      const requestFilters = {
        module: appliedActiveFilter,
        fromDate: appliedDateFilters.fromDate,
        toDate: appliedDateFilters.toDate,
        search: appliedPerformerSearch,
        cursor,
        pageSize: ACTIVITY_LOGS_PER_PAGE,
      };

      const result = ownLogsOnly
        ? await getMyActivityLogsPaginated(requestFilters)
        : await getActivityLogsPaginated(requestFilters);

      const hasMore = Boolean(result.pagination?.hasMore);
      const nextCursor = result.pagination?.nextCursor ?? null;
      const logs = result.logs || [];

      if (!logs.length && currentPage > 1) {
        setPagination((prev) => ({
          ...prev,
          hasMore: false,
          nextCursor: null,
        }));
        const trimmedHistory = cursorHistoryRef.current.slice(0, currentPage - 1);
        cursorHistoryRef.current = trimmedHistory;
        setCursorHistory(trimmedHistory);
        setCurrentPage((page) => Math.max(page - 1, 1));
        return;
      }

      setActivityLogs(logs);
      setPagination({
        pageSize:
          Number(result.pagination?.pageSize) || ACTIVITY_LOGS_PER_PAGE,
        hasMore: Boolean(hasMore && nextCursor != null),
        nextCursor: hasMore ? nextCursor : null,
      });
      nextCursorRef.current = hasMore ? nextCursor : null;
      setCursorHistory((prev) => {
        const next = prev.slice(0, currentPage);
        if (hasMore && nextCursor != null) {
          next[currentPage] = nextCursor;
        }
        if (!hasMore) {
          next.length = currentPage;
        }
        cursorHistoryRef.current = next;
        return next;
      });
    } catch (error) {
      if (!silent) {
        setPageError(error.message || "Failed to load activity logs");
        setActivityLogs([]);
      }
    } finally {
      if (!silent) setLogsLoading(false);
    }
  }, [
    ownLogsOnly,
    appliedActiveFilter,
    appliedDateFilters.fromDate,
    appliedDateFilters.toDate,
    appliedPerformerSearch,
    currentPage,
  ]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  useDataRefresh(() => loadLogs({ silent: true }), {
    paused: milestoneOpen,
  });

  const handleDateFilterChange = (e) => {
    const { name, value } = e.target;

    setDateFilterError("");
    setDraftDateFilters((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleApplyFilters = () => {
    const fromDate = `${draftDateFilters.fromDate || ""}`.trim();
    const toDate = `${draftDateFilters.toDate || ""}`.trim();
    const today = getTodayDateInput();

    if (fromDate && toDate && fromDate > toDate) {
      setDateFilterError("From date must be on or before To date.");
      return;
    }

    if ((fromDate && fromDate > today) || (toDate && toDate > today)) {
      setDateFilterError(
        "Date range cannot be in the future. Please select today or an earlier date."
      );
      return;
    }

    setDateFilterError("");
    setAppliedDateFilters({ ...draftDateFilters });
    setAppliedActiveFilter(draftActiveFilter);
    resetPagination();
  };

  const handleSearch = () => {
    setAppliedPerformerSearch(performerSearchDraft.trim());
    resetPagination();
  };

  const handleResetFilters = () => {
    const defaultDates = {
      fromDate: todayDate,
      toDate: todayDate,
    };

    setDateFilterError("");
    setDraftDateFilters(defaultDates);
    setAppliedDateFilters(defaultDates);
    setDraftActiveFilter("All Modules");
    setAppliedActiveFilter("All Modules");
    setPerformerSearchDraft("");
    setAppliedPerformerSearch("");
    resetPagination();
  };

  const totalPages = Math.max(currentPage + (pagination.hasMore ? 1 : 0), 1);
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const startRecord = activityLogs.length
    ? (safeCurrentPage - 1) * ACTIVITY_LOGS_PER_PAGE + 1
    : 0;
  const endRecord =
    startRecord + activityLogs.length - (activityLogs.length ? 1 : 0);

  if (currentPage !== safeCurrentPage) {
    setCurrentPage(safeCurrentPage);
  }

  const summaryLabel = logsLoading
    ? "Loading activity logs..."
    : pagination.hasMore
      ? `Showing ${startRecord}-${endRecord} of ${endRecord}+ entries`
      : activityLogs.length === 0
        ? "Showing 0 entries"
        : `Showing ${startRecord}-${endRecord} of ${endRecord} entries`;

  return (
    <DashboardShell>
      <div className="flex min-h-[calc(100vh-92px)] min-w-0 flex-col gap-5">
        <div className="flex w-full flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-[18px] font-semibold text-[#111827]">
              Activity Log
            </h1>

            <p className="mt-1 text-[12px] text-[#64748B]">
              {ownLogsOnly
                ? "Your activity history"
                : "Track all system activities and user actions"}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {showMyMilestone ? (
              <button
                type="button"
                onClick={() => setMilestoneOpen(true)}
                className="inline-flex h-[34px] items-center justify-center gap-2 rounded-[6px] border border-[#BAE6FD] bg-[#F0F9FF] px-4 text-[12px] font-semibold text-[#0369A1] hover:bg-[#E0F2FE]"
              >
                View My Milestone
              </button>
            ) : null}

            <Link
              href="/orders"
              className="inline-flex h-[34px] w-fit items-center justify-center gap-2 rounded-[6px] border border-[#E2E8F0] bg-white px-4 text-[12px] font-semibold text-[#475569] shadow-sm hover:bg-[#F8FAFC]"
            >
              <ArrowLeftIcon />
              Return to Orders
            </Link>
          </div>
        </div>

        {pageError ? (
          <p className="rounded-[6px] border border-red-200 bg-red-50 px-3 py-2 text-[12px] font-medium text-red-600">
            {pageError}
          </p>
        ) : null}

        <section className="rounded-[9px] border border-[#E2E8F0] bg-white px-4 py-4 shadow-sm">
          <div className="flex flex-wrap items-end gap-x-3 gap-y-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="shrink-0 text-[10px] font-semibold text-[#64748B]">
                Filter:
              </span>

              <div className="flex flex-wrap items-center gap-1 rounded-[6px] border border-[#E2E8F0] bg-[#F8FAFC] p-[3px]">
                {filters.map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    onClick={() => setDraftActiveFilter(filter)}
                    className={`h-[28px] shrink-0 rounded-[5px] px-3 text-[11px] font-semibold transition ${
                      draftActiveFilter === filter
                        ? "bg-[#0097B2] text-white shadow-sm"
                        : "text-[#475569] hover:bg-white hover:text-[#111827]"
                    }`}
                  >
                    {filter}
                  </button>
                ))}
              </div>
            </div>

            <DateFilter
              label="From"
              name="fromDate"
              value={draftDateFilters.fromDate}
              onChange={handleDateFilterChange}
              max={todayDate}
              className="w-[140px]"
            />

            <DateFilter
              label="To"
              name="toDate"
              value={draftDateFilters.toDate}
              onChange={handleDateFilterChange}
              max={todayDate}
              className="w-[140px]"
            />

            <div className="flex shrink-0 items-end gap-2">
              <button
                type="button"
                onClick={handleApplyFilters}
                className="h-[34px] rounded-[6px] bg-[#0097B2] px-4 text-[12px] font-semibold text-white hover:bg-[#0086A0]"
              >
                Apply Filters
              </button>

              <button
                type="button"
                onClick={handleResetFilters}
                className="h-[34px] rounded-[6px] border border-[#E2E8F0] bg-white px-4 text-[12px] font-medium text-[#334155] hover:bg-[#F8FAFC]"
              >
                Reset
              </button>
            </div>
          </div>

          {dateFilterError ? (
            <p className="mt-2 rounded-[6px] border border-red-200 bg-red-50 px-3 py-2 text-[12px] font-medium text-red-600">
              {dateFilterError}
            </p>
          ) : null}

          {!ownLogsOnly ? (
            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
              <PerformerSearch
                value={performerSearchDraft}
                onChange={setPerformerSearchDraft}
                onSearch={handleSearch}
                className="min-w-0 flex-1 sm:max-w-[360px]"
              />
            </div>
          ) : null}

          <p className="mt-2 text-right text-[11px] text-[#64748B]">
            {summaryLabel}
          </p>
        </section>

        <div className="flex min-h-0 flex-1 flex-col">
          {logsLoading ? (
            <div className="flex flex-1 items-center justify-center rounded-[10px] border border-[#E2E8F0] bg-white px-4 py-16 text-[13px] text-[#94A3B8]">
              Loading activity logs...
            </div>
          ) : (
            <ActivityLogTable
              logs={activityLogs}
              footer={
                <div className="flex items-center justify-end gap-1 border-t border-[#F1F5F9] bg-white px-4 py-3">
                  <button
                    type="button"
                    onClick={() => setCurrentPage((page) => Math.max(page - 1, 1))}
                    disabled={logsLoading || safeCurrentPage === 1}
                    className="flex h-[28px] min-w-[28px] items-center justify-center rounded-[6px] border border-[#E2E8F0] bg-white px-2 text-[12px] text-[#64748B] hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    ‹
                  </button>

                  <span className="flex h-[28px] min-w-[28px] items-center justify-center rounded-[6px] bg-[#111827] px-2 text-[12px] font-semibold text-white">
                    {safeCurrentPage}
                  </span>

                  <button
                    type="button"
                    onClick={() => {
                      if (
                        logsLoading ||
                        !pagination.hasMore ||
                        pagination.nextCursor == null ||
                        activityLogs.length === 0
                      ) {
                        return;
                      }
                      const nextCursor = pagination.nextCursor;
                      setPagination((prev) => ({
                        ...prev,
                        hasMore: false,
                        nextCursor: null,
                      }));
                      setCursorHistory((prev) => {
                        const next = prev.slice(0, safeCurrentPage);
                        next[safeCurrentPage] = nextCursor;
                        cursorHistoryRef.current = next;
                        return next;
                      });
                      nextCursorRef.current = nextCursor;
                      setCurrentPage(safeCurrentPage + 1);
                    }}
                    disabled={
                      logsLoading ||
                      !pagination.hasMore ||
                      pagination.nextCursor == null ||
                      activityLogs.length === 0
                    }
                    className="flex h-[28px] min-w-[28px] items-center justify-center rounded-[6px] border border-[#E2E8F0] bg-white px-2 text-[12px] text-[#64748B] hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    ›
                  </button>
                </div>
              }
            />
          )}
        </div>
      </div>

      <EmployeeMilestoneModal
        isOpen={milestoneOpen}
        useSelfStats
        onClose={() => setMilestoneOpen(false)}
      />
    </DashboardShell>
  );
}

function DateFilter({ label, name, value, onChange, max, className = "" }) {
  return (
    <div className={className}>
      <label className="mb-1 block text-[10px] font-semibold text-[#64748B]">
        {label}
      </label>

      <input
        type="date"
        name={name}
        value={value}
        max={max || undefined}
        onChange={onChange}
        className="h-[34px] w-full rounded-[6px] border border-[#E2E8F0] bg-[#F8FAFC] px-2 text-[12px] text-[#111827] outline-none focus:border-[#0097B2] focus:ring-2 focus:ring-[#0097B2]/10"
      />
    </div>
  );
}

function PerformerSearch({ value, onChange, onSearch, className = "" }) {
  const handleKeyDown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onSearch?.();
    }
  };

  return (
    <div className={className}>
      <label className="mb-1 block text-[10px] font-semibold text-[#64748B]">
        Performed By
      </label>

      <div className="flex gap-2">
        <div className="flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-[6px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-[#94A3B8]">
          <SearchIcon />
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search employee name"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[#111827] outline-none placeholder:text-[#94A3B8]"
          />
        </div>

        <button
          type="button"
          onClick={onSearch}
          className="h-[34px] shrink-0 rounded-[6px] bg-[#0097B2] px-4 text-[12px] font-semibold text-white hover:bg-[#0086A0]"
        >
          Search
        </button>
      </div>
    </div>
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

function ArrowLeftIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path
        d="M19 12H5M11 6l-6 6 6 6"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
