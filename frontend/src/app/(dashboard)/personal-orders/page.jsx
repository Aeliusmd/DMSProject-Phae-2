"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/layout/DashboardShell";
import PersonalOrderStatsGrid from "@/components/personal-orders/PersonalOrderStatsGrid";
import PersonalOrderFilterBar, {
  defaultPersonalOrderFilters,
} from "@/components/personal-orders/PersonalOrderFilterBar";
import OrdersTable from "@/components/orders/OrdersTable";
import {
  ORDER_LIST_FILTER_KEYS,
  consumeOrderListFilters,
  writeOrderListFilters,
} from "@/lib/orders/orderListFilterStorage";

export default function PersonalOrdersPage() {
  const [filters, setFilters] = useState(() =>
    consumeOrderListFilters(
      ORDER_LIST_FILTER_KEYS.personalOrders,
      defaultPersonalOrderFilters
    )
  );

  useEffect(() => {
    writeOrderListFilters(
      ORDER_LIST_FILTER_KEYS.personalOrders,
      filters,
      defaultPersonalOrderFilters
    );
  }, [filters]);

  return (
    <DashboardShell>
      <div className="flex min-h-[calc(100vh-92px)] min-w-0 flex-col gap-4">
        <div>
          <h1 className="text-[18px] font-semibold text-[#111827] sm:text-[20px]">
            Personal Orders
          </h1>
          <p className="mt-[4px] text-[13px] text-[#64748B]">
            Personal request portal orders ($35 prepayment). Invoice and records use the same
            staff tools as Orders. Status meanings: In Process (received) → Invoice (extra
            charges) → Paid (preparing records) → Released (ready).
          </p>
        </div>

        <PersonalOrderStatsGrid />

        <PersonalOrderFilterBar filters={filters} onFiltersChange={setFilters} />

        <OrdersTable
          filters={filters}
          fitToWindow
          useServerPagination
          personalMode
          createdSortDir={
            filters.sortDir === "asc" || filters.sortDir === "desc"
              ? filters.sortDir
              : null
          }
          onCreatedSortDirChange={(nextDir) => {
            setFilters((prev) => ({
              ...prev,
              sortDir: nextDir === "asc" || nextDir === "desc" ? nextDir : "",
            }));
          }}
          listReturnTo="personal-orders"
        />
      </div>
    </DashboardShell>
  );
}
