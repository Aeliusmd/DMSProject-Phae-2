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

function isTableChangeNotice(item) {
  const type = String(item?.notificationType || item?.type || "").toLowerCase();
  const reference = String(item?.referenceType || "").toLowerCase();
  return (
    type === "order" ||
    type === "invoice" ||
    reference === "order" ||
    reference === "invoice"
  );
}

function visibleRowSignature(order) {
  if (!order) return "";
  const invoice = order.invoice || {};
  return [
    order.dbId,
    order.orderStatus || "",
    order.displayOrderStatus || "",
    order.invoiceStatus || invoice.status || "",
    invoice.invoiceId || invoice.id || "",
    order.rushLabel || "",
    order.facilityName || "",
    order.applicant || "",
    order.hasMedicalRecords ? "1" : "0",
    order.certificateNoRecords ? "1" : "0",
    order.companyPortalStatus || "",
    order.personalPortalStatus || "",
    order.portalStatus || "",
    order.readyDate || order.mailSentDate || "",
    order.hasActiveReminder ? "1" : "0",
  ].join("|");
}

export function mergeVisibleOrderRows(currentRows, freshRows) {
  const freshById = new Map(
    (freshRows || [])
      .filter((row) => row?.dbId != null)
      .map((row) => [String(row.dbId), row])
  );

  let changed = false;
  const next = (currentRows || []).map((row) => {
    const fresh = freshById.get(String(row.dbId));
    if (!fresh) return row;
    if (visibleRowSignature(row) === visibleRowSignature(fresh)) return row;
    changed = true;
    return fresh;
  });

  return changed ? next : currentRows;
}

/**
 * Updates only rows already on the current page, using the same list API
 * the table uses. Never replaces the page, never adds/removes rows, and
 * never uses the single-order detail payload.
 */
export function useSafeVisibleOrderMerge({
  enabled = true,
  paused = false,
  loadListRows,
  applyRows,
}) {
  const pausedRef = useRef(paused);
  const loadRef = useRef(loadListRows);
  const applyRef = useRef(applyRows);
  const seenNoticeRef = useRef(null);
  const pendingRef = useRef(false);
  const inFlightRef = useRef(false);

  pausedRef.current = paused;
  loadRef.current = loadListRows;
  applyRef.current = applyRows;

  useEffect(() => {
    if (!enabled) return undefined;

    let cancelled = false;

    const mergeFromList = async () => {
      if (cancelled || inFlightRef.current) return;
      if (typeof document !== "undefined" && document.hidden) return;
      if (typeof loadRef.current !== "function") return;
      if (typeof applyRef.current !== "function") return;

      if (pausedRef.current) {
        pendingRef.current = true;
        return;
      }

      inFlightRef.current = true;
      try {
        const freshRows = await loadRef.current();
        if (cancelled || !Array.isArray(freshRows)) return;
        applyRef.current(freshRows);
      } catch {
        // Keep the current table if this background read fails.
      } finally {
        inFlightRef.current = false;
      }
    };

    const pollNotices = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) return;

      try {
        const data = await getNotifications({ limit: 20 });
        const notices = data.notifications || [];
        const newestId = newestNoticeId(notices);

        if (seenNoticeRef.current == null) {
          seenNoticeRef.current = newestId;
          return;
        }

        const hasNew = notices.some(
          (item) =>
            Number(item?.id) > Number(seenNoticeRef.current) &&
            isTableChangeNotice(item)
        );
        if (newestId > Number(seenNoticeRef.current)) {
          seenNoticeRef.current = newestId;
        }
        if (!hasNew) return;

        await mergeFromList();
      } catch {
        // Notifications are only a hint.
      }
    };

    const noticeIntervalId = window.setInterval(() => {
      void pollNotices();
    }, POLL_MS);
    const fallbackIntervalId = window.setInterval(() => {
      void mergeFromList();
    }, POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(noticeIntervalId);
      window.clearInterval(fallbackIntervalId);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || paused || !pendingRef.current) return;
    pendingRef.current = false;
    if (typeof loadRef.current !== "function") return;
    if (typeof applyRef.current !== "function") return;

    void (async () => {
      try {
        const freshRows = await loadRef.current();
        if (Array.isArray(freshRows)) applyRef.current(freshRows);
      } catch {
        // Keep the current table.
      }
    })();
  }, [enabled, paused]);
}
