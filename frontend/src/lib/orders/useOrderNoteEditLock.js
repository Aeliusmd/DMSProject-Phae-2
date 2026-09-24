"use client";

import { useEffect, useRef, useState } from "react";
import {
  acquireOrderNoteEditLock,
  heartbeatOrderNoteEditLock,
  releaseOrderNoteEditLock,
} from "@/lib/orders/orderApi";

const HEARTBEAT_MS = 30 * 1000;

export const ORDER_NOTE_EDIT_LOCK_MESSAGE =
  "Another user is editing this note. Please come again later.";

export function useOrderNoteEditLock(orderId, noteId) {
  const [status, setStatus] = useState(orderId && noteId ? "checking" : "idle");
  const [error, setError] = useState("");
  const heldRef = useRef(false);

  useEffect(() => {
    if (!orderId || !noteId) {
      setStatus("idle");
      return undefined;
    }

    let cancelled = false;
    heldRef.current = false;
    setStatus("checking");
    setError("");

    (async () => {
      try {
        await acquireOrderNoteEditLock(orderId, noteId);
        if (cancelled) {
          // Do not release here. React remounts this effect immediately and
          // releasing creates a gap where another user can take the same note.
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
        setError(err?.message || "Failed to start note editing");
      }
    })();

    const heartbeatId = window.setInterval(async () => {
      if (!heldRef.current) return;
      try {
        await heartbeatOrderNoteEditLock(orderId, noteId);
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
      releaseOrderNoteEditLock(orderId, noteId);
    };

    const onPageHide = () => releaseIfHeld();
    window.addEventListener("pagehide", onPageHide);

    return () => {
      cancelled = true;
      window.clearInterval(heartbeatId);
      window.removeEventListener("pagehide", onPageHide);
      releaseIfHeld();
    };
  }, [orderId, noteId]);

  return { status, error };
}
