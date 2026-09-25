"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import DashboardShell from "@/components/layout/DashboardShell";
import InvoiceReportTable from "@/components/invoices/InvoiceReportTable";
import CurrentDateTime from "@/components/dashboard/CurrentDateTime";
import {
  getInvoiceReportSummary,
  getInvoicesPaginated,
} from "@/lib/invoices/invoiceApi";
import { useDataRefresh } from "@/lib/liveRefresh/useDataRefresh";

const REPORT_INVOICES_PER_PAGE = 10;

const EMPTY_SUMMARY = {
  companies: 0,
  cases: 0,
  invoiced: "$0.00",
  paid: "$0.00",
  due: "$0.00",
};

export default function InvoicesPage() {
  const [invoiceCategory, setInvoiceCategory] = useState("invoice");
  const [activeTab, setActiveTab] = useState("outstanding");
  const [filters, setFilters] = useState({
    from: "",
    through: "",
    orderId: "",
  });
  const [appliedFilters, setAppliedFilters] = useState({
    from: "",
    through: "",
    orderId: "",
  });
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [summariesLoading, setSummariesLoading] = useState(true);
  const [outstanding, setOutstanding] = useState({
    groups: [],
    summary: EMPTY_SUMMARY,
    count: 0,
  });
  const [resend, setResend] = useState({
    groups: [],
    summary: EMPTY_SUMMARY,
    count: 0,
  });
  const [xrayOutstanding, setXrayOutstanding] = useState({
    groups: [],
    summary: EMPTY_SUMMARY,
    count: 0,
  });
  const [xrayResend, setXrayResend] = useState({
    groups: [],
    summary: EMPTY_SUMMARY,
    count: 0,
  });

  const dateFilters = useMemo(
    () => ({
      dateFrom: appliedFilters.from || undefined,
      dateTo: appliedFilters.through || undefined,
      search: appliedFilters.orderId || undefined,
      pageSize: REPORT_INVOICES_PER_PAGE,
    }),
    [appliedFilters.from, appliedFilters.through, appliedFilters.orderId]
  );

  const loadSummaries = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setSummariesLoading(true);

    try {
      const [
        outstandingData,
        resendData,
        xrayOutstandingData,
        xrayResendData,
      ] = await Promise.all([
        getInvoiceReportSummary({ ...dateFilters, tab: "outstanding", type: "invoice" }),
        getInvoiceReportSummary({ ...dateFilters, tab: "resend", type: "invoice" }),
        getInvoiceReportSummary({ ...dateFilters, tab: "outstanding", type: "xray" }),
        getInvoiceReportSummary({ ...dateFilters, tab: "resend", type: "xray" }),
      ]);

      setOutstanding((prev) => ({
        ...prev,
        summary: outstandingData.summary,
        count: outstandingData.count,
      }));
      setResend((prev) => ({
        ...prev,
        summary: resendData.summary,
        count: resendData.count,
      }));
      setXrayOutstanding((prev) => ({
        ...prev,
        summary: xrayOutstandingData.summary,
        count: xrayOutstandingData.count,
      }));
      setXrayResend((prev) => ({
        ...prev,
        summary: xrayResendData.summary,
        count: xrayResendData.count,
      }));
    } catch {
      if (!silent) {
        setOutstanding((prev) => ({ ...prev, summary: EMPTY_SUMMARY, count: 0 }));
        setResend((prev) => ({ ...prev, summary: EMPTY_SUMMARY, count: 0 }));
        setXrayOutstanding((prev) => ({ ...prev, summary: EMPTY_SUMMARY, count: 0 }));
        setXrayResend((prev) => ({ ...prev, summary: EMPTY_SUMMARY, count: 0 }));
      }
    } finally {
      if (!silent) setSummariesLoading(false);
    }
  }, [dateFilters]);

  const loadActiveTab = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);

    const requestFilters = {
      ...dateFilters,
    };

    try {
      let data;

      if (invoiceCategory === "xray") {
        data = await getInvoicesPaginated({
          ...requestFilters,
          tab: activeTab === "resend" ? "resend" : "outstanding",
          type: "xray",
        });

        if (activeTab === "resend") {
          setXrayResend({
            groups: data.groups,
            summary: data.summary,
            count: data.count,
          });
        } else {
          setXrayOutstanding({
            groups: data.groups,
            summary: data.summary,
            count: data.count,
          });
        }
      } else {
        data = await getInvoicesPaginated({
          ...requestFilters,
          tab: activeTab === "resend" ? "resend" : "outstanding",
          type: "invoice",
        });

        if (activeTab === "resend") {
          setResend({
            groups: data.groups,
            summary: data.summary,
            count: data.count,
          });
        } else {
          setOutstanding({
            groups: data.groups,
            summary: data.summary,
            count: data.count,
          });
        }
      }
    } catch {
      if (!silent) {
        if (invoiceCategory === "xray") {
          if (activeTab === "resend") {
            setXrayResend({ groups: [], summary: EMPTY_SUMMARY, count: 0 });
          } else {
            setXrayOutstanding({ groups: [], summary: EMPTY_SUMMARY, count: 0 });
          }
        } else if (activeTab === "resend") {
          setResend({ groups: [], summary: EMPTY_SUMMARY, count: 0 });
        } else {
          setOutstanding({ groups: [], summary: EMPTY_SUMMARY, count: 0 });
        }
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [activeTab, dateFilters, invoiceCategory]);

  useEffect(() => {
    loadSummaries();
  }, [loadSummaries, refreshKey]);

  useEffect(() => {
    loadActiveTab();
  }, [loadActiveTab, refreshKey]);

  const reloadInvoices = useCallback(async () => {
    await Promise.all([loadSummaries(), loadActiveTab()]);
  }, [loadSummaries, loadActiveTab]);

  useDataRefresh(() => {
    void Promise.all([
      loadSummaries({ silent: true }),
      loadActiveTab({ silent: true }),
    ]);
  });

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
      orderId: filters.orderId.trim(),
    });
    setRefreshKey((value) => value + 1);
  };

  const handleReset = () => {
    const emptyFilters = {
      from: "",
      through: "",
      orderId: "",
    };

    setFilters(emptyFilters);
    setAppliedFilters(emptyFilters);
    setRefreshKey((value) => value + 1);
  };

  const isXray = invoiceCategory === "xray";
  const currentOutstandingGroups = isXray
    ? xrayOutstanding.groups
    : outstanding.groups;
  const currentResendGroups = isXray ? xrayResend.groups : resend.groups;

  const currentOutstandingCount = isXray
    ? xrayOutstanding.count
    : outstanding.count;
  const currentResendCount = isXray ? xrayResend.count : resend.count;

  const activeSummary = useMemo(() => {
    if (loading || summariesLoading) {
      return activeTab === "resend"
        ? isXray
          ? xrayResend.summary
          : resend.summary
        : isXray
          ? xrayOutstanding.summary
          : outstanding.summary;
    }

    if (activeTab === "resend") {
      return isXray ? xrayResend.summary : resend.summary;
    }

    return isXray ? xrayOutstanding.summary : outstanding.summary;
  }, [
    activeTab,
    isXray,
    loading,
    summariesLoading,
    outstanding.summary,
    resend.summary,
    xrayOutstanding.summary,
    xrayResend.summary,
  ]);

  return (
    <DashboardShell>
      <div className="flex min-h-[calc(100vh-92px)] min-w-0 flex-col gap-5 overflow-hidden">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <h1 className="text-[18px] font-semibold text-[#111827]">
            DMS Outstanding Invoices Report
          </h1>

          <CurrentDateTime
            variant="short"
            prefix="as of"
            className="text-[12px] text-[#94A3B8]"
          />
        </div>

        <div className="flex flex-col gap-3 border-b border-[#E2E8F0] pb-0">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <InvoiceCategoryTabs
              activeCategory={invoiceCategory}
              onChange={(category) => {
                setInvoiceCategory(category);
                setActiveTab("outstanding");
              }}
              invoiceOutstandingCount={outstanding.count}
              invoiceResendCount={resend.count}
              xrayOutstandingCount={xrayOutstanding.count}
              xrayResendCount={xrayResend.count}
            />

            <Link
              href="/invoices/company-wise"
              className="mb-3 inline-flex h-[34px] w-fit items-center justify-center gap-2 whitespace-nowrap rounded-[6px] border border-[#67D8E8] bg-[#E6F7FA] px-4 text-[12px] font-semibold text-[#007F96] hover:bg-[#DDF6FA]"
            >
              <CompanyIcon />
              View Company Wise
            </Link>
          </div>

          <InvoiceTabs
            activeTab={activeTab}
            onChange={setActiveTab}
            outstandingCount={currentOutstandingCount}
            resendCount={currentResendCount}
            labelPrefix={isXray ? "X-Ray " : ""}
          />
        </div>

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(520px,650px)]">
          <InvoiceFilters
            filters={filters}
            onChange={handleFilterChange}
            onFilter={handleApplyFilters}
            onReset={handleReset}
          />

          <InvoiceSummary summary={activeSummary} loading={loading} />
        </div>

        {activeTab === "outstanding" ? (
          <InvoiceReportTable
            invoiceGroups={currentOutstandingGroups}
            loading={loading}
            onRefresh={reloadInvoices}
            onSent={() => setActiveTab("resend")}
            invoiceType={isXray ? "xray" : "invoice"}
            enableWriteOff
            reportTab="outstanding"
            reportFilters={dateFilters}
          />
        ) : (
          <InvoiceReportTable
            invoiceGroups={currentResendGroups}
            loading={loading}
            onRefresh={reloadInvoices}
            invoiceType={isXray ? "xray" : "invoice"}
            enableWriteOff={false}
            mode="resend"
            reportTab="resend"
            reportFilters={dateFilters}
          />
        )}
      </div>
    </DashboardShell>
  );
}

function InvoiceCategoryTabs({
  activeCategory,
  onChange,
  invoiceOutstandingCount,
  invoiceResendCount,
  xrayOutstandingCount,
  xrayResendCount,
}) {
  const invoiceTotal = invoiceOutstandingCount + invoiceResendCount;
  const xrayTotal = xrayOutstandingCount + xrayResendCount;

  return (
    <div className="flex items-center gap-3 overflow-x-auto">
      <button
        type="button"
        onClick={() => onChange("invoice")}
        className={`whitespace-nowrap rounded-t-[8px] border-b-2 px-5 py-3 text-[13px] font-semibold transition ${
          activeCategory === "invoice"
            ? "border-[#0097B2] bg-[#E6F7FA] text-[#007F96]"
            : "border-transparent text-[#64748B] hover:bg-[#F8FAFC]"
        }`}
      >
        Invoices ({invoiceTotal})
      </button>

      <button
        type="button"
        onClick={() => onChange("xray")}
        className={`whitespace-nowrap rounded-t-[8px] border-b-2 px-5 py-3 text-[13px] font-semibold transition ${
          activeCategory === "xray"
            ? "border-[#0097B2] bg-[#E6F7FA] text-[#007F96]"
            : "border-transparent text-[#64748B] hover:bg-[#F8FAFC]"
        }`}
      >
        X-Ray Invoices ({xrayTotal})
      </button>
    </div>
  );
}

function InvoiceTabs({
  activeTab,
  onChange,
  outstandingCount,
  resendCount,
  labelPrefix = "",
}) {
  return (
    <div className="flex items-center gap-3 overflow-x-auto">
      <button
        type="button"
        onClick={() => onChange("outstanding")}
        className={`whitespace-nowrap border-b-2 px-5 py-3 text-[13px] font-semibold transition ${
          activeTab === "outstanding"
            ? "border-[#0097B2] bg-[#E6F7FA] text-[#007F96]"
            : "border-transparent text-[#64748B] hover:bg-[#F8FAFC]"
        }`}
      >
        Outstanding {labelPrefix}Invoices ({outstandingCount})
      </button>

      <button
        type="button"
        onClick={() => onChange("resend")}
        className={`whitespace-nowrap border-b-2 px-5 py-3 text-[13px] font-semibold transition ${
          activeTab === "resend"
            ? "border-[#0097B2] bg-[#E6F7FA] text-[#007F96]"
            : "border-transparent text-[#64748B] hover:bg-[#F8FAFC]"
        }`}
      >
        Resend {labelPrefix}Invoices ({resendCount})
      </button>
    </div>
  );
}

function InvoiceFilters({ filters, onChange, onFilter, onReset }) {
  return (
    <section className="rounded-[10px] border border-[#E2E8F0] bg-white px-5 py-5 shadow-sm">
      <h2 className="mb-4 text-[13px] font-semibold text-[#334155]">
        Filters
      </h2>

      <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end">
        <TextField
          label="Order ID"
          name="orderId"
          value={filters.orderId}
          onChange={onChange}
          placeholder="Enter order number"
        />

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

function TextField({ label, name, value, onChange, placeholder = "" }) {
  return (
    <div className="min-w-0 flex-1 lg:max-w-[180px]">
      <label className="mb-2 block text-[11px] font-medium text-[#64748B]">
        {label}
      </label>

      <input
        type="text"
        name={name}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className="h-[38px] w-full rounded-[6px] border border-[#CBD5E1] bg-[#F8FAFC] px-3 text-[12px] text-[#111827] outline-none placeholder:text-[#94A3B8] focus:border-[#0097B2] focus:ring-2 focus:ring-[#0097B2]/10"
      />
    </div>
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

function InvoiceSummary({ summary, loading }) {
  return (
    <section className="rounded-[10px] border border-[#E2E8F0] bg-white px-5 py-5 shadow-sm">
      <h2 className="mb-4 text-[13px] font-semibold text-[#334155]">
        Summary
      </h2>

      <div className="grid grid-cols-2 gap-x-10 gap-y-4 sm:grid-cols-3 xl:grid-cols-5">
        <SummaryItem
          label="Companies"
          value={loading ? "..." : String(summary.companies)}
        />
        <SummaryItem
          label="Cases"
          value={loading ? "..." : String(summary.cases)}
        />
        <SummaryItem
          label="Invoiced"
          value={loading ? "..." : summary.invoiced}
        />
        <SummaryItem
          label="Paid"
          value={loading ? "..." : summary.paid}
          green
        />
        <SummaryItem
          label="Due"
          value={loading ? "..." : summary.due}
          red
        />
      </div>
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

function CompanyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 21V5h16v16M8 9h2M8 13h2M8 17h2M14 9h2M14 13h2M14 17h2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
