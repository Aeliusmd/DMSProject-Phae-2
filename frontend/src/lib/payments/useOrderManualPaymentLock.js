"use client";

import { useEffect, useRef, useState } from "react";
import {
  acquireOrderManualPaymentLock,
  heartbeatOrderManualPaymentLock,
  releaseOrderManualPaymentLock,
} from "@/lib/payments/paymentApi";

const HEARTBEAT_MS = 30 * 1000;

export const ORDER_MANUAL_PAYMENT_LOCK_MESSAGE =
  "Another user is adding a payment to this order. Please come again later.";

export function useOrderManualPaymentLock(orderId) {
  const [status, setStatus] = useState(orderId ? "checking" : "idle");
  const [error, setError] = useState("");
  const heldRef = useRef(false);

  useEffect(() => {
    if (!orderId) {
      setStatus("idle");
      return undefined;
    }

    let cancelled = false;
    heldRef.current = false;
    setStatus("checking");
    setError("");

    (async () => {
      try {
        await acquireOrderManualPaymentLock(orderId);
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
        setError(err?.message || "Failed to start payment entry");
      }
    })();

    const heartbeatId = window.setInterval(async () => {
      if (!heldRef.current) return;
      try {
        await heartbeatOrderManualPaymentLock(orderId);
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
      releaseOrderManualPaymentLock(orderId);
    };

    const onPageHide = () => releaseIfHeld();
    window.addEventListener("pagehide", onPageHide);

    return () => {
      cancelled = true;
      window.clearInterval(heartbeatId);
      window.removeEventListener("pagehide", onPageHide);
      releaseIfHeld();
    };
  }, [orderId]);

  return { status, error };
}
