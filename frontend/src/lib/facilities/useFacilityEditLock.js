"use client";

import { useEffect, useRef, useState } from "react";
import {
  acquireFacilityEditLock,
  heartbeatFacilityEditLock,
  releaseFacilityEditLock,
} from "@/lib/facilities/facilityApi";

const HEARTBEAT_MS = 30 * 1000;

export const FACILITY_EDIT_LOCK_MESSAGE =
  "Another user is editing this facility. Please come again later.";

export function useFacilityEditLock(facilityId) {
  const [status, setStatus] = useState(facilityId ? "checking" : "idle");
  const [error, setError] = useState("");
  const heldRef = useRef(false);

  useEffect(() => {
    if (!facilityId) {
      setStatus("idle");
      return undefined;
    }

    let cancelled = false;
    heldRef.current = false;
    setStatus("checking");
    setError("");

    (async () => {
      try {
        await acquireFacilityEditLock(facilityId);
        if (cancelled) {
          await releaseFacilityEditLock(facilityId);
          return;
        }
        heldRef.current = true;
        setStatus("held");
      } catch (err) {
        if (cancelled) return;
        if (Number(err?.status) === 409) {
          setStatus("blocked");
          return;
        }
        setStatus("error");
        setError(err?.message || "Failed to start facility editing");
      }
    })();

    const heartbeatId = window.setInterval(async () => {
      if (!heldRef.current) return;
      try {
        await heartbeatFacilityEditLock(facilityId);
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
      releaseFacilityEditLock(facilityId);
    };

    const onPageHide = () => releaseIfHeld();
    window.addEventListener("pagehide", onPageHide);

    return () => {
      cancelled = true;
      window.clearInterval(heartbeatId);
      window.removeEventListener("pagehide", onPageHide);
      releaseIfHeld();
    };
  }, [facilityId]);

  return { status, error };
}
