"use client";

import { useEffect, useMemo, useState } from "react";
import ConfirmModal from "@/components/ui/ConfirmModal";
import {
  DELETE_REASON_OTHER,
  PREDEFINED_DELETE_REASONS,
  isOtherDeleteReason,
  resolveDeleteReason,
  validateDeleteReasonSelection,
} from "@/lib/orders/orderDeleteReasons";

export default function OrderDeleteModal({
  open,
  order,
  loading = false,
  onClose,
  onConfirm,
}) {
  const [selectedReason, setSelectedReason] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [step, setStep] = useState("reason");
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState("");

  const resolvedReason = useMemo(
    () => resolveDeleteReason(selectedReason, customReason),
    [selectedReason, customReason]
  );

  const isReasonInvalid = useMemo(() => {
    if (!selectedReason) return true;
    if (isOtherDeleteReason(selectedReason)) {
      return !customReason.trim();
    }
    return false;
  }, [selectedReason, customReason]);

  useEffect(() => {
    if (open) {
      setSelectedReason("");
      setCustomReason("");
      setStep("reason");
      setFieldErrors({});
      setError("");
    }
  }, [open, order?.dbId]);

  if (!open) return null;

  if (step === "confirm") {
    return (
      <ConfirmModal
        open
        title="Delete Order"
        message={`Are you sure you want to delete order ${order?.id || ""}?`}
        variant="danger"
        confirmLabel={loading ? "Deleting..." : "Confirm"}
        cancelLabel="Back"
        confirmDisabled={loading}
        onCancel={() => setStep("reason")}
        onConfirm={() => {
          if (loading) return;
          onConfirm(resolvedReason);
        }}
      />
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4 py-6 backdrop-blur-[2px]">
      <section
        className="rounded-[9px] bg-white px-5 py-5 shadow-2xl"
        style={{ width: "100%", maxWidth: "460px" }}
      >
        <h2 className="text-[15px] font-semibold text-[#111827]">Delete Order</h2>
        <p className="mt-2 text-[12px] leading-[20px] text-[#475569]">
          Please select a reason for deleting order{" "}
          <span className="font-semibold text-[#111827]">{order?.id || ""}</span>.
        </p>

        <div
          className={`mt-4 max-h-[280px] space-y-2 overflow-y-auto rounded-[6px] border px-3 py-3 ${
            fieldErrors.selectedReason
              ? "border-red-500"
              : "border-[#E2E8F0]"
          }`}
        >
          {PREDEFINED_DELETE_REASONS.map((reasonOption) => (
            <label
              key={reasonOption}
              className="flex cursor-pointer items-start gap-3 rounded-[6px] px-2 py-2 text-[12px] text-[#334155] hover:bg-[#F8FAFC]"
            >
              <input
                type="radio"
                name="deleteReason"
                value={reasonOption}
                checked={selectedReason === reasonOption}
                onChange={() => {
                  setSelectedReason(reasonOption);
                  setFieldErrors({});
                  if (error) setError("");
                }}
                className="mt-[2px] h-[14px] w-[14px] shrink-0 accent-[#DC2626]"
              />
              <span className="leading-[18px]">{reasonOption}</span>
            </label>
          ))}
        </div>

        {fieldErrors.selectedReason ? (
          <p className="mt-2 text-[11px] font-medium text-red-500">
            {fieldErrors.selectedReason}
          </p>
        ) : null}

        {isOtherDeleteReason(selectedReason) ? (
          <textarea
            value={customReason}
            onChange={(event) => {
              setCustomReason(event.target.value);
              setFieldErrors((current) => {
                const next = { ...current };
                delete next.customReason;
                return next;
              });
              if (error) setError("");
            }}
            rows={3}
            placeholder="Enter deletion reason..."
            className={`mt-3 w-full resize-none rounded-[6px] border px-3 py-2 text-[12px] text-[#334155] outline-none focus:ring-2 ${
              fieldErrors.customReason
                ? "border-red-500 focus:border-red-500 focus:ring-red-500/10"
                : "border-[#E2E8F0] focus:border-[#007F96] focus:ring-[#007F96]/10"
            }`}
          />
        ) : null}

        {fieldErrors.customReason ? (
          <p className="mt-2 text-[11px] font-medium text-red-500">
            {fieldErrors.customReason}
          </p>
        ) : null}

        {error ? (
          <p className="mt-2 text-[11px] font-medium text-red-500">{error}</p>
        ) : null}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-[34px] items-center justify-center rounded-[6px] bg-[#F8FAFC] px-4 text-[12px] font-semibold leading-none text-[#334155] hover:bg-[#E2E8F0]"
          >
            Close
          </button>

          <button
            type="button"
            onClick={() => {
              const validationErrors = validateDeleteReasonSelection(
                selectedReason,
                customReason
              );
              if (Object.keys(validationErrors).length > 0) {
                setFieldErrors(validationErrors);
                setError("");
                return;
              }

              setFieldErrors({});
              setStep("confirm");
            }}
            disabled={isReasonInvalid}
            className="inline-flex h-[34px] items-center justify-center gap-2 rounded-[6px] px-4 text-[12px] font-semibold leading-none text-white disabled:cursor-not-allowed disabled:opacity-60"
            style={{ backgroundColor: "#DC2626" }}
          >
            Continue
          </button>
        </div>
      </section>
    </div>
  );
}
