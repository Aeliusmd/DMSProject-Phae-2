"use client";

import { useCallback, useEffect, useState } from "react";
import DashboardShell from "@/components/layout/DashboardShell";
import UnprocessedSubpoenaCard from "@/components/orders/unprocessed/UnprocessedSubpoenaCard";
import PdfPreviewDrawer from "@/components/orders/unprocessed/PdfPreviewDrawer";
import { getUnprocessedSubpoenas } from "@/lib/orders/orderApi";
import { mapUnprocessedSubpoenaItem } from "@/lib/orders/unprocessedUtils";
import { useDataRefresh } from "@/lib/liveRefresh/useDataRefresh";

export default function UnprocessedSubpoenasPage() {
  const [subpoenas, setSubpoenas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedSubpoena, setSelectedSubpoena] = useState(null);

  const loadSubpoenas = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);

    try {
      const items = await getUnprocessedSubpoenas();
      setSubpoenas(items.map(mapUnprocessedSubpoenaItem));
      setError("");
    } catch (err) {
      if (!silent) {
        setError(err.message || "Failed to load unprocessed subpoenas.");
        setSubpoenas([]);
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSubpoenas();
  }, [loadSubpoenas]);

  useDataRefresh(() => loadSubpoenas({ silent: true }), {
    paused: Boolean(selectedSubpoena),
  });

  return (
    <DashboardShell>
      <div className="flex min-h-[calc(100vh-92px)] flex-col gap-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-[20px] font-semibold text-[#111827]">
              Unprocessed Subpoenas
            </h1>
            <p className="mt-[4px] text-[13px] text-[#64748B]">
              Uploaded subpoenas not yet linked to an order
            </p>
          </div>

          <p className="text-[12px] font-medium text-[#94A3B8] sm:mt-[6px]">
            {subpoenas.length} subpoenas
          </p>
        </div>

        <section className="flex min-h-[520px] flex-1 overflow-hidden rounded-[9px] border border-[#E2E8F0] bg-white shadow-sm">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading && (
              <p className="px-6 py-8 text-[13px] text-[#64748B]">Loading...</p>
            )}

            {!loading && error && (
              <p className="px-6 py-8 text-[13px] text-red-500">{error}</p>
            )}

            {!loading && !error && subpoenas.length === 0 && (
              <p className="px-6 py-8 text-[13px] text-[#64748B]">
                No unprocessed subpoenas yet. Upload a batch scan to get started.
              </p>
            )}

            {!loading &&
              !error &&
              subpoenas.map((subpoena) => (
                <UnprocessedSubpoenaCard
                  key={subpoena.id}
                  subpoena={subpoena}
                  isSelected={selectedSubpoena?.id === subpoena.id}
                  onPreview={() => setSelectedSubpoena(subpoena)}
                />
              ))}
          </div>
        </section>
      </div>

      <PdfPreviewDrawer
        subpoena={selectedSubpoena}
        onClose={() => setSelectedSubpoena(null)}
      />
    </DashboardShell>
  );
}
