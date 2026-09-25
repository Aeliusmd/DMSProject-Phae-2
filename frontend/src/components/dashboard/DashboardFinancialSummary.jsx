"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getApiErrorMessage } from "@/lib/apiErrorUtils";
import { getDashboardStats } from "@/lib/dashboard/dashboardApi";
import { useDataRefresh } from "@/lib/liveRefresh/useDataRefresh";

export default function DashboardFinancialSummary() {
  const [financial, setFinancial] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadFinancial = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);

    try {
      const stats = await getDashboardStats();
      setFinancial(stats?.financial || null);
      setError("");
    } catch (err) {
      if (!silent) {
        setFinancial(null);
        setError(getApiErrorMessage(err, "Failed to load financial summary"));
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFinancial();
  }, [loadFinancial]);

  useDataRefresh(() => loadFinancial({ silent: true }));

  const items = useMemo(() => {
    if (!financial) return [];

    return [
      {
        label: "Total Invoiced",
        value: financial.totalInvoicedDisplay,
        color: "text-[#111827]",
      },
      {
        label: "Total Paid",
        value: financial.totalPaidDisplay,
        color: "text-[#059669]",
      },
      {
        label: "Outstanding",
        value: financial.outstandingDisplay,
        color: "text-[#EA580C]",
      },
      {
        label: "Write Off",
        value: financial.writeOffDisplay,
        color: "text-[#7C3AED]",
      },
      {
        label: "Overdue Invoices",
        value: String(financial.overdueInvoices ?? 0),
        color: "text-red-500",
      },
      {
        label: "Needs Resend",
        value: String(financial.needsResend ?? 0),
        color: "text-[#EA580C]",
      },
    ];
  }, [financial]);

  return (
    <section className="rounded-[10px] border border-[#E2E8F0] bg-white px-4 py-3 shadow-sm">
      <h2 className="mb-2.5 text-[13px] font-semibold text-[#111827]">
        Financial Summary
      </h2>

      {error ? (
        <p className="mb-2 text-[12px] font-medium text-red-500">{error}</p>
      ) : null}

      <div className="space-y-2">
        {(loading ? PLACEHOLDER_ITEMS : items).map((item) => (
          <div key={item.label} className="flex items-center justify-between gap-3">
            <span className="text-[12px] leading-5 text-[#64748B]">{item.label}</span>
            <span className={`text-[13px] font-semibold leading-5 ${item.color}`}>
              {loading ? "…" : item.value}
            </span>
          </div>
        ))}
      </div>

      <Link
        href="/invoices"
        className="mt-2.5 block text-center text-[12px] font-semibold text-[#0097B2] hover:underline"
      >
        View Outstanding Invoices
      </Link>
    </section>
  );
}

const PLACEHOLDER_ITEMS = [
  { label: "Total Invoiced", color: "text-[#111827]" },
  { label: "Total Paid", color: "text-[#059669]" },
  { label: "Outstanding", color: "text-[#EA580C]" },
  { label: "Write Off", color: "text-[#7C3AED]" },
  { label: "Overdue Invoices", color: "text-red-500" },
  { label: "Needs Resend", color: "text-[#EA580C]" },
];
