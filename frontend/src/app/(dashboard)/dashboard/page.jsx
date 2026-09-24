"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import DashboardShell from "@/components/layout/DashboardShell";
import DashboardOverview from "@/components/dashboard/DashboardOverview";
import DashboardRecentOrders from "@/components/dashboard/DashboardRecentOrders";
import DashboardFinancialSummary from "@/components/dashboard/DashboardFinancialSummary";
import DashboardTopProviders from "@/components/dashboard/DashboardTopProviders";
import { getStoredUser } from "@/lib/auth/authStorage";
import { canAccessNavItem, isAdmin } from "@/lib/auth/roles";
import { isUnprocessedSubpoenasNavHidden } from "@/lib/portalNavigationVisibility";
import { markFreshNewOrderNavigation } from "@/lib/orders/facilityOrderUtils";

const quickActions = [
  {
    label: "New Order",
    href: "/orders/new",
    icon: <PlusIcon />,
    primary: true,
  },
  {
    label: "Reports",
    href: "/reports",
    icon: <ReportsIcon />,
  },
  {
    label: "Activity Report",
    href: "/reports/activity-report",
    icon: <ClockIcon />,
  },
  {
    label: "Invoices",
    href: "/invoices",
    icon: <InvoiceIcon />,
  },
  {
    label: "Unprocessed",
    href: "/orders/unprocessed",
    icon: <DocumentIcon />,
  },
  {
    label: "Batch Scan",
    href: "/orders/batch-scan",
    icon: <ScanIcon />,
  },
  {
    label: "Facilities",
    href: "/facilities",
    icon: <CustomerIcon />,
  },
  {
    label: "Employees",
    href: "/employees",
    icon: <EmployeesIcon />,
  },
];

export default function DashboardPage() {
  const user = getStoredUser();
  const showFinancialWidgets = isAdmin(user);
  const rightColumnRef = useRef(null);
  const [matchedHeight, setMatchedHeight] = useState(null);

  const visibleQuickActions = quickActions.filter(
    (action) =>
      !isUnprocessedSubpoenasNavHidden(action.href) &&
      canAccessNavItem(user, action.href)
  );

  // Recent Orders height = Financial Summary + Top Providers (same top & bottom).
  // Extra orders scroll inside the Recent Orders card only.
  useEffect(() => {
    if (!showFinancialWidgets) {
      setMatchedHeight(null);
      return undefined;
    }

    const column = rightColumnRef.current;
    if (!column || typeof ResizeObserver === "undefined") return undefined;

    const syncHeight = () => {
      const nextHeight = Math.ceil(column.getBoundingClientRect().height);
      setMatchedHeight((prev) => (prev === nextHeight ? prev : nextHeight));
    };

    syncHeight();
    const observer = new ResizeObserver(syncHeight);
    observer.observe(column);
    return () => observer.disconnect();
  }, [showFinancialWidgets]);

  return (
    <DashboardShell>
      <div className="flex min-h-0 min-w-0 flex-col gap-4">
        <DashboardOverview />

        <div className="flex flex-wrap items-center gap-3">
          {visibleQuickActions.map((action) => (
            <QuickActionButton key={action.label} {...action} />
          ))}
        </div>

        {showFinancialWidgets ? (
          <div className="flex min-h-0 flex-col gap-3 xl:flex-row xl:items-start">
            <div
              className="min-h-0 min-w-0 flex-1 overflow-hidden"
              style={
                matchedHeight
                  ? { height: matchedHeight, maxHeight: matchedHeight }
                  : undefined
              }
            >
              <DashboardRecentOrders fillHeight />
            </div>

            <div
              ref={rightColumnRef}
              className="flex w-full shrink-0 flex-col gap-3 xl:w-[360px]"
            >
              <DashboardFinancialSummary />
              <DashboardTopProviders />
            </div>
          </div>
        ) : (
          <DashboardRecentOrders />
        )}
      </div>
    </DashboardShell>
  );
}

function QuickActionButton({ label, href, icon, primary = false }) {
  return (
    <Link
      href={href}
      onClick={href === "/orders/new" ? markFreshNewOrderNavigation : undefined}
      className={`inline-flex h-[38px] items-center justify-center gap-2 rounded-[6px] px-4 text-[12px] font-semibold shadow-sm transition ${
        primary
          ? "bg-[#0097B2] text-white hover:bg-[#0086A0]"
          : "border border-[#E2E8F0] bg-white text-[#334155] hover:bg-[#F8FAFC]"
      }`}
    >
      {icon}
      {label}
    </Link>
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

function PlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ReportsIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path d="M5 20V4h14v16H5Z" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 16V9M12 16V6M16 16v-4" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function InvoiceIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path d="M7 3h10v18l-2-1-2 1-2-1-2 1-2-1V3Z" stroke="currentColor" strokeWidth="1.8" />
      <path d="M10 8h4M10 12h4" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function ScanIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path d="M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3" stroke="currentColor" strokeWidth="1.8" />
      <path d="M7 12h10" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function EmployeesIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <circle cx="9" cy="8" r="3" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3 20a6 6 0 0 1 12 0" stroke="currentColor" strokeWidth="1.8" />
      <path d="M17 10a3 3 0 1 0 0-6" stroke="currentColor" strokeWidth="1.8" />
      <path d="M17 14a5 5 0 0 1 4 5" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}
