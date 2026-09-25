"use client";

import { useEffect, useRef } from "react";
import { getOrder } from "@/lib/orders/orderApi";
import { getNotifications } from "@/lib/notifications/notificationsApi";

const SYNC_MS = 12000;

function sameId(left, right) {
  return String(left ?? "") === String(right ?? "");
}

function rowSignature(order) {
  if (!order) return "";
  const invoice = order.invoice || {};
  return [
    order.dbId,
    order.orderStatus || order.status || "",
    order.displayOrderStatus || order.displayStatus || "",
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

function orderIdFromNotice(item) {
  const type = String(item?.referenceType || "").toLowerCase();
  const noticeType = String(item?.notificationType || item?.type || "").toLowerCase();
  if (type !== "order" && noticeType !== "order") return null;

  const orderId = Number(item.referenceId);
  if (!Number.isFinite(orderId) || orderId <= 0) return null;
  return String(orderId);
}

/**
 * When another user changes an order, replace only that row if it is already
 * on this page. Does not reload the table, change pagination, or set loading.
 */
export function useSharedOrderRowSync({
  orders,
  setOrders,
  mapRow,
  paused = false,
  busyOrderIds = [],
}) {
  const ordersRef = useRef(orders);
  const mapRowRef = useRef(mapRow);
  const pausedRef = useRef(paused);
  const busyRef = useRef(new Set());
  const seenNoticeRef = useRef(null);
  const inFlightRef = useRef(false);

  ordersRef.current = orders;
  mapRowRef.current = mapRow;
  pausedRef.current = paused;
  busyRef.current = new Set((busyOrderIds || []).map(String));

  useEffect(() => {
    let cancelled = false;

    const patchRow = async (orderId) => {
      if (busyRef.current.has(String(orderId))) return;

      const onPage = (ordersRef.current || []).some((row) =>
        sameId(row.dbId, orderId)
      );
      if (!onPage) return;

      const fresh = await getOrder(orderId);
      if (cancelled || !fresh) return;

      const mapped =
        typeof mapRowRef.current === "function"
          ? mapRowRef.current(fresh)
          : fresh;
      if (!mapped) return;

      setOrders((prev) => {
        let changed = false;
        const next = prev.map((row) => {
          if (!sameId(row.dbId, orderId)) return row;
          if (rowSignature(row) === rowSignature(mapped)) return row;
          changed = true;
          return { ...row, ...mapped, dbId: row.dbId };
        });
        return changed ? next : prev;
      });
    };

    const sync = async () => {
      if (cancelled || inFlightRef.current) return;
      if (pausedRef.current) return;
      if (typeof document !== "undefined" && document.hidden) return;

      const visibleIds = new Set(
        (ordersRef.current || []).map((row) => String(row.dbId || "")).filter(Boolean)
      );
      if (!visibleIds.size) return;

      inFlightRef.current = true;
      try {
        const idsToFetch = new Set();

        try {
          const data = await getNotifications({ limit: 20, type: "Order" });
          const notices = data.notifications || [];
          const newestId = Number(notices[0]?.id) || 0;

          if (seenNoticeRef.current == null) {
            seenNoticeRef.current = newestId;
          } else {
            notices.forEach((item) => {
              if (Number(item.id) <= Number(seenNoticeRef.current)) return;
              const orderId = orderIdFromNotice(item);
              if (orderId && visibleIds.has(orderId)) {
                idsToFetch.add(orderId);
              }
            });
            if (newestId > Number(seenNoticeRef.current)) {
              seenNoticeRef.current = newestId;
            }
          }
        } catch {
          // Fall through to the visible-row check.
        }

        // Also refresh rows already on this page so edits that do not notify
        // still update only that row.
        visibleIds.forEach((id) => idsToFetch.add(id));

        await Promise.all(
          [...idsToFetch].map(async (orderId) => {
            try {
              await patchRow(orderId);
            } catch {
              // Keep the current row if this one fetch fails.
            }
          })
        );
      } finally {
        inFlightRef.current = false;
      }
    };

    const intervalId = window.setInterval(sync, SYNC_MS);

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void sync();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [setOrders]);
}
