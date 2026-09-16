"use client";

import { useEffect, useMemo, useState } from "react";
import DashboardShell from "@/components/layout/DashboardShell";
import OrderStatsGrid from "@/components/orders/OrderStatsGrid";
import OrderActionButton from "@/components/orders/OrderActionButton";
import OrderFilterBar, {
  defaultOrderFilters,
} from "@/components/orders/OrderFilterBar";
import OrdersTable from "@/components/orders/OrdersTable";
import ReminderNotesModal from "@/components/orders/reminders/ReminderNotesModal";
import {
  isCompanyOrderSource,
  isPersonalOrderSource,
  toApiCreationSource,
} from "@/lib/orders/orderFilterConstants";
import {
  ORDER_LIST_FILTER_KEYS,
  consumeOrderListFilters,
  writeOrderListFilters,
} from "@/lib/orders/orderListFilterStorage";
import { STAFF_PORTAL_ORDERS_HIDDEN } from "@/lib/portalNavigationVisibility";

const BATCH_SCAN_FLASH_KEY = "dms.batchScanFlash";
const BATCH_SCAN_FLASH_MS = 10000;

export default function OrdersPage() {
  const [isReminderModalOpen, setIsReminderModalOpen] = useState(false);
  const [filters, setFilters] = useState(() =>
    consumeOrderListFilters(ORDER_LIST_FILTER_KEYS.orders, defaultOrderFilters)
  );
  const [batchScanFlash, setBatchScanFlash] = useState(null);

  const orderSource = filters.creationSource || "internal";
  const companyPortalMode = isCompanyOrderSource(orderSource);
  const personalMode = isPersonalOrderSource(orderSource);
  const apiCreationSource = useMemo(
    () => toApiCreationSource(orderSource) || null,
    [orderSource]
  );

  useEffect(() => {
    writeOrderListFilters(
      ORDER_LIST_FILTER_KEYS.orders,
      filters,
      defaultOrderFilters
    );
  }, [filters]);

  useEffect(() => {
    let message = "";
    let failedCount = 0;
    let duplicateCount = 0;
    let noExtractionCount = 0;
    let shownAt = Date.now();

    try {
      const raw = window.sessionStorage.getItem(BATCH_SCAN_FLASH_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        message = `${parsed?.message || ""}`.trim();
        failedCount = Number(parsed?.failedCount) || 0;
        duplicateCount = Number(parsed?.duplicateCount) || 0;
        noExtractionCount = Number(parsed?.noExtractionCount) || 0;
        shownAt = Number(parsed?.at) || Date.now();
      }
    } catch {
      message = "";
    }

    if (!message) return undefined;

    const remaining = BATCH_SCAN_FLASH_MS - (Date.now() - shownAt);
    if (remaining <= 0) {
      window.sessionStorage.removeItem(BATCH_SCAN_FLASH_KEY);
      return undefined;
    }

    setBatchScanFlash({
      message,
      failedCount,
      duplicateCount,
      noExtractionCount,
    });
    const timer = window.setTimeout(() => {
      window.sessionStorage.removeItem(BATCH_SCAN_FLASH_KEY);
      setBatchScanFlash(null);
    }, remaining);

    return () => window.clearTimeout(timer);
  }, []);

  return (
    <DashboardShell>
      <div className="flex min-h-[calc(100vh-92px)] min-w-0 flex-col gap-4">
        {batchScanFlash ? (
          <div
            className={`rounded-[8px] border px-3 py-2.5 text-[12px] font-medium shadow-sm ${
              batchScanFlash.failedCount > 0
                ? batchScanFlash.duplicateCount > 0 ||
                  batchScanFlash.noExtractionCount > 0
                  ? "border-[#FECACA] bg-[#FEF2F2] text-[#991B1B]"
                  : "border-[#FDE68A] bg-[#FFFBEB] text-[#92400E]"
                : "border-[#A7F3D0] bg-[#ECFDF5] text-[#047857]"
            }`}
          >
            {batchScanFlash.message}
          </div>
        ) : null}

        <div className="min-w-0">
          <h1 className="text-[18px] font-semibold text-[#111827] sm:text-[20px]">
            Orders
          </h1>
          <p className="mt-[4px] text-[13px] text-[#64748B]">
            Overview of your legal practice orders and cases
          </p>
        </div>

        <OrderStatsGrid />

        <section className="rounded-[9px] border border-[#E2E8F0] bg-white px-3 py-4 shadow-sm sm:px-4">
          <h2 className="mb-3 text-[13px] font-semibold text-[#111827]">
            Quick Actions
          </h2>

          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-3">
            <OrderActionButton
              href="/orders/new"
              variant="primary"
              icon={<PlusIcon />}
            >
              New Order
            </OrderActionButton>

            <OrderActionButton href="/orders/batch-scan" icon={<BatchIcon />}>
              Batch Scan
            </OrderActionButton>

            <OrderActionButton
              icon={<ReminderIcon />}
              onClick={() => setIsReminderModalOpen(true)}
            >
              Reminders
            </OrderActionButton>
          </div>
        </section>

        <OrderFilterBar
          filters={filters}
          onFiltersChange={setFilters}
          showOrderSourceFilter={!STAFF_PORTAL_ORDERS_HIDDEN}
        />

        <OrdersTable
          filters={filters}
          fitToWindow
          useServerPagination
          creationSource={apiCreationSource}
          companyPortalMode={companyPortalMode}
          personalMode={personalMode}
          listReturnTo="orders"
        />
      </div>

      <ReminderNotesModal
        isOpen={isReminderModalOpen}
        onClose={() => setIsReminderModalOpen(false)}
      />
    </DashboardShell>
  );
}

function PlusIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function BatchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path d="M8 7h12v12H8V7Z" stroke="currentColor" strokeWidth="1.7" />
      <path d="M4 17V3h12" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function ReminderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path
        d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 7h18s-3 0-3-7Z"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path d="M10 19a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}
