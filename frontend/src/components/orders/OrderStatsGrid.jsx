"use client";

import { useCallback, useEffect, useState } from "react";
import { getApiErrorMessage } from "@/lib/apiErrorUtils";
import StatCard from "@/components/dashboard/StatCard";
import { getOrderStats } from "@/lib/orders/orderApi";
import { useDataRefresh } from "@/lib/liveRefresh/useDataRefresh";

function formatCount(value) {
  if (value === null || value === undefined) return "—";
  return String(value);
}

export default function OrderStatsGrid() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadStats = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);

    try {
      const data = await getOrderStats();
      setStats(data);
      setError("");
    } catch (err) {
      if (!silent) {
        setStats(null);
        setError(getApiErrorMessage(err, "Failed to load order stats"));
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  useDataRefresh(() => loadStats({ silent: true }));

  return (
    <div className="space-y-3">
      {error && (
        <p className="rounded-[6px] border border-[#FEE2E2] bg-[#FEF2F2] px-3 py-2 text-[11px] font-medium text-red-600">
          {error}
        </p>
      )}

      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        layout="horizontal"
        icon={<TotalIcon />}
        value={loading ? "…" : formatCount(stats?.totalOrders)}
        label="Total Orders"
        iconBg="#111827"
        iconColor="#FFFFFF"
      />

      <StatCard
        layout="horizontal"
        icon={<ActiveIcon />}
        value={loading ? "…" : formatCount(stats?.activeCases)}
        label="Active Cases"
        iconBg="#10B981"
        iconColor="#FFFFFF"
      />

      <StatCard
        layout="horizontal"
        icon={<ReadyIcon />}
        value={loading ? "…" : formatCount(stats?.readyToPickup)}
        label="Ready to Pickup"
        iconBg="#0097B2"
        iconColor="#FFFFFF"
      />

      <StatCard
        layout="horizontal"
        icon={<CompletedIcon />}
        value={loading ? "…" : formatCount(stats?.completed)}
        label="Completed"
        iconBg="#475569"
        iconColor="#FFFFFF"
      />
      </div>
    </div>
  );
}

function TotalIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path d="M6 4h12v16H6V4Z" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9 9h6M9 13h6M9 17h4" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function ActiveIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path d="M5 7h14v12H5V7Z" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9 7V5h6v2" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function ReadyIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path d="m7 12 3 3 7-7" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function CompletedIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
      <path d="m9 12 2 2 4-4" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}
