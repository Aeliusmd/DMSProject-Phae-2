"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import useIsClient from "@/hooks/useIsClient";
import AlertModal from "@/components/ui/AlertModal";
import {
  ORDER_MANUAL_PAYMENT_LOCK_MESSAGE,
  useOrderManualPaymentLock,
} from "@/lib/payments/useOrderManualPaymentLock";
import {
  formatMoney,
  recordManualPayment,
  searchOrderInvoices,
} from "@/lib/payments/paymentApi";
import { getTodayInputDate } from "@/lib/utils/dateUtils";
import { applyApiFieldErrors, getApiErrorMessage } from "@/lib/apiErrorUtils";
import { validateNoHtmlMarkup } from "@/lib/validations/nameValidation";

const INVOICE_STYLES = {
  regular: {
    card: "border-[#67D8E8] bg-[#E6F7FA]",
    badge: "bg-[#E6F7FA] text-[#007F96] border-[#67D8E8]",
    label: "Regular Invoice",
  },
  xray: {
    card: "border-[#C7D2FE] bg-[#EEF2FF]",
    badge: "bg-[#EEF2FF] text-[#4338CA] border-[#C7D2FE]",
    label: "X-Ray Invoice",
  },
};

export default function ManualPaymentModal({ isOpen, onClose, onSaved }) {
  const router = useRouter();
  const mounted = useIsClient();
  const [orderId, setOrderId] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [orderInfo, setOrderInfo] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [expandedType, setExpandedType] = useState(null);
  const [formByType, setFormByType] = useState({});
  const [fieldErrorsByType, setFieldErrorsByType] = useState({});
  const [savingType, setSavingType] = useState(null);
  const [saveError, setSaveError] = useState("");
  const [paymentLockBlocked, setPaymentLockBlocked] = useState(false);

  const lockOrderId = isOpen && orderInfo?.id ? orderInfo.id : null;
  const { status: lockStatus, error: lockError } = useOrderManualPaymentLock(
    lockOrderId
  );

  useEffect(() => {
    if (!isOpen) {
      setPaymentLockBlocked(false);
      return;
    }
    if (lockStatus === "blocked") {
      setPaymentLockBlocked(true);
    }
  }, [isOpen, lockStatus]);

  if (!isOpen || !mounted) return null;

  const resetSearchState = () => {
    setSearchError("");
    setOrderInfo(null);
    setInvoices([]);
    setExpandedType(null);
    setFormByType({});
    setFieldErrorsByType({});
    setSaveError("");
  };

  const handleClose = () => {
    setOrderId("");
    resetSearchState();
    onClose?.();
  };

  const handleSearch = async () => {
    const trimmed = orderId.trim();
    if (!trimmed) {
      setSearchError("Enter an order ID to search.");
      return;
    }

    setSearching(true);
    setSearchError("");
    setExpandedType(null);
    setFormByType({});
    setFieldErrorsByType({});
    setSaveError("");

    try {
      const result = await searchOrderInvoices(trimmed);
      setOrderInfo(result.order);
      setInvoices(result.invoices || []);
    } catch (error) {
      setOrderInfo(null);
      setInvoices([]);
      setSearchError(error.message || "Unable to search invoices for this order.");
    } finally {
      setSearching(false);
    }
  };

  const handleToggleInvoice = (invoice) => {
    if (invoice.isPaid) return;

    setSaveError("");
    setExpandedType((current) =>
      current === invoice.type ? null : invoice.type
    );

    setFormByType((current) => {
      if (current[invoice.type]) return current;

      return {
        ...current,
        [invoice.type]: {
          checkNumber: invoice.paymentCheckNumber || "",
          paymentDate: invoice.paymentDate || getTodayInputDate(),
          note: "",
        },
      };
    });
  };

  const handleFieldChange = (type, field, value) => {
    setFormByType((current) => ({
      ...current,
      [type]: {
        ...current[type],
        [field]: value,
      },
    }));

    setFieldErrorsByType((current) => {
      const typeErrors = current[type];
      if (!typeErrors?.[field]) return current;

      const nextTypeErrors = { ...typeErrors };
      delete nextTypeErrors[field];

      return {
        ...current,
        [type]: nextTypeErrors,
      };
    });
  };

  const handleSave = async (invoice) => {
    if (!orderInfo?.id) return;
    if (lockStatus !== "held") {
      if (lockStatus === "blocked") {
        setPaymentLockBlocked(true);
      }
      return;
    }

    const form = formByType[invoice.type] || {};
    const checkNumber = `${form.checkNumber || ""}`.trim();
    const paymentDate = `${form.paymentDate || ""}`.trim();
    const note = `${form.note || ""}`.trim();
    const nextErrors = {};

    if (!checkNumber) {
      nextErrors.checkNumber = "Check number is required.";
    }

    if (!paymentDate) {
      nextErrors.paymentDate = "Payment date is required.";
    }

    const noteError = validateNoHtmlMarkup(note, { fieldLabel: "Payment note" });
    if (noteError) nextErrors.note = noteError;

    if (Object.keys(nextErrors).length > 0) {
      setFieldErrorsByType((current) => ({
        ...current,
        [invoice.type]: nextErrors,
      }));
      setSaveError("");
      return;
    }

    setSavingType(invoice.type);
    setSaveError("");
    setFieldErrorsByType((current) => ({
      ...current,
      [invoice.type]: {},
    }));

    try {
      const result = await recordManualPayment({
        orderId: orderInfo.id,
        invoiceType: invoice.type,
        checkNumber,
        paymentDate,
        note,
      });

      setOrderInfo(result.order);
      setInvoices(result.invoices || []);
      setExpandedType(null);
      onSaved?.();
    } catch (error) {
      if (Number(error?.status) === 409) {
        setPaymentLockBlocked(true);
        return;
      }

      const { fieldErrors, message } = applyApiFieldErrors(error);

      if (Object.keys(fieldErrors).length > 0) {
        setFieldErrorsByType((current) => ({
          ...current,
          [invoice.type]: fieldErrors,
        }));
      }

      setSaveError(
        message || getApiErrorMessage(error, "Unable to save manual payment.")
      );
    } finally {
      setSavingType(null);
    }
  };

  const handleLockDismiss = () => {
    handleClose();
    router.push("/payments");
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/45 px-4 py-6 backdrop-blur-[2px]">
      <div
        className={`flex max-h-[90vh] w-full max-w-[720px] flex-col overflow-hidden rounded-[12px] border border-[#E2E8F0] bg-white shadow-xl ${
          paymentLockBlocked ? "pointer-events-none select-none blur-[4px]" : ""
        }`}
      >
        <div className="flex items-start justify-between border-b border-[#E2E8F0] px-5 py-4">
          <div>
            <h2 className="text-[16px] font-semibold text-[#111827]">
              Add Manual Payment
            </h2>
            <p className="mt-1 text-[12px] text-[#64748B]">
              Search an order, select an invoice, and record the check details.
            </p>
          </div>

          <button
            type="button"
            onClick={handleClose}
            className="rounded-[6px] px-2 py-1 text-[18px] leading-none text-[#94A3B8] hover:bg-[#F8FAFC] hover:text-[#334155]"
            aria-label="Close modal"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <label className="mb-2 block text-[11px] font-medium text-[#64748B]">
                Order ID
              </label>
              <input
                type="text"
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleSearch();
                  }
                }}
                placeholder="Enter order number or ID"
                className="h-[38px] w-full rounded-[6px] border border-[#CBD5E1] bg-[#F8FAFC] px-3 text-[12px] text-[#111827] outline-none placeholder:text-[#94A3B8] focus:border-[#0097B2] focus:ring-2 focus:ring-[#0097B2]/10"
              />
            </div>

            <button
              type="button"
              onClick={handleSearch}
              disabled={searching}
              className="h-[38px] shrink-0 rounded-[6px] bg-[#0097B2] px-5 text-[12px] font-semibold text-white hover:bg-[#0086A0] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {searching ? "Searching..." : "Search Invoices"}
            </button>
          </div>

          {searchError || (lockStatus === "error" && lockError) ? (
            <p className="mt-3 rounded-[6px] border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-[12px] text-[#DC2626]">
              {searchError || lockError}
            </p>
          ) : null}

          {orderInfo ? (
            <div className="mt-4 rounded-[8px] border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3">
              <p className="text-[12px] font-semibold text-[#334155]">
                Order {orderInfo.orderNumber}
              </p>
              <p className="mt-1 text-[11px] text-[#64748B]">
                {orderInfo.applicant || "—"} · {orderInfo.company || "—"}
                {orderInfo.caseNo ? ` · Case ${orderInfo.caseNo}` : ""}
              </p>
            </div>
          ) : null}

          {orderInfo && !searching && invoices.length === 0 ? (
            <p className="mt-4 rounded-[8px] border border-dashed border-[#CBD5E1] bg-[#F8FAFC] px-4 py-6 text-center text-[12px] text-[#64748B]">
              This order has no invoices.
            </p>
          ) : null}

          {invoices.length > 0 ? (
            <div className="mt-4 space-y-3">
              {invoices.map((invoice) => {
                const styles = INVOICE_STYLES[invoice.type] || INVOICE_STYLES.regular;
                const isExpanded = expandedType === invoice.type;
                const form = formByType[invoice.type] || {
                  checkNumber: "",
                  paymentDate: getTodayInputDate(),
                  note: "",
                };
                const fieldErrors = fieldErrorsByType[invoice.type] || {};
                const isPaymentFormInvalid =
                  !`${form.checkNumber || ""}`.trim() ||
                  !`${form.paymentDate || ""}`.trim();

                return (
                  <div
                    key={invoice.type}
                    className={`overflow-hidden rounded-[10px] border ${styles.card}`}
                  >
                    <button
                      type="button"
                      onClick={() => handleToggleInvoice(invoice)}
                      disabled={invoice.isPaid || lockStatus !== "held"}
                      className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left ${
                        invoice.isPaid
                          ? "cursor-default opacity-80"
                          : "hover:bg-white/40"
                      }`}
                    >
                      <div className="min-w-0">
                        <span
                          className={`inline-flex h-[22px] items-center rounded-full border px-3 text-[10px] font-semibold ${styles.badge}`}
                        >
                          {styles.label}
                        </span>
                        <p className="mt-2 text-[13px] font-semibold text-[#111827]">
                          {invoice.invoiceNumber}
                        </p>
                        <p className="mt-1 text-[12px] text-[#334155]">
                          Amount: {formatMoney(invoice.amount)}
                        </p>
                      </div>

                      <div className="shrink-0 text-right">
                        <span
                          className={`inline-flex h-[22px] items-center rounded-full px-3 text-[10px] font-semibold ${
                            invoice.isPaid
                              ? "bg-[#ECFDF5] text-[#059669]"
                              : "bg-white/70 text-[#334155]"
                          }`}
                        >
                          {invoice.status}
                        </span>
                        {!invoice.isPaid ? (
                          <p className="mt-2 text-[11px] font-medium text-[#007F96]">
                            {isExpanded ? "Collapse" : "Record payment"}
                          </p>
                        ) : null}
                      </div>
                    </button>

                    {isExpanded && !invoice.isPaid ? (
                      <div className="border-t border-white/70 bg-white/60 px-4 py-4">
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                          <div>
                            <label className="mb-2 block text-[11px] font-medium text-[#64748B]">
                              Check Number
                            </label>
                            <input
                              type="text"
                              value={form.checkNumber}
                              onChange={(e) =>
                                handleFieldChange(
                                  invoice.type,
                                  "checkNumber",
                                  e.target.value
                                )
                              }
                              placeholder="Enter check number"
                              className={`h-[38px] w-full rounded-[6px] border bg-white px-3 text-[12px] text-[#111827] outline-none placeholder:text-[#94A3B8] focus:ring-2 ${
                                fieldErrors.checkNumber
                                  ? "border-red-500 focus:border-red-500 focus:ring-red-500/10"
                                  : "border-[#CBD5E1] focus:border-[#0097B2] focus:ring-[#0097B2]/10"
                              }`}
                            />
                            {fieldErrors.checkNumber ? (
                              <p className="mt-1 text-[11px] text-red-500">
                                {fieldErrors.checkNumber}
                              </p>
                            ) : null}
                          </div>

                          <div>
                            <label className="mb-2 block text-[11px] font-medium text-[#64748B]">
                              Payment Date
                            </label>
                            <input
                              type="date"
                              value={form.paymentDate}
                              onChange={(e) =>
                                handleFieldChange(
                                  invoice.type,
                                  "paymentDate",
                                  e.target.value
                                )
                              }
                              className={`h-[38px] w-full rounded-[6px] border bg-white px-3 text-[12px] text-[#111827] outline-none focus:ring-2 ${
                                fieldErrors.paymentDate
                                  ? "border-red-500 focus:border-red-500 focus:ring-red-500/10"
                                  : "border-[#CBD5E1] focus:border-[#0097B2] focus:ring-[#0097B2]/10"
                              }`}
                            />
                            {fieldErrors.paymentDate ? (
                              <p className="mt-1 text-[11px] text-red-500">
                                {fieldErrors.paymentDate}
                              </p>
                            ) : null}
                          </div>
                        </div>

                        <div className="mt-3">
                          <label className="mb-2 block text-[11px] font-medium text-[#64748B]">
                            Note (optional)
                          </label>
                          <textarea
                            value={form.note}
                            onChange={(e) =>
                              handleFieldChange(invoice.type, "note", e.target.value)
                            }
                            rows={3}
                            placeholder="Add any note for this payment"
                            className="w-full rounded-[6px] border border-[#CBD5E1] bg-white px-3 py-2 text-[12px] text-[#111827] outline-none placeholder:text-[#94A3B8] focus:border-[#0097B2] focus:ring-2 focus:ring-[#0097B2]/10"
                          />
                        </div>

                        <div className="mt-4 flex justify-end">
                          <button
                            type="button"
                            onClick={() => handleSave(invoice)}
                            disabled={
                              savingType === invoice.type ||
                              isPaymentFormInvalid ||
                              lockStatus !== "held"
                            }
                            className="h-[38px] rounded-[6px] bg-[#0097B2] px-5 text-[12px] font-semibold text-white hover:bg-[#0086A0] disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {savingType === invoice.type
                              ? "Saving..."
                              : "Save Payment"}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          {saveError ? (
            <p className="mt-3 rounded-[6px] border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-[12px] text-[#DC2626]">
              {saveError}
            </p>
          ) : null}
        </div>
      </div>
      <AlertModal
        open={paymentLockBlocked}
        variant="error"
        title="Payment is being added"
        message={ORDER_MANUAL_PAYMENT_LOCK_MESSAGE}
        confirmLabel="OK"
        onClose={handleLockDismiss}
      />
    </div>,
    document.body
  );
}
