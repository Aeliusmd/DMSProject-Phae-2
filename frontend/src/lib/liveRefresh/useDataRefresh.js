"use client";

import { useEffect, useRef } from "react";
import {
  DATA_CHANGED_EVENT,
  STORAGE_KEY,
  getDataRevision,
} from "@/lib/liveRefresh/dataRefresh";

const DEFAULT_DEBOUNCE_MS = 350;

/**
 * Soft-refetch after this browser's own successful writes, and when coming
 * back to a tab/page that missed those writes. Does not hard-reload.
 */
export function useDataRefresh(refetch, options = {}) {
  const { enabled = true, paused = false, debounceMs = DEFAULT_DEBOUNCE_MS } =
    options;
  const refetchRef = useRef(refetch);
  const pausedRef = useRef(paused);
  const seenRevRef = useRef(getDataRevision());
  const timerRef = useRef(null);

  refetchRef.current = refetch;
  pausedRef.current = paused;

  useEffect(() => {
    if (!enabled) return undefined;

    const run = (force = false) => {
      if (pausedRef.current) return;

      const rev = getDataRevision();
      if (!force && rev <= seenRevRef.current) return;
      seenRevRef.current = rev;

      if (typeof refetchRef.current === "function") {
        void refetchRef.current();
      }
    };

    const schedule = (force = false) => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        run(force);
      }, debounceMs);
    };

    const onChanged = () => schedule(true);
    const onStorage = (event) => {
      if (event.key === STORAGE_KEY) onChanged();
    };
    const onResume = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState &&
        document.visibilityState !== "visible"
      ) {
        return;
      }
      schedule(false);
    };

    window.addEventListener(DATA_CHANGED_EVENT, onChanged);
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onResume);
    window.addEventListener("pageshow", onResume);
    document.addEventListener("visibilitychange", onResume);

    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      window.removeEventListener(DATA_CHANGED_EVENT, onChanged);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onResume);
      window.removeEventListener("pageshow", onResume);
      document.removeEventListener("visibilitychange", onResume);
    };
  }, [enabled, debounceMs]);

  useEffect(() => {
    if (!enabled || paused) return;
    if (getDataRevision() <= seenRevRef.current) return;
    if (typeof refetchRef.current === "function") {
      seenRevRef.current = getDataRevision();
      void refetchRef.current();
    }
  }, [enabled, paused]);
}
