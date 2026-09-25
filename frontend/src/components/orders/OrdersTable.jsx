"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import CreateInvoiceModal from "@/components/orders/CreateInvoiceModal";
import CreateXrayInvoiceModal from "@/components/orders/CreateXrayInvoiceModal";
import CoverSheetModal from "@/components/orders/CoverSheetModal";
import XrayCoverSheetModal from "@/components/orders/XrayCoverSheetModal";
import CertificateNoRecordsModal from "@/components/orders/CertificateNoRecordsModal";
import CnrNoteModal from "@/components/orders/CnrNoteModal";
import CertificateOfRecordsModal from "@/components/orders/CertificateOfRecordsModal";
import SendCopyLetterModal from "@/components/orders/SendCopyLetterModal";
import OrderActivityLogModal from "@/components/orders/OrderActivityLogModal";
import OrderAddNoteModal from "@/components/orders/OrderAddNoteModal";
import OrderNotesListModal from "@/components/orders/OrderNotesListModal";
import OrderNotesColumn from "@/components/orders/OrderNotesColumn";
import SendInvoiceEmailModal from "@/components/orders/SendInvoiceEmailModal";
import OrderPickupModal from "@/components/orders/OrderPickupModal";
import OrderFaxModal from "@/components/orders/OrderFaxModal";
import OrderCancelModal from "@/components/orders/OrderCancelModal";
import OrderDeleteModal from "@/components/orders/OrderDeleteModal";
import ConfirmModal from "@/components/ui/ConfirmModal";
import CompanyOrderFacilityModal from "@/components/orders/CompanyOrderFacilityModal";
import OrderStatusBadge from "@/components/orders/OrderStatusBadge";
import CompletedDeliveryLink from "@/components/orders/CompletedDeliveryLink";
import {
  cancelOrder,
  deleteOrder,
  restoreOrder,
  getOrders,
  getOrdersPaginated,
  fetchOrderMedicalRecordsPdf,
  fetchOrderPrintInvoicePdf,
  fetchOrderPrintXrayInvoicePdf,
  fetchOrderSubpoenaPdf,
  mailCompletedOrder,
  sendCopyServiceLetter,
  sendCnrRecord,
  sendCertificateOfRecords,
  recordOrderPickup,
  recordOrderFax,
  removeMedicalRecords,
  updateCompanyOrderStage,
  emailCompanyOrderRecords,
  restoreCompanyOrderInProcess,
  restorePersonalOrderInProcess,
} from "@/lib/orders/orderApi";
import { getApiErrorMessage } from "@/lib/apiErrorUtils";
import { getDocumentOpenErrorMessage } from "@/lib/utils/documentOpenErrors";
import { getTodayInputDate } from "@/lib/utils/dateUtils";
import {
  cleanupPdfPrintFrame,
  downloadPdfFromUrl,
  printPdfFromUrl,
} from "@/lib/utils/pdfPrintUtils";
import {
  getCompletedDeliveryActions,
  getDeliveryStatus,
} from "@/lib/orders/deliveryActions";
import { getOrderPeriodStartDate } from "@/lib/orders/orderFilterConstants";
import { markOrderListFiltersForRestore } from "@/lib/orders/orderListFilterStorage";
import {
  emailXrayInvoiceByOrderId,
  resendInvoices,
  resendXrayInvoices,
  sendInvoices,
} from "@/lib/invoices/invoiceApi";
import {
  formatMoneyAmount,
  parsePaymentAmount,
} from "@/lib/orders/paymentUtils";
import {
  deriveDisplayOrderStatus,
  resolveRushLabel,
  buildRushBadgeTooltip,
  RUSH_LEVEL_STYLES,
} from "@/lib/orders/rushUtils";
import SubpoenaPreviewContent from "@/components/orders/new-order/SubpoenaPreviewContent";
import { getOrderRecordSlots, getOrderTypeLabel } from "@/lib/orders/recordTypeUtils";
import { useDataRefresh } from "@/lib/liveRefresh/useDataRefresh";
import { useSharedOrderRowSync } from "@/lib/orders/useSharedOrderRowSync";

const ORDERS_PER_PAGE = 10;

const PERSONAL_PORTAL_STATUS_FLOW = [
  "in_process",
  "invoice",
  "paid",
  "released",
];

const PERSONAL_PORTAL_STATUS_LABELS = {
  pending_payment: "Pending Payment",
  in_process: "In Process",
  invoice: "Invoice",
  paid: "Paid",
  released: "Released",
};

function buildPersonalPortalStatusStages(
  portalStatus,
  { hasRecords = false, hasInvoice = false, invoicesPaid = false } = {}
) {
  const normalized =
    portalStatus && PERSONAL_PORTAL_STATUS_FLOW.includes(portalStatus)
      ? portalStatus
      : "in_process";

  return PERSONAL_PORTAL_STATUS_FLOW.map((key) => {
    let status = "pending";

    if (key === "in_process") {
      status = "complete";
    } else if (key === "invoice") {
      status =
        hasInvoice ||
        invoicesPaid ||
        normalized === "invoice" ||
        normalized === "paid"
          ? "complete"
          : "pending";
    } else if (key === "paid") {
      status =
        invoicesPaid || normalized === "paid" ? "complete" : "pending";
    } else if (key === "released") {
      // Records uploaded → Released completed
      status = hasRecords ? "complete" : "pending";
    }

    return {
      key,
      label: PERSONAL_PORTAL_STATUS_LABELS[key],
      status,
    };
  });
}

function buildPersonalReviewRecordsStage(order) {
  const hasAllRecordsUploaded = Boolean(order.hasMedicalRecords);
  const hasAnyRecordsUploaded = Boolean(order.hasAnyRecordsUploaded);

  return {
    key: "Review Records",
    label: "Review Records",
    status: hasAllRecordsUploaded ? "complete" : "pending",
    showScanRecordsLink: !hasAllRecordsUploaded,
    showPreviewRecords: hasAnyRecordsUploaded,
    showRemoveRecords: hasAllRecordsUploaded && hasAnyRecordsUploaded,
  };
}

function getPersonalScanRecordsHref(order) {
  if (!order?.dbId || order.certificateNoRecords) return null;
  if (order.hasMedicalRecords) return null;
  return `/orders/scan-medical-records?orderId=${encodeURIComponent(
    order.dbId
  )}&returnTo=${encodeURIComponent("personal-orders")}`;
}

function resolveOrderListReturnTo(
  order = {},
  { personalMode = false, companyPortalMode = false, listReturnTo = "" } = {}
) {
  const preferred = `${listReturnTo || ""}`.trim().replace(/^\/+/, "");
  if (
    preferred === "orders" ||
    preferred === "company-orders" ||
    preferred === "personal-orders" ||
    preferred === "reports"
  ) {
    return preferred;
  }
  if (personalMode || order.creationSource === "personal_portal") {
    return "personal-orders";
  }
  if (companyPortalMode || order.creationSource === "company_portal") {
    return "company-orders";
  }
  return "orders";
}

function buildOrderEditHref(
  orderId,
  {
    returnTo = "orders",
    panel = null,
  } = {}
) {
  const params = new URLSearchParams();
  params.set("mode", "edit");
  params.set("orderId", String(orderId));
  if (returnTo && returnTo !== "orders") {
    params.set("returnTo", returnTo);
  }
  if (panel) params.set("panel", panel);
  return `/orders/new?${params.toString()}`;
}

function rememberFiltersBeforeOrderEdit(
  returnTo = "orders",
  filtersSnapshot = null
) {
  markOrderListFiltersForRestore(returnTo, filtersSnapshot);
}

const defaultOrderFilters = {
  facility: "",
  company: "",
  year: "",
  period: "",
  status: "",
  search: "",
  sortDir: "",
};

const DEFAULT_ORDER_FORMS = [
  "Send Copy/Letter",
  "Certification of Records",
  "CNR",
];

const CNR_DELIVERY_LABELS = {
  email: "Email",
  fax: "Fax",
  pickup: "Pickup",
};

function formatCnrDisplayDate(dateValue) {
  if (!dateValue) return "";

  const value = String(dateValue).slice(0, 10);
  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);

  if (isoMatch) {
    return `${isoMatch[2]}/${isoMatch[3]}/${isoMatch[1].slice(-2)}`;
  }

  return value;
}

function IncompleteOrderIndicator({ missingFields = [] }) {
  const fields = missingFields.filter(Boolean);
  const tooltipText =
    fields.length > 0
      ? `Required fields are not completed: ${fields.join(", ")}`
      : "Required fields are not completed";

  return (
    <span
      className="group relative shrink-0 cursor-help"
      title={tooltipText}
      aria-label={tooltipText}
    >
      <span className="text-[12px] font-bold leading-none text-red-500">!</span>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-full top-1/2 z-30 ml-1.5 hidden w-max max-w-[240px] -translate-y-1/2 rounded-[6px] border border-[#FECACA] bg-[#FEF2F2] px-2.5 py-2 text-left shadow-md group-hover:block"
      >
        <span className="block text-[10px] font-semibold text-[#B91C1C]">
          Required fields are not completed
        </span>
        {fields.length > 0 ? (
          <span className="mt-1 block text-[10px] leading-snug text-[#7F1D1D]">
            {fields.join(", ")}
          </span>
        ) : null}
      </span>
    </span>
  );
}

function orderHasIncompleteRequiredFields(order = {}) {
  const missing = Array.isArray(order.missingRequiredFields)
    ? order.missingRequiredFields
    : Array.isArray(order.missing_required_fields)
      ? order.missing_required_fields
      : [];

  const hasDoctorName = Boolean(
    `${order.doctor || order.specificDoctor || order.requestedTreatingDoctor || ""}`.trim()
  );
  const doctorUnresolved =
    order.creationSource === "personal_portal" &&
    Boolean(order.doctorNotInSystem) &&
    hasDoctorName;

  return (
    Boolean(
      order.hasIncompleteRequiredFields ?? order.has_incomplete_required_fields
    ) ||
    missing.length > 0 ||
    doctorUnresolved
  );
}

function buildIncompleteOrderTooltip(missingFields = []) {
  const fields = missingFields.filter(Boolean);
  return fields.length > 0
    ? `Required fields are not completed: ${fields.join(", ")}`
    : "Required fields are not completed";
}

function isPersonalOrderIncompleteDisplay(order, personalMode) {
  return personalMode || order.creationSource === "personal_portal";
}

function openCnrTextModal(setModal, order, title, note = order?.cnrReason || "") {
  setModal({ title, note });
}

const WORKFLOW_STAGES = [
  "Review Records",
  "Serve",
  "SENT",
];

const COMPANY_PORTAL_STAGES = [
  "In Process",
  "Invoice",
  "Paid",
  "Released",
];

function resolveEffectiveCompanyPortalStatus(order = {}) {
  const status = order.companyPortalStatus || "In Process";

  if (
    status === "Invoice" &&
    order.companyPortalInvoiceSent &&
    order.companyPortalAllInvoicesPaid
  ) {
    return "Paid";
  }

  return status;
}

function canCompanyPortalUploadRecords(order = {}) {
  return resolveEffectiveCompanyPortalStatus(order) === "Paid";
}

function hasReachedCompanyPortalPaidStage(order = {}) {
  const status = resolveEffectiveCompanyPortalStatus(order);
  if (status === "Paid" || status === "Released") return true;

  if (
    Boolean(order.companyPortalInvoiceSent) &&
    Boolean(order.companyPortalAllInvoicesPaid)
  ) {
    return true;
  }

  const invoice = order.invoice || {};
  const invoiceSent = Boolean(
    order.companyPortalInvoiceSent ||
      invoice.sentDate ||
      invoice.xraySentDate
  );
  const amountDue = parsePaymentAmount(invoice.due);
  const invoicePaid =
    Boolean(order.companyPortalAllInvoicesPaid) ||
    invoice.status === "Paid" ||
    (invoiceSent && amountDue <= 0);

  return invoiceSent && invoicePaid;
}

function shouldShowCompanyPortalUploadLink(order = {}) {
  if (order.certificateNoRecords) return false;
  if (!hasReachedCompanyPortalPaidStage(order)) return false;
  if (Boolean(order.records?.allRecordsUploaded)) return false;
  return true;
}

function getCompanyPortalRecordsUploadHref(order) {
  const returnTo =
    order.creationSource === "company_portal" ? "company-orders" : "orders";

  return `/orders/scan-medical-records?orderId=${encodeURIComponent(
    order.dbId
  )}&returnTo=${encodeURIComponent(returnTo)}`;
}

const WORKFLOW_STATUS_STYLES = {
  complete: { text: "text-[#059669]", dot: "bg-[#10B981]" },
  failed: { text: "text-red-500", dot: "bg-red-500" },
  pending: { text: "text-[#CA8A04]", dot: "bg-[#EAB308]" },
  sent: { text: "text-[#2563EB]", dot: "bg-[#3B82F6]" },
};

function isWorkflowStageComplete(status) {
  return status === "complete" || status === "sent";
}

function mapWorkflowStages(stages = []) {
  const byName = new Map(
    stages.map((stage) => [stage.stageName, stage.stageStatus])
  );

  return WORKFLOW_STAGES.map((stageName) => {
    const status = byName.get(stageName) || "pending";

    return {
      key: stageName,
      label: stageName,
      status,
    };
  });
}

function buildCompanyPortalStages(order) {
  const status = resolveEffectiveCompanyPortalStatus(order);

  // Order was ended because the facility could not be located.
  if (status === "No facility") {
    return COMPANY_PORTAL_STAGES.map((stageName) => ({
      key: stageName,
      label: stageName,
      status: stageName === "In Process" ? "failed" : "pending",
      isCompanyPortalStage: true,
      canAdvance: false,
      showScanRecordsLink: false,
      showEmailRecords: false,
      showPreviewRecords: false,
    }));
  }

  const invoiceComplete =
    Boolean(order.companyPortalInvoiceSent) ||
    ["Invoice", "Paid", "Released"].includes(status);
  const paidComplete =
    Boolean(order.companyPortalAllInvoicesPaid) ||
    ["Paid", "Released"].includes(status);
  const releasedComplete = status === "Released";
  const inProcessComplete =
    invoiceComplete || paidComplete || releasedComplete || status !== "In Process";

  const canScan = shouldShowCompanyPortalUploadLink(order);
  const canEmail =
    Boolean(order.companyPortalCanEmailRecords) ||
    (hasReachedCompanyPortalPaidStage(order) &&
      Boolean(order.hasAnyRecordsUploaded || order.records?.anyRecordsUploaded));

  return COMPANY_PORTAL_STAGES.map((stageName) => {
    let stageStatus = "pending";
    if (stageName === "In Process" && inProcessComplete) stageStatus = "complete";
    if (stageName === "Invoice" && invoiceComplete) stageStatus = "complete";
    if (stageName === "Paid" && paidComplete) stageStatus = "complete";
    if (stageName === "Released" && releasedComplete) stageStatus = "complete";

    // Highlight the first incomplete stage as current.
    if (
      stageStatus === "pending" &&
      ((stageName === "Invoice" && inProcessComplete && !invoiceComplete) ||
        (stageName === "Paid" && invoiceComplete && !paidComplete) ||
        (stageName === "Released" && paidComplete && !releasedComplete))
    ) {
      stageStatus = "sent";
    }

    return {
      key: stageName,
      label: stageName,
      status: stageStatus,
      isCompanyPortalStage: true,
      canAdvance: false,
      showScanRecordsLink: stageName === "Paid" && canScan,
      showEmailRecords:
        stageName === "Released" &&
        canEmail &&
        !releasedComplete &&
        Boolean(order.hasAnyRecordsUploaded || order.records?.anyRecordsUploaded),
      showPreviewRecords:
        stageName === "Paid" &&
        Boolean(order.hasAnyRecordsUploaded || order.records?.anyRecordsUploaded),
    };
  });
}

function buildWorkflowStagesForOrder(order, companyPortalMode = false) {
  if (companyPortalMode || order.creationSource === "company_portal") {
    return buildCompanyPortalStages(order);
  }

  const prepaymentPaid = parsePaymentAmount(order.invoice?.prepaymentPaid);
  const hasAllRecordsUploaded = Boolean(order.records?.allRecordsUploaded);
  const hasAnyRecordsUploaded = Boolean(
    order.records?.anyRecordsUploaded || order.records?.hasMedicalRecords
  );
  const isCnrOrder = Boolean(order.certificateNoRecords);

  return mapWorkflowStages(order.workflowStages).map((stage) => {
    if (stage.key === "Review Records") {
      if (isCnrOrder) {
        return {
          ...stage,
          status: "complete",
          label: "Review Records",
          showScanRecordsLink: false,
          showPreviewRecords: false,
          showRemoveRecords: false,
        };
      }

      const isComplete =
        isWorkflowStageComplete(stage.status) || hasAllRecordsUploaded;

      return {
        ...stage,
        status: isComplete ? "complete" : "pending",
        label: "Review Records",
        showScanRecordsLink: !isComplete,
        showPreviewRecords: hasAnyRecordsUploaded,
        showRemoveRecords: isComplete && hasAnyRecordsUploaded,
      };
    }

    if (stage.key === "Serve") {
      const isComplete = isWorkflowStageComplete(stage.status);

      return {
        ...stage,
        label: isComplete ? "Serve" : "Serve Payment",
        paidAmount:
          prepaymentPaid > 0
            ? `(${formatMoneyAmount(prepaymentPaid)})`
            : null,
      };
    }

    if (stage.key === "SENT" && stage.status === "sent") {
      return {
        ...stage,
        showResend: Boolean(order.invoice?.invoiceId),
        invoiceId: order.invoice?.invoiceId || null,
      };
    }

    return stage;
  });
}

function isInactiveOrderStatus(status) {
  return status === "Cancelled" || status === "Deleted";
}

function isDeletedOrderStatus(status) {
  return status === "Deleted";
}

function isCancelledOrderStatus(status) {
  return status === "Cancelled";
}

function getOrderRowClassName(orderStatus) {
  const base =
    "border-b border-[#F1F5F9] text-[11px] text-[#334155] last:border-b-0";

  if (isCancelledOrderStatus(orderStatus)) {
    return `${base} bg-[#FEE2E2] hover:bg-[#FECDD3]`;
  }

  return `${base} hover:bg-[#F8FBFC]`;
}

function formatShortDate(dateValue) {
  if (!dateValue) return "";

  const value = String(dateValue).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return dateValue;

  const [year, month, day] = value.split("-");
  return `${month}/${day}/${year.slice(2)}`;
}

function formatFullDate(dateValue) {
  if (!dateValue) return "";

  if (dateValue instanceof Date) {
    if (Number.isNaN(dateValue.getTime())) return "";
    const month = String(dateValue.getMonth() + 1).padStart(2, "0");
    const day = String(dateValue.getDate()).padStart(2, "0");
    return `${month}/${day}/${dateValue.getFullYear()}`;
  }

  const value = String(dateValue).trim();
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return `${iso[2]}/${iso[3]}/${iso[1]}`;
  }

  return "";
}

function getOrderIdColumnDate(order) {
  return (
    formatFullDate(order.createdAt || order.created_at) ||
    ""
  );
}

function getOrderDateColumnDisplay(order) {
  const fromDisplay = `${order.orderDateDisplay || ""}`.trim();
  if (fromDisplay) {
    // Date only — never show time under Order Date.
    const dateOnly = fromDisplay.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/);
    if (dateOnly) return dateOnly[0];
    return fromDisplay.split(/\s+/)[0];
  }
  return getOrderIdColumnDate(order);
}

function OrderDateSortHeader({ sortDir, onSortDirChange }) {
  const activeDir =
    sortDir === "asc" || sortDir === "desc" ? sortDir : null;
  const canSort = typeof onSortDirChange === "function";

  return (
    <div className="inline-flex items-center gap-1.5">
      <span>Order Date</span>
      {canSort ? (
        <span className="inline-flex items-center gap-1">
          <button
            type="button"
            aria-label="Sort by order date ascending (oldest to newest)"
            title="Ascending (oldest to newest)"
            onClick={() => onSortDirChange("asc")}
            className={`inline-flex h-[18px] w-[18px] items-center justify-center rounded-[3px] border text-[10px] leading-none transition-colors ${
              activeDir === "asc"
                ? "border-[#0097B2] bg-[#E6F7FA] text-[#0097B2]"
                : "border-[#E2E8F0] bg-white text-[#64748B] hover:border-[#CBD5E1] hover:bg-[#F8FAFC]"
            }`}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label="Sort by order date descending (newest to oldest)"
            title="Descending (newest to oldest)"
            onClick={() => onSortDirChange("desc")}
            className={`inline-flex h-[18px] w-[18px] items-center justify-center rounded-[3px] border text-[10px] leading-none transition-colors ${
              activeDir === "desc"
                ? "border-[#0097B2] bg-[#E6F7FA] text-[#0097B2]"
                : "border-[#E2E8F0] bg-white text-[#64748B] hover:border-[#CBD5E1] hover:bg-[#F8FAFC]"
            }`}
          >
            ↓
          </button>
        </span>
      ) : null}
    </div>
  );
}

function formatReportDate(order, displayKey, rawKey) {
  return order[displayKey] || formatShortDate(order[rawKey]);
}

function ReportCaseCell({ order, onOpenSubpoena }) {
  const subpoenaDate = formatReportDate(
    order,
    "subpoenaDateDisplay",
    "subpoenaDate"
  );
  const subpoenaUploadedDate =
    order.subpoenaUploadedAtDisplay ||
    formatShortDate(order.subpoenaUploadedAt);
  const dateServed = formatReportDate(order, "dateServedDisplay", "dateServed");

  return (
    <>
      {order.caseNumber ? (
        <p className="font-semibold text-[#111827]">{order.caseNumber}</p>
      ) : null}

      {order.orderRef ? (
        <p className={`text-[10px] text-[#64748B] ${order.caseNumber ? "mt-1" : ""}`}>
          {order.orderRef}
        </p>
      ) : null}

      {order.hasSubpoenaFile ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={onOpenSubpoena}
            className="block text-left text-[10px] font-semibold text-[#059669] hover:underline"
          >
            ✓ Subpoena
          </button>
          {subpoenaDate ? (
            <p className="mt-1 text-[10px] font-medium text-[#64748B]">
              Subpoena Date: {subpoenaDate}
            </p>
          ) : null}
          {subpoenaUploadedDate ? (
            <p className="mt-1 text-[10px] font-medium text-[#64748B]">
              Subpoena Uploaded Date: {subpoenaUploadedDate}
            </p>
          ) : null}
        </div>
      ) : null}

      {dateServed ? (
        <p className="mt-1 text-[10px] font-medium text-[#64748B]">
          Served: {dateServed}
        </p>
      ) : null}

      {order.court ? (
        <p className="mt-1 text-[10px] font-semibold text-[#334155]">
          {order.court}
        </p>
      ) : null}

      {order.recNumber ? (
        <p className="mt-1 text-[10px] font-medium text-[#64748B]">
          REC {order.recNumber}
        </p>
      ) : null}
    </>
  );
}

function getRestoreTargetStatus(order) {
  const previous = `${order?.statusBeforeInactive || ""}`.trim();
  return previous || "Active";
}

function getOrderFilterDate(order) {
  const raw = order.createdAt || order.created_at || order.subpoenaDate || "";
  if (!raw) return "";

  if (raw instanceof Date) {
    const year = raw.getFullYear();
    const month = String(raw.getMonth() + 1).padStart(2, "0");
    const day = String(raw.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  const value = String(raw);
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    return value.slice(0, 10);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function filterOrdersByPeriod(orders, period) {
  if (!period) return orders;

  const periodStart = getOrderPeriodStartDate(period);
  if (!periodStart) return orders;

  return orders.filter((order) => {
    const orderDate = getOrderFilterDate(order);
    return orderDate && orderDate >= periodStart;
  });
}

function toRenderOrder(order, companyPortalMode = false) {
  return {
    id: order.id,
    dbId: order.dbId,
    orderStatus: order.status || "",
    statusBeforeInactive: order.statusBeforeInactive || "",
    cancelReason: order.cancelReason || "",
    deleteReason: order.deleteReason || "",
    cancelledAt: order.cancelledAt || "",
    deletedAt: order.deletedAt || "",
    displayOrderStatus:
      order.displayStatus ||
      deriveDisplayOrderStatus(
        order.status,
        order.createdAt || order.created_at
      ),
    rushLabel: resolveRushLabel(order) || "",
    isSubpoena: Boolean(order.isSubpoena),
    isRecords: Boolean(order.isRecords),
    isWriteOffs: Boolean(order.isWriteOffs),
    hasMedicalRecords: Boolean(order.records?.allRecordsUploaded),
    hasAnyRecordsUploaded: Boolean(
      order.records?.anyRecordsUploaded || order.records?.hasMedicalRecords
    ),
    note: order.note,
    recentNotes: order.recentNotes || [],
    hasActiveReminder: Boolean(order.hasActiveReminder),
    subpoena: order.subpoena,
    hasSubpoenaFile: Boolean(order.hasSubpoenaFile),
    court: order.court || "",
    recNumber: order.recNumber || "",
    applicant: order.applicant || "",
    caseNumber: order.caseNumber || "",
    orderRef: order.orderRef || "",
    providerName: order.providerName || "",
    providerEmail: order.providerEmail || order.invoice?.providerEmail || "",
    creationSource: order.creationSource || "manual",
    missingRequiredFields: Array.isArray(order.missingRequiredFields)
      ? order.missingRequiredFields
      : [],
    hasIncompleteRequiredFields: Boolean(order.hasIncompleteRequiredFields),
    autoProcessingStatus: order.autoProcessingStatus || null,
    facilityMismatch: Boolean(order.facilityMismatch),
    extractedFacilityName: order.extractedFacilityName || "",
    companyPortalStatus: order.companyPortalStatus || null,
    companyPortalOrderId: order.companyPortalOrderId || null,
    personalPortalStatus: order.personalPortalStatus || null,
    facilityNotInSystem: Boolean(order.facilityNotInSystem),
    doctorNotInSystem: Boolean(order.doctorNotInSystem),
    requestedTreatingDoctor: order.requestedTreatingDoctor || "",
    newFacilityRequest: order.newFacilityRequest || null,
    pendingFacilitySearchFee: Number(order.pendingFacilitySearchFee) || 0,
    companyPortalInvoiceSent: Boolean(order.companyPortalInvoiceSent),
    companyPortalAllInvoicesPaid: Boolean(order.companyPortalAllInvoicesPaid),
    companyPortalCanScanRecords: Boolean(order.companyPortalCanScanRecords),
    companyPortalCanEmailRecords: Boolean(order.companyPortalCanEmailRecords),
    status: buildWorkflowStagesForOrder(order, companyPortalMode),
    invoice: order.invoice || { createOnly: true },
    invoiceStatus: order.invoiceStatus || order.invoice?.status || "",
    records: order.records || { title: "Records", lines: [], links: [] },
    orderRecords: order.records?.orderRecords || order.orderRecords || [],
    company: order.company || { name: "—", address: "", phone: "", email: "" },
    facilityInfo: order.facilityInfo || {
      name: order.facilityName || "",
      address: "",
      addressLines: [],
    },
    facilityName:
      order.facilityName || order.facilityInfo?.name || "",
    doctor: order.doctor || order.specificDoctor || "",
    certificateNoRecords: Boolean(order.certificateNoRecords),
    cnrReason: order.cnrReason || "",
    cnrMemo: Boolean(order.cnrMemo),
    cnrDelivery: order.cnrDelivery || "",
    mailSentDate: order.readyDate || order.mailSentDate || "",
    readyDate: order.readyDate || "",
    recordsDownloaded: Boolean(order.recordsDownloaded),
    recordsDownloadedAt: order.recordsDownloadedAt || "",
    recordsDownloadedAtDisplay: order.recordsDownloadedAtDisplay || "",
    deliveryDate: order.deliveryDate || "",
    pickupPersonName: order.pickupPersonName || "",
    cnrDateSent: order.cnrDateSent || "",
    year: order.year || "",
    orderDateDisplay: order.orderDateDisplay || "",
    dob: order.dob || "",
    ssn: order.ssn || "",
    dobSsn: order.dobSsn || [],
    doiDisplay: order.doiDisplay || "",
    hasDoi: Boolean(order.hasDoi),
    createdAt: order.createdAt || order.created_at || "",
    subpoenaDate: order.subpoenaDate || "",
    subpoenaDateDisplay: order.subpoenaDateDisplay || "",
    subpoenaUploadedAt: order.subpoenaUploadedAt || "",
    subpoenaUploadedAtDisplay: order.subpoenaUploadedAtDisplay || "",
    dateServed: order.dateServed || "",
    dateServedDisplay: order.dateServedDisplay || "",
    dateRequested: order.dateRequested || "",
    dateRequestedDisplay: order.dateRequestedDisplay || "",
    forms: order.forms?.length ? order.forms : DEFAULT_ORDER_FORMS,
    hasIncompleteRequiredFields: orderHasIncompleteRequiredFields(order),
    facilityMismatch: Boolean(order.facilityMismatch),
    extractedFacilityName: order.extractedFacilityName || "",
    missingRequiredFields: Array.isArray(order.missingRequiredFields)
      ? order.missingRequiredFields
      : Array.isArray(order.missing_required_fields)
        ? order.missing_required_fields
        : [],
    portalStatus: order.portalStatus || null,
    portalStatusLabel: order.portalStatusLabel || null,
  };
}

export default function OrdersTable({
  filters = defaultOrderFilters,
  excludeCompleted = false,
  createdSortDir = null,
  onCreatedSortDirChange = null,
  fitToWindow = false,
  showDoctorColumn = false,
  useServerPagination = false,
  onSummaryChange = null,
  creationSource = null,
  companyPortalMode = false,
  personalMode = false,
  listReturnTo = "",
}) {
  const router = useRouter();
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedInvoiceOrder, setSelectedInvoiceOrder] = useState(null);
  const [invoiceModalMode, setInvoiceModalMode] = useState("create");
  const [selectedXrayOrder, setSelectedXrayOrder] = useState(null);
  const [selectedCoverSheetOrder, setSelectedCoverSheetOrder] = useState(null);
  const [selectedXrayCoverSheetOrder, setSelectedXrayCoverSheetOrder] =
    useState(null);
  const [selectedCnrOrder, setSelectedCnrOrder] = useState(null);
  const [cnrTextModal, setCnrTextModal] = useState(null);
  const [selectedCertificationOrder, setSelectedCertificationOrder] = useState(null);
  const [selectedCopyLetterOrder, setSelectedCopyLetterOrder] = useState(null);
  const [selectedLogOrder, setSelectedLogOrder] = useState(null);
  const [facilityModalState, setFacilityModalState] = useState(null);
  const [restoreInProcessOrder, setRestoreInProcessOrder] = useState(null);
  const [restoringInProcess, setRestoringInProcess] = useState(false);
  const [selectedNoteListOrder, setSelectedNoteListOrder] = useState(null);
  const [selectedAddNoteOrder, setSelectedAddNoteOrder] = useState(null);
  const [selectedMedicalRecordsOrder, setSelectedMedicalRecordsOrder] =
    useState(null);
  const [selectedPrintInvoiceOrder, setSelectedPrintInvoiceOrder] =
    useState(null);
  const [selectedPrintXrayInvoiceOrder, setSelectedPrintXrayInvoiceOrder] =
    useState(null);
  const [selectedSubpoenaOrder, setSelectedSubpoenaOrder] = useState(null);
  const [sendInvoiceEmailModal, setSendInvoiceEmailModal] = useState({
    open: false,
    order: null,
    mode: "send",
    invoiceId: null,
    invoiceKind: "standard",
  });
  const [selectedPickupOrder, setSelectedPickupOrder] = useState(null);
  const [selectedFaxOrder, setSelectedFaxOrder] = useState(null);
  const [emailingOrderId, setEmailingOrderId] = useState(null);
  const [sendingInvoiceOrderId, setSendingInvoiceOrderId] = useState(null);
  const [emailingXrayOrderId, setEmailingXrayOrderId] = useState(null);
  const [emailingCnrOrderId, setEmailingCnrOrderId] = useState(null);
  const [emailingRecordsOrderId, setEmailingRecordsOrderId] = useState(null);
  const [processingDeliveryKey, setProcessingDeliveryKey] = useState("");
  const [emailError, setEmailError] = useState("");
  const [deliveryError, setDeliveryError] = useState("");
  const [deleteModal, setDeleteModal] = useState({ open: false, order: null });
  const [cancelModal, setCancelModal] = useState({ open: false, order: null });
  const [restoreModal, setRestoreModal] = useState({ open: false, order: null });
  const [removeRecordsModal, setRemoveRecordsModal] = useState({
    open: false,
    order: null,
  });
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState("");

  const [orders, setOrders] = useState([]);
  const [keysetPagination, setKeysetPagination] = useState({
    pageSize: ORDERS_PER_PAGE,
    hasMore: false,
    nextCursor: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const [, setRelativeTimeTick] = useState(0);

  // Guards a silent refetch from running too often, and discards responses
  // from stale requests so a late silent fetch never overwrites fresh data.
  const lastFetchAtRef = useRef(0);
  const requestIdRef = useRef(0);
  const tableTopRef = useRef(null);

  const normalizedFilters = {
    facility: filters.facility || "",
    company: filters.company || "",
    year: filters.year || "",
    period: filters.period || "",
    status: filters.status || "",
    rushLevel: filters.rushLevel || "",
    search: filters.search || "",
    createdFrom: filters.createdFrom || "",
    createdTo: filters.createdTo || "",
    creationSource: personalMode
      ? "personal_portal"
      : (() => {
          const raw = `${creationSource || filters.creationSource || ""}`
            .trim()
            .toLowerCase();
          // "internal" is UI-only; API expects empty to exclude portal rows.
          if (!raw || raw === "internal") return "";
          if (raw === "company_portal" || raw === "personal_portal") return raw;
          return "";
        })(),
  };

  const sortDir =
    createdSortDir === "asc" || createdSortDir === "desc"
      ? createdSortDir
      : "";

  const filterKey = `${normalizedFilters.facility}|${normalizedFilters.company}|${normalizedFilters.year}|${normalizedFilters.period}|${normalizedFilters.status}|${normalizedFilters.rushLevel}|${normalizedFilters.search}|${normalizedFilters.createdFrom}|${normalizedFilters.createdTo}|${normalizedFilters.creationSource}|${excludeCompleted ? "1" : "0"}|${sortDir}|${companyPortalMode ? "c" : personalMode ? "p" : "o"}`;
  const [prevFilterKey, setPrevFilterKey] = useState(filterKey);
  const [cursorHistory, setCursorHistory] = useState([null]);
  const cursorHistoryRef = useRef([null]);
  const [isFetching, setIsFetching] = useState(false);

  const fetchOrders = useCallback(
    async ({ silent = false, force = false } = {}) => {
      if (silent && !force && Date.now() - lastFetchAtRef.current < 5000) return;

      const requestId = (requestIdRef.current += 1);
      setIsFetching(true);

      if (!silent) {
        setLoading(true);
        setError("");
      }

      try {
        const baseFilters = {
          facility: normalizedFilters.facility,
          company: normalizedFilters.company,
          year: normalizedFilters.year,
          period: normalizedFilters.period,
          status: normalizedFilters.status,
          rushLevel: normalizedFilters.rushLevel,
          search: normalizedFilters.search,
          createdFrom: normalizedFilters.createdFrom,
          createdTo: normalizedFilters.createdTo,
          creationSource: normalizedFilters.creationSource || undefined,
          excludeCompleted: Boolean(excludeCompleted),
          sortDir: sortDir || undefined,
        };

        let data = [];
        let paginationMeta = null;
        if (useServerPagination) {
          const cursor = cursorHistoryRef.current[currentPage - 1] ?? null;

          // Keyset pages > 1 must send a cursor. Without one the API returns page 1
          // again with hasMore=true, which looks like infinite pages of the same rows.
          if (currentPage > 1 && cursor == null) {
            if (requestId !== requestIdRef.current) return;
            setCurrentPage(1);
            cursorHistoryRef.current = [null];
            setCursorHistory([null]);
            setKeysetPagination({
              pageSize: ORDERS_PER_PAGE,
              hasMore: false,
              nextCursor: null,
            });
            return;
          }

          const result = await getOrdersPaginated({
            ...baseFilters,
            pagination: "keyset",
            cursor,
            pageSize: ORDERS_PER_PAGE,
          });
          data = result.orders || [];
          paginationMeta = result.pagination || null;
        } else {
          data = await getOrders(baseFilters);
        }

        if (requestId !== requestIdRef.current) return;
        if (useServerPagination) {
          const hasMore = Boolean(paginationMeta?.hasMore);
          const nextCursor =
            hasMore && paginationMeta?.nextCursor != null
              ? paginationMeta.nextCursor
              : null;
          setKeysetPagination({
            pageSize: Number(paginationMeta?.pageSize) || ORDERS_PER_PAGE,
            hasMore: Boolean(hasMore && nextCursor != null),
            nextCursor,
          });
          setCursorHistory((prev) => {
            const next = prev.slice(0, currentPage);
            if (hasMore && nextCursor != null) {
              next[currentPage] = nextCursor;
            } else {
              next.length = currentPage;
            }
            cursorHistoryRef.current = next;
            return next;
          });
        }
        setOrders(data.map((row) => toRenderOrder(row, companyPortalMode)));
        setLastUpdatedAt(new Date());
        setError("");
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        if (!silent) {
          setError(getApiErrorMessage(err, "Failed to load orders"));
          setOrders([]);
        }
      } finally {
        lastFetchAtRef.current = Date.now();
        if (requestId === requestIdRef.current) {
          setIsFetching(false);
          if (!silent) setLoading(false);
        }
      }
    },
    [
      normalizedFilters.facility,
      normalizedFilters.company,
      normalizedFilters.year,
      normalizedFilters.period,
      normalizedFilters.status,
      normalizedFilters.rushLevel,
      normalizedFilters.search,
      normalizedFilters.createdFrom,
      normalizedFilters.createdTo,
      normalizedFilters.creationSource,
      excludeCompleted,
      sortDir,
      useServerPagination,
      currentPage,
      creationSource,
      companyPortalMode,
      personalMode,
    ]
  );

  useEffect(() => {
    cursorHistoryRef.current = cursorHistory;
  }, [cursorHistory]);

  useEffect(() => {
    if (filterKey === prevFilterKey) return;
    setPrevFilterKey(filterKey);
    setCurrentPage(1);
    cursorHistoryRef.current = [null];
    setCursorHistory([null]);
    setKeysetPagination({
      pageSize: ORDERS_PER_PAGE,
      hasMore: false,
      nextCursor: null,
    });
  }, [filterKey, prevFilterKey]);

  function openDeleteModal(order) {
    setActionError("");
    setDeleteModal({ open: true, order });
  }

  function closeDeleteModal() {
    if (actionLoading) return;
    setDeleteModal({ open: false, order: null });
  }

  function openCancelModal(order) {
    setActionError("");
    setCancelModal({ open: true, order });
  }

  function closeCancelModal() {
    if (actionLoading) return;
    setCancelModal({ open: false, order: null });
  }

  function openRestoreModal(order) {
    setActionError("");
    setRestoreModal({ open: true, order });
  }

  function closeRestoreModal() {
    if (actionLoading) return;
    setRestoreModal({ open: false, order: null });
  }

  function openRemoveRecordsModal(order) {
    setActionError("");
    setRemoveRecordsModal({ open: true, order });
  }

  function closeRemoveRecordsModal() {
    if (actionLoading) return;
    setRemoveRecordsModal({ open: false, order: null });
  }

  async function handleAdvanceCompanyPortalStage(order, stageName) {
    if (!order?.dbId || !stageName || actionLoading) return;

    setActionLoading(true);
    setActionError("");

    try {
      await updateCompanyOrderStage(order.dbId, stageName);
      await fetchOrders({ silent: true, force: true });
    } catch (err) {
      setActionError(
        getApiErrorMessage(err, "Failed to update company order stage")
      );
    } finally {
      setActionLoading(false);
    }
  }

  function handleEmailCompanyPortalRecords(order) {
    if (!order?.dbId) return;
    openSendInvoiceEmailModal(order, "send", {
      invoiceKind: "companyPortalRecords",
    });
  }

  async function handleConfirmRemoveRecords() {
    if (!removeRecordsModal.order?.dbId || actionLoading) return;

    setActionLoading(true);
    setActionError("");

    try {
      await removeMedicalRecords(removeRecordsModal.order.dbId);
      setRemoveRecordsModal({ open: false, order: null });
      await fetchOrders();
    } catch (err) {
      setActionError(getApiErrorMessage(err, "Failed to remove uploaded records"));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleConfirmDelete(reason) {
    if (!deleteModal.order?.dbId || actionLoading) return;

    setActionLoading(true);
    setActionError("");

    try {
      await deleteOrder(deleteModal.order.dbId, { reason });
      setDeleteModal({ open: false, order: null });
      await fetchOrders();
    } catch (err) {
      setActionError(getApiErrorMessage(err, "Failed to delete order"));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleConfirmCancel(reason) {
    if (!cancelModal.order?.dbId || actionLoading) return;

    setActionLoading(true);
    setActionError("");

    try {
      await cancelOrder(cancelModal.order.dbId, { reason });
      setCancelModal({ open: false, order: null });
      await fetchOrders();
    } catch (err) {
      setActionError(getApiErrorMessage(err, "Failed to cancel order"));
    } finally {
      setActionLoading(false);
    }
  }

  async function handleConfirmRestore() {
    if (!restoreModal.order?.dbId || actionLoading) return;

    setActionLoading(true);
    setActionError("");

    try {
      await restoreOrder(restoreModal.order.dbId);
      setRestoreModal({ open: false, order: null });
      await fetchOrders({ silent: true, force: true });
    } catch (err) {
      setActionError(getApiErrorMessage(err, "Failed to restore order"));
    } finally {
      setActionLoading(false);
    }
  }

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  useEffect(() => {
    if (!lastUpdatedAt) return undefined;

    const intervalId = window.setInterval(() => {
      setRelativeTimeTick((tick) => tick + 1);
    }, 30000);

    return () => window.clearInterval(intervalId);
  }, [lastUpdatedAt]);

  const openSendInvoiceEmailModal = useCallback(
    (order, mode = "send", { invoiceId = null, invoiceKind = "standard" } = {}) => {
      if (!order?.dbId) return;

      setEmailError("");
      setSendInvoiceEmailModal({
        open: true,
        order,
        mode,
        invoiceId: invoiceId || order.invoice?.invoiceId || null,
        invoiceKind,
      });
    },
    []
  );

  const closeSendInvoiceEmailModal = useCallback(() => {
    setSendInvoiceEmailModal({
      open: false,
      order: null,
      mode: "send",
      invoiceId: null,
      invoiceKind: "standard",
    });
  }, []);

  const handleSubmitSendInvoiceEmail = useCallback(
    async (emails) => {
      const { order, mode, invoiceId, invoiceKind } = sendInvoiceEmailModal;

      if (!order?.dbId) {
        throw new Error("Order not found");
      }

      setEmailError("");

      if (invoiceKind === "companyPortalRecords") {
        setEmailingRecordsOrderId(order.dbId);
        try {
          await emailCompanyOrderRecords(order.dbId, { emails });
          await fetchOrders({ silent: true, force: true });
        } finally {
          setEmailingRecordsOrderId(null);
        }
        return;
      }

      if (invoiceKind === "records") {
        setEmailingRecordsOrderId(order.dbId);
        try {
          const result = await mailCompletedOrder(order.dbId, {
            emails,
            deliveryDate: getTodayInputDate(),
          });
          const sentDate = result.readyDate || result.sentDate || getTodayInputDate();
          setOrders((prev) =>
            prev.map((item) =>
              item.dbId === order.dbId
                ? {
                    ...item,
                    orderStatus: "Completed",
                    readyDate: sentDate,
                    deliveryDate: sentDate,
                    mailSentDate: sentDate,
                  }
                : item
            )
          );
          await fetchOrders({ silent: true, force: true });
        } finally {
          setEmailingRecordsOrderId(null);
        }
        return;
      }

      if (invoiceKind === "cnr") {
        setEmailingCnrOrderId(order.dbId);
        try {
          const result = await sendCnrRecord(order.dbId, {
            emails,
            sentDate: getTodayInputDate(),
          });
          const sentDate = result.sentDate || getTodayInputDate();
          setOrders((prev) =>
            prev.map((item) =>
              item.dbId === order.dbId
                ? {
                    ...item,
                    cnrDateSent: sentDate,
                    cnrDelivery: "email",
                  }
                : item
            )
          );
          await fetchOrders({ silent: true, force: true });
        } finally {
          setEmailingCnrOrderId(null);
        }
        return;
      }

      if (invoiceKind === "certification") {
        await sendCertificateOfRecords(order.dbId, {
          emails,
          sentDate: getTodayInputDate(),
        });
        return;
      }

      if (invoiceKind === "xray") {
        setEmailingXrayOrderId(order.dbId);
        try {
          if (mode === "resend") {
            await resendXrayInvoices([order.dbId], emails);
          } else {
            await emailXrayInvoiceByOrderId(order.dbId, emails);
          }
          await fetchOrders({ silent: true, force: true });
        } finally {
          setEmailingXrayOrderId(null);
        }
        return;
      }

      const normalizedInvoiceId = Number(invoiceId || order?.invoice?.invoiceId);

      if (!Number.isFinite(normalizedInvoiceId)) {
        throw new Error("Invoice not found for this order");
      }

      if (mode === "resend") {
        setEmailingOrderId(order.dbId);
        try {
          await resendInvoices([normalizedInvoiceId], emails);
          await fetchOrders({ silent: true, force: true });
        } finally {
          setEmailingOrderId(null);
        }
        return;
      }

      setSendingInvoiceOrderId(order.dbId);
      try {
        await sendInvoices([normalizedInvoiceId], emails);
        await fetchOrders({ silent: true, force: true });
      } finally {
        setSendingInvoiceOrderId(null);
      }
    },
    [fetchOrders, sendInvoiceEmailModal]
  );

  const handleSendInvoice = useCallback(
    (order) => {
      openSendInvoiceEmailModal(order, "send");
    },
    [openSendInvoiceEmailModal]
  );

  const handleResendInvoiceEmail = useCallback(
    (order) => {
      openSendInvoiceEmailModal(order, "resend");
    },
    [openSendInvoiceEmailModal]
  );

  const handleEmailXrayInvoice = useCallback(
    (order) => {
      openSendInvoiceEmailModal(order, "send", { invoiceKind: "xray" });
    },
    [openSendInvoiceEmailModal]
  );

  const handleSendCnrRecord = useCallback(
    (order) => {
      openSendInvoiceEmailModal(order, "send", { invoiceKind: "cnr" });
    },
    [openSendInvoiceEmailModal]
  );

  const handleResendCnrRecord = useCallback(
    (order) => {
      openSendInvoiceEmailModal(order, "resend", { invoiceKind: "cnr" });
    },
    [openSendInvoiceEmailModal]
  );

  const handleResendInvoice = useCallback(
    (order, invoiceId) => {
      openSendInvoiceEmailModal(order, "resend", { invoiceId });
    },
    [openSendInvoiceEmailModal]
  );

  const handleEmailDelivery = useCallback(
    (order) => {
      if (!order?.dbId || getDeliveryStatus(order, "mail").completed) return;

      if (!order.hasAnyRecordsUploaded) {
        setDeliveryError("Scan records before sending email");
        return;
      }

      setDeliveryError("");
      const isCompanyPortalOrder =
        companyPortalMode || order.creationSource === "company_portal";
      openSendInvoiceEmailModal(order, "send", {
        invoiceKind: isCompanyPortalOrder ? "companyPortalRecords" : "records",
      });
    },
    [companyPortalMode, openSendInvoiceEmailModal]
  );


  // Refresh workflow/status changes made elsewhere when the user comes back
  // to the tab or window. No polling, so there is no idle network cost.
  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") {
        fetchOrders({ silent: true });
      }
    };

    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);

    return () => {
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [fetchOrders]);

  useDataRefresh(() => fetchOrders({ silent: true, force: true }));

  const mapSharedOrderRow = useCallback(
    (raw) => toRenderOrder(raw, companyPortalMode),
    [companyPortalMode]
  );

  const busyOrderIds = useMemo(
    () =>
      [
        selectedInvoiceOrder?.dbId,
        selectedXrayOrder?.dbId,
        selectedCoverSheetOrder?.dbId,
        selectedXrayCoverSheetOrder?.dbId,
        selectedCnrOrder?.dbId,
        selectedCertificationOrder?.dbId,
        selectedCopyLetterOrder?.dbId,
        selectedLogOrder?.dbId,
        selectedNoteListOrder?.dbId,
        selectedAddNoteOrder?.dbId,
        selectedMedicalRecordsOrder?.dbId,
        selectedPrintInvoiceOrder?.dbId,
        selectedPrintXrayInvoiceOrder?.dbId,
        selectedSubpoenaOrder?.dbId,
        selectedPickupOrder?.dbId,
        selectedFaxOrder?.dbId,
        facilityModalState?.order?.dbId,
        restoreInProcessOrder?.dbId,
        cnrTextModal?.dbId,
        cnrTextModal?.order?.dbId,
        sendInvoiceEmailModal.open ? sendInvoiceEmailModal.order?.dbId : null,
        deleteModal.open ? deleteModal.order?.dbId : null,
        cancelModal.open ? cancelModal.order?.dbId : null,
        restoreModal.open ? restoreModal.order?.dbId : null,
        removeRecordsModal.open ? removeRecordsModal.order?.dbId : null,
      ].filter(Boolean),
    [
      selectedInvoiceOrder,
      selectedXrayOrder,
      selectedCoverSheetOrder,
      selectedXrayCoverSheetOrder,
      selectedCnrOrder,
      selectedCertificationOrder,
      selectedCopyLetterOrder,
      selectedLogOrder,
      selectedNoteListOrder,
      selectedAddNoteOrder,
      selectedMedicalRecordsOrder,
      selectedPrintInvoiceOrder,
      selectedPrintXrayInvoiceOrder,
      selectedSubpoenaOrder,
      selectedPickupOrder,
      selectedFaxOrder,
      facilityModalState,
      restoreInProcessOrder,
      cnrTextModal,
      sendInvoiceEmailModal,
      deleteModal,
      cancelModal,
      restoreModal,
      removeRecordsModal,
    ]
  );

  useSharedOrderRowSync({
    orders,
    setOrders,
    mapRow: mapSharedOrderRow,
    paused: loading || actionLoading,
    busyOrderIds,
  });

  const filteredOrders = useMemo(() => {
    if (useServerPagination) {
      return orders;
    }

    let result = filterOrdersByPeriod(orders, normalizedFilters.period);

    if (excludeCompleted) {
      result = result.filter(
        (order) => `${order.orderStatus || ""}`.trim() !== "Completed"
      );
    }

    if (normalizedFilters.rushLevel) {
      result = result.filter(
        (order) => order.rushLabel === normalizedFilters.rushLevel
      );
    }

    if (createdSortDir === "asc" || createdSortDir === "desc") {
      const factor = createdSortDir === "asc" ? 1 : -1;
      result = [...result].sort((a, b) => {
        const aTime = new Date(a.createdAt || a.created_at || 0).getTime();
        const bTime = new Date(b.createdAt || b.created_at || 0).getTime();
        const safeA = Number.isNaN(aTime) ? 0 : aTime;
        const safeB = Number.isNaN(bTime) ? 0 : bTime;
        return (safeA - safeB) * factor;
      });
    }

    return result;
  }, [
    orders,
    useServerPagination,
    normalizedFilters.period,
    normalizedFilters.rushLevel,
    excludeCompleted,
    createdSortDir,
  ]);

  const totalPages = useServerPagination
    ? Math.max(
        currentPage +
          (!isFetching && keysetPagination.hasMore && keysetPagination.nextCursor
            ? 1
            : 0),
        1
      )
    : Math.max(1, Math.ceil(filteredOrders.length / ORDERS_PER_PAGE));

  const safeCurrentPage = Math.min(currentPage, totalPages);

  useEffect(() => {
    if (currentPage !== safeCurrentPage) {
      setCurrentPage(safeCurrentPage);
    }
  }, [currentPage, safeCurrentPage]);

  const currentOrders = useMemo(() => {
    if (useServerPagination) {
      return filteredOrders;
    }
    const startIndex = (safeCurrentPage - 1) * ORDERS_PER_PAGE;
    return filteredOrders.slice(startIndex, startIndex + ORDERS_PER_PAGE);
  }, [useServerPagination, safeCurrentPage, filteredOrders]);

  const startRecord = useServerPagination
    ? currentOrders.length === 0
      ? 0
      : (safeCurrentPage - 1) * ORDERS_PER_PAGE + 1
    : filteredOrders.length === 0
    ? 0
    : (safeCurrentPage - 1) * ORDERS_PER_PAGE + 1;

  const endRecord = useServerPagination
    ? startRecord + currentOrders.length - (currentOrders.length ? 1 : 0)
    : Math.min(safeCurrentPage * ORDERS_PER_PAGE, filteredOrders.length);

  useEffect(() => {
    if (typeof onSummaryChange !== "function") return;

    const totalCount = useServerPagination
      ? keysetPagination.hasMore
        ? endRecord + 1
        : endRecord
      : filteredOrders.length;

    onSummaryChange({
      total: totalCount,
      startRecord,
      endRecord,
      currentPage: safeCurrentPage,
      totalPages,
      loading,
    });
  }, [
    onSummaryChange,
    filteredOrders.length,
    useServerPagination,
    keysetPagination.hasMore,
    startRecord,
    endRecord,
    safeCurrentPage,
    totalPages,
    loading,
  ]);

  const scrollToTableTop = () => {
    tableTopRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  const paginationBusy = loading || isFetching;
  const canGoPreviousPage = !paginationBusy && safeCurrentPage > 1;
  const canGoNextPage = useServerPagination
    ? !paginationBusy &&
      keysetPagination.hasMore &&
      keysetPagination.nextCursor != null &&
      currentOrders.length > 0
    : !paginationBusy &&
      safeCurrentPage < totalPages &&
      currentOrders.length > 0;

  const goToPreviousPage = () => {
    if (!canGoPreviousPage) return;
    setCurrentPage((page) => Math.max(page - 1, 1));
    scrollToTableTop();
  };

  const goToNextPage = () => {
    if (!canGoNextPage) return;

    if (useServerPagination) {
      const nextCursor = keysetPagination.nextCursor;
      // Lock next immediately so slow remote responses cannot be double-advanced.
      setKeysetPagination((prev) => ({
        ...prev,
        hasMore: false,
        nextCursor: null,
      }));
      setCursorHistory((prev) => {
        const next = prev.slice(0, safeCurrentPage);
        next[safeCurrentPage] = nextCursor;
        cursorHistoryRef.current = next;
        return next;
      });
      setCurrentPage(safeCurrentPage + 1);
      scrollToTableTop();
      return;
    }

    setCurrentPage((page) => Math.min(page + 1, totalPages));
    scrollToTableTop();
  };

  const isReportView = Boolean(showDoctorColumn && excludeCompleted);
  const tableColumnCount = personalMode
    ? 10
    : isReportView
      ? 13
      : 12;

  const persistFiltersForOrderEdit = (returnTo) => {
    rememberFiltersBeforeOrderEdit(returnTo, {
      ...filters,
      facility: normalizedFilters.facility,
      company: normalizedFilters.company,
      year: normalizedFilters.year,
      period: normalizedFilters.period,
      status: normalizedFilters.status,
      search: normalizedFilters.search,
      creationSource:
        filters.creationSource || normalizedFilters.creationSource || "",
      sortDir: sortDir || filters.sortDir || "",
    });
  };

  const listBackHref =
    listReturnTo === "reports"
      ? "/reports"
      : listReturnTo === "personal-orders" || personalMode
        ? "/personal-orders"
        : listReturnTo === "company-orders" || companyPortalMode
          ? "/company-orders"
          : "/orders";

  return (
    <>
      <section
        ref={tableTopRef}
        className="flex min-h-[520px] min-w-0 flex-1 flex-col overflow-hidden rounded-[9px] border border-[#E2E8F0] bg-white shadow-sm"
      >
        <div className="flex flex-col gap-2 border-b border-[#F1F5F9] px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-[13px] font-semibold text-[#111827]">
            All Orders
          </h2>

          <p
            className="text-[11px] text-[#94A3B8]"
            title={
              lastUpdatedAt
                ? lastUpdatedAt.toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })
                : undefined
            }
          >
            {loading && !lastUpdatedAt
              ? "Updating..."
              : lastUpdatedAt
                ? `Last updated: ${formatLastUpdatedLabel(lastUpdatedAt)}`
                : ""}
          </p>
        </div>

        {emailError && (
          <p className="border-b border-red-100 bg-red-50 px-4 py-2 text-[11px] text-red-600">
            {emailError}
          </p>
        )}

        {deliveryError && (
          <p className="border-b border-red-100 bg-red-50 px-4 py-2 text-[11px] text-red-600">
            {deliveryError}
          </p>
        )}

        {actionError && (
          <p className="border-b border-red-100 bg-red-50 px-4 py-2 text-[11px] text-red-600">
            {actionError}
          </p>
        )}

        {fitToWindow && (
          <style>{`
            /* Below xl: keep readable columns and allow horizontal scroll */
            .orders-table-fit {
              width: 100%;
              min-width: 1420px;
              table-layout: auto;
            }

            @media (min-width: 1280px) {
              .orders-table-fit {
                font-size: 10px;
                min-width: 0;
                table-layout: fixed;
              }
              .orders-table-fit th,
              .orders-table-fit td {
                padding-left: 5px !important;
                padding-right: 5px !important;
                padding-top: 8px !important;
                padding-bottom: 8px !important;
                width: auto !important;
              }
              .orders-table-fit td {
                white-space: normal;
                overflow-wrap: anywhere;
                word-break: break-word;
              }
              .orders-table-fit td *:not(button):not(button *) {
                white-space: normal;
                overflow-wrap: anywhere;
                word-break: break-word;
              }
              ${
                isReportView
                  ? `
              .orders-table-fit th:nth-child(1),
              .orders-table-fit td:nth-child(1) { width: 5% !important; }
              .orders-table-fit th:nth-child(2),
              .orders-table-fit td:nth-child(2) { width: 7% !important; }
              .orders-table-fit th:nth-child(3),
              .orders-table-fit td:nth-child(3) { width: 7% !important; }
              .orders-table-fit th:nth-child(4),
              .orders-table-fit td:nth-child(4) { width: 9% !important; }
              .orders-table-fit th:nth-child(5),
              .orders-table-fit td:nth-child(5) { width: 8% !important; }
              .orders-table-fit th:nth-child(6),
              .orders-table-fit td:nth-child(6) { width: 8% !important; }
              .orders-table-fit th:nth-child(7),
              .orders-table-fit td:nth-child(7) { width: 8% !important; }
              .orders-table-fit th:nth-child(8),
              .orders-table-fit td:nth-child(8) { width: 8% !important; }
              .orders-table-fit th:nth-child(9),
              .orders-table-fit td:nth-child(9) { width: 8% !important; }
              .orders-table-fit th:nth-child(10),
              .orders-table-fit td:nth-child(10) { width: 8% !important; }
              .orders-table-fit th:nth-child(11),
              .orders-table-fit td:nth-child(11) { width: 8% !important; }
              .orders-table-fit th:nth-child(12),
              .orders-table-fit td:nth-child(12) { width: 6% !important; }
              .orders-table-fit th:nth-child(13),
              .orders-table-fit td:nth-child(13) { width: 10% !important; }
                  `
                  : `
              .orders-table-fit th:nth-child(1),
              .orders-table-fit td:nth-child(1) { width: 6% !important; }
              .orders-table-fit th:nth-child(2),
              .orders-table-fit td:nth-child(2) { width: 7% !important; }
              .orders-table-fit th:nth-child(3),
              .orders-table-fit td:nth-child(3) { width: 7% !important; }
              .orders-table-fit th:nth-child(4),
              .orders-table-fit td:nth-child(4) { width: 9% !important; }
              .orders-table-fit th:nth-child(5),
              .orders-table-fit td:nth-child(5) { width: 9% !important; }
              .orders-table-fit th:nth-child(6),
              .orders-table-fit td:nth-child(6) { width: 8% !important; }
              .orders-table-fit th:nth-child(7),
              .orders-table-fit td:nth-child(7) { width: 9% !important; }
              .orders-table-fit th:nth-child(8),
              .orders-table-fit td:nth-child(8) { width: 9% !important; }
              .orders-table-fit th:nth-child(9),
              .orders-table-fit td:nth-child(9) { width: 10% !important; }
              .orders-table-fit th:nth-child(10),
              .orders-table-fit td:nth-child(10) { width: 8% !important; }
              .orders-table-fit th:nth-child(11),
              .orders-table-fit td:nth-child(11) { width: 7% !important; }
              .orders-table-fit th:nth-child(12),
              .orders-table-fit td:nth-child(12) { width: 11% !important; }
                  `
              }
              .orders-table-fit .order-action-btn {
                display: inline-flex !important;
                align-items: center !important;
                justify-content: center !important;
                box-sizing: border-box;
                width: 100%;
                max-width: 100%;
                min-width: 0;
                height: 24px;
                min-height: 24px;
                padding: 0 6px;
                font-size: 10px;
                line-height: 1 !important;
                gap: 4px;
                white-space: nowrap !important;
                overflow: hidden;
                overflow-wrap: normal !important;
                word-break: keep-all !important;
              }
              .orders-table-fit .order-action-btn svg {
                width: 10px;
                height: 10px;
                flex-shrink: 0;
                display: block;
              }
              .orders-table-fit .order-actions {
                gap: 8px;
              }
            }
          `}</style>
        )}

        <div
          className={`min-h-0 flex-1 ${
            fitToWindow
              ? "overflow-auto xl:overflow-y-auto xl:overflow-x-hidden"
              : "overflow-auto"
          }`}
        >
          <table
            className={`w-full border-collapse ${
              fitToWindow ? "orders-table-fit" : "min-w-[1420px]"
            }`}
          >
            <thead className="sticky top-0 z-10 bg-white">
              <tr className="border-b border-[#F1F5F9] text-left text-[11px] font-semibold text-[#64748B]">
                <th
                  className={`${
                    companyPortalMode ? "w-[132px]" : personalMode ? "w-[118px]" : "w-[90px]"
                  } px-4 py-3`}
                >
                  ID
                </th>
                <th className="w-[100px] px-4 py-3">
                  <OrderDateSortHeader
                    sortDir={sortDir}
                    onSortDirChange={onCreatedSortDirChange}
                  />
                </th>
                <th className="w-[110px] px-4 py-3">Notes</th>
                <th className="w-[150px] px-4 py-3">
                  {personalMode ? "Applicant" : "Case"}
                </th>
                {!personalMode && isReportView && (
                  <th className="w-[130px] px-4 py-3">Applicant</th>
                )}
                <th className="w-[160px] px-4 py-3">
                  {showDoctorColumn ? "Doctor" : "Facility"}
                </th>
                <th className="w-[125px] px-4 py-3">Status</th>
                <th className="w-[170px] px-4 py-3">Invoice</th>
                <th className="w-[170px] px-4 py-3">Records</th>
                {!personalMode && (
                  <th className="w-[280px] px-4 py-3">Company</th>
                )}
                <th className="w-[110px] px-4 py-3">
                  {personalMode ? "DOB" : "DOB/SSN/DOI"}
                </th>
                {!personalMode && (
                  <th className="w-[130px] px-4 py-3">Forms</th>
                )}
                <th className="w-[120px] px-4 py-3" />
              </tr>
            </thead>

            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={tableColumnCount}
                    className="px-4 py-10 text-center text-[12px] font-medium text-[#94A3B8]"
                  >
                    Loading orders...
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td
                    colSpan={tableColumnCount}
                    className="px-4 py-10 text-center text-[12px] font-semibold text-red-500"
                  >
                    {error}
                  </td>
                </tr>
              ) : currentOrders.length === 0 ? (
                <tr>
                  <td
                    colSpan={tableColumnCount}
                    className="px-4 py-10 text-center text-[12px] font-medium text-[#94A3B8]"
                  >
                    No orders match the selected filters.
                  </td>
                </tr>
              ) : (
                currentOrders.map((order, orderIndex) => {
                  const incompleteRequired = orderHasIncompleteRequiredFields(order);
                  const personalIncompletePrefix = isPersonalOrderIncompleteDisplay(
                    order,
                    personalMode
                  );
                  const incompleteTooltip = buildIncompleteOrderTooltip(
                    order.missingRequiredFields
                  );
                  const orderDateDisplay = getOrderDateColumnDisplay(order);
                  const openHoverUpward =
                    orderIndex === currentOrders.length - 1;

                  return (
                  <tr
                    key={order.dbId}
                    className={getOrderRowClassName(order.orderStatus)}
                  >
                    <td className="px-4 py-5 align-top">
                      <div className="w-full min-w-0">
                        <div className="inline-flex min-w-0 items-start gap-1">
                          {incompleteRequired && !personalIncompletePrefix && (
                            <IncompleteOrderIndicator
                              missingFields={order.missingRequiredFields}
                            />
                          )}
                          <Link
                            href={buildOrderEditHref(order.dbId, {
                              returnTo: resolveOrderListReturnTo(order, {
                                personalMode,
                                companyPortalMode,
                                listReturnTo,
                              }),
                            })}
                            onClick={() =>
                              persistFiltersForOrderEdit(
                                resolveOrderListReturnTo(order, {
                                  personalMode,
                                  companyPortalMode,
                                  listReturnTo,
                                })
                              )
                            }
                            className="min-w-0 font-semibold text-[#007F96] hover:underline"
                            title={
                              incompleteRequired ? incompleteTooltip : undefined
                            }
                          >
                            {incompleteRequired && personalIncompletePrefix ? (
                              <>
                                <span
                                  className="font-bold text-red-600"
                                  aria-hidden="true"
                                >
                                  !{" "}
                                </span>
                                <span className="break-all">{order.id}</span>
                              </>
                            ) : (
                              order.id
                            )}
                          </Link>
                        </div>

                        {order.creationSource === "auto" &&
                          order.hasIncompleteRequiredFields && (
                            <p className="mt-1 text-[10px] italic text-[#64748B]">
                              Unprocessed
                            </p>
                          )}
                        {order.creationSource === "auto" &&
                          !order.hasIncompleteRequiredFields && (
                            <p className="mt-1 text-[10px] italic text-[#0F766E]">
                              Processed
                            </p>
                          )}
                        {order.creationSource === "auto" && order.facilityMismatch && (
                          <div className="mt-1.5 w-full">
                            <div
                              className="flex w-full items-start gap-1 rounded-[6px] border border-amber-200 bg-amber-50 px-1.5 py-1"
                              title={
                                order.extractedFacilityName
                                  ? `The batchscan extracted facility is ${order.extractedFacilityName}`
                                  : "The batchscan extracted facility differs from your selection"
                              }
                            >
                              <span
                                className="mt-px shrink-0 text-[11px] font-bold leading-none text-amber-600"
                                aria-hidden="true"
                              >
                                !
                              </span>
                              <p className="min-w-0 flex-1 text-[10px] font-medium leading-snug text-amber-700">
                                {order.extractedFacilityName
                                  ? `The batchscan extracted facility is ${order.extractedFacilityName}`
                                  : "The batchscan extracted facility differs from your selection"}
                              </p>
                            </div>
                          </div>
                        )}
                        {order.creationSource === "personal_portal" && (
                          <p className="mt-1 text-[10px] font-medium text-[#0097B2]">
                            Personal Portal
                          </p>
                          )}

                        {(companyPortalMode || personalMode) &&
                          order.facilityNotInSystem && (
                          <div className="mt-1.5 w-full space-y-1">
                            <div className="flex w-full items-start gap-1 rounded-[6px] border border-red-200 bg-red-50 px-1.5 py-1">
                              <span
                                className="mt-px shrink-0 text-[11px] font-bold leading-none text-red-500"
                                title="Facility not in our system"
                                aria-hidden="true"
                              >
                                !
                              </span>
                              <p className="min-w-0 flex-1 text-[10px] font-medium leading-snug text-red-600">
                                Facility not in our system
                              </p>
                            </div>
                            <div className="flex w-full flex-col items-start gap-0.5">
                              <button
                                type="button"
                                onClick={() =>
                                  setFacilityModalState({
                                    order,
                                    startAtConfirm: false,
                                  })
                                }
                                className="text-left text-[10px] font-semibold text-[#007F96] hover:underline"
                              >
                                View details
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setFacilityModalState({
                                    order,
                                    startAtConfirm: true,
                                  })
                                }
                                className="text-left text-[10px] font-semibold text-red-600 hover:underline"
                              >
                                Facility couldn&apos;t be found
                              </button>
                            </div>
                          </div>
                        )}
                        {((companyPortalMode &&
                          order.companyPortalStatus === "No facility") ||
                          (personalMode &&
                            order.personalPortalStatus === "no_facility")) && (
                            <div className="mt-1.5 w-full space-y-1">
                              <p className="w-full rounded-[6px] border border-red-200 bg-red-50 px-1.5 py-1 text-[10px] font-medium leading-snug text-red-600">
                                No facility — order ended
                              </p>
                              <button
                                type="button"
                                onClick={() => setRestoreInProcessOrder(order)}
                                className="text-left text-[10px] font-semibold text-[#007F96] hover:underline"
                              >
                                Back to In Process
                              </button>
                            </div>
                          )}
                      </div>

                      {order.dateRequestedDisplay || order.dateRequested ? (
                        <p className="mt-1 text-[10px] font-medium text-[#64748B]">
                          Req:{" "}
                          {order.dateRequestedDisplay ||
                            formatShortDate(order.dateRequested)}
                        </p>
                      ) : null}

                      <button
                        type="button"
                        onClick={() => setSelectedLogOrder(order)}
                        className="mt-1 block text-left text-[10px] font-medium text-[#007F96] underline"
                      >
                        Order Log
                      </button>
                    </td>

                    <td className="px-4 py-5 align-top">
                      {orderDateDisplay ? (
                        <p className="text-[11px] font-medium text-[#334155]">
                          {orderDateDisplay}
                        </p>
                      ) : (
                        <p className="text-[11px] font-medium text-[#94A3B8]">—</p>
                      )}
                    </td>

                    <td className="px-4 py-5 align-top">
                      <OrderNotesColumn
                        order={order}
                        openUpward={openHoverUpward}
                        onOpenNotes={setSelectedNoteListOrder}
                        onOpenAddNote={setSelectedAddNoteOrder}
                      />
                    </td>

                    <td className="px-4 py-5 align-top">
                      {personalMode ? (
                        <p className="font-semibold text-[#111827]">
                          {order.applicant || "—"}
                        </p>
                      ) : isReportView ? (
                        <ReportCaseCell
                          order={order}
                          onOpenSubpoena={() => setSelectedSubpoenaOrder(order)}
                        />
                      ) : (
                        <>
                          <p className="font-semibold text-[#111827]">
                            {order.applicant}
                          </p>

                          <p className="mt-1 text-[10px] text-[#64748B]">
                            {order.orderRef}
                          </p>

                          {order.hasSubpoenaFile && (
                            <div className="mt-2">
                              <button
                                type="button"
                                onClick={() => setSelectedSubpoenaOrder(order)}
                                className="block text-left text-[10px] font-semibold text-[#059669] hover:underline"
                              >
                                ✓ Subpoena
                              </button>
                              {order.subpoenaDateDisplay || order.subpoenaDate ? (
                                <p className="mt-1 text-[10px] font-medium text-[#64748B]">
                                  Subpoena Date:{" "}
                                  {order.subpoenaDateDisplay ||
                                    formatShortDate(order.subpoenaDate)}
                                </p>
                              ) : null}
                              {order.subpoenaUploadedAtDisplay ||
                              order.subpoenaUploadedAt ? (
                                <p className="mt-1 text-[10px] font-medium text-[#64748B]">
                                  Subpoena Uploaded Date:{" "}
                                  {order.subpoenaUploadedAtDisplay ||
                                    formatShortDate(order.subpoenaUploadedAt)}
                                </p>
                              ) : null}
                            </div>
                          )}

                          {order.court && (
                            <p className="mt-1 text-[10px] font-semibold text-[#334155]">
                              {order.court}
                            </p>
                          )}

                          {order.recNumber && (
                            <p className="mt-1 text-[10px] font-medium text-[#64748B]">
                              REC {order.recNumber}
                            </p>
                          )}
                        </>
                      )}
                    </td>

                    {!personalMode && isReportView && (
                      <td className="px-4 py-5 align-top">
                        <p className="font-semibold text-[#111827]">
                          {order.applicant || "—"}
                        </p>
                      </td>
                    )}

                    <td className="px-4 py-5 align-top">
                      {showDoctorColumn ? (
                        <p className="font-semibold text-[#111827]">
                          {order.doctor || "—"}
                        </p>
                      ) : (
                        <>
                          <p className="font-semibold text-[#111827]">
                            {order.facilityName || "—"}
                          </p>

                          {order.facilityInfo?.address ? (
                            <p className="mt-1 text-[10px] leading-[15px] text-[#64748B]">
                              {order.facilityInfo.address}
                            </p>
                          ) : null}
                        </>
                      )}
                    </td>

                    <td className="px-4 py-5 align-top">
                      {!personalMode ? (
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <OrderStatusBadge status={order.displayOrderStatus} />
                          {order.rushLabel ? (
                            <RushBadge rush={order.rushLabel} order={order} />
                          ) : null}
                        </div>
                      ) : null}

                      {personalMode ? (
                        <div className="space-y-1">
                          <WorkflowStageItem
                            stage={buildPersonalReviewRecordsStage(order)}
                            href={getPersonalScanRecordsHref(order)}
                            onPreviewRecords={() =>
                              setSelectedMedicalRecordsOrder(order)
                            }
                            onRemoveRecords={() => openRemoveRecordsModal(order)}
                            removingRecords={
                              actionLoading &&
                              removeRecordsModal.order?.dbId === order.dbId
                            }
                          />
                          {buildPersonalPortalStatusStages(order.portalStatus, {
                            hasRecords:
                              Boolean(order.hasMedicalRecords) ||
                              Boolean(order.hasAnyRecordsUploaded),
                            hasInvoice: Boolean(
                              order.invoice &&
                                !order.invoice.createOnly &&
                                (order.invoice.invoiceId ||
                                  order.invoice.invoiceDate ||
                                  order.invoice.reviewDate)
                            ),
                            invoicesPaid:
                              `${order.invoiceStatus || ""}`.toLowerCase() ===
                                "paid" ||
                              `${order.invoice?.status || ""}`.toLowerCase() ===
                                "paid",
                          }).map((stage) => (
                            <WorkflowStageItem
                              key={stage.key}
                              stage={stage}
                            />
                          ))}
                        </div>
                      ) : isDeletedOrderStatus(order.orderStatus) ? (
                        <div className="space-y-2">
                          {order.statusBeforeInactive ? (
                            <p className="text-[10px] text-[#94A3B8]">
                              Previous: {order.statusBeforeInactive}
                            </p>
                          ) : null}
                        </div>
                      ) : (
                        <div className="space-y-1">
                          {order.status.map((stage) => (
                            <WorkflowStageItem
                              key={stage.key || stage.label}
                              stage={stage}
                              href={getWorkflowStageHref(stage, order, {
                                listReturnTo,
                                personalMode,
                                companyPortalMode,
                              })}
                              onNavigateToHref={() => {
                                const href = getWorkflowStageHref(stage, order, {
                                  listReturnTo,
                                  personalMode,
                                  companyPortalMode,
                                });
                                if (
                                  href &&
                                  href.startsWith("/orders/new?")
                                ) {
                                  persistFiltersForOrderEdit(
                                    resolveOrderListReturnTo(order, {
                                      listReturnTo,
                                      personalMode,
                                      companyPortalMode,
                                    })
                                  );
                                }
                              }}
                              onAdvance={
                                stage.canAdvance
                                  ? () =>
                                      handleAdvanceCompanyPortalStage(
                                        order,
                                        stage.key
                                      )
                                  : undefined
                              }
                              onEmailRecords={
                                stage.showEmailRecords
                                  ? () => handleEmailCompanyPortalRecords(order)
                                  : undefined
                              }
                              onResend={
                                stage.showResend
                                  ? () =>
                                      handleResendInvoice(order, stage.invoiceId)
                                  : undefined
                              }
                              onPreviewRecords={
                                stage.showPreviewRecords
                                  ? () => setSelectedMedicalRecordsOrder(order)
                                  : undefined
                              }
                              onRemoveRecords={
                                stage.showRemoveRecords
                                  ? () => openRemoveRecordsModal(order)
                                  : undefined
                              }
                              removingRecords={
                                actionLoading &&
                                removeRecordsModal.order?.dbId === order.dbId
                              }
                              resending={
                                emailingOrderId === order.dbId ||
                                sendingInvoiceOrderId === order.dbId
                              }
                            />
                          ))}

                          {isCancelledOrderStatus(order.orderStatus) &&
                          order.cancelReason ? (
                            <p className="max-w-[140px] pt-1 text-[10px] leading-snug text-[#991B1B]">
                              Reason: {order.cancelReason}
                            </p>
                          ) : null}
                        </div>
                      )}

                      {!personalMode &&
                      (order.orderStatus === "Ready to Pickup" ||
                        order.orderStatus === "Completed") &&
                        (() => {
                        const deliveryActions = getCompletedDeliveryActions(order);
                        const mailStatus = getDeliveryStatus(order, "mail");
                        const faxStatus = getDeliveryStatus(order, "fax");
                        const pickupStatus = getDeliveryStatus(order, "pickup");

                        if (
                          !deliveryActions.mail &&
                          !deliveryActions.fax &&
                          !deliveryActions.pickup
                        ) {
                          return null;
                        }

                        return (
                          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                            {deliveryActions.mail && (
                              <div className="flex flex-col items-start gap-0.5">
                                <CompletedDeliveryLink
                                  label="Email"
                                  completed={mailStatus.completed}
                                  hoverText={mailStatus.hoverText}
                                  loading={
                                    emailingRecordsOrderId === order.dbId ||
                                    processingDeliveryKey === `${order.dbId}-mail`
                                  }
                                  onClick={() => handleEmailDelivery(order)}
                                />
                                {mailStatus.completed ? (
                                  <span
                                    title={
                                      order.recordsDownloaded
                                        ? order.recordsDownloadedAtDisplay ||
                                          formatShortDate(
                                            order.recordsDownloadedAt
                                          ) ||
                                          "Records downloaded"
                                        : "Waiting for recipient to download records"
                                    }
                                    className={`text-[10px] font-semibold ${
                                      order.recordsDownloaded
                                        ? "text-[#059669]"
                                        : "text-[#B45309]"
                                    }`}
                                  >
                                    {order.recordsDownloaded
                                      ? "Viewed"
                                      : "Not viewed"}
                                  </span>
                                ) : null}
                              </div>
                            )}
                            {deliveryActions.fax && (
                              <CompletedDeliveryLink
                                label="Fax"
                                completed={faxStatus.completed}
                                hoverText={faxStatus.hoverText}
                                onClick={() => setSelectedFaxOrder(order)}
                              />
                            )}
                            {deliveryActions.pickup && (
                              <CompletedDeliveryLink
                                label="Pickup"
                                completed={pickupStatus.completed}
                                hoverText={pickupStatus.hoverText}
                                onClick={() => setSelectedPickupOrder(order)}
                              />
                            )}
                          </div>
                        );
                      })()}

                    </td>

                    <td className="px-4 py-5 align-top">
                      <InvoiceBlock
                        invoice={order.invoice}
                        orderDbId={order.dbId}
                        pendingFacilitySearchFee={
                          order.pendingFacilitySearchFee || 0
                        }
                        isCnr={order.certificateNoRecords}
                        cnrDelivery={order.cnrDelivery}
                        cnrDateSent={order.cnrDateSent}
                        onCnrReasonClick={() =>
                          openCnrTextModal(setCnrTextModal, order, "Reason")
                        }
                        allowStandardInvoice={true}
                        blockInvoiceCreate={
                          (companyPortalMode &&
                            order.companyPortalStatus === "No facility") ||
                          (personalMode &&
                            order.personalPortalStatus === "no_facility")
                        }
                        providerEmail={
                          order.providerEmail ||
                          order.invoice?.providerEmail ||
                          ""
                        }
                        onCreateInvoice={() => {
                          setInvoiceModalMode("create");
                          setSelectedInvoiceOrder(order);
                        }}
                        onReviewInvoice={() => {
                          setInvoiceModalMode("edit");
                          setSelectedInvoiceOrder({
                            ...order,
                            invoiceId: order.invoice?.invoiceId,
                            invoice: {
                              ...order.invoice,
                              invoiceId: order.invoice?.invoiceId,
                            },
                          });
                        }}
                        onCreateXrayInvoice={() => setSelectedXrayOrder(order)}
                        onReviewXrayInvoice={() => setSelectedXrayOrder(order)}
                        onCoverSheet={() => setSelectedCoverSheetOrder(order)}
                        onXrayCoverSheet={() =>
                          setSelectedXrayCoverSheetOrder(order)
                        }
                        onSendInvoice={() => handleSendInvoice(order)}
                        onResendInvoice={() => handleResendInvoiceEmail(order)}
                        onEmailXrayInvoice={() => handleEmailXrayInvoice(order)}
                        onSendCnrRecord={() => handleSendCnrRecord(order)}
                        onResendCnrRecord={() => handleResendCnrRecord(order)}
                        onPrintInvoice={() => setSelectedPrintInvoiceOrder(order)}
                        onPrintXrayInvoice={() =>
                          setSelectedPrintXrayInvoiceOrder(order)
                        }
                        sending={sendingInvoiceOrderId === order.dbId}
                        emailing={emailingOrderId === order.dbId}
                        emailingXray={emailingXrayOrderId === order.dbId}
                        emailingCnr={emailingCnrOrderId === order.dbId}
                      />
                    </td>

                    <td className="px-4 py-5 align-top">
                      <div className="space-y-1">
                        <RecordsBlock
                          records={order.records}
                          dateRequested={order.dateRequested}
                          dateRequestedDisplay={order.dateRequestedDisplay}
                          isCnr={order.certificateNoRecords}
                          cnrMemo={order.cnrMemo}
                          cnrDelivery={order.cnrDelivery}
                          cnrDateSent={order.cnrDateSent}
                          openUpward={openHoverUpward}
                          onPrintedSentOutClick={() =>
                            openCnrTextModal(
                              setCnrTextModal,
                              order,
                              "Printed/Sent Out Note",
                              [
                                CNR_DELIVERY_LABELS[order.cnrDelivery] ||
                                  order.cnrDelivery,
                                order.cnrDateSent
                                  ? `Date: ${formatCnrDisplayDate(order.cnrDateSent)}`
                                  : "",
                              ]
                                .filter(Boolean)
                                .join("\n")
                            )
                          }
                          onCnrNoteClick={
                            !order.cnrMemo
                              ? () =>
                                  openCnrTextModal(
                                    setCnrTextModal,
                                    order,
                                    "CNR Note"
                                  )
                              : undefined
                          }
                        />

                        {companyPortalMode &&
                        shouldShowCompanyPortalUploadLink(order) ? (
                          <Link
                            href={getCompanyPortalRecordsUploadHref(order)}
                            className="block text-[10px] font-semibold text-[#007F96] underline"
                          >
                            Upload Records
                          </Link>
                        ) : null}

                        {companyPortalMode &&
                        (order.hasAnyRecordsUploaded ||
                          order.records?.anyRecordsUploaded) ? (
                          <button
                            type="button"
                            onClick={() => setSelectedMedicalRecordsOrder(order)}
                            className="block text-left text-[10px] font-semibold text-[#007F96] underline"
                          >
                            View Uploaded Records
                          </button>
                        ) : null}
                      </div>
                    </td>

                    {!personalMode && (
                      <td className="px-4 py-5 align-top">
                        <CompanyBlock company={order.company} />
                      </td>
                    )}

                    <td className="px-4 py-5 align-top">
                      <div className="space-y-1 text-[11px] text-[#334155]">
                        {order.dob ? <p>{order.dob}</p> : <p>—</p>}
                        {!personalMode && order.ssn ? <p>{order.ssn}</p> : null}
                        {!personalMode &&
                          (order.hasDoi ? (
                            <p>{order.doiDisplay}</p>
                          ) : (
                            <Link
                              href={buildOrderEditHref(order.dbId, {
                                returnTo: resolveOrderListReturnTo(order, {
                                  personalMode,
                                  companyPortalMode,
                                  listReturnTo,
                                }),
                              })}
                              onClick={() =>
                                persistFiltersForOrderEdit(
                                  resolveOrderListReturnTo(order, {
                                    personalMode,
                                    companyPortalMode,
                                    listReturnTo,
                                  })
                                )
                              }
                              className="font-semibold text-red-500 hover:underline"
                            >
                              No DOI
                            </Link>
                          ))}
                      </div>
                    </td>

                    {!personalMode && (
                      <td className="px-4 py-5 align-top">
                        <FormsList
                          forms={order.forms}
                          onCnrClick={() => setSelectedCnrOrder(order)}
                          onCertificationClick={() =>
                            setSelectedCertificationOrder(order)
                          }
                          onCopyLetterClick={() =>
                            setSelectedCopyLetterOrder(order)
                          }
                        />
                      </td>
                    )}

                    <td className={`align-top ${fitToWindow ? "px-1 py-3" : "px-4 py-5"}`}>
                      <div
                        className={`order-actions flex flex-col gap-2 ${
                          fitToWindow ? "items-stretch" : "items-start"
                        }`}
                      >
                        {!isInactiveOrderStatus(order.orderStatus) ? (
                          <>
                            <button
                              type="button"
                              onClick={() => openDeleteModal(order)}
                              className={`order-action-btn inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] border border-red-200 bg-red-50 font-semibold leading-none text-red-500 hover:bg-red-100 ${
                                fitToWindow
                                  ? ""
                                  : "h-[28px] px-3 text-[11px]"
                              }`}
                            >
                              <TrashIcon />
                              Delete
                            </button>

                            <button
                              type="button"
                              onClick={() => openCancelModal(order)}
                              className={`order-action-btn inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] font-semibold leading-none transition hover:opacity-85 ${
                                fitToWindow
                                  ? ""
                                  : "h-[28px] px-3 text-[11px]"
                              }`}
                              style={{
                                border: "1px solid #FCD34D",
                                backgroundColor: "#FFFBEB",
                                color: "#B45309",
                              }}
                            >
                              <SmallCircleIcon />
                              Cancel
                            </button>
                          </>
                        ) : isInactiveOrderStatus(order.orderStatus) ? (
                          <>
                            <button
                              type="button"
                              onClick={() => openRestoreModal(order)}
                              className={`order-action-btn inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] border border-[#BAE6FD] bg-[#F0F9FF] font-semibold leading-none text-[#0369A1] hover:bg-[#E0F2FE] ${
                                fitToWindow
                                  ? ""
                                  : "h-[28px] px-3 text-[11px]"
                              }`}
                            >
                              <RestoreIcon />
                              Recover
                            </button>
                            {isDeletedOrderStatus(order.orderStatus) &&
                            order.deleteReason ? (
                              <DeletedReasonPreview
                                text={order.deleteReason}
                                openUpward={openHoverUpward}
                              />
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-3 border-t border-[#F1F5F9] bg-white px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4">
          <p className="text-[11px] text-[#64748B]">
            {useServerPagination
              ? keysetPagination.hasMore
                ? `Showing ${startRecord}-${endRecord} of ${endRecord}+ orders`
                : `Showing ${startRecord}-${endRecord} of ${endRecord} orders`
              : `Showing ${startRecord}-${endRecord} of ${filteredOrders.length} orders`}
          </p>

          <div className="flex max-w-full items-center gap-1 overflow-x-auto">
            <button
              type="button"
              onClick={goToPreviousPage}
              disabled={!canGoPreviousPage}
              className="flex h-[28px] min-w-[28px] items-center justify-center rounded-[6px] border border-[#E2E8F0] bg-white px-2 text-[12px] text-[#64748B] hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-40"
            >
              ‹
            </button>

            {useServerPagination ? (
              <span className="flex h-[28px] min-w-[28px] items-center justify-center rounded-[6px] bg-[#111827] px-2 text-[12px] font-semibold text-white">
                {safeCurrentPage}
              </span>
            ) : (
              Array.from({ length: totalPages }, (_, index) => index + 1).map(
                (page) => (
                  <button
                    key={page}
                    type="button"
                    onClick={() => {
                      if (page === safeCurrentPage || paginationBusy) return;
                      setCurrentPage(page);
                      scrollToTableTop();
                    }}
                    disabled={paginationBusy}
                    className={`flex h-[28px] min-w-[28px] items-center justify-center rounded-[6px] px-2 text-[12px] font-semibold ${
                      safeCurrentPage === page
                        ? "bg-[#111827] text-white"
                        : "border border-[#E2E8F0] bg-white text-[#334155] hover:bg-[#F8FAFC]"
                    } disabled:cursor-not-allowed disabled:opacity-40`}
                  >
                    {page}
                  </button>
                )
              )
            )}

            <button
              type="button"
              onClick={goToNextPage}
              disabled={!canGoNextPage}
              className="flex h-[28px] min-w-[28px] items-center justify-center rounded-[6px] border border-[#E2E8F0] bg-white px-2 text-[12px] text-[#64748B] hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-40"
            >
              ›
            </button>
          </div>
        </div>
      </section>

      <CreateInvoiceModal
        isOpen={Boolean(selectedInvoiceOrder)}
        mode={invoiceModalMode}
        order={selectedInvoiceOrder}
        returnToPath={listBackHref}
        onClose={() => setSelectedInvoiceOrder(null)}
        onSaved={fetchOrders}
      />

      <CreateXrayInvoiceModal
        isOpen={Boolean(selectedXrayOrder)}
        order={selectedXrayOrder}
        returnToPath={listBackHref}
        onClose={() => setSelectedXrayOrder(null)}
        onSaved={fetchOrders}
      />

      <CoverSheetModal
        isOpen={Boolean(selectedCoverSheetOrder)}
        order={selectedCoverSheetOrder}
        onClose={() => setSelectedCoverSheetOrder(null)}
      />

      <XrayCoverSheetModal
        isOpen={Boolean(selectedXrayCoverSheetOrder)}
        order={selectedXrayCoverSheetOrder}
        onClose={() => setSelectedXrayCoverSheetOrder(null)}
      />

      <CertificateNoRecordsModal
        isOpen={Boolean(selectedCnrOrder)}
        order={selectedCnrOrder}
        onClose={() => setSelectedCnrOrder(null)}
        onSendEmail={() => {
          if (!selectedCnrOrder) return;

          const mode =
            selectedCnrOrder.cnrDelivery === "email" && selectedCnrOrder.cnrDateSent
              ? "resend"
              : "send";

          openSendInvoiceEmailModal(selectedCnrOrder, mode, {
            invoiceKind: "cnr",
          });
        }}
      />

      <CnrNoteModal
        isOpen={Boolean(cnrTextModal)}
        title={cnrTextModal?.title || "CNR Note"}
        note={cnrTextModal?.note || ""}
        onClose={() => setCnrTextModal(null)}
      />

      <CertificateOfRecordsModal
        isOpen={Boolean(selectedCertificationOrder)}
        order={selectedCertificationOrder}
        onClose={() => setSelectedCertificationOrder(null)}
        onSendEmail={() => {
          if (!selectedCertificationOrder) return;

          openSendInvoiceEmailModal(selectedCertificationOrder, "send", {
            invoiceKind: "certification",
          });
        }}
      />

      <SendCopyLetterModal
        isOpen={Boolean(selectedCopyLetterOrder)}
        order={selectedCopyLetterOrder}
        onClose={() => setSelectedCopyLetterOrder(null)}
        onSent={async (payload) => {
          const result = await sendCopyServiceLetter(
            selectedCopyLetterOrder.dbId,
            payload
          );
          return result;
        }}
      />

      <OrderActivityLogModal
        isOpen={Boolean(selectedLogOrder)}
        order={selectedLogOrder}
        onClose={() => setSelectedLogOrder(null)}
      />

      <CompanyOrderFacilityModal
        open={Boolean(facilityModalState?.order)}
        order={facilityModalState?.order}
        startAtConfirm={Boolean(facilityModalState?.startAtConfirm)}
        portalType={personalMode ? "personal" : "company"}
        onClose={() => setFacilityModalState(null)}
        onNoFacility={() => fetchOrders({ silent: true, force: true })}
      />

      <OrderNotesListModal
        isOpen={Boolean(selectedNoteListOrder)}
        order={selectedNoteListOrder}
        returnToPath={listBackHref}
        onClose={() => setSelectedNoteListOrder(null)}
        onSaved={() => fetchOrders({ silent: true, force: true })}
      />

      <OrderAddNoteModal
        isOpen={Boolean(selectedAddNoteOrder)}
        order={selectedAddNoteOrder}
        onClose={() => setSelectedAddNoteOrder(null)}
        onSaved={() => fetchOrders({ silent: true, force: true })}
      />

      <UploadedRecordsPreviewModal
        isOpen={Boolean(selectedMedicalRecordsOrder)}
        order={selectedMedicalRecordsOrder}
        onClose={() => setSelectedMedicalRecordsOrder(null)}
      />

      <OrderPdfPreviewModal
        isOpen={Boolean(selectedPrintInvoiceOrder)}
        order={selectedPrintInvoiceOrder}
        onClose={() => setSelectedPrintInvoiceOrder(null)}
        title="Print Invoice"
        fileName="Invoice.pdf"
        fetchPdf={fetchOrderPrintInvoicePdf}
        loadingLabel="Generating invoice PDF..."
      />

      <OrderPdfPreviewModal
        isOpen={Boolean(selectedPrintXrayInvoiceOrder)}
        order={selectedPrintXrayInvoiceOrder}
        onClose={() => setSelectedPrintXrayInvoiceOrder(null)}
        title="Print X-Ray Invoice"
        fileName="XRay-Invoice.pdf"
        fetchPdf={fetchOrderPrintXrayInvoicePdf}
        loadingLabel="Generating X-Ray invoice PDF..."
      />

      <OrderPdfPreviewModal
        isOpen={Boolean(selectedSubpoenaOrder)}
        order={selectedSubpoenaOrder}
        onClose={() => setSelectedSubpoenaOrder(null)}
        title="Subpoena"
        fileName="Subpoena.pdf"
        fetchPdf={fetchOrderSubpoenaPdf}
        loadingLabel="Loading subpoena..."
      />

      <SendInvoiceEmailModal
        isOpen={sendInvoiceEmailModal.open}
        order={sendInvoiceEmailModal.order}
        mode={sendInvoiceEmailModal.mode}
        invoiceKind={sendInvoiceEmailModal.invoiceKind}
        onClose={closeSendInvoiceEmailModal}
        onSend={handleSubmitSendInvoiceEmail}
      />

      <OrderPickupModal
        isOpen={Boolean(selectedPickupOrder)}
        order={selectedPickupOrder}
        onClose={() => setSelectedPickupOrder(null)}
        onConfirm={async ({ pickupPersonName, pickupDate, notes }) => {
          await recordOrderPickup(selectedPickupOrder.dbId, {
            pickupPersonName,
            pickupDate,
            notes,
          });
          setOrders((prev) =>
            prev.map((item) =>
              item.dbId === selectedPickupOrder.dbId
                ? {
                    ...item,
                    orderStatus: "Completed",
                    deliveryDate: pickupDate,
                    readyDate: pickupDate,
                    pickupPersonName,
                  }
                : item
            )
          );
          await fetchOrders();
        }}
      />

      <OrderFaxModal
        isOpen={Boolean(selectedFaxOrder)}
        order={selectedFaxOrder}
        onClose={() => setSelectedFaxOrder(null)}
        onConfirm={async ({ faxNumber, sentDate, notes }) => {
          await recordOrderFax(selectedFaxOrder.dbId, {
            faxNumber,
            sentDate,
            notes,
          });
          await fetchOrders({ silent: true });
        }}
      />

      <ConfirmModal
        open={Boolean(restoreInProcessOrder)}
        title="Restore to In Process?"
        message="Do you really want to change this order status back to In Process? Invoice and facility tooling will be available again."
        variant="warning"
        confirmLabel={restoringInProcess ? "Restoring..." : "Yes, restore"}
        cancelLabel="Cancel"
        confirmDisabled={restoringInProcess}
        onCancel={() => {
          if (restoringInProcess) return;
          setRestoreInProcessOrder(null);
        }}
        onConfirm={async () => {
          if (!restoreInProcessOrder?.dbId || restoringInProcess) return;
          setRestoringInProcess(true);
          try {
            if (personalMode) {
              await restorePersonalOrderInProcess(restoreInProcessOrder.dbId);
            } else {
              await restoreCompanyOrderInProcess(restoreInProcessOrder.dbId);
            }
            setRestoreInProcessOrder(null);
            await fetchOrders({ silent: true, force: true });
          } catch (err) {
            setError(
              getApiErrorMessage(err, "Failed to restore order to In Process")
            );
          } finally {
            setRestoringInProcess(false);
          }
        }}
      />

      <OrderDeleteModal
        open={deleteModal.open}
        order={deleteModal.order}
        loading={actionLoading}
        onClose={closeDeleteModal}
        onConfirm={handleConfirmDelete}
      />

      <ConfirmModal
        open={removeRecordsModal.open}
        title="Remove Uploaded Records"
        message="Remove all uploaded record files for this order? Review Records will return to pending."
        variant="danger"
        confirmLabel={actionLoading ? "Removing..." : "Remove All"}
        cancelLabel="Cancel"
        confirmDisabled={actionLoading}
        onCancel={closeRemoveRecordsModal}
        onConfirm={handleConfirmRemoveRecords}
      />

      <OrderCancelModal
        open={cancelModal.open}
        order={cancelModal.order}
        loading={actionLoading}
        onClose={closeCancelModal}
        onConfirm={handleConfirmCancel}
      />

      <ConfirmModal
        open={restoreModal.open}
        title="Recover Order"
        message={
          restoreModal.order
            ? `Recover order ${restoreModal.order.id}? It will return to ${getRestoreTargetStatus(restoreModal.order)} status.`
            : "Recover this order?"
        }
        variant="warning"
        confirmLabel={actionLoading ? "Recovering..." : "Recover Order"}
        cancelLabel="Cancel"
        confirmDisabled={actionLoading}
        onCancel={closeRestoreModal}
        onConfirm={handleConfirmRestore}
      />
    </>
  );
}

function OrderPdfPreviewModal({
  isOpen,
  order,
  onClose,
  title,
  fileName,
  fetchPdf,
  loadingLabel = "Loading...",
  headerExtra = null,
  previewKey = "",
}) {
  const [src, setSrc] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [printError, setPrintError] = useState("");
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    if (!isOpen || !order?.dbId) {
      setSrc("");
      setError("");
      setPrintError("");
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    let objectUrl = "";

    setLoading(true);
    setError("");
    setPrintError("");

    fetchPdf(order.dbId)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(getDocumentOpenErrorMessage(err, "PDF"));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [isOpen, order?.dbId, fetchPdf, previewKey]);

  useEffect(() => cleanupPdfPrintFrame, []);

  const handleClose = () => {
    cleanupPdfPrintFrame();
    onClose();
  };

  const handlePrint = async () => {
    if (!src || printing) return;

    setPrintError("");
    setPrinting(true);

    try {
      await printPdfFromUrl(src);
    } catch (err) {
      setPrintError(err?.message || "Unable to open the print dialog.");
    } finally {
      setPrinting(false);
    }
  };

  if (!isOpen) return null;

  const canPrint = Boolean(src) && !loading && !error;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[92vh] w-full max-w-[900px] flex-col overflow-hidden rounded-[10px] bg-white shadow-xl">
        <div className="flex items-center justify-between gap-3 border-b border-[#E2E8F0] px-4 py-3">
          <div>
            <h2 className="text-[14px] font-semibold text-[#111827]">{title}</h2>
            <p className="text-[11px] text-[#64748B]">
              Order #{order?.id || order?.dbId}
            </p>
            {headerExtra}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={handlePrint}
              disabled={!canPrint || printing}
              className="inline-flex h-[30px] items-center justify-center gap-2 rounded-[6px] bg-[#111827] px-3 text-[12px] font-semibold text-white hover:bg-[#1F2937] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <PrintIcon />
              {printing ? "Preparing..." : "Print"}
            </button>

            <button
              type="button"
              onClick={() => downloadPdfFromUrl(src, fileName)}
              disabled={!canPrint}
              className="inline-flex h-[30px] items-center justify-center rounded-[6px] border border-[#CBD5E1] px-3 text-[12px] font-semibold text-[#334155] hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Download
            </button>

            <button
              type="button"
              onClick={handleClose}
              className="rounded-[6px] px-3 py-1.5 text-[12px] font-semibold text-[#64748B] hover:bg-[#F8FAFC]"
            >
              Close
            </button>
          </div>
        </div>

        {printError ? (
          <p className="border-b border-[#FEE2E2] bg-[#FEF2F2] px-4 py-2 text-[11px] font-medium text-red-500">
            {printError}
          </p>
        ) : null}

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {loading ? (
            <PdfPreviewSkeleton label={loadingLabel} />
          ) : error ? (
            <div className="flex min-h-[240px] items-center justify-center rounded-[8px] border border-red-200 bg-[#FEF2F2] px-4 text-center text-[12px] font-medium text-red-600">
              {error}
            </div>
          ) : (
            <SubpoenaPreviewContent src={src} name={fileName} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Mirrors the SubpoenaPreviewContent layout so the modal does not resize once the PDF arrives. */
function PdfPreviewSkeleton({ label }) {
  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      role="status"
      aria-live="polite"
    >
      <div className="mb-4 flex shrink-0 items-center justify-between gap-3 rounded-[8px] bg-[#F8FAFC] px-3 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="h-[30px] w-[30px] shrink-0 animate-pulse rounded-[6px] bg-[#E2E8F0]" />

          <div className="min-w-0">
            <span className="block h-3 w-28 animate-pulse rounded bg-[#E2E8F0]" />
            <p className="mt-[6px] text-[11px] text-[#94A3B8]">{label}</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <span className="h-[28px] w-[28px] animate-pulse rounded-[6px] bg-[#E2E8F0]" />
          <span className="h-[28px] w-[46px] animate-pulse rounded-[6px] bg-[#F1F5F9]" />
          <span className="h-[28px] w-[28px] animate-pulse rounded-[6px] bg-[#E2E8F0]" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-[8px] border border-[#E2E8F0] bg-[#F8FAFC] p-4">
        <div className="mx-auto h-[760px] w-[520px] max-w-full rounded-[4px] border border-[#CBD5E1] bg-white px-8 py-9 shadow-sm">
          <div className="flex flex-col items-center gap-2">
            <span className="h-4 w-40 animate-pulse rounded bg-[#E2E8F0]" />
            <span className="h-2 w-56 animate-pulse rounded bg-[#F1F5F9]" />
            <span className="h-2 w-44 animate-pulse rounded bg-[#F1F5F9]" />
          </div>

          <span className="mt-6 block h-px w-full bg-[#E2E8F0]" />

          <div className="mt-6 flex justify-between gap-8">
            {[0, 1].map((column) => (
              <div key={column} className="flex-1 space-y-2">
                <span className="block h-2.5 w-20 animate-pulse rounded bg-[#E2E8F0]" />
                <span className="block h-2 w-full animate-pulse rounded bg-[#F1F5F9]" />
                <span className="block h-2 w-[70%] animate-pulse rounded bg-[#F1F5F9]" />
              </div>
            ))}
          </div>

          <div className="mt-8 space-y-3">
            <div className="flex items-center gap-3 rounded-[4px] bg-[#F8FAFC] px-3 py-2">
              <span className="h-2.5 flex-1 animate-pulse rounded bg-[#E2E8F0]" />
              <span className="h-2.5 w-14 animate-pulse rounded bg-[#E2E8F0]" />
              <span className="h-2.5 w-16 animate-pulse rounded bg-[#E2E8F0]" />
            </div>

            {[0, 1, 2, 3, 4].map((row) => (
              <div key={row} className="flex items-center gap-3 px-3">
                <span className="h-2 flex-1 animate-pulse rounded bg-[#F1F5F9]" />
                <span className="h-2 w-14 animate-pulse rounded bg-[#F1F5F9]" />
                <span className="h-2 w-16 animate-pulse rounded bg-[#F1F5F9]" />
              </div>
            ))}
          </div>

          <div className="mt-8 ml-auto w-[45%] space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="h-2 w-16 animate-pulse rounded bg-[#F1F5F9]" />
              <span className="h-2 w-14 animate-pulse rounded bg-[#F1F5F9]" />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="h-2.5 w-20 animate-pulse rounded bg-[#E2E8F0]" />
              <span className="h-2.5 w-16 animate-pulse rounded bg-[#E2E8F0]" />
            </div>
          </div>

          <div className="mt-10 space-y-2">
            <span className="block h-2 w-full animate-pulse rounded bg-[#F1F5F9]" />
            <span className="block h-2 w-[80%] animate-pulse rounded bg-[#F1F5F9]" />
            <span className="block h-2 w-[55%] animate-pulse rounded bg-[#F1F5F9]" />
          </div>
        </div>
      </div>
    </div>
  );
}

function PrintIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
      <path
        d="M7 8V3h10v5M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path d="M7 14h10v7H7v-7Z" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function UploadedRecordsPreviewModal({ isOpen, order, onClose }) {
  const uploadedRecords = getOrderRecordSlots(order || {}).filter(
    (record) => record.hasFile
  );
  const uploadedFiles = uploadedRecords.flatMap((slot) => {
    const files = slot.files?.length
      ? slot.files
      : [
          {
            id: null,
            recordType: slot.recordType,
            originalFileName: `${slot.label}.pdf`,
            hasFile: true,
          },
        ];

    return files.map((file, index) => ({
      ...file,
      recordType: slot.recordType,
      label: slot.label,
      tabKey: `${slot.recordType}-${file.id || index}`,
    }));
  });
  const [activeKey, setActiveKey] = useState("");

  useEffect(() => {
    if (!isOpen) {
      setActiveKey("");
      return;
    }

    setActiveKey(uploadedFiles[0]?.tabKey || "");
  }, [isOpen, order?.dbId]);

  const activeFile =
    uploadedFiles.find((file) => file.tabKey === activeKey) || uploadedFiles[0];
  const recordType = activeFile?.recordType || "medical";
  const title = activeFile?.originalFileName || getOrderTypeLabel(recordType) || "Uploaded Records";
  const fileName = title.endsWith(".pdf") ? title : `${title}.pdf`;

  return (
    <OrderPdfPreviewModal
      isOpen={isOpen}
      order={order}
      onClose={onClose}
      title={uploadedFiles.length > 1 ? "Uploaded Records" : title}
      fileName={fileName}
      fetchPdf={(orderId) =>
        fetchOrderMedicalRecordsPdf(orderId, {
          recordType,
          recordId: activeFile?.id || null,
        })
      }
      loadingLabel="Loading records..."
      headerExtra={
        uploadedFiles.length > 1 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {uploadedFiles.map((file) => (
              <button
                key={file.tabKey}
                type="button"
                onClick={() => setActiveKey(file.tabKey)}
                className={`rounded-[5px] px-2 py-1 text-[10px] font-semibold ${
                  activeKey === file.tabKey
                    ? "bg-[#0097B2] text-white"
                    : "bg-[#F1F5F9] text-[#475569] hover:bg-[#E2E8F0]"
                }`}
              >
                {file.originalFileName || getOrderTypeLabel(file.recordType)}
              </button>
            ))}
          </div>
        ) : null
      }
      previewKey={activeFile?.tabKey || recordType}
    />
  );
}

function getWorkflowStageHref(stage, order, options = {}) {
  if (stage?.isCompanyPortalStage) {
    if (stage.showScanRecordsLink) {
      return getCompanyPortalRecordsUploadHref(order);
    }
    return null;
  }

  if (stage.key === "Review Records") {
    if (order.certificateNoRecords) {
      return null;
    }

    const allUploaded = Boolean(order.hasMedicalRecords);
    const isComplete =
      isWorkflowStageComplete(stage.status) || allUploaded;

    if (!isComplete) {
      const returnTo = resolveOrderListReturnTo(order, options);
      return `/orders/scan-medical-records?orderId=${encodeURIComponent(
        order.dbId
      )}&returnTo=${encodeURIComponent(returnTo)}`;
    }
  }

  if (
    stage.key === "Serve" &&
    !isWorkflowStageComplete(stage.status)
  ) {
    return buildOrderEditHref(order.dbId, {
      returnTo: resolveOrderListReturnTo(order, options),
      panel: "payment",
    });
  }

  return null;
}

function WorkflowStageItem({
  stage,
  href,
  onNavigateToHref,
  onAdvance,
  onEmailRecords,
  onPreviewRecords,
  onResend,
  onRemoveRecords,
  resending = false,
  removingRecords = false,
}) {
  if (stage.isCompanyPortalStage) {
    const style =
      WORKFLOW_STATUS_STYLES[stage.status] || WORKFLOW_STATUS_STYLES.pending;

    if (stage.showScanRecordsLink && href) {
      return (
        <div className="space-y-1">
          <Link
            href={href}
            className="block text-[10px] font-semibold text-[#007F96] underline"
          >
            Upload Records
          </Link>
          {stage.showPreviewRecords && onPreviewRecords ? (
            <button
              type="button"
              onClick={onPreviewRecords}
              className="block text-[10px] font-semibold text-[#007F96] underline"
            >
              View Uploaded Records
            </button>
          ) : null}
          <div
            className={`flex w-full items-center gap-1.5 text-[10px] font-semibold ${style.text}`}
          >
            <WorkflowStageIcon status={stage.status} />
            <span>{stage.label}</span>
          </div>
        </div>
      );
    }

    if (stage.showEmailRecords && onEmailRecords) {
      return (
        <div className="space-y-1">
          <button
            type="button"
            onClick={onEmailRecords}
            className="block text-[10px] font-semibold text-[#007F96] underline"
          >
            Email Records Link
          </button>
          <div
            className={`flex w-full items-center gap-1.5 text-[10px] font-semibold ${style.text}`}
          >
            <WorkflowStageIcon status={stage.status} />
            <span>{stage.label}</span>
          </div>
        </div>
      );
    }

    const className = `flex w-full items-center gap-1.5 text-left text-[10px] font-semibold ${style.text} ${
      onAdvance ? "hover:underline" : ""
    }`;

    if (onAdvance) {
      return (
        <button type="button" onClick={onAdvance} className={className}>
          <WorkflowStageIcon status={stage.status} />
          <span>{stage.label}</span>
        </button>
      );
    }

    return (
      <div className={className}>
        <WorkflowStageIcon status={stage.status} />
        <span>{stage.label}</span>
      </div>
    );
  }

  if (stage.showScanRecordsLink && href) {
    const pendingStyle = WORKFLOW_STATUS_STYLES.pending;

    return (
      <div className="space-y-1">
        <Link
          href={href}
          className="block text-[10px] font-semibold text-[#007F96] underline"
        >
          Scan Records
        </Link>
        <div
          className={`flex w-full items-center gap-1.5 text-[10px] font-semibold ${pendingStyle.text}`}
        >
          <WorkflowStageIcon status="pending" />
          {stage.showPreviewRecords ? (
            <button
              type="button"
              onClick={onPreviewRecords}
              disabled={!onPreviewRecords}
              className="min-w-0 truncate text-left hover:underline disabled:cursor-default"
            >
              Review Records
            </button>
          ) : (
            <span>Review Records</span>
          )}
        </div>
      </div>
    );
  }

  const style = WORKFLOW_STATUS_STYLES[stage.status] || WORKFLOW_STATUS_STYLES.pending;

  if (stage.showRemoveRecords) {
    return (
      <div
        className={`flex w-full flex-nowrap items-center gap-1.5 text-[10px] font-semibold ${style.text}`}
      >
        <WorkflowStageIcon status={stage.status} />
        <button
          type="button"
          onClick={onPreviewRecords}
          disabled={!onPreviewRecords}
          className="min-w-0 flex-1 truncate text-left hover:underline disabled:cursor-default"
        >
          {stage.label}
        </button>
        <button
          type="button"
          onClick={onRemoveRecords}
          disabled={removingRecords || !onRemoveRecords}
          className="flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded text-red-500 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label="Remove all uploaded records"
        >
          <CloseIcon />
    </button>
      </div>
    );
  }

  if (stage.showResend) {
    return (
      <div
        className={`flex w-full flex-nowrap items-center gap-1.5 text-[10px] font-semibold ${style.text}`}
      >
        <WorkflowStageIcon status={stage.status} />
        <span className="min-w-0">{stage.label}</span>
        <button
          type="button"
          onClick={onResend}
          disabled={resending || !onResend}
          className="shrink-0 text-[#007F96] underline hover:text-[#00667A] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {resending ? "Sending..." : "Resend"}
        </button>
      </div>
    );
  }

  const className = `flex w-full items-center justify-between gap-2 text-left text-[10px] font-semibold ${style.text} ${
    href ? "hover:underline" : ""
  }`;

  const content = (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        <WorkflowStageIcon status={stage.status} />
        <span>{stage.label}</span>
      </span>
      {stage.paidAmount ? (
        <span className="shrink-0 font-semibold text-[#059669]">
          {stage.paidAmount}
        </span>
      ) : null}
    </>
  );

  if (href) {
    return (
      <Link href={href} onClick={() => onNavigateToHref?.()} className={className}>
        {content}
      </Link>
    );
  }

  return <div className={className}>{content}</div>;
}

function WorkflowStageIcon({ status }) {
  if (status === "complete" || status === "sent") {
    const color = status === "sent" ? "text-[#2563EB]" : "text-[#059669]";

    return (
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className={`shrink-0 ${color}`}
      >
        <path
          d="M5 12l4 4L19 6"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  const style = WORKFLOW_STATUS_STYLES[status] || WORKFLOW_STATUS_STYLES.pending;

  return (
    <span className={`h-[6px] w-[6px] shrink-0 rounded-full ${style.dot}`} />
  );
}

function resolveInvoiceDueWithFacilityFee(invoice = {}, pendingFacilitySearchFee = 0) {
  const baseDue = parsePaymentAmount(invoice.due);
  const facilityFee = Number(pendingFacilitySearchFee) || 0;
  // Pending facility fee is rolled into the next/full invoice total
  if (facilityFee > 0) {
    return formatMoneyAmount(baseDue + facilityFee);
  }
  return invoice.due || null;
}

function InvoiceBlock({
  invoice,
  orderDbId,
  pendingFacilitySearchFee = 0,
  isCnr = false,
  cnrDelivery = "",
  cnrDateSent = "",
  onCnrReasonClick,
  onSendCnrRecord,
  onResendCnrRecord,
  allowStandardInvoice = true,
  blockInvoiceCreate = false,
  providerEmail = "",
  onCreateInvoice,
  onReviewInvoice,
  onCreateXrayInvoice,
  onReviewXrayInvoice,
  onCoverSheet,
  onXrayCoverSheet,
  onSendInvoice,
  onResendInvoice,
  onEmailXrayInvoice,
  onPrintInvoice,
  onPrintXrayInvoice,
  sending = false,
  emailing = false,
  emailingXray = false,
  emailingCnr = false,
}) {
  const invoiceSentDate =
    invoice.sentDateCompact || invoice.sentDate || null;
  const xraySentDate =
    invoice.xraySentDateCompact || invoice.xraySentDate || null;
  const showCnrEmailSent = isCnr && cnrDelivery === "email" && cnrDateSent;
  const facilityFee = Number(pendingFacilitySearchFee) || 0;
  const invoiceDueDisplay = resolveInvoiceDueWithFacilityFee(
    invoice,
    facilityFee
  );

  const sendInvoiceButton = !invoice.sentDate ? (
    <button
      type="button"
      onClick={onSendInvoice}
      disabled={sending}
      className="block text-left text-[#007F96] underline disabled:cursor-not-allowed disabled:opacity-60"
    >
      {sending ? "Sending..." : "Send Invoice"}
    </button>
  ) : null;

  const resendInvoiceButton = invoice.sentDate ? (
    <div className="space-y-0.5">
      <p className="font-semibold text-[#2563EB]">Invoice Sent</p>
      {invoiceSentDate ? (
        <p className="text-[#94A3B8]">Sent: {invoiceSentDate}</p>
      ) : null}
      {(providerEmail || invoice.recipientEmail) && (
        <p className="truncate text-[#94A3B8]">
          To: {invoice.recipientEmail || providerEmail}
        </p>
      )}
      <button
        type="button"
        onClick={onResendInvoice}
        disabled={emailing}
        className="block text-left text-[#007F96] underline disabled:cursor-not-allowed disabled:opacity-60"
      >
        {emailing ? "Emailing..." : "Email Invoice"}
      </button>
    </div>
  ) : null;

  const xrayCreateLink = invoice.hasXray ? (
    <>
      <InvoiceReviewRows
        label={
          <button
            type="button"
            onClick={onReviewXrayInvoice}
            className="text-[#007F96] underline"
          >
            Review Xray Invoice
          </button>
        }
        dateCompact={invoice.xrayReviewDateCompact || invoice.xrayReviewDate}
        dueAmount={invoice.xrayReviewAmount}
      />

      <button
        type="button"
        onClick={onPrintXrayInvoice}
        className="block text-left text-[#007F96] underline"
      >
        Print Xray Invoice
      </button>

        <button
          type="button"
          onClick={onXrayCoverSheet}
        className="block text-left text-[#007F96] underline"
        >
          X-ray Cover Sheet
      </button>

      {!invoice.xraySentDate ? (
        <button
          type="button"
          onClick={onEmailXrayInvoice}
          disabled={emailingXray}
          className="block text-left text-[#007F96] underline disabled:cursor-not-allowed disabled:opacity-60"
        >
          {emailingXray ? "Sending..." : "Email Xray Invoice"}
        </button>
      ) : null}

      {invoice.xraySentDate ? (
        <InvoiceEmailedStatus
          label="Xray Invoice Emailed"
          sentDate={xraySentDate}
          recipientEmail={
            invoice.xrayRecipientEmail || providerEmail || invoice.recipientEmail
          }
        />
      ) : null}
    </>
  ) : (
    <button
      type="button"
      onClick={onCreateXrayInvoice}
      className="block text-left text-[#007F96] underline"
    >
      Create Xray Invoice
    </button>
  );

  const cnrSection = isCnr ? (
    <>
      {xrayCreateLink}

      <span className="mt-1 inline-flex rounded-[4px] bg-[#111827] px-2 py-[2px] text-[10px] font-bold uppercase tracking-wide text-white">
        CNR
      </span>

      {cnrDelivery ? (
        <p className="text-[#334155]">
          {CNR_DELIVERY_LABELS[cnrDelivery] || cnrDelivery}
        </p>
      ) : null}

      {cnrDateSent ? (
        <p className="text-[#334155]">Date:{formatCnrDisplayDate(cnrDateSent)}</p>
      ) : null}

      <button
        type="button"
        onClick={onCnrReasonClick}
        className="block text-left text-[#007F96] underline"
      >
        Reason
      </button>

      {!showCnrEmailSent ? (
        <button
          type="button"
          onClick={onSendCnrRecord}
          disabled={emailingCnr}
          className="block text-left text-[#007F96] underline disabled:cursor-not-allowed disabled:opacity-60"
        >
          {emailingCnr ? "Sending..." : "Send CNR Record"}
        </button>
      ) : (
        <div className="space-y-0.5">
          <p className="font-semibold text-[#2563EB]">CNR Record Emailed</p>
          <p className="text-[#94A3B8]">
            Sent: {formatCnrDisplayDate(cnrDateSent)}
          </p>
          <button
            type="button"
            onClick={onResendCnrRecord}
            disabled={emailingCnr}
            className="block text-left text-[#007F96] underline disabled:cursor-not-allowed disabled:opacity-60"
          >
            {emailingCnr ? "Sending..." : "Email CNR Record"}
          </button>
        </div>
      )}
    </>
  ) : null;

  const xraySection = !isCnr && invoice.hasXray ? (
    <>
      <InvoiceReviewRows
        label={
          <button
            type="button"
            onClick={onReviewXrayInvoice}
            className="text-[#007F96] underline"
          >
            Review Xray Invoice
          </button>
        }
        dateCompact={invoice.xrayReviewDateCompact || invoice.xrayReviewDate}
        dueAmount={invoice.xrayReviewAmount}
      />

      <button
        type="button"
        onClick={onPrintXrayInvoice}
        className="block text-left text-[#007F96] underline"
      >
        Print Xray Invoice
      </button>

      <button
        type="button"
        onClick={onXrayCoverSheet}
        className="block text-left text-[#007F96] underline"
      >
        X-ray Cover Sheet
      </button>

      {!invoice.xraySentDate ? (
        <button
          type="button"
          onClick={onEmailXrayInvoice}
          disabled={emailingXray}
          className="block text-left text-[#007F96] underline disabled:cursor-not-allowed disabled:opacity-60"
        >
          {emailingXray ? "Sending..." : "Email Xray Invoice"}
        </button>
      ) : null}

      {invoice.xraySentDate ? (
        <InvoiceEmailedStatus
          label="Xray Invoice Emailed"
          sentDate={xraySentDate}
          recipientEmail={
            invoice.xrayRecipientEmail || providerEmail || invoice.recipientEmail
          }
        />
      ) : null}
    </>
  ) : !isCnr ? (
    blockInvoiceCreate ? (
      <p className="text-[#94A3B8]">X-ray invoice unavailable (No facility)</p>
    ) : (
      <button
        type="button"
        onClick={onCreateXrayInvoice}
        className="block text-left text-[#007F96] underline"
      >
        Create Xray Invoice
      </button>
    )
  ) : null;

  if (isCnr) {
    const cnrInvoiceSection = invoice.createOnly ? (
      <>
        {allowStandardInvoice ? (
          <>
            {blockInvoiceCreate ? (
              <p className="text-[#94A3B8]">
                Invoice unavailable (No facility)
              </p>
            ) : (
              <button
                type="button"
                onClick={onCreateInvoice}
                className="block text-left text-[#007F96] underline"
              >
                Create Invoice
              </button>
            )}

            <button
              type="button"
              onClick={onCoverSheet}
              className="block text-left text-[#007F96] underline"
            >
              Cover Sheet
            </button>

            {!blockInvoiceCreate ? sendInvoiceButton : null}
            {!blockInvoiceCreate ? resendInvoiceButton : null}
          </>
        ) : null}
      </>
    ) : allowStandardInvoice ? (
      <>
        <InvoiceReviewRows
          label={
            <button
              type="button"
              onClick={onReviewInvoice}
              className="text-[#007F96] underline"
            >
              Review Invoice
            </button>
          }
          dateCompact={invoice.invoiceDateCompact || invoice.reviewDate}
          dueAmount={invoiceDueDisplay}
        />

        <button
          type="button"
          onClick={onPrintInvoice}
          className="block text-left text-[#007F96] underline"
        >
          Print Invoice
        </button>

        <button
          type="button"
          onClick={onCoverSheet}
          className="block text-left text-[#007F96] underline"
        >
          Cover Sheet
        </button>

        {sendInvoiceButton}
        {resendInvoiceButton}
      </>
    ) : null;

    return (
      <div className="space-y-1 text-[10px]">
        {cnrInvoiceSection}
        {cnrSection}
      </div>
    );
  }

  if (invoice.createOnly) {
    return (
      <div className="space-y-1 text-[10px]">
        {allowStandardInvoice ? (
          <>
            {blockInvoiceCreate ? (
              <p className="text-[#94A3B8]">
                Invoice unavailable (No facility)
              </p>
            ) : (
              <button
                type="button"
                onClick={onCreateInvoice}
                className="block text-left text-[#007F96] underline"
              >
                Create Invoice
              </button>
            )}

            {!blockInvoiceCreate && facilityFee > 0 ? (
              <p className="text-[#B45309]">
                Facility fee {formatMoneyAmount(facilityFee)} (included in invoice)
              </p>
            ) : null}

            <button
              type="button"
              onClick={onCoverSheet}
              className="block text-left text-[#007F96] underline"
            >
              Cover Sheet
            </button>

            {!blockInvoiceCreate ? sendInvoiceButton : null}
            {!blockInvoiceCreate ? resendInvoiceButton : null}
          </>
        ) : null}
        {!isCnr ? xraySection : null}
      </div>
    );
  }

  if (!allowStandardInvoice) {
    return <div className="space-y-1 text-[10px]">{xraySection}</div>;
  }

  return (
    <div className="space-y-1 text-[10px]">
      <InvoiceReviewRows
        label={
          <button
            type="button"
            onClick={onReviewInvoice}
            className="text-[#007F96] underline"
          >
            Review Invoice
          </button>
        }
        dateCompact={invoice.invoiceDateCompact || invoice.reviewDate}
        dueAmount={invoiceDueDisplay}
      />

      {facilityFee > 0 ? (
        <p className="text-[#B45309]">
          Includes facility fee {formatMoneyAmount(facilityFee)}
        </p>
      ) : null}

      <button
        type="button"
        onClick={onPrintInvoice}
        className="block text-left text-[#007F96] underline"
      >
        Print Invoice
      </button>

      <button
        type="button"
        onClick={onCoverSheet}
        className="block text-left text-[#007F96] underline"
      >
        Cover Sheet
      </button>

      {sendInvoiceButton}
      {resendInvoiceButton}
      {xraySection}
    </div>
  );
}

function InvoiceEmailedStatus({ label, sentDate, recipientEmail }) {
  return (
    <div className="space-y-0.5 text-[#334155]">
      <p className="font-semibold text-[#059669]">✓ {label}</p>
      {recipientEmail ? (
        <p className="truncate text-[#94A3B8]">To: {recipientEmail}</p>
      ) : null}
      {sentDate ? (
        <p className="text-[#94A3B8]">Sent: {sentDate}</p>
      ) : null}
    </div>
  );
}

function InvoiceReviewRows({ label, dateCompact, dueAmount }) {
  const dueLabel = dateCompact ? `${dateCompact} - Due:` : null;

  return (
    <div className="space-y-0.5">
      <div className="text-[#334155]">{label}</div>
      {dueLabel && dueAmount ? (
        <div className="flex w-full items-center justify-between gap-2 text-[#334155]">
          <span className="min-w-0 text-left">{dueLabel}</span>
          <span className="shrink-0 text-right">{dueAmount}</span>
        </div>
      ) : null}
    </div>
  );
}

function InvoiceMoneyRow({ label, date, amount, amountClassName = "" }) {
  return (
    <div className="flex w-full items-center justify-between gap-2 text-[#334155]">
      <span className="min-w-0">{label}</span>
      {amount ? (
        <span
          className={`shrink-0 text-right ${
            amountClassName || "font-semibold text-[#111827]"
          }`}
        >
          {date ? (
            <>
              <span className="font-normal text-[#94A3B8]">{date}</span>{" "}
            </>
          ) : null}
          {amount}
        </span>
      ) : null}
    </div>
  );
}

function formatRecordsDateLong(value) {
  if (!value) return "";

  const iso = String(value).slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [year, month, day] = iso.split("-");
    return `${year}/${month}/${day}`;
  }

  return String(value);
}

function resolveRecordsDateRange(records, dateRequested, dateRequestedDisplay) {
  if (records?.dateRange) return records.dateRange;

  const start = formatRecordsDateLong(dateRequested || dateRequestedDisplay);
  return start ? `${start} - Present` : "";
}

function normalizeRecordsCaption(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function RecordsCaptionPreview({ text, openUpward = false }) {
  const normalizedText = normalizeRecordsCaption(text);
  if (!normalizedText) return null;

  return (
    <div className="group/records-caption relative">
      <p className="line-clamp-2 whitespace-pre-line text-left text-[#334155]">
        {normalizedText}
      </p>
      <div
        className={`pointer-events-none absolute left-0 z-30 hidden min-w-[320px] max-w-[480px] rounded-[8px] border border-[#E2E8F0] bg-white p-4 text-left text-[11px] leading-[18px] whitespace-pre-line text-[#334155] shadow-xl group-hover/records-caption:block ${
          openUpward ? "bottom-full mb-1.5" : "top-full mt-1.5"
        }`}
      >
        {normalizedText}
      </div>
    </div>
  );
}

function DeletedReasonPreview({ text, openUpward = false }) {
  const normalizedText = normalizeRecordsCaption(text);
  if (!normalizedText) return null;

  return (
    <div className="group/delete-reason relative max-w-[160px]">
      <p className="line-clamp-2 whitespace-pre-line text-left text-[10px] leading-snug text-[#991B1B]">
        <span className="font-semibold">Deleted reason:</span> {normalizedText}
      </p>
      <div
        className={`pointer-events-none absolute right-0 z-30 hidden min-w-[240px] max-w-[360px] rounded-[8px] border border-[#E2E8F0] bg-white p-3 text-left text-[11px] leading-[18px] whitespace-pre-line text-[#334155] shadow-xl group-hover/delete-reason:block ${
          openUpward ? "bottom-full mb-1.5" : "top-full mt-1.5"
        }`}
      >
        <span className="font-semibold text-[#991B1B]">Deleted reason:</span>{" "}
        {normalizedText}
      </div>
    </div>
  );
}

function RecordsBlock({
  records,
  dateRequested = "",
  dateRequestedDisplay = "",
  isCnr = false,
  cnrMemo = false,
  cnrDelivery = "",
  cnrDateSent = "",
  openUpward = false,
  onCnrNoteClick,
  onPrintedSentOutClick,
}) {
  const showPrintedSentOutNote = isCnr && cnrDelivery && cnrDateSent;
  const showCnrNote = isCnr && !cnrMemo && records.cnrNote;
  const requestedTypes =
    records.requestedTypes?.length > 0
      ? records.requestedTypes
      : records.title
      ? [{ type: "default", label: records.title }]
      : [];
  const caption = records.caption || "";
  const dateRange = resolveRecordsDateRange(
    records,
    dateRequested,
    dateRequestedDisplay
  );

  return (
    <div className="space-y-1 text-[10px]">
      {!isCnr && (
        <>
          {requestedTypes.map(({ type, label }) => (
            <p key={type} className="font-semibold text-[#007F96]">
              {label}
            </p>
          ))}

          {dateRange ? (
            <p className="font-medium text-[#334155]">{dateRange}</p>
          ) : null}

          {caption ? (
            <RecordsCaptionPreview text={caption} openUpward={openUpward} />
          ) : null}
        </>
      )}

      {isCnr && records.title ? (
        <p className="font-semibold text-[#111827]">{records.title}</p>
      ) : null}

      {showPrintedSentOutNote ? (
        <button
          type="button"
          onClick={onPrintedSentOutClick}
          className="block text-left font-medium text-[#007F96] underline"
        >
          Printed/Sent Out Note
        </button>
      ) : null}

      {showCnrNote && onCnrNoteClick ? (
        <button
          type="button"
          onClick={onCnrNoteClick}
          className="block text-left font-medium text-[#007F96] underline"
        >
          {records.cnrNote?.label || "CNR Note"}
        </button>
      ) : null}
    </div>
  );
}

function CompanyBlock({ company }) {
  return (
    <div className="space-y-1 text-[10px] leading-[15px]">
      <p className="font-semibold text-[#007F96]">{company.name}</p>
      <p className="text-[#334155]">{company.address}</p>
      <p className="text-[#64748B]">{company.phone}</p>
      <p className="text-[#64748B]">{company.email}</p>
    </div>
  );
}

function FormsList({ forms, onCnrClick, onCertificationClick, onCopyLetterClick }) {
  const handlers = {
    CNR: onCnrClick,
    "Certification of Records": onCertificationClick,
    "Send Copy/Letter": onCopyLetterClick,
  };

        return (
    <div className="space-y-1">
      {forms.map((form) => (
          <button
            key={form}
            type="button"
          onClick={handlers[form]}
          disabled={!handlers[form]}
          className={`block text-left text-[10px] font-medium underline ${
            handlers[form]
              ? "text-[#007F96] hover:opacity-80"
              : "cursor-default text-[#94A3B8] no-underline"
          }`}
          >
            {form}
          </button>
      ))}
    </div>
  );
}

function formatLastUpdatedLabel(date) {
  const diffSeconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));

  if (diffSeconds < 15) return "just now";
  if (diffSeconds < 60) return `${diffSeconds}s ago`;

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes} min${diffMinutes === 1 ? "" : "s"} ago`;
  }

  return date.toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function RushBadge({ rush, order }) {
  if (!rush) return null;

  const tooltip = buildRushBadgeTooltip(order, rush);

  return (
    <span
      title={tooltip}
      aria-label={tooltip || rush}
      className={`inline-flex h-[22px] items-center justify-center whitespace-nowrap rounded-full border px-3 text-[10px] font-semibold ${
        RUSH_LEVEL_STYLES[rush] || RUSH_LEVEL_STYLES["Rush 1"]
      }`}
    >
      {rush}
    </span>
  );
}

function TrashIcon() {
  return (
    <svg className="block shrink-0" width="11" height="11" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg className="block shrink-0" width="11" height="11" viewBox="0 0 24 24" fill="none">
      <path
        d="M3 12a9 9 0 1 0 2.6-6.4M3 4v5h5"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SmallCircleIcon() {
  return (
    <svg className="block shrink-0" width="11" height="11" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}