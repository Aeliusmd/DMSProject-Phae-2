"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import DashboardShell from "@/components/layout/DashboardShell";
import FacilityTable from "@/components/facilities/FacilityTable";
import {
  deleteFacility,
  getFacilitiesPaginated,
} from "@/lib/facilities/facilityApi";
import { getStoredUser } from "@/lib/auth/authStorage";
import { canDeleteFacilities } from "@/lib/auth/roles";

const FACILITIES_PER_PAGE = 10;

export default function FacilitiesPage() {
  const canDelete = canDeleteFacilities(getStoredUser());
  const [facilities, setFacilities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [sortDir, setSortDir] = useState("desc");
  const [currentPage, setCurrentPage] = useState(1);
  const [cursorHistory, setCursorHistory] = useState([null]);
  const cursorHistoryRef = useRef([null]);
  const [pagination, setPagination] = useState({
    pageSize: FACILITIES_PER_PAGE,
    hasMore: false,
    nextCursor: null,
  });

  const applySearch = () => {
    setAppliedSearch(searchInput.trim());
    setCurrentPage(1);
    cursorHistoryRef.current = [null];
    setCursorHistory([null]);
    setPagination({
      pageSize: FACILITIES_PER_PAGE,
      hasMore: false,
      nextCursor: null,
    });
  };

  const clearSearch = () => {
    setSearchInput("");
    setAppliedSearch("");
    setCurrentPage(1);
    cursorHistoryRef.current = [null];
    setCursorHistory([null]);
    setPagination({
      pageSize: FACILITIES_PER_PAGE,
      hasMore: false,
      nextCursor: null,
    });
  };

  const loadFacilities = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const cursor = cursorHistoryRef.current[currentPage - 1] ?? null;

      if (currentPage > 1 && cursor == null) {
        setCurrentPage(1);
        cursorHistoryRef.current = [null];
        setCursorHistory([null]);
        setPagination({
          pageSize: FACILITIES_PER_PAGE,
          hasMore: false,
          nextCursor: null,
        });
        return;
      }

      const result = await getFacilitiesPaginated({
        search: appliedSearch,
        pagination: "keyset",
        cursor,
        pageSize: FACILITIES_PER_PAGE,
        sortDir,
      });
      const hasMore = Boolean(result.pagination?.hasMore);
      const nextCursor =
        hasMore && result.pagination?.nextCursor != null
          ? result.pagination.nextCursor
          : null;

      setFacilities(result.facilities || []);
      setPagination({
        pageSize: Number(result.pagination?.pageSize) || FACILITIES_PER_PAGE,
        hasMore: Boolean(hasMore && nextCursor != null),
        nextCursor,
      });
      setCursorHistory((prev) => {
        const next = prev.slice(0, currentPage);
        if (hasMore && nextCursor != null) {
          next[currentPage] = nextCursor;
        } else {
          next.length = currentPage;
        }
        cursorHistoryRef.current = next;
        return next;
      });
    } catch (err) {
      setError(err.message || "Failed to load facilities");
      setFacilities([]);
    } finally {
      setLoading(false);
    }
  }, [appliedSearch, currentPage, sortDir]);

  useEffect(() => {
    cursorHistoryRef.current = cursorHistory;
  }, [cursorHistory]);

  useEffect(() => {
    loadFacilities();
  }, [loadFacilities]);

  const handleSortDirChange = (nextDir) => {
    const normalized = nextDir === "asc" ? "asc" : "desc";
    if (normalized === sortDir) return;

    setSortDir(normalized);
    setCurrentPage(1);
    cursorHistoryRef.current = [null];
    setCursorHistory([null]);
    setPagination({
      pageSize: FACILITIES_PER_PAGE,
      hasMore: false,
      nextCursor: null,
    });
  };

  const handleDeleteFacility = async (facility) => {
    if (!canDelete) return;

    try {
      await deleteFacility(facility.id);
      await loadFacilities();
    } catch (err) {
      setError(err.message || "Failed to delete facility");
    }
  };

  const startRecord = facilities.length
    ? (currentPage - 1) * FACILITIES_PER_PAGE + 1
    : 0;
  const endRecord = startRecord + facilities.length - (facilities.length ? 1 : 0);

  const canGoPreviousPage = !loading && currentPage > 1;
  const canGoNextPage =
    !loading &&
    pagination.hasMore &&
    pagination.nextCursor != null &&
    facilities.length > 0;

  const goToPreviousPage = () => {
    if (!canGoPreviousPage) return;
    setCurrentPage((page) => Math.max(page - 1, 1));
  };

  const goToNextPage = () => {
    if (!canGoNextPage) return;
    const nextCursor = pagination.nextCursor;
    setPagination((prev) => ({
      ...prev,
      hasMore: false,
      nextCursor: null,
    }));
    setCursorHistory((prev) => {
      const next = prev.slice(0, currentPage);
      next[currentPage] = nextCursor;
      cursorHistoryRef.current = next;
      return next;
    });
    setCurrentPage(currentPage + 1);
  };

  return (
    <DashboardShell>
      <div className="flex min-h-[calc(100vh-92px)] min-w-0 flex-col gap-5 overflow-hidden">
        <div className="flex w-full flex-col gap-4 lg:flex-row lg:items-center">
          <h1 className="shrink-0 text-[18px] font-semibold text-[#111827]">
            List of Facilities
          </h1>

          <div className="flex w-full flex-wrap items-center gap-3 lg:ml-auto lg:w-auto lg:justify-end">
            <Link
              href="/orders"
              className="inline-flex h-[36px] items-center justify-center gap-2 whitespace-nowrap rounded-[6px] border border-[#E2E8F0] bg-white px-4 text-[12px] font-semibold text-[#475569] shadow-sm hover:bg-[#F8FAFC]"
            >
              <ArrowLeftIcon />
              Return to Orders
            </Link>

            <Link
              href="/facilities/new"
              className="inline-flex h-[36px] items-center justify-center gap-2 whitespace-nowrap rounded-[6px] bg-[#0097B2] px-4 text-[12px] font-semibold text-white shadow-sm hover:bg-[#0086A0]"
            >
              <UserPlusIcon />
              New Facility
            </Link>
          </div>
        </div>

        {error && (
          <div className="rounded-[7px] border border-red-200 bg-red-50 px-3 py-3 text-[12px] font-semibold text-red-600">
            {error}
          </div>
        )}

        {!loading && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <FacilitySearch
              value={searchInput}
              onChange={setSearchInput}
              onSearch={applySearch}
              onClear={clearSearch}
              hasApplied={Boolean(appliedSearch.trim())}
            />

            <p className="text-[11px] text-[#64748B]">
              {appliedSearch.trim()
                ? pagination.hasMore
                  ? `Showing ${startRecord}-${endRecord} of ${endRecord}+ facilities`
                  : `Showing ${startRecord}-${endRecord} of ${endRecord} facilities`
                : pagination.hasMore
                  ? `Showing ${startRecord}-${endRecord} of ${endRecord}+ facilities`
                  : `${endRecord} facilities`}
            </p>
          </div>
        )}

        {loading ? (
          <div className="flex flex-1 items-center justify-center rounded-[10px] border border-[#E2E8F0] bg-white py-16 text-[13px] text-[#64748B]">
            Loading facilities...
          </div>
        ) : (
          <FacilityTable
            facilities={facilities}
            onDelete={handleDeleteFacility}
            canDelete={canDelete}
            sortDir={sortDir}
            onSortDirChange={handleSortDirChange}
          />
        )}

        {!loading && (
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={goToPreviousPage}
              disabled={!canGoPreviousPage}
              className="flex h-[28px] min-w-[28px] items-center justify-center rounded-[6px] border border-[#E2E8F0] bg-white px-2 text-[12px] text-[#64748B] hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-40"
            >
              ‹
            </button>

            <span className="flex h-[28px] min-w-[28px] items-center justify-center rounded-[6px] bg-[#111827] px-2 text-[12px] font-semibold text-white">
              {currentPage}
            </span>

            <button
              type="button"
              onClick={goToNextPage}
              disabled={!canGoNextPage}
              className="flex h-[28px] min-w-[28px] items-center justify-center rounded-[6px] border border-[#E2E8F0] bg-white px-2 text-[12px] text-[#64748B] hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-40"
            >
              ›
            </button>
          </div>
        )}
      </div>
    </DashboardShell>
  );
}

function FacilitySearch({ value, onChange, onSearch, onClear, hasApplied }) {
  const handleKeyDown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onSearch?.();
    }
  };

  return (
    <div className="w-full max-w-[360px]">
      <div className="flex gap-2">
        <div className="flex h-[36px] min-w-0 flex-1 items-center gap-2 rounded-[6px] border border-[#CBD5E1] bg-white px-3">
          <SearchIcon />
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search facility name"
            className="min-w-0 flex-1 bg-transparent text-[12px] text-[#111827] outline-none placeholder:text-[#94A3B8]"
          />

          {value && (
            <button
              type="button"
              onClick={onClear}
              aria-label="Clear search"
              className="shrink-0 text-[#94A3B8] hover:text-[#475569]"
            >
              <CloseIcon />
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={onSearch}
          className="h-[36px] shrink-0 rounded-[6px] bg-[#0097B2] px-4 text-[12px] font-semibold text-white hover:bg-[#0086A0]"
        >
          Filter
        </button>

        {hasApplied && (
          <button
            type="button"
            onClick={onClear}
            className="h-[36px] shrink-0 rounded-[6px] border border-[#E2E8F0] bg-white px-4 text-[12px] font-semibold text-[#475569] hover:bg-[#F8FAFC]"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg
      className="shrink-0 text-[#94A3B8]"
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

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path
        d="M18 6 6 18M6 6l12 12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
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

function UserPlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path
        d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="9" cy="7" r="4" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M19 8v6M22 11h-6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
