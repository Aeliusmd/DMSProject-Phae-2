"use client";

import { useEffect, useRef } from "react";
import { getNotifications } from "@/lib/notifications/notificationsApi";

const POLL_MS = 15000;

function newestNoticeId(notifications = []) {
  return notifications.reduce((max, item) => {
    const id = Number(item?.id) || 0;
    return id > max ? id : max;
  }, 0);
}

function hasNewOrderNotice(notifications = [], seenId) {
  return notifications.some((item) => {
    const id = Number(item?.id) || 0;
    if (id <= seenId) return false;
    const type = String(item.notificationType || item.type || "").toLowerCase();
    const reference = String(item.referenceType || "").toLowerCase();
    return type === "order" || reference === "order";
  });
}

/**
 * When another user changes an order, reload this table with the same list
 * API already used by the page. Does not patch rows from getOrder.
 */
export function usePeerOrderListSync({ enabled = true, paused = false, onRefresh }) {
  const pausedRef = useRef(paused);
  const onRefreshRef = useRef(onRefresh);
  const seenIdRef = useRef(null);
  const pendingRef = useRef(false);
  const inFlightRef = useRef(false);

  pausedRef.current = paused;
  onRefreshRef.current = onRefresh;

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;

    const refreshIfIdle = async () => {
      if (cancelled || typeof onRefreshRef.current !== "function") return;
      if (pausedRef.current) {
        pendingRef.current = true;
        return;
      }
      pendingRef.current = false;
      await onRefreshRef.current();
    };

    const poll = async () => {
      if (cancelled || inFlightRef.current) return;
      if (typeof document !== "undefined" && document.hidden) return;

      inFlightRef.current = true;
      try {
        const data = await getNotifications({ limit: 20, type: "Order" });
        if (cancelled) return;

        const notices = data.notifications || [];
        const newestId = newestNoticeId(notices);

        if (seenIdRef.current == null) {
          seenIdRef.current = newestId;
          return;
        }

        const hasNew = hasNewOrderNotice(notices, seenIdRef.current);
        if (newestId > Number(seenIdRef.current)) {
          seenIdRef.current = newestId;
        }
        if (!hasNew) return;

        await refreshIfIdle();
      } catch {
        // Leave the current table as-is if notifications cannot be read.
      } finally {
        inFlightRef.current = false;
      }
    };

    const intervalId = window.setInterval(() => {
      void poll();
    }, POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || paused || !pendingRef.current) return;
    pendingRef.current = false;
    if (typeof onRefreshRef.current === "function") {
      void onRefreshRef.current();
    }
  }, [enabled, paused]);
}
