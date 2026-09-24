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
import {
  createInvoice,
  getInvoice,
  updateInvoice,
} from "@/lib/invoices/invoiceApi";
import {
  buildPaymentLinesFromOrder,
  extractFacilitySearchFeeFromNotes,
  formatMoneyAmount,
  formatPaidBracket,
  getPaymentLineAmount,
  isQuickRecordsFeeInvoice,
  mapDueFormToInvoiceFees,
  mapInvoiceFeesToDueForm,
  PAYMENT_CHARGE_AMOUNTS,
  QUICK_RECORDS_FEE,
  REQUEST_TOTAL_WITH_RECORDS_FEE,
  resolveFullFeeAmounts,
  resolvePersonalPortalInvoiceAmounts,
  resolvePersistedInvoiceAmounts,
} from "@/lib/orders/paymentUtils";
import {
  calculateOrderRushLevel,
} from "@/lib/orders/rushUtils";
import { getOrder } from "@/lib/orders/orderApi";
import { getTodayInputDate } from "@/lib/utils/dateUtils";
import {
  applyApiFieldErrors,
  getApiErrorMessage,
  hasValidationErrors,
  shouldShowSubmitError,
} from "@/lib/apiErrorUtils";
import { validateNoHtmlMarkup } from "@/lib/validations/nameValidation";

const initialFormData = {
  invoiceDate: "",
  storageFee: "0.00",
  pages: "0",
  perPageAmount: "0.00",
  clericalTimeHours: "0",
  clericalHourlyRate: "0.00",
  shippingHandling: "0.00",
  notes: "",
  sendOrderDetails: false,
  rushOrder: false,
};

export default function CreateInvoiceModal({
  isOpen,
  order,
  onClose,
  onSaved,
  mode = "create",
  returnToPath = "",
}) {
  const router = useRouter();
  const pathname = usePathname();
  const mounted = useIsClient();
  const isEditMode = mode === "edit";
  const listBackHref = returnToPath || pathname || "/orders";

  const [formData, setFormData] = useState(initialFormData);
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [successMessage, setSuccessMessage] = useState("");
  const [isContentReady, setIsContentReady] = useState(false);
  const [paymentLines, setPaymentLines] = useState([]);
  const [prepaymentAmount, setPrepaymentAmount] = useState("0.00");
  const [loadedPrepaymentAmount, setLoadedPrepaymentAmount] = useState(0);
  const [rushLevel, setRushLevel] = useState(null);
  const [persistedInvoiceMeta, setPersistedInvoiceMeta] = useState(null);
  const [quickRecordsFee, setQuickRecordsFee] = useState(false);
  const [savedDetailedFees, setSavedDetailedFees] = useState(null);
  const [pendingFacilitySearchFee, setPendingFacilitySearchFee] = useState(0);
  const [isEditing, setIsEditing] = useState(!isEditMode);
  const [invoiceReloadKey, setInvoiceReloadKey] = useState(0);
  const [invoiceLockBlocked, setInvoiceLockBlocked] = useState(false);

  const lockOrderId = isOpen && order?.dbId ? order.dbId : null;
  const { status: lockStatus, error: lockError } = useOrderInvoiceEditLock(
    lockOrderId,
    "regular"
  );

  const openSession =
    isOpen && order ? `${order.id || order.orderNo}-${isEditMode}` : null;
  const [prevOpenSession, setPrevOpenSession] = useState(null);

  if (openSession !== prevOpenSession) {
    setPrevOpenSession(openSession);

    if (openSession) {
      setIsContentReady(false);
      const isCnr = Boolean(order?.certificateNoRecords);
      setFormData(getInitialInvoiceFormData(order, isEditMode, isCnr));
      setErrors({});
      setSubmitError("");
      setLoadError("");
      setSuccessMessage("");
      // CNR: fees locked at $0. Normal create: start detailed; user clicks $20 button.
      setQuickRecordsFee(
        isEditMode && !isCnr
          ? isQuickRecordsFeeInvoice(order?.invoice || {})
          : false
      );
      setSavedDetailedFees(null);
      setIsEditing(!isEditMode);
      setInvoiceLockBlocked(false);
    }
  }

  useEffect(() => {
    if (lockStatus === "blocked") {
      setInvoiceLockBlocked(true);
    }
  }, [lockStatus]);

  useEffect(() => {
    if (!isOpen) return;
    if (lockStatus !== "held") return;

    if (!order?.dbId) {
      setLoadError("Order not found");
      setIsContentReady(true);
      return;
    }

    let cancelled = false;

    async function loadInvoice() {
      setSubmitError("");
      setLoadError("");

      try {
        const orderData = await getOrder(order.dbId);

        if (cancelled) return;

        if (!orderData) {
          setLoadError("Order not found");
          return;
        }

        const derivedRushLevel = calculateOrderRushLevel(orderData.createdAt);
        setRushLevel(derivedRushLevel);
        setPendingFacilitySearchFee(
          !isEditMode
            ? toNumber(orderData.pendingFacilitySearchFee) ||
                toNumber(order?.pendingFacilitySearchFee) ||
                0
            : 0
        );
        const loadedPaymentLines = buildPaymentLinesFromOrder(orderData);
        setPaymentLines(loadedPaymentLines);
        const loadedPrepayment = getPaymentLineAmount(loadedPaymentLines, "prepayment");
        setLoadedPrepaymentAmount(loadedPrepayment);
        setPrepaymentAmount(
          loadedPrepayment > 0 ? loadedPrepayment.toFixed(2) : "0.00"
        );

        const invoiceId = order.invoiceId || order.invoice?.invoiceId;

        if (isEditMode && invoiceId) {
          const invoice = await getInvoice(invoiceId);
          if (cancelled) return;

          const mapped = mapInvoiceFeesToDueForm(mapInvoiceToFormData(invoice, order));
          const isCnr = Boolean(
            order.certificateNoRecords || orderData.certificateNoRecords
          );
          setFormData(
            isCnr
              ? {
                  ...mapped,
                  ...zeroInvoiceFeeFields(),
                  notes: mapped.notes || "",
                }
              : mapped
          );
          setPersistedInvoiceMeta({
            status: invoice.status,
            writeoffAmount: invoice.writeoffAmount || 0,
          });
          setRushLevel(invoice.rushLevel || derivedRushLevel);
          setQuickRecordsFee(!isCnr && isQuickRecordsFeeInvoice(invoice));
          setSavedDetailedFees(null);
          return;
        }

        const isCnr = Boolean(
          order.certificateNoRecords || orderData.certificateNoRecords
        );
        const suggestedPages = resolveRegularInvoicePageCount(orderData);
        setPersistedInvoiceMeta(null);
        setQuickRecordsFee(false);
        setSavedDetailedFees(null);
        setFormData({
          ...getInitialInvoiceFormData(order, isEditMode, isCnr),
          rushOrder: Boolean(derivedRushLevel),
          notes: "",
          ...(!isCnr ? { pages: String(suggestedPages) } : {}),
        });
      } catch (error) {
        if (!cancelled) {
          setLoadError(getApiErrorMessage(error, "Failed to load invoice"));
        }
      } finally {
        if (!cancelled) {
          setIsContentReady(true);
        }
      }
    }

    loadInvoice();

    return () => {
      cancelled = true;
    };
  }, [isOpen, order?.dbId, isEditMode, order?.invoiceId, order?.invoice?.invoiceId, invoiceReloadKey, lockStatus]);

  useEffect(() => {
    if (!openSession) {
      setPaymentLines([]);
      setPrepaymentAmount("0.00");
      setLoadedPrepaymentAmount(0);
      setRushLevel(null);
      setPendingFacilitySearchFee(0);
      setQuickRecordsFee(false);
      setSavedDetailedFees(null);
    }
  }, [openSession]);

  useEffect(() => {
    if (!isOpen) return;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [isOpen]);

  const pagesAmount = useMemo(() => {
    return toNumber(formData.pages) * toNumber(formData.perPageAmount);
  }, [formData.pages, formData.perPageAmount]);

  const clericalAmount = useMemo(() => {
    return (
      toNumber(formData.clericalTimeHours) * toNumber(formData.clericalHourlyRate)
    );
  }, [formData.clericalTimeHours, formData.clericalHourlyRate]);

  const fullFees = useMemo(() => {
    return resolveFullFeeAmounts(formData);
  }, [formData]);

  // Company / personal portal: $5 facility-search fee is auto-added into the
  // invoice total (once) when DMS located/added an unmatched facility.
  // Create: add pending fee on top of storage. Review/Edit: fee is already inside
  // storageFee — extract from notes for display only (do not add again to total).
  const billedFacilitySearchFee = useMemo(
    () => extractFacilitySearchFeeFromNotes(formData.notes),
    [formData.notes]
  );

  const pendingFacilityFeeAmount = useMemo(() => {
    if (isEditMode) return 0;
    return toNumber(
      pendingFacilitySearchFee || order?.pendingFacilitySearchFee || 0
    );
  }, [isEditMode, pendingFacilitySearchFee, order?.pendingFacilitySearchFee]);

  const facilitySearchFee = isEditMode
    ? billedFacilitySearchFee
    : pendingFacilityFeeAmount;

  const displayStorageFee = useMemo(() => {
    if (isEditMode && billedFacilitySearchFee > 0) {
      return Math.max(
        0,
        Number((fullFees.storageFee - billedFacilitySearchFee).toFixed(2))
      );
    }
    return fullFees.storageFee;
  }, [isEditMode, billedFacilitySearchFee, fullFees.storageFee]);

  const isPersonalPortalOrder =
    order?.creationSource === "personal_portal" ||
    order?.creation_source === "personal_portal";

  const totalAmount = useMemo(() => {
    return (
      pagesAmount +
      clericalAmount +
      toNumber(formData.shippingHandling) +
      fullFees.storageFee +
      // Only add pending fee on create — review already has it inside storageFee
      pendingFacilityFeeAmount
    );
  }, [
    formData,
    fullFees,
    pagesAmount,
    clericalAmount,
    pendingFacilityFeeAmount,
  ]);

  const prepaymentPaid = useMemo(() => {
    return toNumber(prepaymentAmount);
  }, [prepaymentAmount]);

  const personalPortalLineItemsTotal = useMemo(() => {
    const storageOnly =
      isEditMode && billedFacilitySearchFee > 0
        ? displayStorageFee
        : fullFees.storageFee;

    return (
      pagesAmount +
      clericalAmount +
      toNumber(formData.shippingHandling) +
      storageOnly
    );
  }, [
    isEditMode,
    billedFacilitySearchFee,
    displayStorageFee,
    fullFees.storageFee,
    pagesAmount,
    clericalAmount,
    formData.shippingHandling,
  ]);

  const personalPortalFinancials = useMemo(() => {
    if (!isPersonalPortalOrder) return null;

    return resolvePersonalPortalInvoiceAmounts({
      lineItemsTotal: personalPortalLineItemsTotal,
      facilityFee: facilitySearchFee,
      prepaymentPaid,
      writeoffAmount: persistedInvoiceMeta?.writeoffAmount || 0,
    });
  }, [
    isPersonalPortalOrder,
    personalPortalLineItemsTotal,
    facilitySearchFee,
    prepaymentPaid,
    persistedInvoiceMeta?.writeoffAmount,
  ]);

  // Flat $20 records fee is separate from the $15 witness prepayment — do not
  // credit prepayment against the records-fee invoice due.
  const amountPaid = useMemo(() => {
    if (isPersonalPortalOrder) {
      return personalPortalFinancials?.amountPaid ?? 0;
    }

    if (quickRecordsFee || isQuickRecordsFeeInvoice(formData)) {
      return 0;
    }

    return prepaymentPaid;
  }, [
    isPersonalPortalOrder,
    personalPortalFinancials,
    quickRecordsFee,
    formData,
    prepaymentPaid,
  ]);

  const invoiceTotals = useMemo(() => {
    if (isPersonalPortalOrder && personalPortalFinancials) {
      return resolvePersistedInvoiceAmounts(
        personalPortalFinancials.totalAmount,
        personalPortalFinancials.amountPaid,
        {
          writeoffAmount: persistedInvoiceMeta?.writeoffAmount || 0,
          persistedStatus: persistedInvoiceMeta?.status || null,
        }
      );
    }

    return resolvePersistedInvoiceAmounts(totalAmount, amountPaid, {
      writeoffAmount: persistedInvoiceMeta?.writeoffAmount || 0,
      persistedStatus: persistedInvoiceMeta?.status || null,
    });
  }, [
    isPersonalPortalOrder,
    personalPortalFinancials,
    totalAmount,
    amountPaid,
    persistedInvoiceMeta,
  ]);

  const invoiceIdForValidation =
    order?.invoiceId || order?.invoice?.invoiceId;
  const completingXrayOnlyStub =
    !isEditMode && invoiceIdForValidation && order?.invoice?.createOnly;
  const willCreateInvoice = !(
    (isEditMode || completingXrayOnlyStub) && invoiceIdForValidation
  );
  const isCnrOrder = Boolean(order?.certificateNoRecords);

  const clientValidationErrors = useMemo(() => {
    const displayedTotal = isPersonalPortalOrder
      ? (personalPortalFinancials?.totalAmount ?? totalAmount)
      : totalAmount;

    return validateInvoiceForm(formData, {
      // CNR invoices may be $0 (only the prior $15 witness fee applies).
      // Personal unmatched-facility invoices may be the $5 search fee only.
      requirePositiveTotal: willCreateInvoice && !isCnrOrder,
      facilitySearchFee: pendingFacilityFeeAmount,
      computedTotal: displayedTotal,
    });
  }, [
    formData,
    willCreateInvoice,
    isCnrOrder,
    pendingFacilityFeeAmount,
    isPersonalPortalOrder,
    personalPortalFinancials,
    totalAmount,
  ]);
  const isFormInvalid = hasValidationErrors(clientValidationErrors);

  const { amountDue, overpayment, status: invoiceStatus, isOverpaid } =
    invoiceTotals;

  const feesLocked = isCnrOrder || quickRecordsFee;
  const fieldsReadOnly = isEditMode && !isEditing;
  const canToggleQuickRecordsFee = !isCnrOrder && !fieldsReadOnly;
  const isQuickMode =
    !isCnrOrder && (quickRecordsFee || isQuickRecordsFeeInvoice(formData));
  const witnessFeeRequired = PAYMENT_CHARGE_AMOUNTS.prepayment;
  const witnessFeeShortfall = Math.max(0, witnessFeeRequired - prepaymentPaid);
  const prepaymentDueForCnr = isCnrOrder ? witnessFeeShortfall : 0;
  // $20 quick records fee (+ unpaid witness when applicable) + any pending
  // facility search fee — facility fee always stacks onto records/other fees.
  const quickWitnessDue = isPersonalPortalOrder
    ? 0
    : Math.max(0, witnessFeeRequired - loadedPrepaymentAmount);
  const quickCollectTotal = isQuickMode
    ? QUICK_RECORDS_FEE + quickWitnessDue + pendingFacilityFeeAmount
    : null;
  const requestTotalDisplay = isQuickMode
    ? isPersonalPortalOrder
      ? QUICK_RECORDS_FEE + pendingFacilityFeeAmount
      : REQUEST_TOTAL_WITH_RECORDS_FEE + pendingFacilityFeeAmount
    : null;
  const writeoffAmt = Number(persistedInvoiceMeta?.writeoffAmount) || 0;
  // Quick/CNR Due paths are computed from fee rules and must still net write-offs
  // (detailed mode already uses amountDue which includes writeoffAmount).
  const displayDue = isPersonalPortalOrder
    ? (personalPortalFinancials?.amountDue ?? 0)
    : isCnrOrder
      ? Math.max(0, prepaymentDueForCnr - writeoffAmt)
      : isQuickMode
        ? Math.max(0, quickCollectTotal - writeoffAmt)
        : amountDue;

  if (!mounted || !isOpen || !order) return null;

  const modalTitle = !isContentReady
    ? isEditMode
      ? "Edit Invoice"
      : "Invoice"
    : isEditMode
      ? "Edit Invoice"
      : "Create Invoice";
  const submitLabel = isEditMode
    ? isEditing
      ? "Save Invoice"
      : "Edit Invoice"
    : "Create Invoice";

  const clearValidationFeedback = (...fields) => {
    setErrors((prev) => {
      const next = { ...prev, totalAmount: "" };

      fields.forEach((field) => {
        next[field] = "";
      });

      return next;
    });
    setSubmitError("");
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;

    setFormData((prev) => ({
      ...prev,
      [name]: type === "checkbox" ? checked : value,
    }));

    clearValidationFeedback(name);
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

    clearValidationFeedback(name);
  };

  const handlePagesChange = (e) => {
    const { value } = e.target;
    const cleanValue = value.replace(/\D/g, "");

    setFormData((prev) => ({
      ...prev,
      pages: cleanValue,
    }));

    clearValidationFeedback("pages");
  };

  const handleClericalHoursChange = (e) => {
    const { value } = e.target;
    const cleanValue = value
      .replace(/[^\d.]/g, "")
      .replace(/(\..*)\./g, "$1")
      .replace(/^(\d*\.\d{0,2}).*$/, "$1");

    setFormData((prev) => ({
      ...prev,
      clericalTimeHours: cleanValue,
    }));

    clearValidationFeedback("clericalTimeHours");
  };

  const handleQuickRecordsFeeToggle = () => {
    if (!canToggleQuickRecordsFee) return;

    clearValidationFeedback(
      "storageFee",
      "pages",
      "perPageAmount",
      "clericalTimeHours",
      "clericalHourlyRate",
      "shippingHandling",
      "totalAmount",
      "prepaymentAmount"
    );

    if (quickRecordsFee) {
      setQuickRecordsFee(false);
      setFormData((prev) => ({
        ...prev,
        ...(savedDetailedFees || {
          storageFee: "0.00",
          pages: "0",
          perPageAmount: "0.00",
          clericalTimeHours: "0",
          clericalHourlyRate: "0.00",
          shippingHandling: "0.00",
        }),
      }));
      setSavedDetailedFees(null);
      return;
    }

    setSavedDetailedFees({
      storageFee: formData.storageFee,
      pages: formData.pages,
      perPageAmount: formData.perPageAmount,
      clericalTimeHours: formData.clericalTimeHours,
      clericalHourlyRate: formData.clericalHourlyRate,
      shippingHandling: formData.shippingHandling,
    });
    setQuickRecordsFee(true);
    setFormData((prev) => applyQuickRecordsFeeFields(prev));
  };

  const handleSubmit = async () => {
    if (isEditMode && !isEditing) {
      setIsEditing(true);
      setSubmitError("");
      setErrors({});
      return;
    }

    const invoiceId = order.invoiceId || order.invoice?.invoiceId;
    const completingXrayOnlyStub =
      !isEditMode && invoiceId && order.invoice?.createOnly;
    const willCreate = !((isEditMode || completingXrayOnlyStub) && invoiceId);

    const displayedTotal = isPersonalPortalOrder
      ? (personalPortalFinancials?.totalAmount ?? totalAmount)
      : totalAmount;

    const validationErrors = validateInvoiceForm(formData, {
      requirePositiveTotal: willCreate && !isCnrOrder,
      facilitySearchFee: pendingFacilityFeeAmount,
      computedTotal: displayedTotal,
    });

    setErrors(validationErrors);
    setSubmitError("");

    if (Object.keys(validationErrors).length > 0) return;
    if (lockStatus !== "held") return;

    const feePayload = mapDueFormToInvoiceFees(formData);

    const payload = {
      orderId: order.dbId,
      activeType: isEditMode ? "Edit Invoice" : "Create Invoice",
      ...feePayload,
      pagesAmount,
      clericalAmount,
      totalAmount,
      // Prepayment is managed on the order — do not overwrite from invoice.
    };

    setSubmitting(true);
    setSubmitError("");
    setSuccessMessage("");

    try {
      if ((isEditMode || completingXrayOnlyStub) && invoiceId) {
        await updateInvoice(invoiceId, payload);
      } else {
        await createInvoice(payload);
      }

      onSaved?.();

      if (!isEditMode) {
        setSuccessMessage(
          "Custodian invoice was generated successfully."
        );
        window.setTimeout(() => {
          onClose();
        }, 1400);
      } else {
        setIsEditing(false);
        setIsContentReady(false);
        setInvoiceReloadKey((prev) => prev + 1);
      }
    } catch (error) {
      if (Number(error?.status) === 409) {
        setInvoiceLockBlocked(true);
        return;
      }

      const { fieldErrors, errorMessage } = resolveInvoiceSubmitError(error);

      if (Object.keys(fieldErrors).length > 0) {
        setErrors((prev) => ({ ...prev, ...fieldErrors }));
      }

      if (isOrderMissingError(errorMessage)) {
        setLoadError(errorMessage);
        setSubmitError("");
      } else {
        setSubmitError(errorMessage);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleLockDismiss = () => {
    onClose?.();
    router.push(listBackHref);
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-end justify-center overflow-y-auto bg-black/50 p-0 backdrop-blur-[2px] sm:items-center sm:p-4 sm:py-6">
      <section
        className={`flex h-[100dvh] max-h-[100dvh] w-full max-w-[880px] min-h-0 flex-col overflow-hidden rounded-t-[12px] bg-white shadow-2xl sm:h-auto sm:max-h-[calc(100dvh-42px)] sm:rounded-[10px] ${
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

        {!isContentReady || lockStatus === "checking" ? (
          <InvoiceModalLoadingBody message="Loading invoice..." />
        ) : lockStatus === "error" || loadError ? (
          <InvoiceModalErrorBody message={loadError || lockError} />
        ) : (
          <>
        <div className="shrink-0 border-b border-[#E2E8F0] bg-white px-4 py-3 sm:px-5">
          <div className="-mx-1 overflow-x-auto px-1">
            <div className="flex min-w-max flex-wrap items-center gap-x-5 gap-y-2 text-[11px] sm:min-w-0">
            <MetaItem label="# ID" value={order.id || order.orderNo} />
            <MetaItem
              label=""
              value={order.company?.name || order.provider || "N/A"}
              linkStyle
            />

            <MetaItem
              label="Invoiced"
              value={formatMoney(
                isPersonalPortalOrder
                  ? (personalPortalFinancials?.totalAmount ?? totalAmount)
                  : isCnrOrder
                    ? PAYMENT_CHARGE_AMOUNTS.prepayment
                    : isQuickMode
                      ? requestTotalDisplay
                      : totalAmount
              )}
            />
            <MetaItem
              label="Paid"
              value={formatMoney(
                isCnrOrder || (isQuickMode && !isPersonalPortalOrder)
                  ? prepaymentPaid
                  : amountPaid
              )}
            />
            <MetaItem label="Due" value={formatMoney(displayDue)} />
            {persistedInvoiceMeta?.writeoffAmount > 0 && (
              <MetaItem
                label="Written Off"
                value={formatMoney(persistedInvoiceMeta.writeoffAmount)}
              />
            )}
            {isOverpaid && (
              <MetaItem label="Credit" value={formatMoney(overpayment)} />
            )}
            <MetaItem label="Status" value={invoiceStatus} />
            {rushLevel && <MetaItem label="Rush Level" value={rushLevel} />}
            </div>
          </div>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_200px] md:overflow-hidden">
          <div className="min-h-0 px-4 py-4 sm:px-5 md:overflow-y-auto">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <DateField
                label="Invoice Date"
                name="invoiceDate"
                value={formData.invoiceDate}
                onChange={handleChange}
                error={errors.invoiceDate}
                disabled={fieldsReadOnly || (isCnrOrder && isEditMode)}
              />
            </div>

            <SectionTitle title="Fees" />

            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-[8px] border border-[#D0E8ED] bg-[#F0FAFC] px-3 py-2.5">
              <p className="text-[12px] font-semibold text-[#0B7C8E]">
                {isCnrOrder
                  ? "CNR — $15 witness fee  (Prepayment) only"
                  : `Records fee $${QUICK_RECORDS_FEE.toFixed(2)}`}
              </p>
              {canToggleQuickRecordsFee ? (
                <button
                  type="button"
                  onClick={handleQuickRecordsFeeToggle}
                  disabled={submitting}
                  className={`inline-flex h-[32px] shrink-0 items-center justify-center rounded-[7px] px-3 text-[12px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
                    quickRecordsFee
                      ? "border border-[#0B7C8E] bg-white text-[#0B7C8E] hover:bg-[#E6F7FA]"
                      : "bg-[#0097B2] text-white hover:bg-[#0086A0]"
                  }`}
                >
                  {quickRecordsFee
                    ? "Use detailed"
                    : `Apply $${QUICK_RECORDS_FEE.toFixed(2)}`}
                </button>
              ) : (
                <span className="text-[11px] font-medium text-[#64748B]">
                  Locked
                </span>
              )}
            </div>

            <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <ReadOnlyMoneyField
                label="Prepayment"
                value={loadedPrepaymentAmount}
                paymentHint={formatPaidBracket(witnessFeeRequired)}
                error={errors.prepaymentAmount}
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <MoneyField
                label={feesLocked ? "Records Fee" : "Storage Fee"}
                name="storageFee"
                value={formData.storageFee}
                onChange={handleMoneyChange}
                error={errors.storageFee}
                disabled={feesLocked || fieldsReadOnly}
              />
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <NumberField
                label="Pages"
                name="pages"
                value={formData.pages}
                onChange={handlePagesChange}
                error={errors.pages}
                disabled={feesLocked || fieldsReadOnly}
              />

              <MoneyField
                label="Per Page Amount"
                name="perPageAmount"
                value={formData.perPageAmount}
                onChange={handleMoneyChange}
                error={errors.perPageAmount}
                disabled={feesLocked || fieldsReadOnly}
              />

              <ReadOnlyMoneyField label="Pages Amount" value={pagesAmount} />
            </div>

            <SectionTitle title="Clerical Time" />

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <NumberField
                label="Clerical Time (Hours)"
                name="clericalTimeHours"
                value={formData.clericalTimeHours}
                onChange={handleClericalHoursChange}
                error={errors.clericalTimeHours}
                disabled={feesLocked || fieldsReadOnly}
              />

              <MoneyField
                label="Per Hour Charge"
                name="clericalHourlyRate"
                value={formData.clericalHourlyRate}
                onChange={handleMoneyChange}
                error={errors.clericalHourlyRate}
                disabled={feesLocked || fieldsReadOnly}
              />

              <ReadOnlyMoneyField
                label="Clerical Time Charge"
                value={clericalAmount}
              />
            </div>

            <SectionTitle title="Shipping & Handling" />

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <MoneyField
                label="Shipping & Handling Fee"
                name="shippingHandling"
                value={formData.shippingHandling}
                onChange={handleMoneyChange}
                error={errors.shippingHandling}
                disabled={feesLocked || fieldsReadOnly}
              />
            </div>

            <div className="mt-3">
              <label className="mb-2 block text-[11px] font-semibold text-[#475569]">
                Notes
              </label>

              <textarea
                name="notes"
                value={formData.notes}
                onChange={handleChange}
                placeholder="Invoice notes..."
                rows={2}
                disabled={fieldsReadOnly}
                className={`h-[52px] w-full resize-none rounded-[6px] border px-3 py-2 text-[12px] text-[#111827] outline-none placeholder:text-[#94A3B8] focus:ring-2 ${
                  fieldsReadOnly
                    ? "cursor-not-allowed border-[#E2E8F0] bg-[#F8FAFC] text-[#64748B]"
                    : "border-[#CBD5E1] bg-white focus:border-[#0097B2] focus:ring-[#0097B2]/10"
                }`}
              />
            </div>

            <div className="mt-4 space-y-3">
              <div className="flex flex-wrap items-center gap-5">
                <CheckboxField
                  label="Send Order Details"
                  name="sendOrderDetails"
                  checked={formData.sendOrderDetails}
                  onChange={handleChange}
                  disabled={fieldsReadOnly}
                />

                <CheckboxField
                  label="Rush Order"
                  name="rushOrder"
                  checked={formData.rushOrder}
                  onChange={handleChange}
                  disabled={fieldsReadOnly}
                />
              </div>

              
            </div>
          </div>

          <aside className="flex min-h-[210px] shrink-0 flex-col border-t border-[#E2E8F0] bg-[#F8FAFC] px-4 py-4 md:min-h-0 md:overflow-y-auto md:border-l md:border-t-0 md:px-4">
            <h3 className="mb-4 text-[12px] font-semibold text-[#334155]">
              Summary
            </h3>

            <div className="space-y-3">
              {requestTotalDisplay != null && !isPersonalPortalOrder ? (
                <SummaryRow
                  label={
                    facilitySearchFee > 0
                      ? "Total ($15 + $20 + facility)"
                      : "Total ($15 + $20)"
                  }
                  value={formatMoney(requestTotalDisplay)}
                />
              ) : null}
              <SummaryRow
                label={
                  quickRecordsFee || isQuickRecordsFeeInvoice(formData)
                    ? "Records Fee"
                    : "Storage Fee"
                }
                value={formatMoney(displayStorageFee)}
              />
              <SummaryRow label="Pages" value={formatMoney(pagesAmount)} />
              <SummaryRow
                label="Clerical Time"
                value={formatMoney(clericalAmount)}
              />
              <SummaryRow
                label="Shipping & Handling"
                value={formatMoney(toNumber(formData.shippingHandling))}
              />
              {facilitySearchFee > 0 && (
                <SummaryRow
                  label="Facility Search Fee"
                  value={formatMoney(facilitySearchFee)}
                />
              )}
            </div>
            {facilitySearchFee > 0 && (
              <p className="mt-2 rounded-[8px] border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-700">
                {isEditMode
                  ? `This invoice includes a $${facilitySearchFee.toFixed(2)} facility search fee${
                      isPersonalPortalOrder
                        ? " for the personal request unmatched facility."
                        : " for the external company new-facility search."
                    }`
                  : `A $${facilitySearchFee.toFixed(2)} facility search fee is added${
                      isPersonalPortalOrder
                        ? " for this personal request unmatched facility."
                        : " for this external company new-facility search."
                    }`}
              </p>
            )}

            <div className="mt-4 space-y-3 border-t border-[#E2E8F0] pt-4">
              <SummaryRow
                label="Invoice total"
                value={formatMoney(
                  isPersonalPortalOrder
                    ? (personalPortalFinancials?.totalAmount ?? totalAmount)
                    : isQuickMode
                      ? quickCollectTotal
                      : totalAmount
                )}
              />
              {isCnrOrder ? (
                <>
                  <SummaryRow
                    label={`Prepayment ${formatPaidBracket(PAYMENT_CHARGE_AMOUNTS.prepayment)}`}
                    value={formatMoney(prepaymentPaid)}
                    muted={prepaymentDueForCnr <= 0}
                  />
                  {prepaymentDueForCnr > 0 ? (
                    <SummaryRow
                      label="Due"
                      value={formatMoney(prepaymentDueForCnr)}
                    />
                  ) : (
                    <SummaryRow
                      label="Paid"
                      value={formatMoney(prepaymentPaid)}
                      muted
                    />
                  )}
                </>
              ) : isQuickMode ? (
                <>
                  {!isPersonalPortalOrder ? (
                    <SummaryRow
                      label={`Prepayment ${formatPaidBracket(witnessFeeRequired)}`}
                      value={formatMoney(loadedPrepaymentAmount)}
                      muted={loadedPrepaymentAmount >= witnessFeeRequired}
                    />
                  ) : personalPortalFinancials?.prepaymentCredit > 0 ? (
                    <SummaryRow
                      label="Prepayment"
                      value={`-${formatMoney(personalPortalFinancials.prepaymentCredit)}`}
                      muted
                    />
                  ) : null}
                  <SummaryRow
                    label="Records fee"
                    value={formatMoney(QUICK_RECORDS_FEE)}
                  />
                  {facilitySearchFee > 0 ? (
                    <SummaryRow
                      label="Facility Search Fee"
                      value={formatMoney(facilitySearchFee)}
                    />
                  ) : null}
                </>
              ) : (
                (isPersonalPortalOrder
                  ? (personalPortalFinancials?.prepaymentCredit ?? 0) > 0
                  : prepaymentPaid > 0) && (
                  <SummaryRow
                    label="Prepayment"
                    value={`-${formatMoney(
                      isPersonalPortalOrder
                        ? personalPortalFinancials.prepaymentCredit
                        : prepaymentPaid
                    )}`}
                    muted
                  />
                )
              )}
              {persistedInvoiceMeta?.writeoffAmount > 0 && (
                <SummaryRow
                  label="Written Off"
                  value={`-${formatMoney(persistedInvoiceMeta.writeoffAmount)}`}
                  muted
                />
              )}
              <SummaryRow
                label="Due"
                value={formatMoney(displayDue)}
                highlight={displayDue <= 0}
                unpaid={displayDue > 0}
              />
              {isOverpaid && !isCnrOrder && !isQuickMode && (
                <SummaryRow
                  label="Credit"
                  value={formatMoney(overpayment)}
                  highlight
                />
              )}
            </div>

            <div className="mt-5 rounded-[8px] border border-[#E2E8F0] bg-white px-3 py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[12px] font-semibold text-[#111827]">
                  Total
                </span>

                <span className="text-[15px] font-bold text-[#007F96]">
                  {formatMoney(displayDue)}
                </span>
              </div>
              {(errors.totalAmount || clientValidationErrors.totalAmount) && (
                <p className="mt-2 text-[11px] text-red-500">
                  {errors.totalAmount || clientValidationErrors.totalAmount}
                </p>
              )}
            </div>

            <div className="mt-auto pt-6">
              {submitError ? (
                <InvoiceModalBannerError message={submitError} />
              ) : null}

              {successMessage ? (
                <p className="mb-3 rounded-[6px] border border-[#86EFAC] bg-[#ECFDF5] px-3 py-2 text-[11px] font-medium text-[#059669]">
                  {successMessage}
                </p>
              ) : null}

              <button
                type="button"
                onClick={handleSubmit}
                disabled={
                  submitting ||
                  (isEditing && isFormInvalid) ||
                  Boolean(successMessage)
                }
                className="inline-flex h-[36px] w-full items-center justify-center rounded-[7px] bg-[#111827] px-4 text-[12px] font-semibold leading-none text-white hover:bg-[#1F2937] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? "Saving..." : submitLabel}
              </button>

              <button
                type="button"
                onClick={onClose}
                disabled={Boolean(successMessage)}
                className="mt-3 inline-flex h-[30px] w-full items-center justify-center rounded-[6px] text-[12px] font-semibold leading-none text-[#94A3B8] hover:bg-[#E2E8F0] hover:text-[#475569] disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
            </div>
          </aside>
        </div>
          </>
        )}
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

function InvoiceModalLoadingBody({ message = "Loading invoice..." }) {
  return (
    <div className="flex min-h-[360px] flex-1 flex-col items-center justify-center gap-3 px-4 py-12">
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-[#CBD5E1] border-t-[#0097B2]"
        aria-hidden="true"
      />
      <p className="text-[12px] font-medium text-[#64748B]">{message}</p>
    </div>
  );
}

function InvoiceModalErrorBody({ message = "Something went wrong" }) {
  return (
    <div className="flex min-h-[360px] flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rounded-[10px] border border-[#FEE2E2] bg-[#FEF2F2] px-6 py-10">
        <p className="w-full text-center text-[15px] font-semibold leading-snug text-red-500">
          {message}
        </p>
      </div>
    </div>
  );
}

function InvoiceModalBannerError({ message }) {
  return (
    <div className="mb-3 w-full rounded-[6px] border border-[#FEE2E2] bg-[#FEF2F2] px-3 py-3">
      <p className="w-full text-center text-[14px] font-semibold leading-snug text-red-500">
        {message}
      </p>
    </div>
  );
}

function isOrderMissingError(message = "") {
  return /order not found/i.test(`${message || ""}`.trim());
}

function resolveInvoiceSubmitError(error) {
  const { fieldErrors, message } = applyApiFieldErrors(error);
  const fallback = getApiErrorMessage(error, "Failed to save invoice");
  const errorMessage =
    message || (shouldShowSubmitError(fallback, fieldErrors) ? fallback : "");

  return { fieldErrors, errorMessage };
}

function zeroInvoiceFeeFields() {
  return {
    storageFee: "0.00",
    pages: "0",
    perPageAmount: "0.00",
    clericalTimeHours: "0",
    clericalHourlyRate: "0.00",
    shippingHandling: "0.00",
  };
}

function applyQuickRecordsFeeFields(form = {}) {
  return {
    ...form,
    storageFee: QUICK_RECORDS_FEE.toFixed(2),
    pages: "0",
    perPageAmount: "0.00",
    clericalTimeHours: "0",
    clericalHourlyRate: "0.00",
    shippingHandling: "0.00",
  };
}

function getInitialInvoiceFormData(order, isEditMode, isCnr = false) {
  if (!isEditMode) {
    const base = {
      ...initialFormData,
      invoiceDate: getTodayInputDate(),
    };

    // CNR: no records fee — only the prior $15 witness/prepayment applies.
    if (isCnr || order?.certificateNoRecords) {
      return { ...base, ...zeroInvoiceFeeFields() };
    }

    return base;
  }

  const invoice = order?.invoice || {};

  return {
    ...initialFormData,
    invoiceDate: toDateInput(invoice.date) || initialFormData.invoiceDate,
    storageFee: invoice.storageFee || invoice.other || "0.00",
    pages: invoice.pages || "0",
    perPageAmount: invoice.perPageAmount || "0.00",
    clericalTimeHours: invoice.clericalTimeHours || "0",
    clericalHourlyRate: invoice.clericalHourlyRate || "0.00",
    shippingHandling: invoice.shippingHandling || "0.00",
    notes: invoice.notes || "",
    sendOrderDetails: Boolean(invoice.sendOrderDetails),
    rushOrder: Boolean(invoice.rushOrder),
  };
}

function mapInvoiceToFormData(invoice, order) {
  if (!invoice) {
    return getInitialInvoiceFormData(order, true);
  }

  return {
    invoiceDate: invoice.invoiceDate || initialFormData.invoiceDate,
    storageFee: invoice.storageFee || "0.00",
    pages: invoice.pages || "0",
    perPageAmount: invoice.perPageAmount || "0.00",
    clericalTimeHours: invoice.clericalTimeHours || "0",
    clericalHourlyRate: invoice.clericalHourlyRate || "0.00",
    shippingHandling: invoice.shippingHandling || "0.00",
    notes: invoice.notes || "",
    sendOrderDetails: Boolean(invoice.sendOrderDetails),
    rushOrder: Boolean(invoice.rushOrder),
  };
}

function toDateInput(dateValue) {
  if (!dateValue) return "";

  if (/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    return dateValue;
  }

  const parts = String(dateValue).split("/");

  if (parts.length !== 3) {
    return "";
  }

  const [month, day, year] = parts;

  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function moneyToInput(value, fallback = "0.00") {
  if (!value) return fallback;

  const cleanValue = String(value).replace(/[^\d.]/g, "");
  const numberValue = Number(cleanValue);

  if (Number.isNaN(numberValue)) {
    return fallback;
  }

  return numberValue.toFixed(2);
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

function FieldLabel({ label, paymentHint, helperText, helperTone = "muted" }) {
  return (
    <label className="mb-2 block text-[11px] font-semibold text-[#475569]">
      {label}
      {paymentHint ? ` ${paymentHint}` : ""}
      {helperText ? (
        <span
          className={`ml-1 font-normal ${
            helperTone === "danger" ? "text-red-600" : "text-[#94A3B8]"
          }`}
        >
          · {helperText}
        </span>
      ) : null}
    </label>
  );
}

function MoneyField({
  label,
  name,
  value,
  onChange,
  error = "",
  paymentHint,
  helperText,
  helperTone = "muted",
  disabled = false,
  unpaid = false,
}) {
  return (
    <div>
      <FieldLabel
        label={label}
        paymentHint={paymentHint}
        helperText={helperText}
        helperTone={helperTone}
      />

      <div className="relative">
        <span
          className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[12px] ${
            unpaid ? "text-red-500" : "text-[#94A3B8]"
          }`}
        >
          $
        </span>

        <input
          type="text"
          inputMode="decimal"
          name={name}
          value={value}
          onChange={onChange}
          disabled={disabled}
          className={`h-[34px] w-full rounded-[6px] border pl-7 pr-3 text-[12px] outline-none focus:ring-2 ${
            unpaid ? "font-semibold text-red-600" : "text-[#111827]"
          } ${
            disabled
              ? "cursor-not-allowed border-[#E2E8F0] bg-[#F8FAFC]"
              : "bg-white"
          } ${
            error || unpaid
              ? "border-red-500 focus:border-red-500 focus:ring-red-500/10"
              : disabled
                ? ""
                : "border-[#CBD5E1] focus:border-[#0097B2] focus:ring-[#0097B2]/10"
          }`}
        />
      </div>

      {error && <p className="mt-1 text-[11px] text-red-500">{error}</p>}
    </div>
  );
}

function ReadOnlyMoneyField({
  label,
  value,
  paymentHint,
  helperText,
  helperTone = "muted",
  unpaid = false,
  error = "",
}) {
  return (
    <div>
      <FieldLabel
        label={label}
        paymentHint={paymentHint}
        helperText={helperText}
        helperTone={helperTone}
      />

      <div className="relative">
        <span
          className={`pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[12px] ${
            unpaid ? "text-red-500" : "text-[#94A3B8]"
          }`}
        >
          $
        </span>

        <input
          type="text"
          value={Number(value).toFixed(2)}
          readOnly
          className={`h-[34px] w-full cursor-not-allowed rounded-[6px] border bg-[#F8FAFC] pl-7 pr-3 text-[12px] font-semibold outline-none ${
            unpaid || error
              ? "border-red-500 text-red-600"
              : "border-[#E2E8F0] text-[#007F96]"
          }`}
        />
      </div>
      {error ? <p className="mt-1 text-[11px] text-red-500">{error}</p> : null}
    </div>
  );
}

function NumberField({ label, name, value, onChange, error = "", disabled = false }) {
  return (
    <div>
      <label className="mb-2 block text-[11px] font-semibold text-[#475569]">
        {label}
      </label>

      <input
        type="text"
        inputMode="numeric"
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

function CheckboxField({ label, name, checked, onChange, disabled = false }) {
  return (
    <label
      className={`flex items-center gap-2 text-[11px] text-[#64748B] ${
        disabled ? "cursor-not-allowed opacity-70" : ""
      }`}
    >
      <input
        type="checkbox"
        name={name}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="h-[13px] w-[13px] rounded border-[#CBD5E1] accent-[#0097B2] disabled:cursor-not-allowed"
      />
      {label}
    </label>
  );
}

function SummaryRow({
  label,
  value,
  highlight = false,
  muted = false,
  unpaid = false,
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span
        className={`text-[10px] ${
          unpaid ? "font-semibold text-red-600" : "text-[#64748B]"
        }`}
      >
        {label}
      </span>
      <span
        className={`text-[11px] font-semibold ${
          unpaid
            ? "text-red-600"
            : highlight
              ? "text-[#059669]"
              : muted
                ? "text-[#94A3B8]"
                : "text-[#334155]"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function calculateInvoiceTotal(data, facilitySearchFee = 0) {
  const pagesAmount = toNumber(data.pages) * toNumber(data.perPageAmount);
  const clericalAmount =
    toNumber(data.clericalTimeHours) * toNumber(data.clericalHourlyRate);

  return (
    pagesAmount +
    clericalAmount +
    toNumber(data.shippingHandling) +
    toNumber(data.storageFee) +
    toNumber(facilitySearchFee)
  );
}

function validateInvoiceForm(
  data,
  { requirePositiveTotal = false, facilitySearchFee = 0, computedTotal = null } = {}
) {
  const errors = {};

  if (!data.invoiceDate) {
    errors.invoiceDate = "Invoice date is required";
  }

  const moneyFields = [
    { field: "storageFee", label: "Storage fee" },
    { field: "perPageAmount", label: "Per page amount" },
    { field: "clericalHourlyRate", label: "Clerical hourly rate" },
    { field: "shippingHandling", label: "Shipping and handling" },
  ];

  moneyFields.forEach(({ field, label }) => {
    if (data[field] === "") {
      errors[field] = `${label} is required`;
    } else if (Number.isNaN(Number(data[field]))) {
      errors[field] = `Enter a valid ${label.toLowerCase()}`;
    }
  });

  if (data.pages === "") {
    errors.pages = "Page count is required";
  } else if (Number(data.pages) < 0) {
    errors.pages = "Enter a valid page count (0 or greater)";
  }

  if (data.clericalTimeHours === "") {
    errors.clericalTimeHours = "Clerical time is required";
  } else if (Number(data.clericalTimeHours) < 0) {
    errors.clericalTimeHours = "Enter a valid clerical time (0 or greater)";
  }

  const invoiceTotal =
    computedTotal == null
      ? calculateInvoiceTotal(data, facilitySearchFee)
      : toNumber(computedTotal);

  if (requirePositiveTotal && invoiceTotal <= 0) {
    errors.totalAmount = "Invoice total must be greater than zero";
  }

  const notesError = validateNoHtmlMarkup(data.notes, {
    fieldLabel: "Invoice notes",
  });
  if (notesError) errors.notes = notesError;

  return errors;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isNaN(number) ? 0 : number;
}

function resolveRegularInvoicePageCount(orderData = {}) {
  const total = Number(orderData?.records?.regularInvoicePageCount);
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
    if (`${record.recordType || ""}`.toLowerCase() === "xrays") return sum;
    const pages = Number(record.pageCount);
    if (!Number.isFinite(pages) || pages < 0) return sum;
    return sum + Math.floor(pages);
  }, 0);
}

function formatMoney(value) {
  return `$${Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}