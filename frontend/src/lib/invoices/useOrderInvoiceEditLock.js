"use client";

import { useEffect, useRef, useState } from "react";
import {
  acquireOrderInvoiceEditLock,
  heartbeatOrderInvoiceEditLock,
  releaseOrderInvoiceEditLock,
} from "@/lib/invoices/invoiceApi";

const HEARTBEAT_MS = 30 * 1000;

export const ORDER_INVOICE_EDIT_LOCK_MESSAGE =
  "Another user is editing this invoice. Please come again later.";

export function useOrderInvoiceEditLock(orderId, invoiceKind) {
  const [status, setStatus] = useState(
    orderId && invoiceKind ? "checking" : "idle"
  );
  const [error, setError] = useState("");
  const heldRef = useRef(false);

  useEffect(() => {
    if (!orderId || !invoiceKind) {
      setStatus("idle");
      return undefined;
    }

    let cancelled = false;
    heldRef.current = false;
    setStatus("checking");
    setError("");

    (async () => {
      try {
        await acquireOrderInvoiceEditLock(orderId, invoiceKind);
        if (cancelled) {
          return;
        }
        heldRef.current = true;
        setStatus("held");
      } catch (err) {
        if (cancelled) {
          if (Number(err?.status) === 409) {
            setStatus("blocked");
          }
          return;
        }
        if (Number(err?.status) === 409) {
          setStatus("blocked");
          return;
        }
        setStatus("error");
        setError(err?.message || "Failed to start invoice editing");
      }
    })();

    const heartbeatId = window.setInterval(async () => {
      if (!heldRef.current) return;
      try {
        await heartbeatOrderInvoiceEditLock(orderId, invoiceKind);
      } catch (err) {
        if (Number(err?.status) === 409) {
          heldRef.current = false;
          setStatus("blocked");
        }
      }
    }, HEARTBEAT_MS);

    const releaseIfHeld = () => {
      if (!heldRef.current) return;
      heldRef.current = false;
      releaseOrderInvoiceEditLock(orderId, invoiceKind);
    };

    const onPageHide = () => releaseIfHeld();
    window.addEventListener("pagehide", onPageHide);

    return () => {
      cancelled = true;
      window.clearInterval(heartbeatId);
      window.removeEventListener("pagehide", onPageHide);
      releaseIfHeld();
    };
  }, [orderId, invoiceKind]);

  return { status, error };
}
