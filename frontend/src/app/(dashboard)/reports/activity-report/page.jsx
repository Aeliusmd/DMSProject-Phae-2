"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import DashboardShell from "@/components/layout/DashboardShell";
import { getStoredUser } from "@/lib/auth/authStorage";
import { canAccessActivityReport } from "@/lib/auth/roles";
import { getFacilities } from "@/lib/facilities/facilityApi";
import { getApiErrorMessage } from "@/lib/apiErrorUtils";
import { getActivityReport, downloadActivityReportPdf } from "@/lib/reports/reportApi";
import { useDataRefresh } from "@/lib/liveRefresh/useDataRefresh";

function formatDateInput(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getPresetRange(preset) {
  const today = new Date();
  const through = formatDateInput(today);

  if (preset === "Last Month") {
    const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const end = new Date(today.getFullYear(), today.getMonth(), 0);
    return { from: formatDateInput(start), to: formatDateInput(end) };
  }

  if (preset === "Last 6 Months") {
    const start = new Date(today);
    start.setMonth(start.getMonth() - 6);
    return { from: formatDateInput(start), to: through };
  }

  if (preset === "Last Year") {
    const year = today.getFullYear() - 1;
    return { from: `${year}-01-01`, to: `${year}-12-31` };
  }

  const start = new Date(today);
  start.setMonth(start.getMonth() - 1);
  return { from: formatDateInput(start), to: through };
}

function getDefaultFilters() {
  return {
    reportDate: "",
    throughDate: "",
    facility: "all",
    activity: "All",
  };
}

export default function ActivityReportPage() {
  const router = useRouter();
  const user = getStoredUser();
  const allowed = canAccessActivityReport(user);
  const searchInputRef = useRef(null);

  useEffect(() => {
    if (!allowed) {
      router.replace("/reports");
    }
  }, [allowed, router]);

  const [draftFilters, setDraftFilters] = useState(getDefaultFilters);
  const [appliedFilters, setAppliedFilters] = useState(getDefaultFilters);
  const [facilities, setFacilities] = useState([]);
  const [facilitiesLoadError, setFacilitiesLoadError] = useState("");
  const [companies, setCompanies] = useState([]);
  const [summary, setSummary] = useState({ facilityCount: 0, totalCases: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [expandedCompanyId, setExpandedCompanyId] = useState(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");

  useEffect(() => {
    getFacilities()
      .then((data) => {
        setFacilities(data);
        setFacilitiesLoadError("");
      })
      .catch((err) => {
        setFacilities([]);
        setFacilitiesLoadError(
          getApiErrorMessage(err, "Failed to load facilities")
        );
      });
  }, []);

  useEffect(() => {
    if (isSearchOpen) {
      searchInputRef.current?.focus();
    }
  }, [isSearchOpen]);

  const loadReport = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true);
      setError("");
    }

    try {
      const data = await getActivityReport({
        reportDate: appliedFilters.reportDate,
        throughDate: appliedFilters.throughDate,
        facilityId: appliedFilters.facility,
        activity: appliedFilters.activity,
        search: appliedSearch,
      });
      setCompanies(data.companies || []);
      setSummary(data.summary || { facilityCount: 0, totalCases: 0 });
      if (!silent) setError("");
    } catch (err) {
      if (!silent) {
        setCompanies([]);
        setSummary({ facilityCount: 0, totalCases: 0 });
        setError(getApiErrorMessage(err, "Failed to load activity report"));
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, [
    appliedFilters.reportDate,
    appliedFilters.throughDate,
    appliedFilters.facility,
    appliedFilters.activity,
    appliedSearch,
  ]);

  useEffect(() => {
    loadReport();
  }, [loadReport]);

  useDataRefresh(() => loadReport({ silent: true }), {
    paused: exporting,
  });

  const facilityOptions = useMemo(() => {
    const sorted = [...facilities].sort((a, b) => {
      const nameA = (
        a.facility ||
        a.facilityName ||
        a.name ||
        ""
      ).toLowerCase();
      const nameB = (
        b.facility ||
        b.facilityName ||
        b.name ||
        ""
      ).toLowerCase();
      return nameA.localeCompare(nameB);
    });

    return [
      { value: "all", label: "All Facilities" },
      ...sorted.map((facility) => ({
        value: String(facility.id),
        label:
          facility.facility ||
          facility.facilityName ||
          facility.name ||
          `Facility ${facility.id}`,
      })),
    ];
  }, [facilities]);

  const generatedOn = useMemo(() => {
    return new Date().toLocaleDateString("en-US", {
      month: "2-digit",
      day: "2-digit",
      year: "numeric",
    });
  }, []);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setDraftFilters((prev) => ({ ...prev, [name]: value }));
  };

  const handlePreset = (preset) => {
    const range = getPresetRange(preset);
    setDraftFilters((prev) => ({
      ...prev,
      reportDate: range.from,
      throughDate: range.to,
    }));
  };

  const handleApplyFilters = () => {
    setAppliedFilters({ ...draftFilters });
  };

  const handleResetFilters = () => {
    const defaults = getDefaultFilters();
    setDraftFilters(defaults);
    setAppliedFilters(defaults);
    setSearchInput("");
    setAppliedSearch("");
    setIsSearchOpen(false);
  };

  const handleSearch = () => {
    if (!isSearchOpen) {
      setIsSearchOpen(true);
      return;
    }

    setAppliedSearch(searchInput);
  };

  const handleClearSearch = () => {
    setSearchInput("");
    setAppliedSearch("");
    setIsSearchOpen(false);
  };

  const handleSearchKeyDown = (e) => {
    if (e.key === "Enter") {
      setAppliedSearch(searchInput);
    }

    if (e.key === "Escape") {
      handleClearSearch();
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const handleExport = async () => {
    if (!companies.length || exporting) return;

    setExporting(true);
    setExportError("");

    const selectedFacility = facilityOptions.find(
      (option) => option.value === appliedFilters.facility
    );

    try {
      const { blob, fileName } = await downloadActivityReportPdf({
        reportDate: appliedFilters.reportDate,
        throughDate: appliedFilters.throughDate,
        facilityId: appliedFilters.facility,
        facilityLabel: selectedFacility?.label || "All Facilities",
        activity: appliedFilters.activity,
        search: appliedSearch,
      });

      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(getApiErrorMessage(err, "Failed to export activity report PDF"));
    } finally {
      setExporting(false);
    }
  };

  const toggleCompany = (companyId) => {
    setExpandedCompanyId((current) =>
      current === companyId ? null : companyId
    );
  };

  if (!allowed) {
    return (
      <DashboardShell>
        <div className="flex min-h-[calc(100vh-92px)] items-center justify-center">
          <p className="text-[13px] text-[#64748B]">Redirecting...</p>
        </div>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell>
      <div className="flex min-h-[calc(100vh-92px)] min-w-0 flex-col gap-5 overflow-hidden">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-[18px] font-semibold text-[#111827]">
            DMS Custodian - Activity Report
          </h1>

          <Link
            href="/reports"
            className="inline-flex h-[34px] w-fit items-center justify-center gap-2 rounded-[6px] border border-[#E2E8F0] bg-white px-4 text-[12px] font-semibold text-[#475569] shadow-sm hover:bg-[#F8FAFC]"
          >
            <ArrowLeftIcon />
            Back to Reports
          </Link>
        </div>

        <section className="rounded-[10px] border border-[#E2E8F0] bg-white px-4 py-4 shadow-sm">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <ReportField
              label="Report Date"
              name="reportDate"
              type="date"
              value={draftFilters.reportDate}
              onChange={handleChange}
            />

            <ReportField
              label="Through Date"
              name="throughDate"
              type="date"
              value={draftFilters.throughDate}
              onChange={handleChange}
            />

            <ReportField
              label="Facility"
              name="facility"
              type="select"
              value={draftFilters.facility}
              onChange={handleChange}
              options={facilityOptions}
              disabled={Boolean(facilitiesLoadError)}
            />

            <ReportField
              label="Activity"
              name="activity"
              type="select"
              value={draftFilters.activity}
              onChange={handleChange}
              options={[
                { value: "All", label: "All" },
                { value: "Invoiced", label: "Invoiced" },
                { value: "Paid", label: "Paid" },
                { value: "Unpaid", label: "Unpaid" },
                { value: "Written Off", label: "Written Off" },
                { value: "Produced", label: "Produced" },
              ]}
            />
          </div>

          {facilitiesLoadError && (
            <p className="mt-3 rounded-[6px] border border-[#FEE2E2] bg-[#FEF2F2] px-3 py-2 text-[11px] font-medium text-red-600">
              {facilitiesLoadError}
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleApplyFilters}
              className="inline-flex h-[34px] items-center justify-center rounded-[6px] bg-[#0097B2] px-5 text-[12px] font-semibold text-white hover:bg-[#0086A0]"
            >
              Apply Filters
            </button>

            <button
              type="button"
              onClick={handleResetFilters}
              className="inline-flex h-[34px] items-center justify-center rounded-[6px] border border-[#E2E8F0] bg-white px-5 text-[12px] font-medium text-[#334155] hover:bg-[#F8FAFC]"
            >
              Reset
            </button>
          </div>

          <div className="mt-5 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="text-[#94A3B8]">Quick presets:</span>

              {["Last Month", "Last 6 Months", "Last Year"].map(
                (preset, index) => (
                  <div key={preset} className="flex items-center gap-2">
                    {index > 0 && <span className="text-[#CBD5E1]">|</span>}

                    <button
                      type="button"
                      onClick={() => handlePreset(preset)}
                      className="font-semibold text-[#0097B2] hover:underline"
                    >
                      {preset}
                    </button>
                  </div>
                )
              )}
            </div>

            <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center sm:justify-end">
              {isSearchOpen && (
                <div className="relative w-full sm:w-[260px]">
                  <div className="pointer-events-none absolute inset-y-0 left-0 flex w-[34px] items-center justify-center text-[#94A3B8]">
                    <SearchIcon />
                  </div>

                  <input
                    ref={searchInputRef}
                    type="text"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    onKeyDown={handleSearchKeyDown}
                    placeholder="Search facilities..."
                    className="h-[34px] w-full rounded-[6px] border border-[#CBD5E1] bg-white pl-[36px] pr-8 text-[12px] text-[#111827] outline-none placeholder:text-[#94A3B8] focus:border-[#0097B2] focus:ring-2 focus:ring-[#0097B2]/10"
                  />

                  {(searchInput || appliedSearch) && (
                    <button
                      type="button"
                      onClick={handleClearSearch}
                      className="absolute right-2 top-1/2 flex h-[20px] w-[20px] -translate-y-1/2 items-center justify-center rounded-full text-[#94A3B8] hover:bg-[#F1F5F9] hover:text-[#334155]"
                      aria-label="Clear search"
                    >
                      <CloseIcon />
                    </button>
                  )}
                </div>
              )}

              <button
                type="button"
                onClick={handleSearch}
                className="inline-flex h-[34px] w-fit items-center justify-center gap-2 self-end rounded-[6px] bg-[#0097B2] px-5 text-[12px] font-semibold text-white hover:bg-[#0086A0] sm:self-auto"
              >
                <SearchIcon />
                Search
              </button>
            </div>
          </div>
        </section>

        <section className="min-h-0 flex-1 overflow-hidden rounded-[10px] border border-[#E2E8F0] bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-[#E2E8F0] px-4 py-3">
            <p className="text-[12px] font-semibold text-[#475569]">
              Showing {summary.facilityCount} facilities
            </p>

            <p className="text-[12px] text-[#94A3B8]">
              {summary.totalCases} total cases
            </p>
          </div>

          {error && (
            <div className="border-b border-[#FEE2E2] bg-[#FEF2F2] px-4 py-3 text-[12px] font-medium text-red-600">
              {error}
            </div>
          )}

          <div className="max-h-[calc(100vh-345px)] overflow-auto">
            {loading && (
              <div className="px-4 py-12 text-center text-[13px] text-[#94A3B8]">
                Loading activity report...
              </div>
            )}

            {!loading &&
              companies.map((company) => (
                <CompanyReportRow
                  key={company.id}
                  company={company}
                  expanded={expandedCompanyId === company.id}
                  onToggle={() => toggleCompany(company.id)}
                />
              ))}

            {!loading && !error && companies.length === 0 && (
              <div className="px-4 py-12 text-center text-[13px] text-[#94A3B8]">
                No activity report data found.
              </div>
            )}
          </div>
        </section>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-[11px] text-[#94A3B8]">
              Report generated on {generatedOn}
            </p>
            {exportError && (
              <p className="mt-1 text-[11px] font-medium text-red-500">
                {exportError}
              </p>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handlePrint}
              className="inline-flex h-[34px] items-center justify-center gap-2 rounded-[6px] bg-[#111827] px-5 text-[12px] font-semibold text-white hover:bg-[#1F2937]"
            >
              <PrintIcon />
              Print
            </button>

            <button
              type="button"
              onClick={handleExport}
              disabled={!companies.length || exporting}
              className="inline-flex h-[34px] items-center justify-center gap-2 rounded-[6px] border border-[#E2E8F0] bg-white px-5 text-[12px] font-semibold text-[#475569] hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <ExportIcon />
              {exporting ? "Exporting..." : "Export PDF"}
            </button>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}

function CompanyReportRow({ company, expanded, onToggle }) {
  const caseRows = company.caseRows || [];

  return (
    <div className="border-b border-[#F1F5F9] last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="grid w-full grid-cols-1 gap-3 px-4 py-4 text-left transition hover:bg-[#F8FBFC] lg:grid-cols-[minmax(260px,1fr)_90px_130px_110px]"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded text-[#64748B] transition ${
              expanded ? "rotate-90" : ""
            }`}
          >
            <ChevronRightIcon />
          </span>

          <span className="truncate text-[13px] font-semibold text-[#111827]">
            {company.name}
          </span>
        </div>

        <div className="flex items-center lg:justify-end">
          <span className="text-[12px] font-semibold text-[#0097B2]">
            {company.cases} {company.cases === 1 ? "Case" : "Cases"}
          </span>
        </div>

        <div className="flex items-center lg:justify-end">
          <span className="text-[12px] text-[#475569]">
            Invoiced:{" "}
            <span className="font-semibold text-[#111827]">
              {company.invoicedDisplay || formatMoney(company.invoiced)}
            </span>
          </span>
        </div>

        <div className="flex items-center lg:justify-end">
          <span className="text-[12px] text-[#475569]">
            Paid:{" "}
            <span className="font-semibold text-[#059669]">
              {company.paidDisplay || formatMoney(company.paid)}
            </span>
          </span>
        </div>
      </button>

      {expanded && (
        <div className="bg-[#F8FAFC] px-10 py-4">
          <div className="overflow-auto rounded-[8px] border border-[#E2E8F0] bg-white">
            <table className="w-full min-w-[620px] border-collapse">
              <thead className="bg-[#F8FAFC]">
                <tr className="border-b border-[#E2E8F0] text-left text-[11px] font-semibold text-[#64748B]">
                  <th className="px-4 py-3">Case</th>
                  <th className="px-4 py-3">Applicant</th>
                  <th className="px-4 py-3">Activity</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                </tr>
              </thead>

              <tbody>
                {caseRows.map((caseRow) => (
                  <tr
                    key={`${company.id}-${caseRow.orderId}`}
                    className="border-b border-[#F1F5F9] last:border-b-0"
                  >
                    <td className="px-4 py-3 text-[12px] font-semibold text-[#007F96]">
                      {caseRow.caseNo || "—"}
                    </td>
                    <td className="px-4 py-3 text-[12px] text-[#475569]">
                      {caseRow.applicant}
                    </td>
                    <td className="px-4 py-3 text-[12px] text-[#475569]">
                      {caseRow.activity}
                    </td>
                    <td className="px-4 py-3 text-right text-[12px] font-semibold text-[#111827]">
                      {caseRow.amountDisplay || formatMoney(caseRow.amount)}
                    </td>
                  </tr>
                ))}

                {caseRows.length === 0 && (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-4 py-6 text-center text-[12px] text-[#94A3B8]"
                    >
                      No case details available.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ReportField({
  label,
  name,
  value,
  onChange,
  type = "text",
  options = [],
  disabled = false,
}) {
  return (
    <div>
      <label className="mb-2 block text-[11px] font-semibold text-[#475569]">
        {label}
      </label>

      {type === "select" ? (
        <select
          name={name}
          value={value}
          onChange={onChange}
          disabled={disabled}
          className="h-[36px] w-full rounded-[6px] border border-[#CBD5E1] bg-white px-3 text-[12px] text-[#111827] outline-none focus:border-[#0097B2] focus:ring-2 focus:ring-[#0097B2]/10 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {options.map((option) => {
            const optionValue =
              typeof option === "string" ? option : option.value;
            const optionLabel =
              typeof option === "string" ? option : option.label;

            return (
              <option key={optionValue} value={optionValue}>
                {optionLabel}
              </option>
            );
          })}
        </select>
      ) : (
        <input
          type={type}
          name={name}
          value={value}
          onChange={onChange}
          className="h-[36px] w-full rounded-[6px] border border-[#CBD5E1] bg-white px-3 text-[12px] text-[#111827] outline-none focus:border-[#0097B2] focus:ring-2 focus:ring-[#0097B2]/10"
        />
      )}
    </div>
  );
}

function formatMoney(value) {
  const amount = Number(value) || 0;
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
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

function SearchIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="m20 20-3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
      <path
        d="M18 6 6 18M6 6l12 12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
      <path
        d="m9 18 6-6-6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PrintIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path
        d="M7 8V3h10v5M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path d="M7 14h10v7H7v-7Z" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 3v12M8 11l4 4 4-4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 21h14"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
