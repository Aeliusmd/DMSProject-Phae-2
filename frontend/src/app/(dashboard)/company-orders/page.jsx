"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/layout/DashboardShell";
import OrderFilterBar, {
  defaultOrderFilters,
} from "@/components/orders/OrderFilterBar";
import OrdersTable from "@/components/orders/OrdersTable";
import { getCompanyOrderStats } from "@/lib/orders/orderApi";
import {
  ORDER_LIST_FILTER_KEYS,
  consumeOrderListFilters,
  writeOrderListFilters,
} from "@/lib/orders/orderListFilterStorage";

const defaultFilters = {
  ...defaultOrderFilters,
  creationSource: "",
};

export default function CompanyOrdersPage() {
  const [filters, setFilters] = useState(() =>
    consumeOrderListFilters(ORDER_LIST_FILTER_KEYS.companyOrders, defaultFilters)
  );
  const [stats, setStats] = useState({
    totalOrders: 0,
    inProcess: 0,
    invoice: 0,
    paid: 0,
    released: 0,
  });

  useEffect(() => {
    writeOrderListFilters(
      ORDER_LIST_FILTER_KEYS.companyOrders,
      filters,
      defaultFilters
    );
  }, [filters]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const data = await getCompanyOrderStats();
        if (!cancelled) setStats(data);
      } catch {
        if (!cancelled) {
          setStats({
            totalOrders: 0,
            inProcess: 0,
            invoice: 0,
            paid: 0,
            released: 0,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <DashboardShell>
      <div className="flex min-h-[calc(100vh-92px)] min-w-0 flex-col gap-4">
        <div>
          <h1 className="text-[18px] font-semibold text-[#111827] sm:text-[20px]">
            Company Orders
          </h1>
          <p className="mt-[4px] text-[13px] text-[#64748B]">
            Manage orders submitted by external companies. Same invoice,
            records, CNR, rush, and write-off tooling as internal orders —
            with company portal stages.
          </p>
        </div>

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard label="Total" value={stats.totalOrders} />
          <StatCard label="In Process" value={stats.inProcess} />
          <StatCard label="Invoice" value={stats.invoice} />
          <StatCard label="Paid" value={stats.paid} />
          <StatCard label="Released" value={stats.released} />
        </section>

        <OrderFilterBar filters={filters} onFiltersChange={setFilters} statusOptionsVariant="company" />

        <OrdersTable
          filters={filters}
          fitToWindow
          useServerPagination
          creationSource="company_portal"
          companyPortalMode
          createdSortDir={
            filters.sortDir === "asc" || filters.sortDir === "desc"
              ? filters.sortDir
              : null
          }
          listReturnTo="company-orders"
        />
      </div>
    </DashboardShell>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="rounded-[9px] border border-[#E2E8F0] bg-white px-4 py-3 shadow-sm">
      <p className="text-[11px] font-medium text-[#64748B]">{label}</p>
      <p className="mt-1 text-[20px] font-semibold text-[#111827]">
        {Number(value) || 0}
      </p>
    </div>
  );
}
