"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { applyApiFieldErrors, getApiErrorMessage, hasValidationErrors } from "@/lib/apiErrorUtils";
import AlertModal from "@/components/ui/AlertModal";
import {
  ORDER_INVOICE_WRITEOFF_LOCK_MESSAGE,
  useOrderInvoiceWriteOffLocks,
} from "@/lib/invoices/useOrderInvoiceEditLock";

function parseCurrency(value) {
  if (typeof value === "number") return value;

  const parsed = Number(String(value || "").replace(/[^0-9.-]+/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatCurrency(value) {
  return Number(value || 0).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

export default function WriteOffInvoiceModal({
  isOpen,
  invoices = [],
  onClose,
  onSubmit,
  returnToPath = "",
}) {
  const router = useRouter();
  const pathname = usePathname();
  const listBackHref = returnToPath || pathname || "/invoices";
  const [writeOffType, setWriteOffType] = useState("full");
  const [specifiedAmount, setSpecifiedAmount] = useState("");
  const [orderAction, setOrderAction] = useState("keep_write_off");
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [writeOffLockBlocked, setWriteOffLockBlocked] = useState(false);

  const lockTargets = useMemo(() => {
    if (!isOpen) return [];

    const seen = new Set();
    return invoices
      .map((invoice) => {
        const orderId = Number(invoice.orderId);
        const kind =
          invoice.invoiceType === "xray" ? "xray_writeoff" : "regular_writeoff";
        return { orderId, kind };
      })
      .filter((target) => {
        if (!Number.isFinite(target.orderId) || target.orderId <= 0) return false;
        const key = `${target.orderId}:${target.kind}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((left, right) =>
        `${left.orderId}:${left.kind}`.localeCompare(`${right.orderId}:${right.kind}`)
      );
  }, [isOpen, invoices]);

  const { status: lockStatus, error: lockError } = useOrderInvoiceWriteOffLocks(
    lockTargets
  );

  const totalDue = useMemo(() => {
    return invoices.reduce(
      (total, invoice) => total + parseCurrency(invoice.due),
      0
    );
  }, [invoices]);

  const isBulkWriteOff = invoices.length > 1;
  const selectedInvoice = invoices[0];
  const hasDue = totalDue > 0;
  const showOrderAction =
    !hasDue ||
    isBulkWriteOff ||
    writeOffType === "full" ||
    (writeOffType === "specified" &&
      specifiedAmount &&
      Number(specifiedAmount) >= totalDue);

  const openSession = isOpen
    ? invoices.map((invoice) => invoice.id || invoice.invoiceNo || "").join(",")
    : null;
  const [prevOpenSession, setPrevOpenSession] = useState(null);

  if (openSession !== prevOpenSession) {
    setPrevOpenSession(openSession);

    if (openSession) {
      setWriteOffType("full");
      setSpecifiedAmount("");
      setOrderAction("keep_write_off");
      setFieldErrors({});
      setError("");
      setSubmitting(false);
      setWriteOffLockBlocked(false);
    }
  }

  const clientValidationErrors = useMemo(() => {
    const nextErrors = {};

    if (!hasDue) {
      if (!orderAction) {
        nextErrors.orderAction =
          "Please choose whether to close the order or keep it as write off.";
      }
      return nextErrors;
    }

    if (!isBulkWriteOff && writeOffType === "specified") {
      const amountToWriteOff = Number(specifiedAmount);
      if (!specifiedAmount || !Number.isFinite(amountToWriteOff) || amountToWriteOff <= 0) {
        nextErrors.amount = "Please enter a valid write off amount.";
      }
    }

    const amountToWriteOff =
      isBulkWriteOff || writeOffType === "full"
        ? totalDue
        : Number(specifiedAmount);
    const isFullWriteOff = amountToWriteOff >= totalDue;

    if (isFullWriteOff && !orderAction) {
      nextErrors.orderAction =
        "Please choose whether to close the order or keep it as write off.";
    }

    return nextErrors;
  }, [
    hasDue,
    isBulkWriteOff,
    writeOffType,
    specifiedAmount,
    totalDue,
    orderAction,
  ]);

  const isFormInvalid = hasValidationErrors(clientValidationErrors);

  useEffect(() => {
    if (lockStatus === "blocked") {
      setWriteOffLockBlocked(true);
    }
  }, [lockStatus]);

  if (!isOpen) return null;

  const handleAmountChange = (e) => {
    const value = e.target.value;

    if (value === "") {
      setSpecifiedAmount("");
      setError("");
      return;
    }

    const numericValue = Number(value);

    if (!Number.isFinite(numericValue) || numericValue < 0) return;

    if (numericValue > totalDue) {
      setSpecifiedAmount(String(totalDue));
      setFieldErrors({
        amount: `Amount cannot be higher than ${formatCurrency(totalDue)}.`,
      });
      return;
    }

    setSpecifiedAmount(value);
    setFieldErrors({});
    setError("");
  };

  const buildPayload = () => {
    if (!hasDue) {
      return {
        mode: isBulkWriteOff ? "bulk" : "single",
        writeOffType: "full",
        orderAction,
        isFullWriteOff: true,
        isZeroDue: true,
        amount: 0,
        totalDue: 0,
        invoices: invoices.map((invoice) => ({
          ...invoice,
          dueAmount: parseCurrency(invoice.due),
          writeOffAmount: 0,
        })),
      };
    }

    const amountToWriteOff =
      isBulkWriteOff || writeOffType === "full"
        ? totalDue
        : Number(specifiedAmount);
    const isFullWriteOff = amountToWriteOff >= totalDue;

    return {
      mode: isBulkWriteOff ? "bulk" : "single",
      writeOffType: isBulkWriteOff ? "full" : writeOffType,
      orderAction: isFullWriteOff ? orderAction : null,
      isFullWriteOff,
      amount: amountToWriteOff,
      totalDue,
      invoices: invoices.map((invoice) => {
        const dueAmount = parseCurrency(invoice.due);

        return {
          ...invoice,
          dueAmount,
          writeOffAmount: isBulkWriteOff ? dueAmount : amountToWriteOff,
        };
      }),
    };
  };

  const handleSubmit = async () => {
    setError("");
    setFieldErrors(clientValidationErrors);

    if (Object.keys(clientValidationErrors).length > 0) {
      return;
    }

    if (lockStatus !== "held") {
      if (lockStatus === "blocked") {
        setWriteOffLockBlocked(true);
      }
      return;
    }

    if (!onSubmit) {
      onClose?.();
      return;
    }

    setSubmitting(true);

    try {
      await onSubmit(buildPayload());
      onClose?.();
    } catch (err) {
      if (Number(err?.status) === 409) {
        setWriteOffLockBlocked(true);
        return;
      }

      const { fieldErrors: apiErrors, message } = applyApiFieldErrors(err);

      if (apiErrors.orderAction) {
        setFieldErrors((prev) => ({ ...prev, orderAction: apiErrors.orderAction }));
      }

      if (apiErrors.amount || apiErrors["invoices.0.writeOffAmount"]) {
        setFieldErrors((prev) => ({
          ...prev,
          amount: apiErrors.amount || apiErrors["invoices.0.writeOffAmount"],
        }));
      }

      setError(message || getApiErrorMessage(err, "Failed to write off invoices"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleLockDismiss = () => {
    onClose?.();
    router.push(listBackHref);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-6">
      <div
        className={`w-full max-w-[560px] rounded-[12px] bg-white shadow-xl ${
          writeOffLockBlocked ? "pointer-events-none select-none blur-[4px]" : ""
        }`}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[#E2E8F0] px-6 py-5">
          <div>
            <h2 className="text-[16px] font-semibold text-[#111827]">
              Write Off Invoice
            </h2>

            <p className="mt-1 text-[12px] text-[#64748B]">
              {isBulkWriteOff
                ? `${invoices.length} invoices selected. The full due amount will be written off.`
                : `Case ${selectedInvoice?.caseNo || "N/A"}`}
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-[6px] px-2 py-1 text-[18px] leading-none text-[#64748B] hover:bg-[#F1F5F9] hover:text-[#111827]"
            aria-label="Close write off modal"
          >
            ×
          </button>
        </div>

        <div className="space-y-5 px-6 py-5">
          <div className="rounded-[10px] border border-[#FEE2E2] bg-red-50 px-4 py-4">
            <p className="text-[11px] font-medium uppercase tracking-wide text-red-500">
              Total Due Amount
            </p>

            <p className="mt-1 text-[24px] font-semibold text-red-600">
              {formatCurrency(totalDue)}
            </p>
          </div>

          {!hasDue ? (
            <div className="rounded-[8px] border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3 text-[12px] text-[#475569]">
              This invoice has no remaining due amount. Choose whether to close the
              order as completed or keep it marked as a write off.
            </div>
          ) : isBulkWriteOff ? (
            <div className="rounded-[8px] border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3 text-[12px] text-[#475569]">
              Bulk write off is enabled. Amount input is disabled because all
              selected invoice due amounts will be written off fully.
            </div>
          ) : (
            <div>
              <p className="mb-3 text-[12px] font-semibold text-[#334155]">
                Write Off Amount
              </p>

              <div className="space-y-3">
                <label className="flex cursor-pointer items-center gap-3 rounded-[8px] border border-[#E2E8F0] px-4 py-3 text-[12px] text-[#334155] hover:bg-[#F8FAFC]">
                  <input
                    type="radio"
                    name="writeOffType"
                    value="full"
                    checked={writeOffType === "full"}
                    onChange={() => {
                      setWriteOffType("full");
                      setSpecifiedAmount("");
                      setError("");
                    }}
                    className="h-[14px] w-[14px] accent-red-500"
                  />
                  Write off the full due amount
                </label>

                <label className="flex cursor-pointer items-center gap-3 rounded-[8px] border border-[#E2E8F0] px-4 py-3 text-[12px] text-[#334155] hover:bg-[#F8FAFC]">
                  <input
                    type="radio"
                    name="writeOffType"
                    value="specified"
                    checked={writeOffType === "specified"}
                    onChange={() => {
                      setWriteOffType("specified");
                      setError("");
                    }}
                    className="h-[14px] w-[14px] accent-red-500"
                  />
                  Specify write off amount
                </label>
              </div>

              {writeOffType === "specified" && (
                <div className="mt-3">
                  <label className="mb-2 block text-[11px] font-medium text-[#64748B]">
                    Amount to write off
                  </label>

                  <input
                    type="number"
                    min="0.01"
                    max={totalDue}
                    step="0.01"
                    value={specifiedAmount}
                    onChange={handleAmountChange}
                    placeholder="0.00"
                    className={`h-[38px] w-full rounded-[6px] border bg-[#F8FAFC] px-3 text-[12px] text-[#111827] outline-none focus:ring-2 ${
                      fieldErrors.amount
                        ? "border-red-500 focus:border-red-500 focus:ring-red-500/10"
                        : "border-[#CBD5E1] focus:border-red-500 focus:ring-red-500/10"
                    }`}
                  />

                  {fieldErrors.amount ? (
                    <p className="mt-2 text-[11px] font-medium text-red-600">
                      {fieldErrors.amount}
                    </p>
                  ) : (
                    <p className="mt-2 text-[11px] text-[#64748B]">
                      Amount must be equal to or lower than{" "}
                      {formatCurrency(totalDue)}.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          <div>
            <p className="mb-3 text-[12px] font-semibold text-[#334155]">
              After Write Off
            </p>

            {!showOrderAction ? (
              <p className="rounded-[8px] border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3 text-[12px] text-[#475569]">
                Partial write off — order status stays unchanged. Choose full due
                amount to close or mark as write off.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex cursor-pointer items-center gap-3 rounded-[8px] border border-[#E2E8F0] px-4 py-3 text-[12px] text-[#334155] hover:bg-[#F8FAFC]">
                  <input
                    type="radio"
                    name="orderAction"
                    value="close_order"
                    checked={orderAction === "close_order"}
                    onChange={() => setOrderAction("close_order")}
                    className="h-[14px] w-[14px] accent-red-500"
                  />
                  Close the order
                </label>

                <label className="flex cursor-pointer items-center gap-3 rounded-[8px] border border-[#E2E8F0] px-4 py-3 text-[12px] text-[#334155] hover:bg-[#F8FAFC]">
                  <input
                    type="radio"
                    name="orderAction"
                    value="keep_write_off"
                    checked={orderAction === "keep_write_off"}
                    onChange={() => setOrderAction("keep_write_off")}
                    className="h-[14px] w-[14px] accent-red-500"
                  />
                  Keep this as write off
                </label>
              </div>
            )}
          </div>

          {fieldErrors.orderAction ? (
            <p className="text-[11px] font-medium text-red-600">{fieldErrors.orderAction}</p>
          ) : null}

          {(error || (lockStatus === "error" && lockError)) && (
            <div className="rounded-[8px] border border-red-200 bg-red-50 px-4 py-3 text-[12px] font-medium text-red-600">
              {error || lockError}
            </div>
          )}
        </div>

        <div className="flex flex-col-reverse gap-3 border-t border-[#E2E8F0] px-6 py-4 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-[36px] items-center justify-center rounded-[6px] bg-[#F1F5F9] px-5 text-[12px] font-semibold leading-none text-[#334155] hover:bg-[#E2E8F0]"
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || isFormInvalid || lockStatus !== "held"}
            className="inline-flex h-[36px] items-center justify-center rounded-[6px] bg-red-500 px-5 text-[12px] font-semibold leading-none text-white hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting
              ? "Processing..."
              : lockStatus === "checking"
                ? "Checking..."
                : hasDue
                  ? "Confirm Write Off"
                  : "Confirm Update Order"}
          </button>
        </div>
      </div>
      <AlertModal
        open={writeOffLockBlocked}
        variant="error"
        title="Invoice is being written off"
        message={ORDER_INVOICE_WRITEOFF_LOCK_MESSAGE}
        confirmLabel="OK"
        onClose={handleLockDismiss}
      />
    </div>
  );
}