"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import DashboardShell from "@/components/layout/DashboardShell";
import PaymentsTable from "@/components/payments/PaymentsTable";
import ManualPaymentModal from "@/components/payments/ManualPaymentModal";
import CurrentDateTime from "@/components/dashboard/CurrentDateTime";
import { getPayments } from "@/lib/payments/paymentApi";
import { useDataRefresh } from "@/lib/liveRefresh/useDataRefresh";

const PAYMENTS_PER_PAGE = 10;

const EMPTY_MANUAL_SUMMARY = {
  totalPayments: 0,
  totalAmount: "$0.00",
  checkCount: 0,
  wireCount: 0,
  pendingCount: 0,
};

const EMPTY_ONLINE_SUMMARY = {
  totalTransactions: 0,
  totalCollected: "$0.00",
  succeededCount: 0,
  pendingCount: 0,
  failedCount: 0,
};

const EMPTY_PAGINATION = {
  type: "keyset",
  pageSize: PAYMENTS_PER_PAGE,
  hasMore: false,
  nextCursor: null,
};

function createTabState(emptySummary) {
  return {
    payments: [],
    summary: emptySummary,
    pagination: { ...EMPTY_PAGINATION },
    count: 0,
    currentPage: 1,
    cursorHistory: [null],
    loaded: false,
  };
}

export default function PaymentsPage() {
  const searchParams = useSearchParams();
  const initialChannel =
    searchParams.get("channel") === "online" ? "online" : "manual";
  const [paymentType, setPaymentType] = useState(initialChannel);
  const [filters, setFilters] = useState({
    from: "",
    through: "",
  });
  const [appliedFilters, setAppliedFilters] = useState({
    from: "",
    through: "",
  });
  const [orderSearch, setOrderSearch] = useState("");
  const [appliedOrderSearch, setAppliedOrderSearch] = useState("");
  const [invoiceSearch, setInvoiceSearch] = useState("");
  const [appliedInvoiceSearch, setAppliedInvoiceSearch] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [manualPaymentModalOpen, setManualPaymentModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  const [manualState, setManualState] = useState(() =>
    createTabState(EMPTY_MANUAL_SUMMARY)
  );
  const [onlineState, setOnlineState] = useState(() =>
    createTabState(EMPTY_ONLINE_SUMMARY)
  );

  const manualCursorHistoryRef = useRef([null]);
  const onlineCursorHistoryRef = useRef([null]);
  const loadAbortRef = useRef(null);

  useEffect(() => {
    manualCursorHistoryRef.current = manualState.cursorHistory;
  }, [manualState.cursorHistory]);

  useEffect(() => {
    onlineCursorHistoryRef.current = onlineState.cursorHistory;
  }, [onlineState.cursorHistory]);

  const isManual = paymentType === "manual";
  const activeState = isManual ? manualState : onlineState;
  const setActiveState = isManual ? setManualState : setOnlineState;
  const activeCursorHistoryRef = isManual
    ? manualCursorHistoryRef
    : onlineCursorHistoryRef;
  const activePage = activeState.currentPage;

  const loadActiveTab = useCallback(async ({ silent = false } = {}) => {
    if (loadAbortRef.current) {
      loadAbortRef.current.abort();
    }
    const controller = new AbortController();
    loadAbortRef.current = controller;

    if (!silent) setLoading(true);

    const cursor = activeCursorHistoryRef.current[activePage - 1] ?? null;
    const includeSummary = activePage === 1;

    try {
      const result = await getPayments({
        type: paymentType,
        dateFrom: appliedFilters.from || undefined,
        dateTo: appliedFilters.through || undefined,
        orderSearch: appliedOrderSearch || undefined,
        invoiceSearch: appliedInvoiceSearch || undefined,
        cursor,
        pageSize: PAYMENTS_PER_PAGE,
        pagination: "keyset",
        includeSummary,
        signal: controller.signal,
      });

      if (controller.signal.aborted) return;

      const hasMore = Boolean(result.pagination?.hasMore);
      const nextCursor = result.pagination?.nextCursor ?? null;

      setActiveState((prev) => {
        const nextHistory = prev.cursorHistory.slice(0, activePage);
        if (hasMore && nextCursor != null) {
          nextHistory[activePage] = nextCursor;
        }
        activeCursorHistoryRef.current = nextHistory;

        const nextSummary =
          result.summary != null
            ? result.summary
            : prev.summary ||
              (paymentType === "manual"
                ? EMPTY_MANUAL_SUMMARY
                : EMPTY_ONLINE_SUMMARY);

        const nextCount =
          result.count != null
            ? result.count
            : result.summary != null
              ? Number(
                  result.summary.totalPayments ??
                    result.summary.totalTransactions ??
                    0
                ) || prev.count
              : prev.count;

        return {
          ...prev,
          payments: result.payments || [],
          summary: nextSummary,
          pagination: {
            type: "keyset",
            pageSize:
              Number(result.pagination?.pageSize) || PAYMENTS_PER_PAGE,
            hasMore,
            nextCursor,
          },
          count: nextCount,
          currentPage: activePage,
          cursorHistory: nextHistory.length ? nextHistory : [null],
          loaded: true,
        };
      });
    } catch (error) {
      if (
        controller.signal.aborted ||
        error?.name === "AbortError" ||
        error?.code === 20
      ) {
        return;
      }

      if (!silent) {
        setActiveState((prev) => ({
          ...prev,
          payments: [],
          summary:
            paymentType === "manual"
              ? EMPTY_MANUAL_SUMMARY
              : EMPTY_ONLINE_SUMMARY,
          pagination: { ...EMPTY_PAGINATION },
          count: 0,
          loaded: true,
        }));
      }
    } finally {
      if (!controller.signal.aborted && !silent) {
        setLoading(false);
      }
    }
  }, [
    activeCursorHistoryRef,
    activePage,
    appliedFilters.from,
    appliedFilters.through,
    appliedInvoiceSearch,
    appliedOrderSearch,
    paymentType,
    setActiveState,
  ]);

  useEffect(() => {
    loadActiveTab();
    return () => {
      if (loadAbortRef.current) {
        loadAbortRef.current.abort();
      }
    };
  }, [loadActiveTab, refreshKey]);

  useDataRefresh(() => loadActiveTab({ silent: true }), {
    paused: manualPaymentModalOpen,
  });

  const resetTabPagination = useCallback((setter, historyRef) => {
    setter((prev) => {
      const next = {
        ...prev,
        currentPage: 1,
        cursorHistory: [null],
        loaded: false,
      };
      if (historyRef) historyRef.current = [null];
      return next;
    });
  }, []);

  const handleFilterChange = (e) => {
    const { name, value } = e.target;

    setFilters((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleApplyFilters = () => {
    setAppliedFilters({
      from: filters.from,
      through: filters.through,
    });
    resetTabPagination(setManualState, manualCursorHistoryRef);
    resetTabPagination(setOnlineState, onlineCursorHistoryRef);
    setRefreshKey((value) => value + 1);
  };

  const handleReset = () => {
    const emptyFilters = {
      from: "",
      through: "",
    };

    setFilters(emptyFilters);
    setAppliedFilters(emptyFilters);
    setOrderSearch("");
    setAppliedOrderSearch("");
    setInvoiceSearch("");
    setAppliedInvoiceSearch("");
    resetTabPagination(setManualState, manualCursorHistoryRef);
    resetTabPagination(setOnlineState, onlineCursorHistoryRef);
    setRefreshKey((value) => value + 1);
  };

  const handleIdSearch = () => {
    setAppliedOrderSearch(orderSearch.trim());
    setAppliedInvoiceSearch(invoiceSearch.trim());
    resetTabPagination(setManualState, manualCursorHistoryRef);
    resetTabPagination(setOnlineState, onlineCursorHistoryRef);
    setRefreshKey((value) => value + 1);
  };

  const handleClearIdSearch = () => {
    setOrderSearch("");
    setAppliedOrderSearch("");
    setInvoiceSearch("");
    setAppliedInvoiceSearch("");
    resetTabPagination(setManualState, manualCursorHistoryRef);
    resetTabPagination(setOnlineState, onlineCursorHistoryRef);
    setRefreshKey((value) => value + 1);
  };

  const handleTabChange = (nextType) => {
    if (nextType === paymentType) return;
    setPaymentType(nextType);
  };

  const goToPreviousPage = () => {
    setActiveState((prev) => ({
      ...prev,
      currentPage: Math.max(prev.currentPage - 1, 1),
    }));
  };

  const goToNextPage = () => {
    if (loading) return;

    setActiveState((prev) => {
      if (!prev.pagination.hasMore || prev.pagination.nextCursor == null) {
        return prev;
      }

      const nextHistory = prev.cursorHistory.slice(0, prev.currentPage);
      nextHistory[prev.currentPage] = prev.pagination.nextCursor;
      activeCursorHistoryRef.current = nextHistory;

      return {
        ...prev,
        cursorHistory: nextHistory,
        currentPage: prev.currentPage + 1,
        pagination: {
          ...prev.pagination,
          hasMore: false,
          nextCursor: null,
        },
      };
    });
  };

  const currentPayments = activeState.payments;
  const currentSummary = activeState.summary;
  const startRecord = currentPayments.length
    ? (activeState.currentPage - 1) * PAYMENTS_PER_PAGE + 1
    : 0;
  const endRecord =
    startRecord + currentPayments.length - (currentPayments.length ? 1 : 0);

  const rangeLabel = useMemo(() => {
    if (loading) return "Loading...";
    if (!currentPayments.length) return "0 payments";
    if (activeState.pagination.hasMore) {
      return `Showing ${startRecord}-${endRecord} of ${endRecord}+ payments`;
    }
    return `Showing ${startRecord}-${endRecord} of ${activeState.count || endRecord} payments`;
  }, [
    activeState.count,
    activeState.pagination.hasMore,
    currentPayments.length,
    endRecord,
    loading,
    startRecord,
  ]);

  return (
    <DashboardShell>
      <div className="flex min-h-[calc(100vh-92px)] min-w-0 flex-col gap-5 overflow-hidden">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-[18px] font-semibold text-[#111827]">
              DMS Payments
            </h1>
            <p className="mt-1 text-[12px] text-[#64748B]">
              Track manual payments and online Stripe transactions in one place.
            </p>
          </div>

          <CurrentDateTime
            variant="short"
            prefix="as of"
            className="text-[12px] text-[#94A3B8]"
          />
        </div>

        <GlobalIdSearch
          orderValue={orderSearch}
          invoiceValue={invoiceSearch}
          onOrderChange={setOrderSearch}
          onInvoiceChange={setInvoiceSearch}
          onSearch={handleIdSearch}
          onClear={handleClearIdSearch}
        />

        <div className="flex flex-col gap-3 border-b border-[#E2E8F0] pb-0">
          <PaymentTypeTabs
            activeType={paymentType}
            onChange={handleTabChange}
            manualCount={
              manualState.loaded ? manualState.count : null
            }
            onlineCount={
              onlineState.loaded ? onlineState.count : null
            }
          />
        </div>

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(520px,650px)]">
          <PaymentFilters
            filters={filters}
            onChange={handleFilterChange}
            onFilter={handleApplyFilters}
            onReset={handleReset}
          />

          <PaymentSummary
            paymentType={paymentType}
            summary={currentSummary}
            loading={loading && activePage === 1}
          />
        </div>

        {isManual ? (
          <ManualPaymentPrompt
            onAddPayment={() => setManualPaymentModalOpen(true)}
          />
        ) : (
          <StripeIntegratedBadge />
        )}

        <ManualPaymentModal
          isOpen={manualPaymentModalOpen}
          onClose={() => setManualPaymentModalOpen(false)}
          onSaved={() => {
            resetTabPagination(setManualState, manualCursorHistoryRef);
            resetTabPagination(setOnlineState, onlineCursorHistoryRef);
            setRefreshKey((value) => value + 1);
          }}
        />

        <PaymentsTable
          payments={currentPayments}
          loading={loading}
          paymentType={paymentType}
        />

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[11px] text-[#64748B]">{rangeLabel}</p>

          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={goToPreviousPage}
              disabled={loading || activeState.currentPage === 1}
              className="flex h-[28px] min-w-[28px] items-center justify-center rounded-[6px] border border-[#E2E8F0] bg-white px-2 text-[12px] text-[#64748B] hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-40"
            >
              ‹
            </button>

            <span className="flex h-[28px] min-w-[28px] items-center justify-center rounded-[6px] bg-[#111827] px-2 text-[12px] font-semibold text-white">
              {activeState.currentPage}
            </span>

            <button
              type="button"
              onClick={goToNextPage}
              disabled={
                loading ||
                !activeState.pagination.hasMore ||
                activeState.pagination.nextCursor == null
              }
              className="flex h-[28px] min-w-[28px] items-center justify-center rounded-[6px] border border-[#E2E8F0] bg-white px-2 text-[12px] text-[#64748B] hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-40"
            >
              ›
            </button>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}

function GlobalIdSearch({
  orderValue,
  invoiceValue,
  onOrderChange,
  onInvoiceChange,
  onSearch,
  onClear,
}) {
  const handleKeyDown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onSearch?.();
    }
  };

  const canReset = Boolean(
    `${orderValue || ""}`.trim() || `${invoiceValue || ""}`.trim()
  );

  return (
    <section className="rounded-[10px] border border-[#E2E8F0] bg-white px-4 py-3 shadow-sm">
      <div className="flex flex-col gap-3">
        <p className="text-[12px] font-semibold text-[#334155]">
          Search by Order ID or Invoice ID
        </p>

        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[6px] border border-[#CBD5E1] bg-[#F8FAFC] px-3">
            <SearchIcon />
            <label
              htmlFor="global-order-search"
              className="shrink-0 text-[11px] font-medium text-[#64748B]"
            >
              Order ID
            </label>
            <input
              id="global-order-search"
              type="text"
              value={orderValue}
              onChange={(e) => onOrderChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Order number or ID (e.g. 70656-1)"
              className="h-[38px] min-w-0 flex-1 bg-transparent text-[12px] text-[#111827] outline-none placeholder:text-[#94A3B8]"
            />
          </div>

          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[6px] border border-[#CBD5E1] bg-[#F8FAFC] px-3">
            <SearchIcon />
            <label
              htmlFor="global-invoice-search"
              className="shrink-0 text-[11px] font-medium text-[#64748B]"
            >
              Invoice ID
            </label>
            <input
              id="global-invoice-search"
              type="text"
              value={invoiceValue}
              onChange={(e) => onInvoiceChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Invoice number (e.g. INV-24018)"
              className="h-[38px] min-w-0 flex-1 bg-transparent text-[12px] text-[#111827] outline-none placeholder:text-[#94A3B8]"
            />
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onSearch}
              className="h-[38px] min-w-[88px] rounded-[6px] bg-[#0097B2] px-5 text-[12px] font-semibold text-white hover:bg-[#0086A0]"
            >
              Search
            </button>

            <button
              type="button"
              onClick={onClear}
              disabled={!canReset}
              className="h-[38px] min-w-[88px] rounded-[6px] bg-[#F1F5F9] px-5 text-[12px] font-semibold text-[#334155] hover:bg-[#E2E8F0] disabled:cursor-not-allowed disabled:bg-[#F8FAFC] disabled:text-[#94A3B8] disabled:hover:bg-[#F8FAFC]"
            >
              Reset
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function SearchIcon() {
  return (
    <svg
      className="shrink-0 text-[#94A3B8]"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.7" />
      <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function PaymentTypeTabs({ activeType, onChange, manualCount, onlineCount }) {
  return (
    <div className="flex items-center gap-3 overflow-x-auto">
      <button
        type="button"
        onClick={() => onChange("manual")}
        className={`whitespace-nowrap rounded-t-[8px] border-b-2 px-5 py-3 text-[13px] font-semibold transition ${
          activeType === "manual"
            ? "border-[#0097B2] bg-[#E6F7FA] text-[#007F96]"
            : "border-transparent text-[#64748B] hover:bg-[#F8FAFC]"
        }`}
      >
        Manual Payments
        {manualCount != null ? ` (${manualCount})` : ""}
      </button>

      <button
        type="button"
        onClick={() => onChange("online")}
        className={`whitespace-nowrap rounded-t-[8px] border-b-2 px-5 py-3 text-[13px] font-semibold transition ${
          activeType === "online"
            ? "border-[#0097B2] bg-[#E6F7FA] text-[#007F96]"
            : "border-transparent text-[#64748B] hover:bg-[#F8FAFC]"
        }`}
      >
        Online Payments
        {onlineCount != null ? ` (${onlineCount})` : ""}
      </button>
    </div>
  );
}

function PaymentFilters({ filters, onChange, onFilter, onReset }) {
  return (
    <section className="rounded-[10px] border border-[#E2E8F0] bg-white px-5 py-5 shadow-sm">
      <h2 className="mb-4 text-[13px] font-semibold text-[#334155]">
        Filters
      </h2>

      <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end">
        <DateField
          label="From"
          name="from"
          value={filters.from}
          onChange={onChange}
        />

        <DateField
          label="Through"
          name="through"
          value={filters.through}
          onChange={onChange}
        />

        <button
          type="button"
          onClick={onFilter}
          className="h-[38px] whitespace-nowrap rounded-[6px] bg-[#0097B2] px-5 text-[12px] font-semibold text-white hover:bg-[#0086A0]"
        >
          Apply Filters
        </button>

        <button
          type="button"
          onClick={onReset}
          className="h-[38px] whitespace-nowrap rounded-[6px] bg-[#F1F5F9] px-5 text-[12px] font-semibold text-[#334155] hover:bg-[#E2E8F0]"
        >
          Reset
        </button>
      </div>
    </section>
  );
}

function DateField({ label, name, value, onChange }) {
  return (
    <div className="min-w-0 flex-1">
      <label className="mb-2 block text-[11px] font-medium text-[#64748B]">
        {label}
      </label>

      <input
        type="date"
        name={name}
        value={value}
        onChange={onChange}
        className="h-[38px] w-full rounded-[6px] border border-[#CBD5E1] bg-[#F8FAFC] px-3 text-[12px] text-[#111827] outline-none focus:border-[#0097B2] focus:ring-2 focus:ring-[#0097B2]/10"
      />
    </div>
  );
}

function PaymentSummary({ paymentType, summary, loading }) {
  const isManual = paymentType === "manual";

  return (
    <section className="rounded-[10px] border border-[#E2E8F0] bg-white px-5 py-5 shadow-sm">
      <h2 className="mb-4 text-[13px] font-semibold text-[#334155]">
        Summary
      </h2>

      {isManual ? (
        <div className="grid grid-cols-2 gap-x-10 gap-y-4 sm:grid-cols-3 xl:grid-cols-5">
          <SummaryItem
            label="Total Payments"
            value={loading ? "..." : String(summary.totalPayments)}
          />
          <SummaryItem
            label="Total Amount"
            value={loading ? "..." : summary.totalAmount}
          />
          <SummaryItem
            label="Checks"
            value={loading ? "..." : String(summary.checkCount)}
          />
          <SummaryItem
            label="Wire Transfers"
            value={loading ? "..." : String(summary.wireCount)}
          />
          <SummaryItem
            label="Pending Review"
            value={loading ? "..." : String(summary.pendingCount)}
            red={summary.pendingCount > 0}
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-10 gap-y-4 sm:grid-cols-3 xl:grid-cols-5">
          <SummaryItem
            label="Transactions"
            value={loading ? "..." : String(summary.totalTransactions)}
          />
          <SummaryItem
            label="Collected"
            value={loading ? "..." : summary.totalCollected}
            green
          />
          <SummaryItem
            label="Succeeded"
            value={loading ? "..." : String(summary.succeededCount)}
            green
          />
          <SummaryItem
            label="Pending"
            value={loading ? "..." : String(summary.pendingCount)}
          />
          <SummaryItem
            label="Failed"
            value={loading ? "..." : String(summary.failedCount)}
            red={summary.failedCount > 0}
          />
        </div>
      )}
    </section>
  );
}

function SummaryItem({ label, value, green = false, red = false }) {
  return (
    <div className="min-w-[105px]">
      <p className="mb-2 text-[11px] text-[#64748B]">{label}</p>

      <p
        className={`whitespace-nowrap text-[18px] font-semibold ${
          green
            ? "text-[#059669]"
            : red
              ? "text-red-500"
              : "text-[#111827]"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function ManualPaymentPrompt({ onAddPayment }) {
  return (
    <section className="flex flex-col gap-4 rounded-[10px] border border-[#E2E8F0] bg-white px-5 py-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h2 className="text-[13px] font-semibold text-[#334155]">
          Got a manual payment?
        </h2>
        <p className="mt-1 text-[12px] text-[#64748B]">
          Update details by searching the order and recording the check information.
        </p>
      </div>

      <button
        type="button"
        onClick={onAddPayment}
        className="h-[38px] shrink-0 rounded-[6px] bg-[#0097B2] px-5 text-[12px] font-semibold text-white hover:bg-[#0086A0]"
      >
        Add New Payment
      </button>
    </section>
  );
}

function StripeIntegratedBadge() {
  return (
    <div className="flex justify-end">
      <span className="inline-flex h-[28px] items-center gap-2 rounded-full border border-[#CFFAFE] bg-[#E6F7FA] px-3 text-[11px] font-semibold text-[#007F96]">
        <StripeMarkIcon />
        Stripe Integrated
      </span>
    </div>
  );
}

function StripeMarkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 10.2c0-.9.7-1.2 1.9-1.4 1.1-.1 2.5-.1 4.1 0V7.4c0-.2 0-.4-.1-.5H5.9c-1 0-1.8.4-1.8 1.4v8.8c0 .3.2.5.5.5h2.1c.3 0 .5-.2.5-.5v-6.9Z"
        fill="currentColor"
      />
      <path
        d="M13.2 8.8c1.6-.1 3.2 0 4.3.2 1.2.2 1.9.5 1.9 1.4v6.9c0 .3-.2.5-.5.5h-2.1c-.3 0-.5-.2-.5-.5v-1.6c-.8.6-1.8.9-3 .9-2.1 0-3.5-1.1-3.5-2.8 0-1.8 1.4-2.7 3.8-2.9Zm1.6 4.5c.7 0 1.3-.2 1.8-.5v-1.8c-.5-.2-1.1-.3-1.8-.3-1 0-1.6.4-1.6 1 0 .6.6 1 1.6 1Z"
        fill="currentColor"
      />
    </svg>
  );
}
