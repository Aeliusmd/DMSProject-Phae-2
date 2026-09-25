"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getApiErrorMessage } from "@/lib/apiErrorUtils";
import { getTopProviders } from "@/lib/dashboard/dashboardApi";
import { useDataRefresh } from "@/lib/liveRefresh/useDataRefresh";

const VISIBLE_PROVIDER_COUNT = 5;
/** Top N by active case volume (then invoiced $); viewport shows 5, rest scroll. */
const FETCH_PROVIDER_LIMIT = 10;
/** Exactly 5 provider rows visible; remaining top providers scroll inside this card. */
const PROVIDER_LIST_HEIGHT =
  "h-[calc(5*2.75rem+4*0.75rem)] max-h-[calc(5*2.75rem+4*0.75rem)]";

export default function DashboardTopProviders() {
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadProviders = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);

    try {
      const data = await getTopProviders(FETCH_PROVIDER_LIMIT);
      setProviders(Array.isArray(data) ? data : []);
      setError("");
    } catch (err) {
      if (!silent) {
        setProviders([]);
        setError(getApiErrorMessage(err, "Failed to load top providers"));
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  useDataRefresh(() => loadProviders({ silent: true }));

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-[10px] border border-[#E2E8F0] bg-white px-4 py-3 shadow-sm">
      <div className="mb-2.5 flex shrink-0 items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-[#111827]">
          Top Providers
        </h2>

        <Link
          href="/reports/activity-report"
          className="text-[11px] font-semibold text-[#0097B2] hover:underline"
        >
          Full Report
        </Link>
      </div>

      {error ? (
        <p className="mb-2 shrink-0 text-[12px] font-medium text-red-500">
          {error}
        </p>
      ) : null}

      <div
        className={`min-h-0 overflow-y-auto overscroll-contain ${PROVIDER_LIST_HEIGHT}`}
      >
        <div className="space-y-3">
          {loading &&
            Array.from({ length: VISIBLE_PROVIDER_COUNT }).map((_, index) => (
              <div
                key={`loading-${index}`}
                className="flex h-11 items-start justify-between gap-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="h-3 w-32 animate-pulse rounded bg-[#E2E8F0]" />
                  <div className="mt-2 h-2 w-16 animate-pulse rounded bg-[#F1F5F9]" />
                </div>
                <div className="shrink-0 text-right">
                  <div className="h-3 w-20 animate-pulse rounded bg-[#E2E8F0]" />
                  <div className="mt-2 h-2 w-16 animate-pulse rounded bg-[#F1F5F9]" />
                </div>
              </div>
            ))}

          {!loading &&
            providers.map((provider) => (
              <div
                key={provider.name}
                className="flex h-11 items-start justify-between gap-4"
              >
                <div className="min-w-0">
                  <h3 className="truncate text-[12px] font-semibold leading-5 text-[#334155]">
                    {provider.name}
                  </h3>
                  <p className="mt-0.5 text-[10px] leading-4 text-[#94A3B8]">
                    {provider.casesLabel}
                  </p>
                </div>

                <div className="shrink-0 text-right">
                  <p className="text-[12px] font-semibold leading-5 text-[#334155]">
                    {provider.invoiced}
                  </p>
                  <p className="mt-0.5 text-[10px] font-semibold leading-4 text-[#059669]">
                    {provider.paid}
                  </p>
                </div>
              </div>
            ))}

          {!loading && !error && providers.length === 0 && (
            <p className="py-2 text-center text-[12px] text-[#94A3B8]">
              No provider data found.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
