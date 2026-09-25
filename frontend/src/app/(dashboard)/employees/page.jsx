"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import DashboardShell from "@/components/layout/DashboardShell";
import MatrixEmployeesTable from "@/components/employees/MatrixEmployeesTable";
import EmployeeFormModal from "@/components/employees/EmployeeFormModal";
import { getStoredUser } from "@/lib/auth/authStorage";
import { canAccessEmployeesPage, canManageEmployees } from "@/lib/auth/roles";
import {
  activateEmployee,
  createEmployee,
  deleteEmployee,
  getEmployeesPaginated,
  suspendEmployee,
  terminateEmployee,
  updateEmployee,
} from "@/lib/employees/employeeApi";
import { useDataRefresh } from "@/lib/liveRefresh/useDataRefresh";

const EMPLOYEES_PER_PAGE = 10;
/** Quiet refresh so auto-reactivation shows without a full page reload. */
const EMPLOYEE_STATUS_POLL_MS = 30 * 1000;

function mergeEmployeeStatus(previousList, nextList) {
  const previousById = new Map(
    (previousList || []).map((employee) => [String(employee.id), employee])
  );

  return (nextList || []).map((employee) => {
    const previous = previousById.get(String(employee.id));
    if (!previous) return employee;

    return {
      ...previous,
      ...employee,
      // Keep identity/display fields stable; status comes from the server.
      suspended: employee.suspended,
      terminated: employee.terminated,
      reactivatedDate: employee.reactivatedDate,
      reactivatedAt: employee.reactivatedAt,
      lastLogin: employee.lastLogin,
      lastLoginAt: employee.lastLoginAt,
    };
  });
}

export default function EmployeesPage() {
  const router = useRouter();
  const [employees, setEmployees] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [isNewEmployeeModalOpen, setIsNewEmployeeModalOpen] = useState(false);
  const [editEmployee, setEditEmployee] = useState(null);
  const [tableBusy, setTableBusy] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [cursorHistory, setCursorHistory] = useState([null]);
  const cursorHistoryRef = useRef([null]);
  const writeInFlightRef = useRef(false);
  const [pagination, setPagination] = useState({
    pageSize: EMPLOYEES_PER_PAGE,
    hasMore: false,
    nextCursor: null,
  });

  const user = getStoredUser();
  const readOnly = !canManageEmployees(user);

  const applySearch = () => {
    setAppliedSearch(searchInput.trim());
    setCurrentPage(1);
    cursorHistoryRef.current = [null];
    setCursorHistory([null]);
    setPagination({
      pageSize: EMPLOYEES_PER_PAGE,
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
      pageSize: EMPLOYEES_PER_PAGE,
      hasMore: false,
      nextCursor: null,
    });
  };

  const loadEmployees = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setIsLoading(true);
      setPageError("");
    }

    try {
      const cursor = cursorHistoryRef.current[currentPage - 1] ?? null;

      if (currentPage > 1 && cursor == null) {
        setCurrentPage(1);
        cursorHistoryRef.current = [null];
        setCursorHistory([null]);
        setPagination({
          pageSize: EMPLOYEES_PER_PAGE,
          hasMore: false,
          nextCursor: null,
        });
        return;
      }

      const result = await getEmployeesPaginated({
        search: appliedSearch,
        pagination: "keyset",
        cursor,
        pageSize: EMPLOYEES_PER_PAGE,
      });
      const hasMore = Boolean(result.pagination?.hasMore);
      const nextCursor =
        hasMore && result.pagination?.nextCursor != null
          ? result.pagination.nextCursor
          : null;
      const nextEmployees = result.employees || [];

      setEmployees((previous) =>
        silent ? mergeEmployeeStatus(previous, nextEmployees) : nextEmployees
      );
      setPagination({
        pageSize: Number(result.pagination?.pageSize) || EMPLOYEES_PER_PAGE,
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
    } catch (error) {
      if (error.status === 403) {
        router.replace("/dashboard");
        return;
      }

      // Background polls must not wipe the table or flash errors.
      if (silent) return;

      setPageError(error.message || "Unable to load employees");
      setEmployees([]);
    } finally {
      if (!silent) {
        setIsLoading(false);
      }
    }
  }, [appliedSearch, currentPage, router]);

  useEffect(() => {
    const currentUser = getStoredUser();

    if (!canAccessEmployeesPage(currentUser)) {
      router.replace("/dashboard");
      return;
    }

    loadEmployees();
  }, [loadEmployees, router]);

  useEffect(() => {
    cursorHistoryRef.current = cursorHistory;
  }, [cursorHistory]);

  useEffect(() => {
    if (isLoading) return undefined;

    const poll = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (writeInFlightRef.current) return;
      if (isNewEmployeeModalOpen || editEmployee) return;
      if (tableBusy) return;

      void loadEmployees({ silent: true });
    };

    const timerId = window.setInterval(poll, EMPLOYEE_STATUS_POLL_MS);

    const onVisibility = () => {
      if (!document.hidden) poll();
    };

    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.clearInterval(timerId);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [
    editEmployee,
    isLoading,
    isNewEmployeeModalOpen,
    loadEmployees,
    tableBusy,
  ]);

  useDataRefresh(() => loadEmployees({ silent: true }), {
    paused:
      Boolean(editEmployee) ||
      isNewEmployeeModalOpen ||
      tableBusy ||
      isLoading,
  });

  const withWriteLock = async (work) => {
    writeInFlightRef.current = true;
    try {
      return await work();
    } finally {
      writeInFlightRef.current = false;
    }
  };

  const handleCreateEmployee = async (newEmployeeData) => {
    await withWriteLock(async () => {
      await createEmployee(newEmployeeData);
      setIsNewEmployeeModalOpen(false);
      setCurrentPage(1);
      setCursorHistory([null]);
      await loadEmployees();
    });
  };

  const handleUpdateEmployee = async (payload) => {
    if (!editEmployee) return;

    await withWriteLock(async () => {
      const updated = await updateEmployee(editEmployee.id, payload);
      setEmployees((prev) =>
        prev.map((item) => (item.id === updated.id ? updated : item))
      );
      setEditEmployee(null);
    });
  };

  const handleTerminateEmployee = async (employee) => {
    await withWriteLock(async () => {
      const updatedEmployee = await terminateEmployee(employee.id);
      setEmployees((prev) =>
        prev.map((item) =>
          item.id === updatedEmployee.id ? updatedEmployee : item
        )
      );
    });
  };

  const handleActivateEmployee = async (employee) => {
    return withWriteLock(async () => {
      const updatedEmployee = await activateEmployee(employee.id);
      setEmployees((prev) =>
        prev.map((item) =>
          item.id === updatedEmployee.id ? updatedEmployee : item
        )
      );
      return updatedEmployee;
    });
  };

  const handleSuspendEmployee = async (employee, reactivatedDate) => {
    return withWriteLock(async () => {
      const updatedEmployee = await suspendEmployee(
        employee.id,
        reactivatedDate
      );
      setEmployees((prev) =>
        prev.map((item) =>
          item.id === updatedEmployee.id ? updatedEmployee : item
        )
      );
      return updatedEmployee;
    });
  };

  const handleDeleteEmployee = async (employee) => {
    await withWriteLock(async () => {
      await deleteEmployee(employee.id);
      await loadEmployees();
    });
  };

  const startRecord = employees.length
    ? (currentPage - 1) * EMPLOYEES_PER_PAGE + 1
    : 0;
  const endRecord = startRecord + employees.length - (employees.length ? 1 : 0);

  const canGoPreviousPage = !isLoading && currentPage > 1;
  const canGoNextPage =
    !isLoading &&
    pagination.hasMore &&
    pagination.nextCursor != null &&
    employees.length > 0;

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
            List of Matrix Employees
          </h1>

          <div className="flex w-full flex-wrap items-center gap-3 lg:ml-auto lg:w-auto lg:justify-end">
            <Link
              href="/orders"
              className="inline-flex h-[36px] items-center justify-center gap-2 whitespace-nowrap rounded-[6px] border border-[#E2E8F0] bg-white px-4 text-[12px] font-semibold text-[#475569] shadow-sm hover:bg-[#F8FAFC]"
            >
              <ArrowLeftIcon />
              Return to Orders
            </Link>

            {!readOnly && (
              <button
                type="button"
                onClick={() => setIsNewEmployeeModalOpen(true)}
                className="inline-flex h-[36px] items-center justify-center gap-2 whitespace-nowrap rounded-[6px] bg-[#0097B2] px-4 text-[12px] font-semibold text-white shadow-sm hover:bg-[#0086A0]"
              >
                <UserPlusIcon />
                New Matrix Employee
              </button>
            )}
          </div>
        </div>

        {pageError && (
          <p className="rounded-[6px] border border-red-200 bg-red-50 px-3 py-2 text-[12px] font-medium text-red-600">
            {pageError}
          </p>
        )}

        {!isLoading && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <EmployeeSearch
              value={searchInput}
              onChange={setSearchInput}
              onSearch={applySearch}
              onClear={clearSearch}
              hasApplied={Boolean(appliedSearch.trim())}
            />

            <p className="text-[11px] text-[#64748B]">
              {appliedSearch.trim()
                ? pagination.hasMore
                  ? `Showing ${startRecord}-${endRecord} of ${endRecord}+ employees`
                  : `Showing ${startRecord}-${endRecord} of ${endRecord} employees`
                : pagination.hasMore
                  ? `Showing ${startRecord}-${endRecord} of ${endRecord}+ employees`
                  : `${endRecord} employees`}
            </p>
          </div>
        )}

        {isLoading ? (
          <div className="flex flex-1 items-center justify-center rounded-[10px] border border-[#E2E8F0] bg-white">
            <p className="text-[13px] text-[#64748B]">Loading employees...</p>
          </div>
        ) : (
          <MatrixEmployeesTable
            employees={employees}
            readOnly={readOnly}
            onEditEmployee={setEditEmployee}
            onTerminateEmployee={handleTerminateEmployee}
            onDeleteEmployee={handleDeleteEmployee}
            onActivateEmployee={handleActivateEmployee}
            onSuspendEmployee={handleSuspendEmployee}
            onInteractionBusyChange={setTableBusy}
          />
        )}

        {!isLoading && (
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

        {!readOnly && (
          <EmployeeFormModal
            open={isNewEmployeeModalOpen}
            onClose={() => setIsNewEmployeeModalOpen(false)}
            onCreate={handleCreateEmployee}
          />
        )}

        {!readOnly && (
          <EmployeeFormModal
            open={Boolean(editEmployee)}
            mode="edit"
            employee={editEmployee}
            onClose={() => setEditEmployee(null)}
            onUpdate={handleUpdateEmployee}
          />
        )}
      </div>
    </DashboardShell>
  );
}

function EmployeeSearch({ value, onChange, onSearch, onClear, hasApplied }) {
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
            placeholder="Search employee name"
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
