"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import useIsClient from "@/hooks/useIsClient";
import AlertModal from "@/components/ui/AlertModal";
import {
  ORDER_INVOICE_EDIT_LOCK_MESSAGE,
  useOrderInvoiceEditLock,
} from "@/lib/invoices/useOrderInvoiceEditLock";
import { getTodayInputDate } from "@/lib/utils/dateUtils";
import {
  getXrayInvoiceByOrderId,
  saveXrayInvoice,
} from "@/lib/invoices/invoiceApi";
import { getOrder } from "@/lib/orders/orderApi";
import {
  applyApiFieldErrors,
  getApiErrorMessage,
  hasValidationErrors,
} from "@/lib/apiErrorUtils";
import { validateNoHtmlMarkup } from "@/lib/validations/nameValidation";

const initialFormData = {
  xrayInvoiceDate: "",
  examDate: "",
  views: "0",
  perViewAmount: "0.00",
  xrayPaidEarlier: "0.00",
  checkNumber: "",
  description: "",
  writeoffAmount: 0,
};

export default function CreateXrayInvoiceModal({
  isOpen,
  order,
  onClose,
  onSaved,
  returnToPath = "",
}) {
  const router = useRouter();
  const pathname = usePathname();
  const mounted = useIsClient();
  const listBackHref = returnToPath || pathname || "/orders";
  const [formData, setFormData] = useState(initialFormData);
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [isContentReady, setIsContentReady] = useState(false);
  const [hasExistingInvoice, setHasExistingInvoice] = useState(false);
  const [isEditing, setIsEditing] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [invoiceLockBlocked, setInvoiceLockBlocked] = useState(false);

  const lockOrderId = isOpen && order?.dbId ? order.dbId : null;
  const { status: lockStatus, error: lockError } = useOrderInvoiceEditLock(
    lockOrderId,
    "xray"
  );

  const openSession =
    isOpen && order ? String(order.id || order.orderNo) : null;
  const [prevOpenSession, setPrevOpenSession] = useState(null);

  if (openSession !== prevOpenSession) {
    setPrevOpenSession(openSession);

    if (openSession) {
      const likelyExisting = orderIndicatesExistingXrayInvoice(order);
      setIsContentReady(false);
      setFormData({ ...initialFormData, xrayInvoiceDate: getTodayInputDate() });
      setErrors({});
      setSubmitError("");
      setHasExistingInvoice(likelyExisting);
      setIsEditing(!likelyExisting);
      setInvoiceLockBlocked(false);
    }
  }

  useEffect(() => {
    if (lockStatus === "blocked") {
      setInvoiceLockBlocked(true);
    }
  }, [lockStatus]);

  useEffect(() => {
    if (!isOpen || !order?.dbId) return;
    if (lockStatus !== "held") return;

    let cancelled = false;

    async function loadXrayInvoice() {
      try {
        const [data, orderData] = await Promise.all([
          getXrayInvoiceByOrderId(order.dbId),
          getOrder(order.dbId),
        ]);
        if (cancelled) return;

        const xray = data?.xray;
        const xrayPaidEarlier =
          xray?.xrayPaidEarlier ?? xray?.prepayment ?? "0.00";
        const hasSavedXray = Boolean(String(xray?.xrayInvoiceDate || "").trim());
        const suggestedViews = resolveXrayInvoicePageCount(orderData);

        setHasExistingInvoice(hasSavedXray);
        setIsEditing(!hasSavedXray);
        setFormData({
          xrayInvoiceDate: xray?.xrayInvoiceDate || getTodayInputDate(),
          examDate: xray?.examDate || "",
          views: hasSavedXray
            ? (xray?.views ?? initialFormData.views)
            : String(suggestedViews),
          perViewAmount: xray?.perViewAmount ?? initialFormData.perViewAmount,
          xrayPaidEarlier,
          checkNumber: xray?.checkNumber ?? "",
          description: xray?.description || "",
          writeoffAmount: toNumber(xray?.writeoffAmount),
        });
      } catch {
        if (!cancelled) {
          setFormData({
            ...initialFormData,
            xrayInvoiceDate: getTodayInputDate(),
          });
          setHasExistingInvoice(false);
          setIsEditing(true);
        }
      } finally {
        if (!cancelled) {
          setIsContentReady(true);
        }
      }
    }

    loadXrayInvoice();

    return () => {
      cancelled = true;
    };
  }, [isOpen, order?.dbId, reloadKey, lockStatus]);

  useEffect(() => {
    if (!isOpen) return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [isOpen]);

  const viewsAmount = useMemo(() => {
    return toNumber(formData.views) * toNumber(formData.perViewAmount);
  }, [formData.views, formData.perViewAmount]);

  const totalInvoiced = useMemo(() => {
    // Do not credit more than the invoice views total.
    const paidEarlier = Math.min(
      viewsAmount,
      Math.max(0, toNumber(formData.xrayPaidEarlier))
    );
    return Math.max(0, viewsAmount - paidEarlier);
  }, [viewsAmount, formData.xrayPaidEarlier]);

  const balanceDue = useMemo(() => {
    return Math.max(0, totalInvoiced - toNumber(formData.writeoffAmount));
  }, [totalInvoiced, formData.writeoffAmount]);

  const clientValidationErrors = useMemo(
    () => validateXrayInvoiceForm(formData),
    [formData]
  );
  const isFormInvalid = hasValidationErrors(clientValidationErrors);
  const fieldsReadOnly = hasExistingInvoice && !isEditing;
  const modalTitle = !isContentReady
    ? orderIndicatesExistingXrayInvoice(order)
      ? "Edit X-Ray Invoice"
      : "X-Ray Invoice"
    : hasExistingInvoice
      ? "Edit X-Ray Invoice"
      : "New X-Ray Invoice";
  const submitLabel =
    hasExistingInvoice && !isEditing ? "Edit Invoice" : "Save Invoice";

  if (!mounted || !isOpen || !order) return null;

  const handleChange = (e) => {
    const { name, value } = e.target;

    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));

    setErrors((prev) => ({
      ...prev,
      [name]: "",
    }));
  };

  const handleViewsChange = (e) => {
    const cleanValue = e.target.value.replace(/\D/g, "");

    setFormData((prev) => ({
      ...prev,
      views: cleanValue,
    }));

    setErrors((prev) => ({
      ...prev,
      views: "",
    }));
  };

  const handleMoneyChange = (e) => {
    const { name, value } = e.target;

    const cleanValue = value
      .replace(/[^\d.]/g, "")
      .replace(/(\..*)\./g, "$1")
      .replace(/^(\d*\.\d{0,2}).*$/, "$1");

    setFormData((prev) => ({
      ...prev,
      [name]: cleanValue,
    }));

    setErrors((prev) => ({
      ...prev,
      [name]: "",
    }));
  };

  const handleSubmit = async () => {
    if (hasExistingInvoice && !isEditing) {
      setIsEditing(true);
      setSubmitError("");
      setErrors({});
      return;
    }

    const validationErrors = validateXrayInvoiceForm(formData);
    setErrors(validationErrors);

    if (Object.keys(validationErrors).length > 0) return;
    if (lockStatus !== "held") return;

    setSubmitting(true);
    setSubmitError("");

    try {
      await saveXrayInvoice({
        orderId: order.dbId,
        xrayInvoiceDate: formData.xrayInvoiceDate,
        examDate: formData.examDate,
        views: formData.views,
        perViewAmount: formData.perViewAmount,
        checkNumber: formData.checkNumber,
        description: formData.description,
      });

      if (onSaved) {
        await onSaved();
      }

      if (hasExistingInvoice) {
        setHasExistingInvoice(true);
        setIsEditing(false);
        setIsContentReady(false);
        setReloadKey((prev) => prev + 1);
        return;
      }

      onClose();
    } catch (error) {
      if (Number(error?.status) === 409) {
        setInvoiceLockBlocked(true);
        return;
      }

      const { fieldErrors, message } = applyApiFieldErrors(error);

      if (Object.keys(fieldErrors).length > 0) {
        setErrors((prev) => ({ ...prev, ...fieldErrors }));
      }

      setSubmitError(
        message || getApiErrorMessage(error, "Failed to save X-Ray invoice")
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleLockDismiss = () => {
    onClose?.();
    router.push(listBackHref);
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-end justify-center bg-black/50 p-0 backdrop-blur-[2px] sm:items-center sm:p-4 sm:py-6">
      <section
        className={`flex max-h-[100dvh] w-full max-w-[720px] flex-col overflow-hidden rounded-t-[12px] bg-white shadow-2xl sm:max-h-[calc(100vh-42px)] sm:rounded-[10px] ${
          invoiceLockBlocked ? "pointer-events-none select-none blur-[4px]" : ""
        }`}
      >
        <div className="relative shrink-0 bg-gradient-to-r from-[#008AA3] via-[#0A96AA] to-[#56AFC0] px-4 py-4 text-white sm:px-5">
          <button
            type="button"
            onClick={onClose}
            className="absolute right-4 top-4 flex h-[24px] w-[24px] items-center justify-center rounded-[6px] bg-white/15 text-[15px] leading-none text-white hover:bg-white/25"
            aria-label="Close modal"
          >
            ×
          </button>

          <h2 className="text-[15px] font-semibold leading-none">
            {modalTitle}
          </h2>

          <p className="mt-3 text-[11px] font-medium text-white/90">
            Order{" "}
            <span className="font-semibold text-white">
              {order.id || order.orderNo}
            </span>{" "}
            <span className="mx-1">•</span>
            {order.applicant || "N/A"}
          </p>
        </div>

        <div className="shrink-0 border-b border-[#E2E8F0] bg-white px-4 py-3 sm:px-5">
          <div className="-mx-1 overflow-x-auto px-1">
            <div className="flex min-w-max flex-wrap items-center gap-x-5 gap-y-2 text-[11px] sm:min-w-0">
            <MetaItem label="Ref #" value={order.orderRef || "—"} />

            <MetaItem
              label=""
              value={order.company?.name || order.provider || "N/A"}
              linkStyle
            />

            <MetaItem label="WCAB:" value={order.court || "N/A"} />
            </div>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[minmax(0,1fr)_200px]">
          {lockStatus === "error" ? (
            <p className="px-5 py-10 text-center text-[12px] font-medium text-red-500">
              {lockError || "Failed to start invoice editing"}
            </p>
          ) : !isContentReady || lockStatus === "checking" ? (
            <InvoiceModalLoadingBody message="Loading X-Ray invoice..." />
          ) : (
            <>
          <div className="min-h-0 overflow-y-auto px-4 py-4 sm:px-5">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <DateField
                label="X-Ray Invoice Date"
                name="xrayInvoiceDate"
                value={formData.xrayInvoiceDate}
                onChange={handleChange}
                error={errors.xrayInvoiceDate}
                disabled={fieldsReadOnly}
              />

              <DateField
                label="Exam Date"
                name="examDate"
                value={formData.examDate}
                onChange={handleChange}
                error={errors.examDate}
                disabled={fieldsReadOnly}
              />
            </div>

            <SectionTitle title="Views" />

            <div className="rounded-[8px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-3">
              <div className="grid grid-cols-1 items-center gap-3 sm:grid-cols-[90px_auto_1fr]">
                <input
                  type="text"
                  inputMode="numeric"
                  name="views"
                  value={formData.views}
                  onChange={handleViewsChange}
                  disabled={fieldsReadOnly}
                  className={`h-[34px] rounded-[6px] border px-3 text-center text-[12px] text-[#111827] outline-none focus:ring-2 ${
                    fieldsReadOnly
                      ? "cursor-not-allowed border-[#E2E8F0] bg-[#F8FAFC] text-[#64748B]"
                      : "bg-white"
                  } ${
                    errors.views
                      ? "border-red-500 focus:border-red-500 focus:ring-red-500/10"
                      : fieldsReadOnly
                        ? ""
                        : "border-[#CBD5E1] focus:border-[#0097B2] focus:ring-[#0097B2]/10"
                  }`}
                />

                <div className="flex items-center gap-2 text-[12px] text-[#475569]">
                  <span>×</span>

                  <div className="relative w-[92px]">
                    <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-[#94A3B8]">
                      $
                    </span>

                    <input
                      type="text"
                      inputMode="decimal"
                      name="perViewAmount"
                      value={formData.perViewAmount}
                      onChange={handleMoneyChange}
                      disabled={fieldsReadOnly}
                      className={`h-[34px] w-full rounded-[6px] border pl-6 pr-2 text-[12px] text-[#111827] outline-none focus:ring-2 ${
                        fieldsReadOnly
                          ? "cursor-not-allowed border-[#E2E8F0] bg-[#F8FAFC] text-[#64748B]"
                          : "border-[#CBD5E1] bg-white focus:border-[#0097B2] focus:ring-[#0097B2]/10"
                      }`}
                    />
                  </div>

                  <span>/ view</span>
                </div>

                <div className="text-right text-[13px] font-semibold text-[#111827] sm:text-left">
                  = {formatMoney(viewsAmount)}
                </div>
              </div>

              {(errors.views || errors.perViewAmount) && (
                <p className="mt-2 text-[11px] text-red-500">
                  {errors.views || errors.perViewAmount}
                </p>
              )}
            </div>

            <div className="mt-4">
              <label className="mb-2 block text-[11px] font-semibold text-[#475569]">
                Description
              </label>

              <textarea
                name="description"
                value={formData.description}
                onChange={handleChange}
                placeholder="Add a note or description..."
                rows={4}
                disabled={fieldsReadOnly}
                className={`h-[74px] w-full resize-none rounded-[6px] border px-3 py-2 text-[12px] text-[#111827] outline-none placeholder:text-[#94A3B8] focus:ring-2 ${
                  fieldsReadOnly
                    ? "cursor-not-allowed border-[#E2E8F0] bg-[#F8FAFC] text-[#64748B]"
                    : "border-[#CBD5E1] bg-white focus:border-[#0097B2] focus:ring-[#0097B2]/10"
                }`}
              />
            </div>
          </div>

          <aside className="flex min-h-[220px] flex-col border-t border-[#E2E8F0] bg-[#F8FAFC] px-4 py-4 md:border-l md:border-t-0">
            <h3 className="mb-4 text-[12px] font-semibold text-[#334155]">
              Summary
            </h3>

            <div className="space-y-3">
              <SummaryRow
                label={`Views (${toNumber(formData.views)})`}
                value={formatMoney(viewsAmount)}
              />

              <SummaryRow
                label="X-Ray Paid Earlier"
                value={`-${formatMoney(toNumber(formData.xrayPaidEarlier))}`}
                danger
              />

              {formData.checkNumber ? (
                <p className="text-[10px] font-semibold text-[#059669]">
                  ✓ CHK #{formData.checkNumber}
                </p>
              ) : null}
            </div>

            <div className="mt-5 space-y-3">
              <SummaryRow
                label="Total Invoiced"
                value={formatMoney(totalInvoiced)}
                danger={totalInvoiced < 0}
              />

              {toNumber(formData.writeoffAmount) > 0 ? (
                <SummaryRow
                  label="Written Off"
                  value={`-${formatMoney(toNumber(formData.writeoffAmount))}`}
                  danger
                />
              ) : null}

              <div className="rounded-[8px] border border-[#E2E8F0] bg-white px-3 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[12px] font-semibold text-[#111827]">
                    Balance Due
                  </span>

                  <span
                    className={`text-[13px] font-bold ${
                      balanceDue < 0 ? "text-red-500" : "text-[#007F96]"
                    }`}
                  >
                    {formatMoney(balanceDue)}
                  </span>
                </div>
              </div>
            </div>

            <div className="mt-auto pt-6">
              {submitError && (
                <p className="mb-3 text-center text-[11px] text-red-500">
                  {submitError}
                </p>
              )}

              <button
                type="button"
                onClick={handleSubmit}
                disabled={
                  submitting || (isEditing && isFormInvalid)
                }
                className="h-[36px] w-full rounded-[7px] bg-[#111827] px-4 text-[12px] font-semibold text-white hover:bg-[#1F2937] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? "Saving..." : submitLabel}
              </button>

              <button
                type="button"
                onClick={onClose}
                className="mt-3 h-[30px] w-full rounded-[6px] text-[12px] font-semibold text-[#94A3B8] hover:bg-[#E2E8F0] hover:text-[#475569]"
              >
                Cancel
              </button>
            </div>
          </aside>
            </>
          )}
        </div>
      </section>
      <AlertModal
        open={invoiceLockBlocked}
        variant="error"
        title="Invoice is being edited"
        message={ORDER_INVOICE_EDIT_LOCK_MESSAGE}
        confirmLabel="OK"
        onClose={handleLockDismiss}
      />
    </div>,
    document.body
  );
}

function orderIndicatesExistingXrayInvoice(order) {
  return Boolean(order?.invoice?.hasXray);
}

function InvoiceModalLoadingBody({ message = "Loading invoice..." }) {
  return (
    <div className="col-span-full flex min-h-[320px] flex-1 flex-col items-center justify-center gap-3 px-4 py-12">
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-[#CBD5E1] border-t-[#0097B2]"
        aria-hidden="true"
      />
      <p className="text-[12px] font-medium text-[#64748B]">{message}</p>
    </div>
  );
}

function MetaItem({ label, value, linkStyle = false }) {
  return (
    <p className="text-[#64748B]">
      {label && <span className="mr-1">{label}</span>}

      <span
        className={`font-semibold ${
          linkStyle ? "text-[#007F96]" : "text-[#334155]"
        }`}
      >
        {value}
      </span>
    </p>
  );
}

function SectionTitle({ title }) {
  return (
    <h3 className="mb-2 mt-4 text-[11px] font-semibold text-[#64748B]">
      {title}
    </h3>
  );
}

function DateField({ label, name, value, onChange, error = "", disabled = false }) {
  return (
    <div>
      <label className="mb-2 block text-[11px] font-semibold text-[#475569]">
        {label}
      </label>

      <input
        type="date"
        name={name}
        value={value}
        onChange={onChange}
        disabled={disabled}
        className={`h-[34px] w-full rounded-[6px] border px-3 text-[12px] text-[#111827] outline-none focus:ring-2 ${
          disabled
            ? "cursor-not-allowed border-[#E2E8F0] bg-[#F8FAFC] text-[#64748B]"
            : "bg-white"
        } ${
          error
            ? "border-red-500 focus:border-red-500 focus:ring-red-500/10"
            : disabled
              ? ""
              : "border-[#CBD5E1] focus:border-[#0097B2] focus:ring-[#0097B2]/10"
        }`}
      />

      {error && <p className="mt-1 text-[11px] text-red-500">{error}</p>}
    </div>
  );
}

function SummaryRow({ label, value, danger = false }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[10px] text-[#64748B]">{label}</span>

      <span
        className={`text-[11px] font-semibold ${
          danger ? "text-red-500" : "text-[#334155]"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function validateXrayInvoiceForm(data) {
  const errors = {};

  if (!data.xrayInvoiceDate) {
    errors.xrayInvoiceDate = "X-Ray invoice date is required";
  }

  if (data.views === "") {
    errors.views = "View count is required";
  } else if (Number(data.views) < 0) {
    errors.views = "Enter a valid view count (0 or greater)";
  }

  if (data.perViewAmount === "") {
    errors.perViewAmount = "Per view amount is required";
  } else if (Number.isNaN(Number(data.perViewAmount))) {
    errors.perViewAmount = "Enter a valid per view amount";
  }

  const descriptionError = validateNoHtmlMarkup(data.description, {
    fieldLabel: "Description",
  });
  if (descriptionError) errors.description = descriptionError;

  return errors;
}

function resolveXrayInvoicePageCount(orderData = {}) {
  const total = Number(orderData?.records?.xrayInvoicePageCount);
  if (Number.isFinite(total) && total >= 0) {
    return Math.floor(total);
  }

  const rows = [
    ...(Array.isArray(orderData?.records?.orderRecords)
      ? orderData.records.orderRecords
      : []),
    ...(Array.isArray(orderData?.orderRecords) ? orderData.orderRecords : []),
  ];

  return rows.reduce((sum, record) => {
    if (!record?.hasFile) return sum;
    if (`${record.recordType || ""}`.toLowerCase() !== "xrays") return sum;
    const pages = Number(record.pageCount);
    if (!Number.isFinite(pages) || pages < 0) return sum;
    return sum + Math.floor(pages);
  }, 0);
}

function toNumber(value) {
  const number = Number(value);
  return Number.isNaN(number) ? 0 : number;
}

function formatMoney(value) {
  const absoluteValue = Math.abs(Number(value));

  const money = `$${absoluteValue.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

  return Number(value) < 0 ? `-${money}` : money;
}