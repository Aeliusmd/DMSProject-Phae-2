"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import DashboardShell from "@/components/layout/DashboardShell";
import CurrentDateTime from "@/components/dashboard/CurrentDateTime";
import { getCompanyWiseInvoices } from "@/lib/invoices/invoiceApi";
import { useDataRefresh } from "@/lib/liveRefresh/useDataRefresh";

const EMPTY_SUMMARY = {
  companies: 0,
  totalCases: 0,
  needsResend: 0,
  invoiced: "$0.00",
  paid: "$0.00",
  due: "$0.00",
};

export default function CompanyWiseInvoicesPage() {
  const [searchInput, setSearchInput] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [companies, setCompanies] = useState([]);
  const [summary, setSummary] = useState(EMPTY_SUMMARY);

  const loadCompanies = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);

    try {
      const data = await getCompanyWiseInvoices();
      setCompanies(data.companies);
      setSummary(data.summary);
    } catch {
      if (!silent) {
        setCompanies([]);
        setSummary(EMPTY_SUMMARY);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCompanies();
  }, [loadCompanies]);

  useDataRefresh(() => loadCompanies({ silent: true }));

  const filteredCompanies = useMemo(() => {
    const query = appliedSearch.trim().toLowerCase();

    if (!query) return companies;

    return companies.filter((company) => {
      return (
        company.company.toLowerCase().includes(query) ||
        company.email.toLowerCase().includes(query)
      );
    });
  }, [companies, appliedSearch]);

  const handleSearch = () => {
    setAppliedSearch(searchInput.trim());
  };

  const handleClearSearch = () => {
    setSearchInput("");
    setAppliedSearch("");
  };

  const handleSearchKeyDown = (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleSearch();
    }
  };

  return (
    <DashboardShell>
      <div className="flex min-h-[calc(100vh-92px)] min-w-0 flex-col gap-5 overflow-hidden">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <Link
              href="/invoices"
              className="mt-[2px] inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[6px] border border-[#E2E8F0] bg-white text-[#64748B] hover:bg-[#F8FAFC]"
            >
              <ArrowLeftIcon />
            </Link>

            <div className="min-w-0">
              <h1 className="text-[18px] font-semibold text-[#111827]">
                Company Wise Invoices
              </h1>

              <p className="mt-[4px] text-[12px] text-[#64748B]">
                View outstanding and resend standard and X-Ray invoices grouped by
                provider company
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              <div className="relative w-full sm:w-[260px]">
                <SearchIcon />

                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="Search companies..."
                  className="h-[36px] w-full rounded-[6px] border border-[#CBD5E1] bg-white pl-9 pr-3 text-[12px] text-[#111827] outline-none placeholder:text-[#94A3B8] focus:border-[#0097B2] focus:ring-2 focus:ring-[#0097B2]/10"
                />
              </div>

              <button
                type="button"
                onClick={handleSearch}
                className="h-[36px] rounded-[6px] bg-[#0097B2] px-5 text-[12px] font-semibold text-white hover:bg-[#0086A0]"
              >
                Search
              </button>

              {appliedSearch ? (
                <button
                  type="button"
                  onClick={handleClearSearch}
                  className="h-[36px] rounded-[6px] border border-[#E2E8F0] bg-white px-4 text-[12px] font-medium text-[#334155] hover:bg-[#F8FAFC]"
                >
                  Clear
                </button>
              ) : null}
            </div>

            <CurrentDateTime
              variant="short"
              prefix="as of"
              className="whitespace-nowrap text-[12px] text-[#94A3B8]"
            />
          </div>
        </div>

        <SummaryStrip summary={summary} loading={loading} />

        <CompanyWiseTable companies={filteredCompanies} loading={loading} />
      </div>
    </DashboardShell>
  );
}

function SummaryStrip({ summary, loading }) {
  return (
    <section className="rounded-[10px] border border-[#E2E8F0] bg-white px-5 py-4 shadow-sm">
      <div className="grid grid-cols-2 gap-x-10 gap-y-4 sm:grid-cols-3 lg:grid-cols-6">
        <SummaryItem
          label="Companies"
          value={loading ? "..." : String(summary.companies)}
        />
        <SummaryItem
          label="Total Cases"
          value={loading ? "..." : String(summary.totalCases)}
        />
        <SummaryItem
          label="Needs Resend"
          value={loading ? "..." : String(summary.needsResend)}
          orange
        />
        <SummaryItem
          label="Total Invoiced"
          value={loading ? "..." : summary.invoiced}
        />
        <SummaryItem
          label="Total Paid"
          value={loading ? "..." : summary.paid}
          green
        />
        <SummaryItem
          label="Total Due"
          value={loading ? "..." : summary.due}
          red
        />
      </div>
    </section>
  );
}

function SummaryItem({ label, value, green = false, red = false, orange = false }) {
  return (
    <div>
      <p className="mb-2 text-[11px] text-[#64748B]">{label}</p>

      <p
        className={`whitespace-nowrap text-[16px] font-semibold ${
          green
            ? "text-[#059669]"
            : red
            ? "text-red-500"
            : orange
            ? "text-[#EA580C]"
            : "text-[#111827]"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function CompanyWiseTable({ companies, loading }) {
  return (
    <section className="min-h-0 flex-1 overflow-hidden rounded-[10px] border border-[#E2E8F0] bg-white shadow-sm">
      <div className="h-full max-h-[calc(100vh-265px)] overflow-auto">
        <table className="w-full min-w-[1050px] border-collapse">
          <thead className="sticky top-0 z-10 bg-[#F8FAFC]">
            <tr className="border-b border-[#E2E8F0] text-left text-[11px] font-semibold text-[#475569]">
              <th className="w-[250px] px-4 py-3">Company Name</th>
              <th className="w-[360px] px-4 py-3">Email</th>
              <th className="w-[110px] px-4 py-3 text-center">Total Cases</th>
              <th className="w-[120px] px-4 py-3 text-center">Needs Resend</th>
              <th className="w-[135px] px-4 py-3">Invoiced</th>
              <th className="w-[135px] px-4 py-3">Paid</th>
              <th className="w-[135px] px-4 py-3">Due</th>
              <th className="w-[100px] px-4 py-3 text-center"></th>
            </tr>
          </thead>

          <tbody>
            {loading && (
              <tr>
                <td
                  colSpan={8}
                  className="px-5 py-14 text-center text-[13px] text-[#94A3B8]"
                >
                  Loading companies...
                </td>
              </tr>
            )}

            {!loading &&
              companies.map((company) => (
              <tr
                key={company.id}
                className="border-b border-[#F1F5F9] last:border-b-0 odd:bg-white even:bg-[#FCFEFF] hover:bg-[#F8FBFC]"
              >
                <td className="px-4 py-4 align-middle">
                  <Link
                    href={`/invoices/company-wise/${company.id}`}
                    className="text-left text-[12px] font-semibold text-[#007F96] hover:underline"
                  >
                    {company.company}
                  </Link>
                </td>

                <td className="px-4 py-4 align-middle">
                  <p className="max-w-[320px] truncate text-[12px] text-[#475569]">
                    {company.email}
                  </p>
                </td>

                <td className="px-4 py-4 text-center align-middle text-[12px] font-semibold text-[#334155]">
                  {company.cases}
                </td>

                <td className="px-4 py-4 text-center align-middle">
                  {company.needsResend > 0 ? (
                    <span className="inline-flex h-[20px] min-w-[22px] items-center justify-center rounded-full bg-[#FEF3C7] px-2 text-[11px] font-semibold text-[#D97706]">
                      {company.needsResend}
                    </span>
                  ) : (
                    <span className="text-[12px] text-[#94A3B8]">-</span>
                  )}
                </td>

                <td className="px-4 py-4 align-middle text-[12px] text-[#334155]">
                  {company.invoiced}
                </td>

                <td className="px-4 py-4 align-middle text-[12px] font-semibold text-[#059669]">
                  {company.paid}
                </td>

                <td className="px-4 py-4 align-middle text-[12px] font-semibold text-red-500">
                  {company.due}
                </td>

                <td className="px-4 py-4 text-center align-middle">
                  <Link
                    href={`/invoices/company-wise/${company.id}`}
                    className="inline-flex h-[26px] items-center justify-center gap-1 rounded-[6px] bg-[#E6F7FA] px-3 text-[11px] font-semibold text-[#007F96] hover:bg-[#DDF6FA]"
                  >
                    <span className="text-[12px]">+</span>
                    View
                  </Link>
                </td>
              </tr>
            ))}

            {!loading && companies.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  className="px-5 py-14 text-center text-[13px] text-[#94A3B8]"
                >
                  No companies found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
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

function SearchIcon() {
  return (
    <svg
      className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#94A3B8]"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle
        cx="11"
        cy="11"
        r="7"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="m20 20-3.5-3.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}