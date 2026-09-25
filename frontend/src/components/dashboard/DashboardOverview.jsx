"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import CurrentDateTime from "@/components/dashboard/CurrentDateTime";
import { getApiErrorMessage } from "@/lib/apiErrorUtils";
import { getDashboardStats } from "@/lib/dashboard/dashboardApi";
import { getCurrentUser } from "@/lib/auth/authApi";
import { getStoredUser } from "@/lib/auth/authStorage";
import { isUnprocessedSubpoenasHidden } from "@/lib/portalNavigationVisibility";
import { useDataRefresh } from "@/lib/liveRefresh/useDataRefresh";

function formatCount(value) {
  if (value === null || value === undefined) return "—";
  return String(value);
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

function getDisplayFirstName(name) {
  if (!name) return "User";
  return name.trim().split(/\s+/)[0] || "User";
}

export default function DashboardOverview() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [userName, setUserName] = useState("");

  useEffect(() => {
    let active = true;

    const stored = getStoredUser();
    if (stored?.name) {
      setUserName(getDisplayFirstName(stored.name));
    } else {
      getCurrentUser()
        .then((user) => {
          if (active) setUserName(getDisplayFirstName(user?.name));
        })
        .catch(() => {
          if (active) setUserName("User");
        });
    }

    return () => {
      active = false;
    };
  }, []);

  const loadStats = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);

    try {
      const data = await getDashboardStats();
      setStats(data);
      setError("");
    } catch (err) {
      if (!silent) {
        setStats(null);
        setError(getApiErrorMessage(err, "Failed to load dashboard stats"));
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  useDataRefresh(() => loadStats({ silent: true }));

  const statCards = useMemo(() => {
    const cards = [
      {
        label: "Total Orders",
        value: formatCount(stats?.totalOrders),
        icon: <OrderIcon />,
        iconBg: "#E6F7FA",
        iconColor: "#0097B2",
      },
      {
        label: "Active Cases",
        value: formatCount(stats?.activeCases),
        icon: <CaseIcon />,
        iconBg: "#ECFDF5",
        iconColor: "#059669",
      },
      {
        label: "Rush Orders",
        value: formatCount(stats?.rushOrders),
        icon: <RushIcon />,
        iconBg: "#FFF7ED",
        iconColor: "#EA580C",
      },
      {
        label: "Outstanding",
        value: stats?.outstandingDisplay || "—",
        icon: <MoneyIcon />,
        iconBg: "#FFFBEB",
        iconColor: "#B45309",
      },
      {
        label: "Unprocessed",
        value: formatCount(stats?.unprocessed),
        icon: <DocumentIcon />,
        iconBg: "#F5F3FF",
        iconColor: "#7C3AED",
      },
      {
        label: "Facilities",
        value: formatCount(stats?.facilities),
        icon: <CustomerIcon />,
        iconBg: "#EFF6FF",
        iconColor: "#2563EB",
      },
      {
        label: "Pending Reminders",
        value: formatCount(stats?.pendingReminders),
        icon: <ReminderIcon />,
        iconBg: "#FFF1F2",
        iconColor: "#E11D48",
      },
      {
        label: "Completed",
        value: formatCount(stats?.completed),
        icon: <CompletedIcon />,
        iconBg: "#ECFDF5",
        iconColor: "#059669",
      },
    ];

    return isUnprocessedSubpoenasHidden()
      ? cards.filter((card) => card.label !== "Unprocessed")
      : cards;
  }, [stats]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <h1 className="text-[18px] font-semibold text-[#111827]">
            {getGreeting()}
            {userName ? `, ${userName}` : ""}
          </h1>

          <p className="mt-1 text-[12px] text-[#64748B]">
            Here&apos;s your DMS command center — all systems at a glance
          </p>
        </div>

        <div className="flex flex-col gap-1 text-left text-[11px] text-[#64748B] sm:flex-row sm:items-center sm:gap-8 xl:text-right">
          <CurrentDateTime />

          <p>
            Found{" "}
            <span className="font-semibold text-[#334155]">
              {loading ? "…" : formatCount(stats?.totalOrders)}
            </span>{" "}
            records
            {error ? (
              <span className="ml-2 text-red-500">({error})</span>
            ) : null}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {statCards.map((stat) => (
          <DashboardStatCard
            key={stat.label}
            {...stat}
            loading={loading}
          />
        ))}
      </div>
    </div>
  );
}

function DashboardStatCard({ label, value, icon, iconBg, iconColor, loading }) {
  return (
    <section className="min-w-0 rounded-[10px] border border-[#E2E8F0] bg-white px-4 py-4 shadow-sm">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div
          className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px]"
          style={{
            backgroundColor: iconBg,
            color: iconColor,
          }}
        >
          {icon}
        </div>

        <span className="text-[13px] text-[#CBD5E1]">→</span>
      </div>

      <h2 className="truncate text-[24px] font-semibold leading-none text-[#111827]">
        {loading ? "…" : value}
      </h2>

      <p className="mt-2 text-[12px] text-[#64748B]">{label}</p>
    </section>
  );
}

function OrderIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path d="M7 3h10v18H7V3Z" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9 8h6M9 12h6M9 16h4" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function CaseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path d="M4 7h16v12H4V7Z" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9 7V5h6v2" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function RushIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path
        d="M13 2 5 14h6l-1 8 8-12h-6l1-8Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MoneyIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 7v10M9.5 9.5A2.5 2.5 0 0 1 12 8c1.4 0 2.5.7 2.5 1.7 0 1.1-1 1.6-2.5 2.1-1.5.5-2.5 1-2.5 2.2 0 1.1 1.1 2 2.6 2 1.2 0 2.2-.5 2.8-1.3"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DocumentIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M7 3h7l5 5v13H7V3Z" stroke="currentColor" strokeWidth="1.8" />
      <path d="M14 3v5h5" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function CustomerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M5 21a7 7 0 0 1 14 0"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ReminderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path
        d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 7h18s-3 0-3-7"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path d="M10 19a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.8" />
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
