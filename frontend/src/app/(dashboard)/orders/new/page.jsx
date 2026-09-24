"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import DashboardShell from "@/components/layout/DashboardShell";
import CollapsibleOrderPanel from "@/components/orders/new-order/CollapsibleOrderPanel";
import NewOrderField, {
  CheckboxOption,
  RadioOption,
} from "@/components/orders/new-order/NewOrderField";
import PaymentChargeCard from "@/components/orders/new-order/PaymentChargeCard";
import ProviderSearchField from "@/components/orders/new-order/ProviderSearchField";
import FacilitySearchField from "@/components/orders/new-order/FacilitySearchField";
import DoctorSearchField from "@/components/orders/new-order/DoctorSearchField";
import DoctorAddressSearchField from "@/components/orders/new-order/DoctorAddressSearchField";
import SubpoenaPreviewContent from "@/components/orders/new-order/SubpoenaPreviewContent";
import SubpoenaExtractionOverlay from "@/components/orders/new-order/SubpoenaExtractionOverlay";
import CertificateNoRecordsPanel from "@/components/orders/new-order/CertificateNoRecordsPanel";
import RecordTypeMultiSelect from "@/components/orders/new-order/RecordTypeMultiSelect";

import {
  formatMoneyInput,
  formatPhone,
  formatSSN,
  formatZip,
  getImmediateRequiredFields,
  moneyFields,
  numericOnlyFields,
  phoneFields,
  validateFile,
  validateNewOrderForm,
} from "@/lib/validations/newOrderValidation";

import {
  OrderIcon,
  PaymentIcon,
  SaveIcon,
  ServeIcon,
  SubpoenaIcon,
} from "@/components/icons/NewOrderIcons";

import { createOrder, getOrder, updateOrder, getUnprocessedSubpoenaById, fetchUnprocessedSubpoenaPdf, fetchOrderSubpoenaPdf, uploadSingleSubpoena, deleteOrderAdditionalDocument, removeOrderSubpoena } from "@/lib/orders/orderApi";
import ConfirmModal from "@/components/ui/ConfirmModal";
import { getFacilities } from "@/lib/facilities/facilityApi";
import { findSimilarFacilities } from "@/lib/orders/facilitySimilarity";
import {
  clearDraftOrderSession,
  consumeFreshNewOrderNavigation,
  getDraftOrderScope,
  hasDraftableOrderContent,
  isRestorableDraftOrderSession,
  isSameFacilityLabel,
  readDraftOrderSession,
  rememberDraftOrderSession,
  resolvePendingFacility,
  resolveBatchMismatchFacilityForEdit,
  serializeFormForDraft,
  mergePersonalPortalFieldsFromOrder,
} from "@/lib/orders/facilityOrderUtils";
import {
  applyResolvedDoctorToForm,
  buildDoctorResolveAfterFacilityReturn,
  resolvePendingDoctorForOrder,
} from "@/lib/orders/doctorOrderUtils";
import { getProviders, updateProvider } from "@/lib/providers/providerApi";
import { buildFormFromExtract } from "@/lib/orders/extractionFormUtils";
import { markOrderListFiltersForRestore } from "@/lib/orders/orderListFilterStorage";
import { syncPaymentDueFields, validateOrderPaymentAmounts } from "@/lib/orders/paymentUtils";
import { API_BASE_URL } from "@/config/api";
import { applyApiFieldErrors, getApiErrorMessage } from "@/lib/apiErrorUtils";
import { getDocumentOpenErrorMessage } from "@/lib/utils/documentOpenErrors";

const AUTO_PENDING_ORDER_PREFIX = "AUTO-PENDING-";

function toFileUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  const origin = API_BASE_URL.replace(/\/api\/?$/, "");
  return `${origin}${path.startsWith("/") ? "" : "/"}${path}`;
}

function subpoenaFileName(path) {
  if (!path) return "Subpoena";
  const normalized = String(path).replace(/\\/g, "/");
  return normalized.split("/").pop() || "Subpoena";
}

function isGeneratedSubpoenaDisplayName(name) {
  const base = String(name || "").trim().split(/[\\/]/).pop() || "";
  if (!base) return true;
  if (/^[a-f0-9]{32}_\d+\./i.test(base)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(base)) {
    return true;
  }
  if (/^\d+_\d{10,}_\d+_/.test(base)) return true;
  return false;
}

function displaySubpoenaName({
  subpoenaFile,
  subpoenaOriginalFileName,
  subpoenaFileName: storedFileName,
  subpoenaStoragePath,
} = {}) {
  const fromColumn = `${subpoenaOriginalFileName || storedFileName || ""}`.trim();
  if (fromColumn && !isGeneratedSubpoenaDisplayName(fromColumn)) {
    return fromColumn;
  }

  const fromUpload = `${subpoenaFile?.name || ""}`.trim();
  if (fromUpload && !isGeneratedSubpoenaDisplayName(fromUpload)) {
    return fromUpload;
  }

  return fromColumn || subpoenaFileName(subpoenaStoragePath);
}

const PROVIDER_SYNC_FIELDS = new Set([
  "address",
  "zip",
  "city",
  "state",
  "phone",
  "fax",
  "email",
]);

const initialFormData = {
  facility: "",
  facilityName: "",
  facilityAddress: "",
  providerId: "",
  type: "",
  caseNumber: "",
  ssn: "",
  dob: "",
  driverLicenseNumber: "",
  hasDriverLicenseDocument: false,
  hasPersonalDocument: false,

  firstName: "",
  middleName: "",
  lastName: "",
  aka: "",
  defendant: "",
  injuryType: "",
  injuryDate: "",
  injuryDateBegin: "",
  injuryDateEnd: "",

  documentName: "",
  subpoenaFile: null,
  subpoenaExtractId: "",
  subpoenaOriginalFileName: "",
  additionalDocumentFile: null,

  orderNumber: "",
  recNumber: "",
  serveCompanyName: "",
  address: "",
  zip: "",
  city: "",
  state: "",
  phone: "",
  fax: "",
  email: "",

  contact1Name: "",
  contact1Title: "",
  contact1Phone: "",
  contact1Fax: "",
  contact1Email: "",

  contact2Name: "",
  contact2Title: "",
  contact2Phone: "",
  contact2Fax: "",
  contact2Email: "",

  dateServed: "",
  depoDueDate: "",
  deliveryDate: "",
  subpoenaDate: "",
  dateRequested: "",
  readyDate: "",
  invoiceDate: "",
  xrayInvoiceDate: "",

  medicalRecords: false,
  billingRecords: false,
  employmentRecords: false,
  xrays: false,
  otherRecord: false,

  specificRecord: "",
  specificDoctor: "",
  specificDoctorId: "",
  specificDoctorIsDefault: false,
  fullAddress: "",

  certificateNoRecords: false,
  cnrReason: "",
  cnrDelivery: "",
  cnrDateSent: "",
  cnrMemo: false,

  prepaymentCheck: "",
  prepaymentDate: "",
  prepaymentPaid: "",
  prepaymentDue: "15.00",
  prepaymentMemo: "",

  custodianCheck: "",
  custodianDate: "",
  custodianPaid: "",
  custodianDue: "0.00",
  custodianMemo: "",

  xrayCheck: "",
  xrayDate: "",
  xrayPaid: "",
  xrayDue: "0",
  xrayMemo: "",
};

function isOrderInactiveStatus(status) {
  return status === "Cancelled" || status === "Deleted";
}

/** Form fields typically filled from subpoena extraction — cleared when subpoena is removed. */
const SUBPOENA_EXTRACTED_FIELD_KEYS = [
  "orderNumber",
  "recNumber",
  "caseNumber",
  "ssn",
  "dob",
  "firstName",
  "middleName",
  "lastName",
  "aka",
  "defendant",
  "injuryType",
  "injuryDate",
  "injuryDateBegin",
  "injuryDateEnd",
  "facility",
  "facilityName",
  "providerId",
  "serveCompanyName",
  "address",
  "zip",
  "city",
  "state",
  "phone",
  "fax",
  "email",
  "dateServed",
  "depoDueDate",
  "subpoenaDate",
  "dateRequested",
  "specificRecord",
  "specificDoctor",
  "specificDoctorId",
  "specificDoctorIsDefault",
  "fullAddress",
  "prepaymentCheck",
  "prepaymentDate",
  "prepaymentPaid",
  "medicalRecords",
  "billingRecords",
  "employmentRecords",
  "xrays",
  "otherRecord",
  "type",
];

export default function NewOrderPage() {
  return (
    <Suspense
      fallback={
        <DashboardShell lockScroll>
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <p className="text-[13px] text-[#64748B]">Loading...</p>
          </div>
        </DashboardShell>
      }
    >
      <NewOrderPageContent />
    </Suspense>
  );
}

function NewOrderPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const orderId = searchParams.get("orderId");
  const subpoenaId = searchParams.get("subpoenaId");
  const panel = searchParams.get("panel");
  const facilityRefresh = searchParams.get("facilityRefresh");
  const applyFacilityId = searchParams.get("applyFacilityId");
  const applyDoctorId = searchParams.get("applyDoctorId");
  const returnToParam = searchParams.get("returnTo");

  const isEditMode = Boolean(orderId);

  const resolveListPath = useCallback(
    (creationSource = "") => {
      const normalized = `${returnToParam || ""}`.trim().replace(/^\/+/, "");
      if (
        normalized === "personal-orders" ||
        normalized === "company-orders" ||
        normalized === "reports" ||
        normalized === "orders"
      ) {
        return `/${normalized}`;
      }
      if (creationSource === "personal_portal") return "/personal-orders";
      if (creationSource === "company_portal") return "/company-orders";
      return "/orders";
    },
    [returnToParam]
  );

  const returnToOrderPath = useMemo(() => {
    const params = new URLSearchParams();
    if (orderId) {
      params.set("mode", "edit");
      params.set("orderId", orderId);
    }
    if (subpoenaId) params.set("subpoenaId", subpoenaId);
    if (panel) params.set("panel", panel);
    if (returnToParam) params.set("returnTo", returnToParam);
    const query = params.toString();
    return `/orders/new${query ? `?${query}` : ""}`;
  }, [orderId, subpoenaId, panel, returnToParam]);

  const draftScope = useMemo(
    () => getDraftOrderScope({ orderId, subpoenaId }),
    [orderId, subpoenaId]
  );

  const [expandedPanels, setExpandedPanels] = useState({
    subpoena: false,
    order: true,
    serve: true,
    payment: true,
  });

  const [formData, setFormData] = useState(initialFormData);
  const formDataRef = useRef(formData);
  const committedFacilityRef = useRef({ id: "", name: "" });
  const draftRestoredRef = useRef(false);
  const restoredDraftScopeRef = useRef("");
  const prevDraftScopeRef = useRef(draftScope);

  useEffect(() => {
    formDataRef.current = formData;
  }, [formData]);

  // Kill document scroll on this page — only the order cards may scroll.
  useEffect(() => {
    const html = document.documentElement;
    const { body } = document;
    const prev = {
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
      htmlHeight: html.style.height,
      bodyHeight: body.style.height,
      htmlBg: html.style.background,
      bodyBg: body.style.background,
    };

    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    html.style.height = "100%";
    body.style.height = "100%";
    html.style.background = "#F8FAFC";
    body.style.background = "#F8FAFC";

    return () => {
      html.style.overflow = prev.htmlOverflow;
      body.style.overflow = prev.bodyOverflow;
      html.style.height = prev.htmlHeight;
      body.style.height = prev.bodyHeight;
      html.style.background = prev.htmlBg;
      body.style.background = prev.bodyBg;
    };
  }, []);

  const setFormDataAndRef = useCallback((updater) => {
    setFormData((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      formDataRef.current = next;
      return next;
    });
  }, []);

  const resetBlankNewOrderForm = useCallback(() => {
    formDataRef.current = initialFormData;
    setFormDataAndRef(initialFormData);
    setTouched({});
    setSubmitAttempted(false);
    setFileErrors({});
    setExtractError("");
    setExtractionMeta({
      facilityName: "",
      facilityCreated: false,
      facilityReactivated: false,
      extractedDoctorName: "",
      providerName: "",
      providerCreated: false,
    });
    setFacilityProfileIncomplete(false);
    setFacilityCreated(false);
    setFacilityReactivated(false);
    setMissingDefaultDoctor(false);
    setDoctorCreated(false);
    setEditSubpoenaSrc("");
    setEditSubpoenaError("");
    setMatchedFacilities([]);
    setClickedMatchFacilityId("");
    clearCommittedFacility();
    clearDraftOrderSession("new");
    draftRestoredRef.current = false;
    restoredDraftScopeRef.current = "";
  }, [setFormDataAndRef]);

  const markCommittedFacility = (id, name) => {
    committedFacilityRef.current = {
      id: `${id || ""}`.trim(),
      name: `${name || ""}`.trim(),
    };
  };

  const clearCommittedFacility = () => {
    committedFacilityRef.current = { id: "", name: "" };
  };

  const [touched, setTouched] = useState({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [fileErrors, setFileErrors] = useState({});

  const [facilities, setFacilities] = useState([]);
  const [facilitiesLoadError, setFacilitiesLoadError] = useState("");

  const [loadingOrder, setLoadingOrder] = useState(isEditMode);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [apiFieldErrors, setApiFieldErrors] = useState({});
  const [extractingSubpoena, setExtractingSubpoena] = useState(false);
  const [extractError, setExtractError] = useState("");
  const [extractionMeta, setExtractionMeta] = useState({
    facilityName: "",
    facilityCreated: false,
    facilityReactivated: false,
    extractedDoctorName: "",
    providerName: "",
    providerCreated: false,
  });
  const [facilityProfileIncomplete, setFacilityProfileIncomplete] = useState(false);
  const [facilityCreated, setFacilityCreated] = useState(false);
  const [facilityReactivated, setFacilityReactivated] = useState(false);
  const [resolvingFacility, setResolvingFacility] = useState(false);
  const [matchedFacilities, setMatchedFacilities] = useState([]);
  const [clickedMatchFacilityId, setClickedMatchFacilityId] = useState("");
  const [missingDefaultDoctor, setMissingDefaultDoctor] = useState(false);
  const [doctorCreated, setDoctorCreated] = useState(false);
  const [resolvingDoctor, setResolvingDoctor] = useState(false);
  const [editSubpoenaSrc, setEditSubpoenaSrc] = useState("");
  const [editSubpoenaLoading, setEditSubpoenaLoading] = useState(false);
  const [editSubpoenaError, setEditSubpoenaError] = useState("");
  const [subpoenaRemoveModal, setSubpoenaRemoveModal] = useState({
    open: false,
    removing: false,
  });
  const [subpoenaViewing, setSubpoenaViewing] = useState(false);
  const [subpoenaViewError, setSubpoenaViewError] = useState("");
  const [subpoenaActionMessage, setSubpoenaActionMessage] = useState("");
  const extractionMetaRef = useRef(extractionMeta);
  const doctorCreatedRef = useRef(false);

  useEffect(() => {
    extractionMetaRef.current = extractionMeta;
  }, [extractionMeta]);

  useEffect(() => {
    doctorCreatedRef.current = doctorCreated;
  }, [doctorCreated]);

  const persistOrderDraft = useCallback((options = {}) => {
    // Blank New Order must not keep a leftover edit/create draft.
    // Only persist that scope when leaving to create/edit a facility or doctor.
    if (draftScope === "new" && options.force !== true) {
      return;
    }

    const current = formDataRef.current;
    const existing = readDraftOrderSession(draftScope, { allowIncomplete: true });

    if (!hasDraftableOrderContent(current) && !existing?.facilityId) {
      return;
    }

    rememberDraftOrderSession(draftScope, {
      // Prefer live form values, but never wipe a known facility id with a stale empty ref.
      facilityId: current.facility || existing?.facilityId || "",
      facilityName: current.facilityName || existing?.facilityName || "",
      formSnapshot: serializeFormForDraft({
        ...(existing?.formSnapshot || {}),
        ...current,
        facility: current.facility || existing?.facilityId || existing?.formSnapshot?.facility || "",
        facilityName:
          current.facilityName ||
          existing?.facilityName ||
          existing?.formSnapshot?.facilityName ||
          "",
      }),
      extractionMeta: {
        ...extractionMetaRef.current,
        doctorCreated: doctorCreatedRef.current,
      },
    });
  }, [draftScope]);

  const persistFacilityDraft = useCallback(() => {
    persistOrderDraft({ force: true });
  }, [persistOrderDraft]);

  useEffect(() => {
    if (!hasDraftableOrderContent(formData)) {
      return undefined;
    }

    const timer = setTimeout(() => {
      persistOrderDraft();
    }, 400);

    return () => clearTimeout(timer);
  }, [formData, persistOrderDraft]);

  useEffect(() => {
    return () => {
      persistOrderDraft();
    };
  }, [persistOrderDraft]);

  const clearFacilityRefreshParam = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("facilityRefresh");
    params.delete("applyFacilityId");
    params.delete("applyDoctorId");
    const query = params.toString();
    router.replace(`/orders/new${query ? `?${query}` : ""}`, { scroll: false });
  }, [router, searchParams]);

  const restoreOrderDraftAfterFacilityReturn = useCallback(async () => {
    const draft = readDraftOrderSession(draftScope);
    if (!draft?.formSnapshot && !draft?.facilityId) {
      return false;
    }

    let resolved = {
      facilityId:
        applyFacilityId ||
        draft.facilityId ||
        draft.formSnapshot?.facility ||
        "",
      // An explicit returned ID is authoritative. Passing the old draft name
      // with a newly created ID can resolve back to the previous facility.
      facilityName: applyFacilityId
        ? ""
        : draft.facilityName || draft.formSnapshot?.facilityName || "",
      facilityProfileIncomplete: false,
      facilityCreated: false,
    };

    if (resolved.facilityId || resolved.facilityName) {
      try {
        resolved = await resolvePendingFacility({
          facilityId: resolved.facilityId,
          facilityName: resolved.facilityName,
        });
      } catch {
        // Keep the facility details already stored in the draft.
      }
    }

    let nextForm = {
      ...initialFormData,
      ...(draft.formSnapshot || {}),
      facility: resolved.facilityId || draft.formSnapshot?.facility || "",
      facilityName: resolved.facilityName || draft.formSnapshot?.facilityName || "",
    };

    let doctorResolved = null;

    if (resolved.facilityId || nextForm.facility) {
      try {
        const resolveDoctorInput = buildDoctorResolveAfterFacilityReturn({
          formSnapshot: nextForm,
          extractionMeta: draft.extractionMeta || {},
        });
        doctorResolved = await resolvePendingDoctorForOrder({
          facilityId: resolved.facilityId || nextForm.facility,
          ...resolveDoctorInput,
          doctorId:
            applyDoctorId ||
            resolveDoctorInput.doctorId ||
            nextForm.specificDoctorId ||
            draft.formSnapshot?.specificDoctorId ||
            "",
        });
        nextForm = applyResolvedDoctorToForm(nextForm, doctorResolved);
        setMissingDefaultDoctor(doctorResolved.missingDefaultDoctor);
        setDoctorCreated(doctorResolved.doctorCreated);
      } catch {
        // Keep the doctor already stored in the draft.
      }
    }

    const activeSubpoenaId =
      `${subpoenaId || nextForm.subpoenaExtractId || ""}`.trim();
    if (activeSubpoenaId && !nextForm.subpoenaFile) {
      try {
        const [blob, extract] = await Promise.all([
          fetchUnprocessedSubpoenaPdf(activeSubpoenaId),
          getUnprocessedSubpoenaById(activeSubpoenaId),
        ]);
        nextForm.subpoenaFile = new File(
          [blob],
          extract?.fileName || "subpoena.pdf",
          { type: "application/pdf" }
        );
      } catch (err) {
        // Prefill can still proceed without the PDF attachment.
        setExtractError(getDocumentOpenErrorMessage(err, "subpoena PDF"));
      }
    }

    setFormDataAndRef(nextForm);
    markCommittedFacility(resolved.facilityId, resolved.facilityName);
    setFacilityProfileIncomplete(resolved.facilityProfileIncomplete);
    setFacilityCreated(resolved.facilityCreated);
    setFacilityReactivated(Boolean(resolved.facilityReactivated));
    if (draft.extractionMeta) {
      setExtractionMeta(draft.extractionMeta);
    } else {
      setExtractionMeta((prev) => ({
        ...prev,
        facilityName: resolved.facilityName,
        facilityCreated: resolved.facilityCreated,
        facilityReactivated: Boolean(resolved.facilityReactivated),
      }));
    }
    if (doctorResolved) {
      setMissingDefaultDoctor(doctorResolved.missingDefaultDoctor);
      setDoctorCreated(doctorResolved.doctorCreated);
    }
    setExpandedPanels((prev) => ({
      ...prev,
      subpoena: Boolean(nextForm.subpoenaFile),
      order: true,
    }));

    rememberDraftOrderSession(draftScope, {
      facilityId: resolved.facilityId,
      facilityName: resolved.facilityName,
      formSnapshot: serializeFormForDraft(nextForm),
      extractionMeta: draft.extractionMeta || extractionMetaRef.current,
    });

    if (resolved.facilityId) {
      setFacilities((prev) => {
        if (prev.some((item) => String(item.id) === String(resolved.facilityId))) {
          return prev;
        }
        return [
          {
            id: Number(resolved.facilityId),
            facility: resolved.facilityName,
          },
          ...prev,
        ];
      });
    }

    draftRestoredRef.current = true;
    restoredDraftScopeRef.current = draftScope;
    return true;
  }, [
    applyDoctorId,
    applyFacilityId,
    draftScope,
    setFormDataAndRef,
    subpoenaId,
  ]);

  useEffect(() => {
    let active = true;

    getFacilities()
      .then((facilityList) => {
        if (!active) return;
        setFacilities(facilityList);
        setFacilitiesLoadError("");
      })
      .catch((err) => {
        if (active) {
          setFacilities([]);
          setFacilitiesLoadError(
            getApiErrorMessage(err, "Failed to load facilities")
          );
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;

    const scopeChanged = prevDraftScopeRef.current !== draftScope;
    prevDraftScopeRef.current = draftScope;

    if (
      isEditMode &&
      restoredDraftScopeRef.current === draftScope &&
      facilityRefresh !== "1" &&
      !applyFacilityId &&
      !applyDoctorId
    ) {
      return undefined;
    }

    if (!isEditMode || !orderId) {
      const returningFromFacilityOrDoctor =
        facilityRefresh === "1" ||
        Boolean(applyFacilityId) ||
        Boolean(applyDoctorId);

      // Soft-nav from edit/subpoena → blank New Order keeps React state.
      // Opening New Order from the list/nav must start empty, not a prior edit.
      if (
        scopeChanged &&
        draftScope === "new" &&
        !subpoenaId &&
        !returningFromFacilityOrDoctor
      ) {
        draftRestoredRef.current = false;
        restoredDraftScopeRef.current = "";
      }

      const forceFreshNewOrder = consumeFreshNewOrderNavigation();

      if (!subpoenaId) {
        // Only restore an in-progress draft when returning from facility/doctor
        // create/edit. Opening New Order from the nav must start fresh.
        if (
          !forceFreshNewOrder &&
          returningFromFacilityOrDoctor &&
          isRestorableDraftOrderSession(readDraftOrderSession(draftScope))
        ) {
          setLoadingOrder(true);
          restoreOrderDraftAfterFacilityReturn()
            .catch(() => {})
            .finally(() => {
              if (active) setLoadingOrder(false);
            });

          return () => {
            active = false;
          };
        }

        if (!returningFromFacilityOrDoctor || forceFreshNewOrder) {
          resetBlankNewOrderForm();
        }
      }
      if (!isEditMode && !subpoenaId && facilityRefresh !== "1") {
        setLoadingOrder(false);
      }
      return undefined;
    }

    setLoadingOrder(true);
    setLoadError("");

    getOrder(orderId)
      .then(async (order) => {
        if (!active) return;

        if (!order) {
          setLoadError("Order not found");
          return;
        }

        const isReturnFromFacilityEdit = facilityRefresh === "1";
        const draftFacility = readDraftOrderSession(draftScope);
        const draftFacilityId = `${
          draftFacility?.facilityId || draftFacility?.formSnapshot?.facility || ""
        }`.trim();
        const orderFacilityId = `${order.facility || ""}`.trim();
        let restoredDoctorAfterFacilityReturn = false;
        // Restore the draft when returning from a facility/doctor detour, when a
        // facility change is still pending, or whenever unsaved edits were kept.
        const shouldRestoreDraft = Boolean(
          ((isReturnFromFacilityEdit || applyFacilityId || applyDoctorId) &&
            (draftFacility?.formSnapshot || draftFacility?.facilityId)) ||
            (draftFacilityId && draftFacilityId !== orderFacilityId) ||
            isRestorableDraftOrderSession(draftFacility)
        );

        let nextForm = syncPaymentDueFields(
          { ...initialFormData, ...order, zip: formatZip(order.zip) },
          order.invoiceFees
        );
        if (
          order.creationSource === "auto" &&
          `${nextForm.orderNumber || ""}`.startsWith(AUTO_PENDING_ORDER_PREFIX)
        ) {
          nextForm.orderNumber = "";
        }
        let profileIncomplete = Boolean(order.facilityProfileIncomplete);
        let facilityWasCreated = Boolean(order.facilityIsAutoCreated);
        let facilityLabel = order.facilityName || "";

        const pendingFacilityId = `${
          applyFacilityId ||
          draftFacility?.facilityId ||
          draftFacility?.formSnapshot?.facility ||
          ""
        }`.trim();
        const pendingFacilityName = `${
          applyFacilityId
            ? ""
            : draftFacility?.facilityName ||
              draftFacility?.formSnapshot?.facilityName ||
              ""
        }`.trim();

        if (shouldRestoreDraft) {
          const draftSnapshot = draftFacility?.formSnapshot || {};
          const hasPendingFacilityChange = Boolean(
            pendingFacilityId && pendingFacilityId !== orderFacilityId
          );
          const shouldApplyDraftDoctor = Boolean(
            applyDoctorId ||
              `${draftSnapshot.specificDoctorId || ""}`.trim() ||
              `${draftSnapshot.specificDoctor || ""}`.trim() ||
              hasPendingFacilityChange
          );

          // Existing-order fields always come from the database. The draft is
          // only a temporary carrier for facility/doctor changes until Update
          // Order succeeds; it must never blank Order No or other saved fields.
          nextForm = {
            ...nextForm,
            facility: pendingFacilityId || nextForm.facility,
            facilityName:
              pendingFacilityName ||
              (applyFacilityId ? "" : nextForm.facilityName),
            ...(shouldApplyDraftDoctor
              ? {
                  specificDoctor: draftSnapshot.specificDoctor || "",
                  specificDoctorId: draftSnapshot.specificDoctorId || "",
                  specificDoctorIsDefault: Boolean(
                    draftSnapshot.specificDoctorIsDefault
                  ),
                }
              : {}),
          };

          try {
            const resolved =
              pendingFacilityId || pendingFacilityName
                ? await resolvePendingFacility({
                    facilityId: pendingFacilityId,
                    facilityName: pendingFacilityName,
                  })
                : {
                    facilityId: nextForm.facility,
                    facilityName: nextForm.facilityName,
                    facilityProfileIncomplete: profileIncomplete,
                    facilityCreated: facilityWasCreated,
                  };

            nextForm = {
              ...nextForm,
              facility: resolved.facilityId || nextForm.facility,
              facilityName: resolved.facilityName || nextForm.facilityName,
              facilityNotInSystem: false,
            };
            profileIncomplete = resolved.facilityProfileIncomplete;
            facilityWasCreated = resolved.facilityCreated;
            facilityLabel = resolved.facilityName || nextForm.facilityName;

            rememberDraftOrderSession(draftScope, {
              facilityId: resolved.facilityId || nextForm.facility,
              facilityName: resolved.facilityName || nextForm.facilityName,
              formSnapshot: serializeFormForDraft(nextForm),
              extractionMeta: draftFacility.extractionMeta || extractionMetaRef.current,
            });

            try {
              const resolveDoctorInput = buildDoctorResolveAfterFacilityReturn({
                formSnapshot: nextForm,
                extractionMeta: draftFacility.extractionMeta || {},
              });
              const doctorResolved = await resolvePendingDoctorForOrder({
                facilityId: resolved.facilityId || nextForm.facility,
                ...resolveDoctorInput,
                doctorId:
                  applyDoctorId ||
                  resolveDoctorInput.doctorId ||
                  nextForm.specificDoctorId ||
                  draftFacility.formSnapshot?.specificDoctorId ||
                  "",
              });
              nextForm = applyResolvedDoctorToForm(nextForm, doctorResolved);
              restoredDoctorAfterFacilityReturn = true;
              if (active) {
                setMissingDefaultDoctor(doctorResolved.missingDefaultDoctor);
                setDoctorCreated(doctorResolved.doctorCreated);
              }
            } catch {
              // Keep the doctor already stored on the order.
            }
          } catch {
            // Keep the facility already stored on the order/draft.
          }
        } else if (applyFacilityId) {
          try {
            const resolved = await resolvePendingFacility({
              facilityId: applyFacilityId,
            });
            nextForm = {
              ...nextForm,
              facility: resolved.facilityId || order.facility || nextForm.facility,
              facilityName:
                resolved.facilityName || order.facilityName || nextForm.facilityName,
              facilityNotInSystem: false,
            };
            profileIncomplete = resolved.facilityProfileIncomplete;
            facilityWasCreated = resolved.facilityCreated;
            facilityLabel = resolved.facilityName || nextForm.facilityName;
          } catch {
            nextForm = {
              ...nextForm,
              facility: order.facility || nextForm.facility,
              facilityName: order.facilityName || nextForm.facilityName,
              facilityNotInSystem: false,
            };
          }
        } else if (!isReturnFromFacilityEdit) {
          // No pending facility change — drop stale draft for a clean load.
          clearDraftOrderSession(draftScope);
        }

        if (
          order.creationSource === "auto" &&
          order.facilityMismatch &&
          order.extractedFacilityId &&
          !shouldRestoreDraft &&
          !applyFacilityId &&
          !isReturnFromFacilityEdit
        ) {
          try {
            const resolved = await resolveBatchMismatchFacilityForEdit(order);
            if (resolved?.facilityId) {
              nextForm = {
                ...nextForm,
                facility: resolved.facilityId,
                facilityName: resolved.facilityName || nextForm.facilityName,
              };
              profileIncomplete = resolved.facilityProfileIncomplete;
              facilityWasCreated = resolved.facilityCreated;
              facilityLabel = resolved.facilityName || nextForm.facilityName;
            }
          } catch {
            // Keep the facility already stored on the order.
          }
        }

        if (!active) return;

        if (
          shouldRestoreDraft ||
          isReturnFromFacilityEdit ||
          applyFacilityId ||
          applyDoctorId
        ) {
          // Marking the scope as restored keeps a later re-render from reloading
          // the saved order over the draft the user is still editing.
          draftRestoredRef.current = true;
          restoredDraftScopeRef.current = draftScope;
        }

        if (nextForm.facility) {
          const isPersonalPortal = nextForm.creationSource === "personal_portal";
          const requestedDoctor = `${
            nextForm.requestedTreatingDoctor ||
            nextForm.newFacilityRequest?.treatingDoctor ||
            ""
          }`.trim();
          const shouldResolveDoctor =
            isPersonalPortal ||
            Boolean(applyDoctorId) ||
            !`${nextForm.specificDoctor || ""}`.trim();
          const skipPostLoadDoctorResolve =
            restoredDoctorAfterFacilityReturn &&
            isReturnFromFacilityEdit &&
            shouldRestoreDraft &&
            !applyDoctorId;

          if (shouldResolveDoctor && !skipPostLoadDoctorResolve) {
            try {
              const resolveDoctorInput =
                isReturnFromFacilityEdit || applyFacilityId
                  ? buildDoctorResolveAfterFacilityReturn({
                      formSnapshot: nextForm,
                      extractionMeta: draftFacility?.extractionMeta || {},
                    })
                  : {
                      doctorId: applyDoctorId || nextForm.specificDoctorId || "",
                      doctorName: isPersonalPortal
                        ? requestedDoctor || nextForm.specificDoctor || ""
                        : "",
                      extractedDoctorName: isPersonalPortal ? requestedDoctor : "",
                      allowCreate: false,
                      useDefaultWhenMissing: isPersonalPortal ? !requestedDoctor : true,
                    };
              const doctorResolved = await resolvePendingDoctorForOrder({
                facilityId: nextForm.facility,
                ...resolveDoctorInput,
                doctorId: applyDoctorId || resolveDoctorInput.doctorId || "",
              });
              nextForm = applyResolvedDoctorToForm(nextForm, doctorResolved);
              nextForm = {
                ...nextForm,
                requestedTreatingDoctor:
                  nextForm.requestedTreatingDoctor || requestedDoctor || "",
              };
              if (active) {
                setMissingDefaultDoctor(
                  Boolean(doctorResolved.missingDefaultDoctor)
                );
                setDoctorCreated(doctorResolved.doctorCreated);
              }
            } catch {
              if (active) setMissingDefaultDoctor(false);
            }
          } else if (active) {
            setMissingDefaultDoctor(false);
          }
        } else if (active) {
          setMissingDefaultDoctor(false);
        }

        nextForm = mergePersonalPortalFieldsFromOrder(nextForm, order);

        if (isReturnFromFacilityEdit || applyFacilityId || applyDoctorId) {
          rememberDraftOrderSession(draftScope, {
            facilityId: nextForm.facility,
            facilityName: nextForm.facilityName,
            formSnapshot: serializeFormForDraft(nextForm),
            extractionMeta:
              draftFacility?.extractionMeta || extractionMetaRef.current,
          });
        }

        setFormDataAndRef(nextForm);
        markCommittedFacility(nextForm.facility, nextForm.facilityName);
        setFacilityProfileIncomplete(profileIncomplete);
        setFacilityCreated(facilityWasCreated);
        setFacilityReactivated(false);
        if (isReturnFromFacilityEdit && draftFacility?.extractionMeta) {
          setExtractionMeta(draftFacility.extractionMeta);
        } else {
          setExtractionMeta((prev) => ({
            ...prev,
            facilityName: facilityLabel,
            facilityCreated: facilityWasCreated,
            facilityReactivated: false,
          }));
        }
        setTouched({});
        setSubmitAttempted(false);
        setFileErrors({});
        if (isReturnFromFacilityEdit || applyFacilityId || applyDoctorId) {
          clearFacilityRefreshParam();
        }
      })
      .catch((err) => {
        if (active) setLoadError(err.message || "Failed to load order");
      })
      .finally(() => {
        if (active) setLoadingOrder(false);
      });

    return () => {
      active = false;
    };
  }, [
    isEditMode,
    orderId,
    subpoenaId,
    facilityRefresh,
    applyFacilityId,
    applyDoctorId,
    draftScope,
    clearFacilityRefreshParam,
    restoreOrderDraftAfterFacilityReturn,
    resetBlankNewOrderForm,
    setFormDataAndRef,
  ]);

  useEffect(() => {
    if (isEditMode || facilityRefresh !== "1") {
      return undefined;
    }

    let active = true;

    (async () => {
      setLoadingOrder(true);
      setLoadError("");

      try {
        const restored = await restoreOrderDraftAfterFacilityReturn();
        if (!active) return;

        if (!restored && subpoenaId) {
          const facilityList = facilities.length ? facilities : await getFacilities();
          const providerList = await getProviders();
          if (!active) return;

          if (!facilities.length) {
            setFacilities(facilityList);
          }

          const extract = await getUnprocessedSubpoenaById(subpoenaId);
          if (!active) return;

          if (extract) {
            let subpoenaFile = null;
            try {
              const blob = await fetchUnprocessedSubpoenaPdf(subpoenaId);
              subpoenaFile = new File(
                [blob],
                extract.fileName || "subpoena.pdf",
                { type: "application/pdf" }
              );
            } catch (err) {
              // Prefill can still proceed without the PDF attachment.
              if (active) {
                setExtractError(getDocumentOpenErrorMessage(err, "subpoena PDF"));
              }
            }

            const { formUpdates, meta } = buildFormFromExtract(
              extract,
              { facilityList, providerList },
              subpoenaFile
            );

            await applyExtractFormUpdates(formUpdates, meta, subpoenaFile, {
              reset: true,
            });
            setExpandedPanels((prev) => ({
              ...prev,
              subpoena: Boolean(subpoenaFile),
              order: true,
            }));
          } else {
            setLoadError("Could not restore your in-progress order.");
          }
        } else if (!restored) {
          setLoadError(
            "Could not restore your in-progress order. Please re-open it from the orders list or re-upload the subpoena."
          );
        }

        clearFacilityRefreshParam();
        setTouched({});
        setSubmitAttempted(false);
        setFileErrors({});
      } catch (err) {
        if (active) {
          setLoadError(err.message || "Failed to restore order after facility update");
        }
      } finally {
        if (active) setLoadingOrder(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [
    isEditMode,
    facilityRefresh,
    restoreOrderDraftAfterFacilityReturn,
    clearFacilityRefreshParam,
    subpoenaId,
    facilities,
  ]);

  useEffect(() => {
    if (!isEditMode) return;

    if (panel === "upload") {
      setExpandedPanels((prev) => ({
        ...prev,
        order: true,
      }));
      return;
    }

    if (panel === "payment") {
      setExpandedPanels((prev) => ({
        ...prev,
        payment: true,
      }));
    }
  }, [panel, isEditMode]);

  useEffect(() => {
    if (!isEditMode || !orderId) return undefined;

    let active = true;

    async function refreshInvoiceFees() {
      try {
        const order = await getOrder(orderId);
        if (!active || !order) return;

        setFormData((prev) =>
          syncPaymentDueFields(
            {
              ...prev,
              invoiceFees: order.invoiceFees || prev.invoiceFees,
            },
            order.invoiceFees || prev.invoiceFees
          )
        );
      } catch {
        // Payment charges can still use the last loaded invoice snapshot.
      }
    }

    if (panel === "payment") {
      refreshInvoiceFees();
    }

    const handleVisibility = () => {
      if (document.visibilityState === "visible" && panel === "payment") {
        refreshInvoiceFees();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      active = false;
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [isEditMode, orderId, panel]);

  useEffect(() => {
    if (!isEditMode || !orderId || !expandedPanels.payment) {
      return undefined;
    }

    let active = true;

    async function refreshPaymentDues() {
      try {
        const order = await getOrder(orderId);
        if (!active || !order) return;

        setFormData((prev) =>
          syncPaymentDueFields(
            {
              ...prev,
              invoiceFees: order.invoiceFees || prev.invoiceFees,
            },
            order.invoiceFees || prev.invoiceFees
          )
        );
      } catch {
        // Keep the last loaded payment snapshot.
      }
    }

    refreshPaymentDues();

    return () => {
      active = false;
    };
  }, [isEditMode, orderId, expandedPanels.payment]);

  useEffect(() => {
    if (!isEditMode || !orderId) {
      setEditSubpoenaSrc("");
      setEditSubpoenaError("");
      setEditSubpoenaLoading(false);
      return undefined;
    }

    if (!formData.subpoenaStoragePath || formData.subpoenaFile) {
      setEditSubpoenaSrc("");
      setEditSubpoenaError("");
      setEditSubpoenaLoading(false);
      return undefined;
    }

    let active = true;
    let objectUrl = "";

    setEditSubpoenaLoading(true);
    setEditSubpoenaError("");

    (async () => {
      try {
        const blob = await fetchOrderSubpoenaPdf(orderId);
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setEditSubpoenaSrc(objectUrl);
        setEditSubpoenaError("");
      } catch (err) {
        if (active) {
          setEditSubpoenaSrc("");
          setEditSubpoenaError(
            getDocumentOpenErrorMessage(err, "subpoena PDF")
          );
        }
      } finally {
        if (active) {
          setEditSubpoenaLoading(false);
        }
      }
    })();

    return () => {
      active = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [isEditMode, orderId, formData.subpoenaStoragePath, formData.subpoenaFile, formData.subpoenaUrl]);

  useEffect(() => {
    if (
      isEditMode ||
      !subpoenaId ||
      facilityRefresh === "1" ||
      draftRestoredRef.current
    ) {
      return undefined;
    }

    let active = true;

    setLoadingOrder(true);
    setLoadError("");

    (async () => {
      try {
        const facilityList = facilities.length ? facilities : await getFacilities();
        const providerList = await getProviders();
        if (!active) return;

        if (!facilities.length) {
          setFacilities(facilityList);
        }

        const extract = await getUnprocessedSubpoenaById(subpoenaId);
        if (!active) return;

        if (!extract) {
          setLoadError("Subpoena extract not found");
          return;
        }

        let subpoenaFile = null;
        try {
          const blob = await fetchUnprocessedSubpoenaPdf(subpoenaId);
          subpoenaFile = new File(
            [blob],
            extract.fileName || "subpoena.pdf",
            { type: "application/pdf" }
          );
        } catch (err) {
          // Prefill can still proceed without the PDF attachment.
          if (active) {
            setExtractError(getDocumentOpenErrorMessage(err, "subpoena PDF"));
          }
        }

        const { formUpdates, meta } = buildFormFromExtract(
          extract,
          { facilityList, providerList },
          subpoenaFile
        );

        await applyExtractFormUpdates(formUpdates, meta, subpoenaFile, {
          reset: true,
        });
        setTouched({});
        setSubmitAttempted(false);
        setFileErrors({});
        setExpandedPanels((prev) => ({
          ...prev,
          subpoena: Boolean(subpoenaFile),
          order: true,
        }));
      } catch (err) {
        if (active) {
          setLoadError(err.message || "Failed to load subpoena extract");
        }
      } finally {
        if (active) setLoadingOrder(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [isEditMode, subpoenaId]);

  const applyExtractFormUpdates = async (
    formUpdates,
    meta,
    subpoenaFile = null,
    { reset = false } = {}
  ) => {
    let nextUpdates = { ...formUpdates };
    let nextMeta = { ...meta };

    if (formUpdates.facility) {
      setFacilityProfileIncomplete(Boolean(meta.facilityProfileIncomplete));
      setFacilityCreated(Boolean(meta.facilityCreated));
      setFacilityReactivated(Boolean(meta.facilityReactivated));
      markCommittedFacility(
        formUpdates.facility,
        formUpdates.facilityName || meta.facilityName || ""
      );

      if (formUpdates.facility) {
        setFacilities((prev) => {
          if (prev.some((item) => String(item.id) === String(formUpdates.facility))) {
            return prev;
          }
          return [
            {
              id: Number(formUpdates.facility),
              facility: formUpdates.facilityName || meta.facilityName || "",
            },
            ...prev,
          ];
        });
      }
    }

    const unresolvedFacilityName =
      !formUpdates.facility &&
      `${meta.pendingFacilityName || formUpdates.facilityName || ""}`.trim();

    if (unresolvedFacilityName) {
      nextUpdates = {
        ...nextUpdates,
        facility: "",
        facilityName: unresolvedFacilityName,
      };
      nextMeta = {
        ...nextMeta,
        facilityName: unresolvedFacilityName,
        facilityCreated: false,
        facilityReactivated: false,
      };
      clearCommittedFacility();
      setFacilityProfileIncomplete(false);
      setFacilityCreated(false);
      setFacilityReactivated(false);
    }

    const facilityIdForDoctor = `${nextUpdates.facility || formUpdates.facility || ""}`.trim();
    if (facilityIdForDoctor) {
      if (nextMeta.missingDefaultDoctor) {
        nextUpdates = {
          ...nextUpdates,
          specificDoctor: "",
          specificDoctorId: "",
          specificDoctorIsDefault: false,
        };
        setMissingDefaultDoctor(true);
        setDoctorCreated(Boolean(nextMeta.doctorCreated));
      } else {
        const doctorName =
          nextUpdates.specificDoctor ||
          formUpdates.specificDoctor ||
          nextMeta.extractedDoctorName ||
          "";

        try {
          const doctorResolved = await resolvePendingDoctorForOrder({
            facilityId: facilityIdForDoctor,
            doctorId:
              nextUpdates.specificDoctorId ||
              formUpdates.specificDoctorId ||
              "",
            doctorName,
            extractedDoctorName: nextMeta.extractedDoctorName,
            priorDoctorCreated: Boolean(nextMeta.doctorCreated),
            allowCreate: false,
          });
          nextUpdates = {
            ...nextUpdates,
            specificDoctor: doctorResolved.specificDoctor,
            specificDoctorId: doctorResolved.specificDoctorId,
            specificDoctorIsDefault: doctorResolved.specificDoctorIsDefault,
            doctorNotInSystem: Boolean(doctorResolved.doctorMissing),
          };
          setMissingDefaultDoctor(doctorResolved.missingDefaultDoctor);
          setDoctorCreated(doctorResolved.doctorCreated);
        } catch {
          setMissingDefaultDoctor(false);
          setDoctorCreated(false);
        }
      }
    }

    setFormData((prev) => {
      const previousOriginal = reset
        ? ""
        : `${prev.subpoenaOriginalFileName || ""}`.trim();
      const fileOriginal = `${subpoenaFile?.name || ""}`.trim();
      const looksGenerated =
        /^[a-f0-9]{32}_\d+\./i.test(fileOriginal) ||
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(
          fileOriginal
        );

      return {
        ...(reset ? initialFormData : prev),
        ...nextUpdates,
        ...(subpoenaFile ? { subpoenaFile } : {}),
        subpoenaOriginalFileName:
          previousOriginal ||
          `${nextUpdates.subpoenaOriginalFileName || ""}`.trim() ||
          (fileOriginal && !looksGenerated ? fileOriginal : "") ||
          "",
      };
    });
    setExtractionMeta((prev) => ({ ...prev, ...nextMeta }));

    // Suggest system facilities with >= 80% name similarity to the extracted name.
    // Does not change extraction; click only fills the form until Save.
    try {
      const extractedFacilityName = `${
        nextMeta.pendingFacilityName ||
        nextMeta.facilityName ||
        nextUpdates.facilityName ||
        formUpdates.facilityName ||
        ""
      }`.trim();

      if (extractedFacilityName) {
        let facilityList = facilities;
        if (!facilityList.length) {
          facilityList = await getFacilities();
          setFacilities(facilityList);
        }
        setClickedMatchFacilityId("");
        setMatchedFacilities(
          findSimilarFacilities(extractedFacilityName, facilityList, {
            minScore: 0.8,
            limit: 5,
          })
        );
      } else {
        setMatchedFacilities([]);
    setClickedMatchFacilityId("");
      }
    } catch {
      setMatchedFacilities([]);
    setClickedMatchFacilityId("");
    }

    const draftFacilityId = `${nextUpdates.facility || formUpdates.facility || ""}`.trim();
    if (draftFacilityId) {
      rememberDraftOrderSession(draftScope, {
        facilityId: draftFacilityId,
        facilityName:
          nextUpdates.facilityName ||
          formUpdates.facilityName ||
          nextMeta.facilityName ||
          "",
        formSnapshot: serializeFormForDraft({
          ...(reset ? initialFormData : formDataRef.current),
          ...nextUpdates,
          ...(subpoenaFile ? { subpoenaExtractId: nextUpdates.subpoenaExtractId } : {}),
        }),
        extractionMeta: { ...extractionMetaRef.current, ...nextMeta },
      });
    }
  };

  const errors = useMemo(
    () => ({
      ...validateNewOrderForm(formData, fileErrors),
      ...validateOrderPaymentAmounts(formData, formData.invoiceFees),
      ...apiFieldErrors,
    }),
    [formData, fileErrors, apiFieldErrors]
  );

  const hasImmediateRequiredErrors = getImmediateRequiredFields(formData).some(
    (field) => {
      if (field === "facilityName") {
        return Boolean(errors.facilityName || errors.facility);
      }
      if (field === "facilityAddress") {
        return Boolean(errors.facilityAddress);
      }
      return Boolean(errors[field]);
    }
  );

  const hasValidationErrors = Object.values(errors).some(Boolean);
  const isOrderReadOnly =
    isEditMode && isOrderInactiveStatus(formData.status);

  const listBackHref = useMemo(
    () => resolveListPath(formData.creationSource),
    [formData.creationSource, resolveListPath]
  );

  const listBackLabel = useMemo(() => {
    if (listBackHref === "/personal-orders") return "Back to Personal Orders";
    if (listBackHref === "/company-orders") return "Back to Company Orders";
    if (listBackHref === "/reports") return "Back to Reports";
    return "Back to Orders";
  }, [listBackHref]);

  const handleListBack = useCallback(() => {
    if (isEditMode) {
      const returnTo =
        listBackHref === "/personal-orders"
          ? "personal-orders"
          : listBackHref === "/company-orders"
            ? "company-orders"
            : listBackHref === "/reports"
              ? "reports"
              : "orders";
      markOrderListFiltersForRestore(returnTo);
    }
    clearDraftOrderSession(draftScope);
    draftRestoredRef.current = false;
    router.push(listBackHref);
  }, [draftScope, isEditMode, listBackHref, router]);

  const personalRequestedDoctor = `${
    formData.requestedTreatingDoctor ||
    formData.newFacilityRequest?.treatingDoctor ||
    ""
  }`.trim();
  // Personal required fields are listed separately; facility/doctor link helpers
  // no longer hard-block Update Order.
  const personalDoctorBlocksUpdate = false;

  const personalNeedsFacilityAdd =
    formData.creationSource === "personal_portal" &&
    formData.personalPortalStatus !== "no_facility" &&
    (Boolean(formData.facilityNotInSystem) ||
      formData.newFacilityRequest?.status === "pending" ||
      (!`${formData.facility || ""}`.trim() &&
        Boolean(`${formData.facilityName || ""}`.trim())));

  const syncDoctorFromForm = async (data, options = {}) => {
    const facilityId = `${data.facility || ""}`.trim();

    if (!facilityId) {
      setMissingDefaultDoctor(false);
      setDoctorCreated(false);
      return null;
    }

    const isPersonalPortal = data.creationSource === "personal_portal";
    const requestedDoctor = `${
      data.requestedTreatingDoctor ||
      data.newFacilityRequest?.treatingDoctor ||
      ""
    }`.trim();
    const doctorName = `${options.doctorName ?? data.specificDoctor ?? ""}`.trim();
    const extractedDoctorName = `${options.extractedDoctorName ?? ""}`.trim();
    const useDefaultOnly = Boolean(options.useDefaultOnly);
    const nameToResolve = useDefaultOnly
      ? ""
      : options.resetForFacilityChange
        ? ""
        : options.useTypedDoctorOnly
          ? doctorName
          : isPersonalPortal
            ? requestedDoctor || doctorName
            : doctorName || extractedDoctorName;

    // Personal + requested/typed doctor: never fall through to a fake "present"
    // match; resolve with allowCreate false and surface doctorMissing.
    const personalHasDoctorHint = Boolean(
      isPersonalPortal &&
        !useDefaultOnly &&
        (options.useTypedDoctorOnly
          ? doctorName
          : requestedDoctor || doctorName)
    );

    setResolvingDoctor(true);

    try {
      const resolved = await resolvePendingDoctorForOrder({
        facilityId,
        doctorId:
          useDefaultOnly || options.resetForFacilityChange
            ? ""
            : data.specificDoctorId || "",
        doctorName: nameToResolve,
        extractedDoctorName:
          useDefaultOnly || options.resetForFacilityChange
            ? ""
            : isPersonalPortal
              ? requestedDoctor || doctorName
              : extractedDoctorName ||
                extractionMetaRef.current?.extractedDoctorName,
        priorDoctorCreated:
          useDefaultOnly || options.resetForFacilityChange
            ? false
            : Boolean(extractionMetaRef.current?.doctorCreated),
        allowCreate: false,
        useDefaultWhenMissing: useDefaultOnly
          ? true
          : options.resetForFacilityChange
            ? true
            : isPersonalPortal
              ? !personalHasDoctorHint
              : // Standard orders: doctor is optional — only apply default when asked.
                false,
      });

      setFormData((prev) => ({
        ...prev,
        specificDoctor: resolved.specificDoctor,
        specificDoctorId: resolved.specificDoctorId,
        specificDoctorIsDefault: resolved.specificDoctorIsDefault,
        doctorNotInSystem: Boolean(resolved.doctorMissing),
        requestedTreatingDoctor:
          prev.requestedTreatingDoctor || requestedDoctor || "",
      }));
      setMissingDefaultDoctor(Boolean(resolved.missingDefaultDoctor));
      setDoctorCreated(
        useDefaultOnly || options.resetForFacilityChange
          ? false
          : resolved.doctorCreated
      );

      return resolved;
    } finally {
      setResolvingDoctor(false);
    }
  };

  const syncFacilityFromForm = async (data, options = {}) => {
    const facilityName = `${data.facilityName || ""}`.trim();
    const facilityId = `${data.facility || ""}`.trim();
    const previousFacilityId = `${formDataRef.current.facility || ""}`.trim();
    const blockCreate = data.creationSource === "personal_portal";
    const endedNoFacility =
      blockCreate && data.personalPortalStatus === "no_facility";

    if (!facilityName && !facilityId) {
      setFacilityProfileIncomplete(false);
      setFacilityCreated(false);
      setFacilityReactivated(false);
      setMissingDefaultDoctor(false);
      setDoctorCreated(false);
      return null;
    }

    if (blockCreate && !facilityId) {
      // Typed name only — do not auto-create; staff uses Add facility link.
      setFacilityProfileIncomplete(false);
      setFacilityCreated(false);
      setFacilityReactivated(false);
      return {
        facilityId: "",
        facilityName,
        facilityCreated: false,
        facilityReactivated: false,
        facilityProfileIncomplete: false,
        needsFacilityAdd: true,
      };
    }

    setResolvingFacility(true);

    try {
      const resolved = await resolvePendingFacility({
        facilityName,
        facilityId,
        allowCreate: !blockCreate,
      });
      if (blockCreate && resolved.facilityCreated) {
        setSaveError(
          "Personal orders do not auto-create facilities. Use “Add this facility to system” under Facility, or select an existing facility."
        );
        return null;
      }
      const newFacilityId = `${resolved.facilityId || ""}`.trim();
      const subpoenaFacilityName = `${extractionMetaRef.current.facilityName || ""}`.trim();
      const subpoenaDoctorMismatch =
        Boolean(subpoenaFacilityName) &&
        Boolean(resolved.facilityName) &&
        !isSameFacilityLabel(subpoenaFacilityName, resolved.facilityName) &&
        Boolean(
          data.specificDoctor ||
            data.specificDoctorId ||
            extractionMetaRef.current.extractedDoctorName
        );
      const facilityChanged =
        Boolean(options.facilityChanged) ||
        Boolean(
          previousFacilityId &&
            newFacilityId &&
            previousFacilityId !== newFacilityId
        ) ||
        subpoenaDoctorMismatch;

      setFormDataAndRef((prev) => ({
        ...prev,
        facility: resolved.facilityId,
        facilityName: resolved.facilityName,
        ...(facilityChanged
          ? {
              specificDoctor: "",
              specificDoctorId: "",
              specificDoctorIsDefault: false,
            }
          : {}),
      }));
      markCommittedFacility(resolved.facilityId, resolved.facilityName);
      const selectedExisting = Boolean(options.fromMatchList);
      setFacilityProfileIncomplete(resolved.facilityProfileIncomplete);
      setFacilityCreated(selectedExisting ? false : resolved.facilityCreated);
      setFacilityReactivated(
        selectedExisting ? false : Boolean(resolved.facilityReactivated)
      );

      const keepSubpoenaDoctorContext =
        extractionMetaRef.current.facilityName &&
        isSameFacilityLabel(
          resolved.facilityName,
          extractionMetaRef.current.facilityName
        );

      if (facilityChanged) {
        setExtractionMeta((prev) => ({
          ...prev,
          facilityName: resolved.facilityName,
          facilityCreated: resolved.facilityCreated,
          facilityReactivated: Boolean(resolved.facilityReactivated),
          ...(keepSubpoenaDoctorContext
            ? {}
            : { extractedDoctorName: "", doctorCreated: false }),
        }));
        setDoctorCreated(false);
      } else {
        setExtractionMeta((prev) => ({
          ...prev,
          facilityName: resolved.facilityName,
          facilityCreated: resolved.facilityCreated,
          facilityReactivated: Boolean(resolved.facilityReactivated),
        }));
      }

      if (resolved.facilityId) {
        setFacilities((prev) => {
          if (prev.some((item) => String(item.id) === String(resolved.facilityId))) {
            return prev;
          }
          return [
            {
              id: Number(resolved.facilityId),
              facility: resolved.facilityName,
            },
            ...prev,
          ];
        });
      }

      const doctorResolved = await syncDoctorFromForm(
        {
          ...(facilityChanged
            ? {
                specificDoctor: "",
                specificDoctorId: "",
                specificDoctorIsDefault: false,
              }
            : data),
          facility: resolved.facilityId,
          facilityName: resolved.facilityName,
        },
        facilityChanged
          ? { resetForFacilityChange: true }
          : {
              extractedDoctorName: extractionMetaRef.current?.extractedDoctorName,
            }
      );

      if (resolved.facilityId) {
        rememberDraftOrderSession(draftScope, {
          facilityId: resolved.facilityId,
          facilityName: resolved.facilityName,
          formSnapshot: serializeFormForDraft({
            ...formDataRef.current,
            ...data,
            facility: resolved.facilityId,
            facilityName: resolved.facilityName,
            specificDoctor:
              doctorResolved?.specificDoctor ?? formDataRef.current.specificDoctor,
            specificDoctorId:
              doctorResolved?.specificDoctorId ?? formDataRef.current.specificDoctorId,
            specificDoctorIsDefault:
              doctorResolved?.specificDoctorIsDefault ??
              formDataRef.current.specificDoctorIsDefault,
          }),
          extractionMeta: extractionMetaRef.current,
        });
      }

      return { ...resolved, doctorResolved };
    } finally {
      setResolvingFacility(false);
    }
  };

  const handleFacilityInput = (facilityName) => {
    if (isOrderReadOnly) return;
    clearCommittedFacility();
    setMatchedFacilities([]);
    setClickedMatchFacilityId("");
    setClickedMatchFacilityId("");
    setExtractionMeta((prev) => ({
      ...prev,
      facilityName: "",
      facilityCreated: false,
      facilityReactivated: false,
      extractedDoctorName: "",
      doctorCreated: false,
    }));
    setFacilityProfileIncomplete(false);
    setFacilityCreated(false);
    setFacilityReactivated(false);
    setMissingDefaultDoctor(false);
    setDoctorCreated(false);
    setFormDataAndRef((prev) => ({
      ...prev,
      facility: "",
      facilityName,
      specificDoctor: "",
      specificDoctorId: "",
      specificDoctorIsDefault: false,
    }));
  };

  const handleFacilitySelect = (facility, { fromMatchList = false } = {}) => {
    if (isOrderReadOnly) return;
    const newFacilityId = String(facility.id);
    const prevFacilityId = `${formDataRef.current.facility || ""}`.trim();
    const selectedFacilityName = facility.facility || facility.facilityName || "";
    const subpoenaFacilityName = `${extractionMetaRef.current.facilityName || ""}`.trim();
    const subpoenaDoctorMismatch =
      Boolean(subpoenaFacilityName) &&
      Boolean(selectedFacilityName) &&
      !isSameFacilityLabel(subpoenaFacilityName, selectedFacilityName) &&
      Boolean(
        formDataRef.current.specificDoctor ||
          formDataRef.current.specificDoctorId ||
          extractionMetaRef.current.extractedDoctorName
      );
    const facilityChanged =
      Boolean(prevFacilityId && prevFacilityId !== newFacilityId) ||
      subpoenaDoctorMismatch;

    const next = {
      ...formDataRef.current,
      facility: newFacilityId,
      facilityName: facility.facility || facility.facilityName || "",
      ...(facilityChanged
        ? {
            specificDoctor: "",
            specificDoctorId: "",
            specificDoctorIsDefault: false,
          }
        : {}),
    };

    if (!fromMatchList) {
      setMatchedFacilities([]);
    setClickedMatchFacilityId("");
    }
    setFormDataAndRef(next);
    syncFacilityFromForm(next, { facilityChanged, fromMatchList });
  };

  const handleMatchedFacilitySelect = (facility) => {
    if (isOrderReadOnly || !facility) return;
    setClickedMatchFacilityId(String(facility.id));
    handleFacilitySelect(facility, { fromMatchList: true });
  };

  const handleFacilityCommit = (typedName = "") => {
    if (isOrderReadOnly) return;
    const trimmedName = `${typedName || formDataRef.current.facilityName || ""}`.trim();

    if (!trimmedName) {
      return;
    }

    if (formDataRef.current.creationSource === "personal_portal") {
      // Keep typed name; Add facility link handles create (no auto-create).
      setFormDataAndRef((prev) => ({
        ...prev,
        facilityName: trimmedName,
        facility: "",
      }));
      return;
    }

    const committed = committedFacilityRef.current;
    if (
      committed.id &&
      formDataRef.current.facility === committed.id &&
      isSameFacilityLabel(trimmedName, committed.name)
    ) {
      return;
    }

    const nextForm = {
      ...formDataRef.current,
      facilityName: trimmedName,
      facility: "",
      specificDoctor: "",
      specificDoctorId: "",
      specificDoctorIsDefault: false,
    };
    setFormDataAndRef(nextForm);
    persistOrderDraft();

    const params = new URLSearchParams({
      facilityName: trimmedName,
      returnTo: returnToOrderPath,
    });
    router.push(`/facilities/new?${params.toString()}`);
  };

  const handleFacilityBlur = () => {
    handleFacilityCommit();
  };

  const hasSubpoena = Boolean(
    formData.subpoenaFile || formData.subpoenaUrl || formData.subpoenaStoragePath
  );

  const visiblePanelKeys = hasSubpoena
    ? ["subpoena", "order", "serve", "payment"]
    : ["order", "serve", "payment"];

  const allExpanded = visiblePanelKeys.every((key) => expandedPanels[key]);

  const togglePanel = (panel) => {
    setExpandedPanels((prev) => ({
      ...prev,
      [panel]: !prev[panel],
    }));
  };

  const toggleAllPanels = () => {
    const nextValue = !allExpanded;

    setExpandedPanels((prev) => ({
      ...prev,
      subpoena: hasSubpoena ? nextValue : false,
      order: nextValue,
      serve: nextValue,
      payment: nextValue,
    }));
  };

  const handleBlur = (e) => {
    const { name } = e.target;

    setTouched((prev) => ({
      ...prev,
      [name]: true,
    }));

    if (PROVIDER_SYNC_FIELDS.has(name)) {
      setFormData((prev) => {
        syncProviderFromForm(prev);
        return prev;
      });
    }
  };

  const syncProviderFromForm = async (data) => {
    const providerId = Number(data.providerId);

    if (!Number.isFinite(providerId) || providerId <= 0) return;
    if (!(`${data.serveCompanyName || ""}`.trim())) return;

    try {
      await updateProvider(providerId, {
        companyName: data.serveCompanyName,
        address: data.address,
        zip: formatZip(data.zip),
        city: data.city,
        state: data.state,
        phone: data.phone,
        fax: data.fax,
        email: data.email,
      });

      setApiFieldErrors((prev) => {
        const next = { ...prev };
        PROVIDER_SYNC_FIELDS.forEach((field) => {
          delete next[field];
        });
        return next;
      });
    } catch (err) {
      const { fieldErrors } = applyApiFieldErrors(err, {
        companyName: "serveCompanyName",
      });

      if (Object.keys(fieldErrors).length > 0) {
        setApiFieldErrors((prev) => ({ ...prev, ...fieldErrors }));
      }
    }
  };

  const handleProviderBlur = () => {
    setFormData((prev) => {
      syncProviderFromForm(prev);
      return prev;
    });
  };

  const handleDoctorBlur = (e) => {
    handleBlur(e);
    const data = formDataRef.current;
    const typedDoctor = `${data.specificDoctor || ""}`.trim();
    const facilityId = `${data.facility || ""}`.trim();
    if (!facilityId) return;

    // Empty doctor is allowed on standard orders — clear link flags.
    if (!typedDoctor) {
      if (data.creationSource === "personal_portal") return;
      setFormData((prev) => ({
        ...prev,
        specificDoctorId: "",
        specificDoctorIsDefault: false,
        doctorNotInSystem: false,
      }));
      setMissingDefaultDoctor(false);
      setDoctorCreated(false);
      return;
    }

    syncDoctorFromForm(data, {
      doctorName: typedDoctor,
      useTypedDoctorOnly: true,
    });
  };

  const handleUseDefaultDoctor = async () => {
    if (isOrderReadOnly) return;
    const data = formDataRef.current;
    if (!`${data.facility || ""}`.trim()) return;

    await syncDoctorFromForm(data, {
      useDefaultOnly: true,
      extractedDoctorName: "",
    });
  };

  const getError = (name) => {
    const shouldShowImmediately =
      getImmediateRequiredFields(formData).includes(name) ||
      (formData.creationSource === "personal_portal" &&
        ["facilityName", "facilityAddress", "dob", "driverLicenseNumber"].includes(
          name
        )) ||
      isEditMode;

    if (shouldShowImmediately || touched[name] || submitAttempted) {
      return errors[name] || "";
    }

    return "";
  };

  const handlePaymentValuesChange = (updates) => {
    if (isOrderReadOnly) return;
    setFormData((prev) =>
      syncPaymentDueFields(
        {
          ...prev,
          ...updates,
        },
        prev.invoiceFees
      )
    );
  };

  const handleChange = (e) => {
    if (isOrderReadOnly) return;
    const { name, value, type, checked } = e.target;

    if (name === "recordTypes" && value && typeof value === "object") {
      setFormData((prev) => ({
        ...prev,
        ...value,
      }));
      return;
    }

    if (name === "certificateNoRecords") {
      setFormData((prev) => ({
        ...prev,
        certificateNoRecords: checked,
        cnrReason: checked ? prev.cnrReason : "",
        cnrDelivery: checked ? prev.cnrDelivery : "",
        cnrDateSent: checked ? prev.cnrDateSent : "",
        cnrMemo: checked ? prev.cnrMemo : false,
      }));

      return;
    }

    let nextValue = value;

    if (type === "checkbox") {
      nextValue = checked;
    } else if (phoneFields.includes(name)) {
      nextValue = formatPhone(value);
    } else if (name === "ssn") {
      nextValue = formatSSN(value);
    } else if (name === "zip") {
      nextValue = formatZip(value);
    } else if (name === "state") {
      nextValue = value.replace(/[^a-zA-Z]/g, "").toUpperCase().slice(0, 2);
    } else if (numericOnlyFields.includes(name)) {
      nextValue = value.replace(/\D/g, "").slice(0, 12);
    } else if (moneyFields.includes(name)) {
      nextValue = formatMoneyInput(value);
    }

    setFormData((prev) => ({
      ...prev,
      [name]: nextValue,
      ...(name === "specificDoctor" && nextValue !== prev.specificDoctor
        ? { specificDoctorIsDefault: false, specificDoctorId: "" }
        : {}),
    }));

    setApiFieldErrors((prev) => {
      if (!prev[name]) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });

    if (name === "facility") {
      setExtractionMeta((prev) => ({
        ...prev,
        facilityName: "",
        facilityCreated: false,
        facilityReactivated: false,
      }));
    }
  };

  const handleProviderInput = (companyName) => {
    if (isOrderReadOnly) return;
    setExtractionMeta((prev) => ({ ...prev, providerName: "" }));
    setFormData((prev) => ({
      ...prev,
      providerId: "",
      serveCompanyName: companyName,
      address: "",
      zip: "",
      city: "",
      state: "",
      phone: "",
      fax: "",
      email: "",
    }));
  };

  const handleProviderSelect = (provider) => {
    if (isOrderReadOnly) return;
    setFormData((prev) => ({
      ...prev,
      providerId: String(provider.id),
      serveCompanyName: provider.companyName || "",
      address: provider.address || "",
      zip: formatZip(provider.zipCode || provider.zip || ""),
      city: provider.city || "",
      state: provider.state || "",
      phone: provider.phone || "",
      fax: provider.fax || "",
      email: provider.email || "",
    }));
  };

  const handleFileChange = async (e, fieldName) => {
    if (isOrderReadOnly) return;
    const file = e.target.files?.[0] || null;
    // Allow selecting the same file again after remove/replace.
    e.target.value = "";

    const error = validateFile(file, {
      pdfOnly: fieldName === "subpoenaFile",
    });

    if (error) {
      // Reject oversize/invalid files: do not keep them or load preview.
      setFormData((prev) => ({
        ...prev,
        [fieldName]: null,
      }));
      if (fieldName === "subpoenaFile") {
        setExtractError("");
        setExtractingSubpoena(false);
      }
      setFileErrors((prev) => ({
        ...prev,
        [fieldName]: error,
      }));
      setTouched((prev) => ({
        ...prev,
        [fieldName]: true,
      }));
      return;
    }

    setFormData((prev) => {
      const next = {
        ...prev,
        [fieldName]: file,
      };

      if (fieldName === "subpoenaFile") {
        // Drop prior extract fields so a replacement PDF cannot leave stale
        // patient/facility values when the new extract omits them.
        for (const key of SUBPOENA_EXTRACTED_FIELD_KEYS) {
          if (Object.prototype.hasOwnProperty.call(initialFormData, key)) {
            next[key] = initialFormData[key];
          }
        }
        next.subpoenaExtractId = "";
        next.subpoenaUrl = "";
        next.subpoenaStoragePath = null;
        next.subpoenaOriginalFileName = file?.name || "";
      }

      return next;
    });

    setFileErrors((prev) => ({
      ...prev,
      [fieldName]: error,
    }));

    setTouched((prev) => ({
      ...prev,
      [fieldName]: true,
    }));

    if (fieldName === "subpoenaFile" && file && !error) {
      setEditSubpoenaSrc("");
      setEditSubpoenaError("");
      setSubpoenaViewError("");
      setSubpoenaActionMessage("");
      setMatchedFacilities([]);
    setClickedMatchFacilityId("");
      setExtractionMeta({
        facilityName: "",
        facilityCreated: false,
        facilityReactivated: false,
        extractedDoctorName: "",
        providerName: "",
        providerCreated: false,
      });
      setFacilityProfileIncomplete(false);
      setFacilityCreated(false);
      setFacilityReactivated(false);
      setMissingDefaultDoctor(false);
      setDoctorCreated(false);
      clearCommittedFacility();
      setExpandedPanels((prev) => ({
        ...prev,
        subpoena: true,
      }));

      setExtractingSubpoena(true);
      setExtractError("");

      try {
        const facilityList = facilities.length ? facilities : await getFacilities();
        const providerList = await getProviders();
        if (!facilities.length) {
          setFacilities(facilityList);
        }

        const result = await uploadSingleSubpoena(file);
        const extract = result?.extract || result;

        const { formUpdates, meta } = buildFormFromExtract(
          { ...extract, extractId: result?.extractId },
          { facilityList, providerList },
          file
        );

        await applyExtractFormUpdates(formUpdates, meta, file);
        setExpandedPanels((prev) => ({
          ...prev,
          subpoena: true,
          order: true,
        }));
      } catch (err) {
        setExtractError(
          getApiErrorMessage(
            err,
            "Failed to extract subpoena. You can still fill the form manually."
          )
        );
      } finally {
        setExtractingSubpoena(false);
      }
    }
  };

  const handleRemoveSelectedFile = (fieldName) => {
    if (isOrderReadOnly) return;
    setFormData((prev) => ({
      ...prev,
      [fieldName]: null,
      ...(fieldName === "subpoenaFile" ? { subpoenaExtractId: "" } : {}),
      ...(fieldName === "additionalDocumentFile" ? { documentName: "" } : {}),
    }));
    setFileErrors((prev) => {
      const next = { ...prev };
      delete next[fieldName];
      return next;
    });
    if (fieldName === "subpoenaFile") {
      setExtractError("");
      setEditSubpoenaSrc("");
      setEditSubpoenaError("");
      setSubpoenaViewError("");
      setSubpoenaActionMessage("");
      setMatchedFacilities([]);
    setClickedMatchFacilityId("");
    }
  };

  const applyOrderDocumentState = (order) => {
    if (!order) return;
    setFormData((prev) => ({
      ...prev,
      documents: Array.isArray(order.documents) ? order.documents : [],
      subpoenaFile: null,
      subpoenaUrl: order.subpoenaUrl || "",
      subpoenaStoragePath: order.subpoenaStoragePath || null,
      subpoenaOriginalFileName:
        order.subpoenaOriginalFileName || order.subpoenaFileName || "",
      additionalDocumentFile: null,
      documentName: "",
    }));
    setEditSubpoenaSrc(order.subpoenaUrl ? toFileUrl(order.subpoenaUrl) : "");
    setEditSubpoenaError("");
    setSubpoenaViewError("");
  };

  const clearSubpoenaExtractedFormFields = () => {
    setFormData((prev) => {
      const next = { ...prev };
      for (const key of SUBPOENA_EXTRACTED_FIELD_KEYS) {
        if (Object.prototype.hasOwnProperty.call(initialFormData, key)) {
          next[key] = initialFormData[key];
        }
      }
      next.subpoenaFile = null;
      next.subpoenaExtractId = "";
      next.subpoenaUrl = "";
      next.subpoenaStoragePath = null;
      next.subpoenaOriginalFileName = "";
      return next;
    });
    setExtractionMeta({
      facilityName: "",
      facilityCreated: false,
      facilityReactivated: false,
      extractedDoctorName: "",
      providerName: "",
      providerCreated: false,
    });
    setFacilityProfileIncomplete(false);
    setFacilityCreated(false);
    setFacilityReactivated(false);
    setMissingDefaultDoctor(false);
    setDoctorCreated(false);
    setExtractError("");
    setEditSubpoenaSrc("");
    setEditSubpoenaError("");
    setSubpoenaViewError("");
    setMatchedFacilities([]);
    setClickedMatchFacilityId("");
    clearCommittedFacility();
    setFileErrors((prev) => {
      const next = { ...prev };
      delete next.subpoenaFile;
      return next;
    });
  };

  const requestRemoveSubpoena = () => {
    if (isOrderReadOnly) return;
    setSubpoenaActionMessage("");
    setSubpoenaRemoveModal({ open: true, removing: false });
  };

  const handleViewExistingSubpoena = async () => {
    if (!isEditMode || !orderId) return;

    setSubpoenaViewing(true);
    setSubpoenaViewError("");
    setSubpoenaActionMessage("");

    try {
      const blob = await fetchOrderSubpoenaPdf(orderId);
      const objectUrl = URL.createObjectURL(blob);
      const opened = window.open(objectUrl, "_blank", "noopener,noreferrer");

      if (!opened) {
        setSubpoenaViewError(
          "Subpoena PDF is ready, but the browser blocked the new tab. Allow pop-ups to view it."
        );
      } else {
        setSubpoenaActionMessage("Subpoena PDF opened.");
      }

      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (err) {
      setSubpoenaViewError(getDocumentOpenErrorMessage(err, "subpoena PDF"));
    } finally {
      setSubpoenaViewing(false);
    }
  };

  const handleRemoveExistingDocument = async (documentId) => {
    if (isOrderReadOnly) return;
    if (!isEditMode || !orderId) {
      setFormData((prev) => ({
        ...prev,
        documents: (prev.documents || []).filter(
          (doc) => String(doc.id) !== String(documentId)
        ),
      }));
      return;
    }

    try {
      const order = await deleteOrderAdditionalDocument(orderId, documentId);
      applyOrderDocumentState(order);
    } catch (err) {
      setSaveError(getApiErrorMessage(err, "Failed to remove document"));
    }
  };

  const confirmRemoveSubpoena = async () => {
    setSubpoenaRemoveModal((prev) => ({ ...prev, removing: true }));
    setSaveError("");
    setSubpoenaActionMessage("");
    setSubpoenaViewError("");

    try {
      if (isEditMode && orderId && !formDataRef.current.subpoenaFile) {
        const order = await removeOrderSubpoena(orderId);
        clearSubpoenaExtractedFormFields();
        setFormData((prev) => ({
          ...prev,
          documents: Array.isArray(order.documents) ? order.documents : prev.documents,
        }));
      } else {
        clearSubpoenaExtractedFormFields();
      }
      setExpandedPanels((prev) => ({ ...prev, subpoena: false }));
      setSubpoenaRemoveModal({ open: false, removing: false });
      setSubpoenaActionMessage("Subpoena removed.");
    } catch (err) {
      setSubpoenaRemoveModal((prev) => ({ ...prev, removing: false }));
      setSaveError(getApiErrorMessage(err, "Failed to remove subpoena"));
    }
  };

  const handleSaveOrder = async () => {
    if (isOrderReadOnly) return;
    setSubmitAttempted(true);
    setSaveError("");
    setApiFieldErrors({});

    if (
      !`${formDataRef.current.facility || ""}`.trim() &&
      `${formDataRef.current.facilityName || ""}`.trim()
    ) {
      handleFacilityCommit(formDataRef.current.facilityName);
      return;
    }

    const resolvedFacility = await syncFacilityFromForm(formDataRef.current);

    if (
      formDataRef.current.creationSource !== "personal_portal" &&
      resolvedFacility?.needsFacilityAdd
    ) {
      setSaveError(
        "Add this facility to the system (use the link under Facility), or select an existing facility, before updating this order."
      );
      return;
    }

    if (
      formDataRef.current.creationSource !== "personal_portal" &&
      resolvedFacility?.facilityProfileIncomplete
    ) {
      setSaveError(
        "Complete the facility profile before saving this order."
      );
      return;
    }

    const pendingDoctorName = `${
      resolvedFacility?.doctorResolved?.specificDoctor ??
      formDataRef.current.specificDoctor ??
      ""
    }`.trim();
    const pendingDoctorMissing = Boolean(
      resolvedFacility?.doctorResolved?.doctorMissing ||
        formDataRef.current.doctorNotInSystem
    );

    if (
      formDataRef.current.creationSource !== "personal_portal" &&
      pendingDoctorName &&
      pendingDoctorMissing
    ) {
      setSaveError(
        `“${pendingDoctorName}” is not linked to this facility. Add them on the facility profile, use the facility default doctor, or clear Specific Doctor (it is optional).`
      );
      return;
    }

    const syncedFormData = {
      ...formDataRef.current,
      facility:
        resolvedFacility?.facilityId || formDataRef.current.facility || "",
      facilityName:
        resolvedFacility?.facilityName ||
        formDataRef.current.facilityName ||
        "",
      facilityAddress:
        formDataRef.current.facilityAddress ||
        formDataRef.current.fullAddress ||
        "",
      fullAddress:
        formDataRef.current.fullAddress ||
        formDataRef.current.facilityAddress ||
        "",
      injuryType:
        formDataRef.current.creationSource === "personal_portal"
          ? formDataRef.current.injuryType || "cumulative"
          : formDataRef.current.injuryType,
      specificDoctor:
        resolvedFacility?.doctorResolved?.specificDoctor ??
        formDataRef.current.specificDoctor ??
        "",
      specificDoctorIsDefault:
        resolvedFacility?.doctorResolved?.specificDoctorIsDefault ??
        formDataRef.current.specificDoctorIsDefault ??
        false,
      hasPersonalDocument: Boolean(
        formDataRef.current.hasPersonalDocument ||
          formDataRef.current.hasDriverLicenseDocument ||
          (Array.isArray(formDataRef.current.documents) &&
            formDataRef.current.documents.length > 0) ||
          formDataRef.current.additionalDocumentFile
      ),
      hasDriverLicenseDocument: Boolean(
        formDataRef.current.hasDriverLicenseDocument ||
          (Array.isArray(formDataRef.current.documents) &&
            formDataRef.current.documents.some((doc) =>
              /driver.?s?\s*licen/i.test(
                `${doc.documentName || ""} ${doc.originalFileName || ""}`
              )
            ))
      ),
    };

    const currentErrors = {
      ...validateNewOrderForm(syncedFormData, fileErrors),
      ...validateOrderPaymentAmounts(syncedFormData, syncedFormData.invoiceFees),
    };

    if (Object.keys(currentErrors).length > 0) {
      setSaveError("Please fix the highlighted fields before saving.");
      return;
    }

    setSaving(true);

    const activeOrderId = orderId || String(syncedFormData.id || "");

    try {
      if (isEditMode || activeOrderId) {
        await updateOrder(activeOrderId, syncedFormData);
        markCommittedFacility(
          resolvedFacility?.facilityId || syncedFormData.facility,
          resolvedFacility?.facilityName || syncedFormData.facilityName
        );
        setMatchedFacilities([]);
    setClickedMatchFacilityId("");
        clearDraftOrderSession(draftScope);
        draftRestoredRef.current = false;
        router.push(resolveListPath(syncedFormData.creationSource));
        return;
      }

      const order = await createOrder(syncedFormData);
      if (order?.id) {
        setMatchedFacilities([]);
    setClickedMatchFacilityId("");
        clearDraftOrderSession(draftScope);
        draftRestoredRef.current = false;
        router.push(resolveListPath(syncedFormData.creationSource));
        return;
      }

      setSaveError("Order was saved but could not return to the orders list. Please refresh and try again.");
      setSaving(false);
    } catch (err) {
      const { fieldErrors, message } = applyApiFieldErrors(err);

      if (Object.keys(fieldErrors).length > 0) {
        setApiFieldErrors(fieldErrors);
      }

      setSaveError(message || getApiErrorMessage(err, "Failed to save order"));
      setSaving(false);
    }
  };

  if (isEditMode && loadingOrder) {
    return (
      <DashboardShell lockScroll>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-1">
          <OrderListBackButton label={listBackLabel} onClick={() => router.push(listBackHref)} />
          <div className="flex flex-1 items-center justify-center">
            <p className="text-[13px] text-[#64748B]">Loading order...</p>
          </div>
        </div>
      </DashboardShell>
    );
  }

  if (isEditMode && loadError) {
    return (
      <DashboardShell lockScroll>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
          <p className="text-[13px] font-semibold text-red-500">{loadError}</p>
          <OrderListBackButton label={listBackLabel} onClick={handleListBack} />
        </div>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell lockScroll>
      <div
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden"
        style={{ background: "#F8FAFC" }}
      >
        {facilitiesLoadError && (
          <div className="shrink-0 rounded-[6px] border border-[#FEE2E2] bg-[#FEF2F2] px-3 py-2 text-[12px] font-medium text-red-600">
            {facilitiesLoadError}
          </div>
        )}

        <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <OrderListBackButton label={listBackLabel} onClick={handleListBack} />
            <h1 className="mt-2 text-[18px] font-semibold text-[#111827] sm:text-[20px]">
              {isOrderReadOnly
                ? "View Order"
                : isEditMode
                  ? "Edit Order"
                  : "New Order"}
            </h1>

            <p className="mt-[4px] text-[13px] text-[#64748B]">
              {isOrderReadOnly
                ? `This order is ${String(formData.status || "").toLowerCase()} and cannot be edited`
                : isEditMode
                  ? `Editing existing order ${formData.orderNumber || orderId}`
                  : formData.subpoenaFile
                    ? "Create a new DMS order with attached subpoena"
                    : "Create a new DMS order with all required information"}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            {isOrderReadOnly ? (
              <span className="inline-flex items-center gap-2 rounded-full bg-[#FEE2E2] px-4 py-2 text-[12px] font-semibold text-[#B91C1C]">
                {formData.status || "Cancelled"} — Read only
              </span>
            ) : isEditMode ? (
              <span className="inline-flex items-center gap-2 rounded-full bg-[#FFF7ED] px-4 py-2 text-[12px] font-semibold text-[#EA580C]">
                Editing Order #{formData.orderNumber || orderId}
              </span>
            ) : null}

            {(formData.subpoenaFile || formData.subpoenaUrl || formData.subpoenaStoragePath) && (
              <span className="inline-flex items-center gap-2 rounded-full bg-[#E6F7FA] px-4 py-2 text-[12px] font-semibold text-[#007F96]">
                <SubpoenaIcon />
                Subpoena attached
              </span>
            )}

            <button
              type="button"
              onClick={toggleAllPanels}
              className="w-fit rounded-full bg-[#E6F7FA] px-4 py-2 text-[12px] font-semibold text-[#007F96] hover:bg-[#DDF6FA]"
            >
              {allExpanded ? "↙ Collapse All" : "↗ Expand All"}
            </button>
          </div>
        </div>

        {isOrderReadOnly && (
          <div className="shrink-0 rounded-[8px] border border-[#FECACA] bg-[#FEF2F2] px-3 py-3 text-[12px] text-[#991B1B]">
            <p className="font-semibold">
              Order #{formData.orderNumber || orderId} is {formData.status || "Cancelled"}
            </p>
            {formData.cancelReason ? (
              <p className="mt-1 text-[11px] leading-relaxed text-[#B91C1C]">
                Reason: {formData.cancelReason}
              </p>
            ) : null}
            <p className="mt-1 text-[11px] text-[#B91C1C]">
              Recover the order from the orders list to make changes.
            </p>
          </div>
        )}

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 xl:flex-row xl:items-stretch">
          {(formData.subpoenaFile || formData.subpoenaUrl || formData.subpoenaStoragePath) && (
            <CollapsibleOrderPanel
              title="Subpoena"
              color="subpoena"
              icon={<SubpoenaIcon />}
              expanded={expandedPanels.subpoena}
              onToggle={() => togglePanel("subpoena")}
            >
              <SubpoenaPreviewContent
                file={formData.subpoenaFile}
                src={
                  formData.subpoenaFile
                    ? undefined
                    : editSubpoenaSrc
                }
                name={displaySubpoenaName(formData)}
                loading={!formData.subpoenaFile && editSubpoenaLoading}
                error={
                  formData.subpoenaFile
                    ? ""
                    : editSubpoenaError
                }
              />
            </CollapsibleOrderPanel>
          )}

          <CollapsibleOrderPanel
            title="Order Details"
            color="order"
            icon={<OrderIcon />}
            expanded={expandedPanels.order}
            onToggle={() => togglePanel("order")}
          >
            <fieldset
              disabled={isOrderReadOnly}
              className="min-w-0 border-0 p-0 disabled:[&_button]:cursor-not-allowed"
            >
              <OrderDetailsForm
                formData={formData}
                onChange={handleChange}
                onBlur={handleBlur}
                getError={getError}
                onFileChange={isOrderReadOnly ? undefined : handleFileChange}
                onRemoveFile={isOrderReadOnly ? undefined : handleRemoveSelectedFile}
                onRemoveExistingDocument={
                  isOrderReadOnly ? undefined : handleRemoveExistingDocument
                }
                onRemoveExistingSubpoena={
                  isOrderReadOnly ? undefined : requestRemoveSubpoena
                }
                onViewExistingSubpoena={
                  isEditMode ? handleViewExistingSubpoena : undefined
                }
                subpoenaViewing={subpoenaViewing}
                subpoenaViewError={subpoenaViewError || editSubpoenaError}
                subpoenaActionMessage={
                  subpoenaViewError || editSubpoenaError
                    ? ""
                    : subpoenaActionMessage ||
                      (isEditMode &&
                      !formData.subpoenaFile &&
                      formData.subpoenaUrl &&
                      editSubpoenaSrc &&
                      !editSubpoenaLoading
                        ? "Subpoena PDF is available to view."
                        : "")
                }
                submitAttempted={submitAttempted}
                extractingSubpoena={extractingSubpoena}
                extractError={extractError}
                extractionMeta={extractionMeta}
                facilityProfileIncomplete={facilityProfileIncomplete}
                facilityCreated={facilityCreated}
                facilityReactivated={facilityReactivated}
                resolvingFacility={resolvingFacility}
                onFacilityInput={handleFacilityInput}
                onFacilitySelect={handleFacilitySelect}
                onFacilityBlur={handleFacilityBlur}
                onFacilityCommit={handleFacilityCommit}
                matchedFacilities={matchedFacilities}
                clickedMatchFacilityId={clickedMatchFacilityId}
                onMatchedFacilitySelect={handleMatchedFacilitySelect}
                returnToOrderPath={returnToOrderPath}
                onBeforeFacilityProfileNavigate={persistFacilityDraft}
                readOnly={isOrderReadOnly}
                allowCreateFacility={formData.creationSource !== "personal_portal"}
                orderEndedNoFacility={
                  formData.creationSource === "personal_portal" &&
                  formData.personalPortalStatus === "no_facility"
                }
                showPersonalAddFacilityLink={personalNeedsFacilityAdd}
              />
            </fieldset>
          </CollapsibleOrderPanel>

          <CollapsibleOrderPanel
            title="Serve Info"
            color="serve"
            icon={<ServeIcon />}
            expanded={expandedPanels.serve}
            onToggle={() => togglePanel("serve")}
          >
            <fieldset
              disabled={isOrderReadOnly}
              className="min-w-0 border-0 p-0 disabled:[&_button]:cursor-not-allowed"
            >
              <ServeInfoForm
                formData={formData}
                onChange={handleChange}
                onBlur={handleBlur}
                getError={getError}
                onProviderInput={handleProviderInput}
                onProviderSelect={handleProviderSelect}
                onProviderBlur={handleProviderBlur}
                extractionMeta={extractionMeta}
                missingDefaultDoctor={missingDefaultDoctor}
                doctorCreated={doctorCreated}
                resolvingDoctor={resolvingDoctor}
                returnToOrderPath={returnToOrderPath}
                onBeforeFacilityProfileNavigate={persistFacilityDraft}
                onUseDefaultDoctor={handleUseDefaultDoctor}
                readOnly={isOrderReadOnly}
                isPersonalPortal={formData.creationSource === "personal_portal"}
                onDoctorBlur={handleDoctorBlur}
              />
            </fieldset>
          </CollapsibleOrderPanel>

          <CollapsibleOrderPanel
            title="Payment"
            color="payment"
            icon={<PaymentIcon />}
            expanded={expandedPanels.payment}
            onToggle={() => togglePanel("payment")}
          >
            <fieldset
              disabled={isOrderReadOnly}
              className="min-w-0 border-0 p-0 disabled:[&_button]:cursor-not-allowed"
            >
              <PaymentForm
                formData={formData}
                onChange={handleChange}
                onBlur={handleBlur}
                getError={getError}
                onValuesChange={handlePaymentValuesChange}
                readOnly={isOrderReadOnly}
              />
            </fieldset>
          </CollapsibleOrderPanel>
        </div>

        {isOrderReadOnly ? (
          <section className="shrink-0 rounded-[12px] border border-[#E2E8F0] bg-white px-3 py-4 shadow-sm sm:px-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-[720px] text-[11px] leading-[16px] text-[#64748B]">
                This order is read-only. Recover it from the orders list if you need to
                make changes.
              </p>
              <button
                type="button"
                onClick={() => router.push(resolveListPath(formData.creationSource))}
                className="flex h-[44px] w-full shrink-0 items-center justify-center gap-2 rounded-[8px] bg-[#0097B2] px-6 text-[13px] font-semibold text-white shadow-sm transition hover:bg-[#0086A0] sm:w-auto sm:min-w-[220px]"
              >
                {resolveListPath(formData.creationSource) === "/personal-orders"
                  ? "Back to Personal Orders"
                  : resolveListPath(formData.creationSource) === "/company-orders"
                    ? "Back to Company Orders"
                    : "Back to Orders"}
              </button>
            </div>
          </section>
        ) : (
          <OrderSaveActionBar
            onSave={handleSaveOrder}
            disabled={
              (isEditMode ? hasValidationErrors : hasImmediateRequiredErrors) ||
              saving ||
              (formData.creationSource !== "personal_portal" &&
                facilityProfileIncomplete) ||
              personalDoctorBlocksUpdate ||
              resolvingFacility ||
              resolvingDoctor
            }
            label={
              saving
                ? "Saving..."
                : isEditMode
                  ? "Update Order"
                  : "Save Order"
            }
            saveError={
              saveError ||
              (personalDoctorBlocksUpdate
                ? !`${formData.facility || ""}`.trim() ||
                  formData.facilityNotInSystem
                  ? "Add this facility to the system (link under Facility), or select an existing facility, before updating."
                  : formData.doctorNotInSystem
                    ? personalRequestedDoctor
                      ? `Add requested doctor “${personalRequestedDoctor}” to the facility, or select/create a default doctor, before updating.`
                      : "Add this doctor to the facility, or select/create a default doctor, before updating."
                    : "This facility has no default doctor. Add a default doctor on the facility profile before updating."
                : "")
            }
          />
        )}
      </div>

      <SubpoenaExtractionOverlay open={extractingSubpoena} />

      <ConfirmModal
        open={subpoenaRemoveModal.open}
        variant="danger"
        title="Remove subpoena?"
        message="Removing this subpoena will also clear form fields that were filled from the subpoena extraction (applicant, facility, doctor, case details, and related serve fields). Do you want to continue?"
        confirmLabel={subpoenaRemoveModal.removing ? "Removing..." : "Remove"}
        cancelLabel="Cancel"
        confirmDisabled={subpoenaRemoveModal.removing}
        onCancel={() => {
          if (subpoenaRemoveModal.removing) return;
          setSubpoenaRemoveModal({ open: false, removing: false });
        }}
        onConfirm={confirmRemoveSubpoena}
      />
    </DashboardShell>
  );
}

function OrderDetailsForm({
  formData,
  onChange,
  onBlur,
  getError,
  onFileChange,
  onRemoveFile,
  onRemoveExistingDocument,
  onRemoveExistingSubpoena,
  onViewExistingSubpoena,
  subpoenaViewing = false,
  subpoenaViewError = "",
  subpoenaActionMessage = "",
  submitAttempted,
  extractingSubpoena = false,
  extractError = "",
  extractionMeta = {},
  facilityProfileIncomplete = false,
  facilityCreated = false,
  facilityReactivated = false,
  resolvingFacility = false,
  onFacilityInput,
  onFacilitySelect,
  onFacilityBlur,
  onFacilityCommit,
  matchedFacilities = [],
  clickedMatchFacilityId = "",
  onMatchedFacilitySelect,
  returnToOrderPath = "",
  onBeforeFacilityProfileNavigate,
  readOnly = false,
  allowCreateFacility = true,
  orderEndedNoFacility = false,
  showPersonalAddFacilityLink = false,
}) {
  const isPersonalPortalOrder = formData.creationSource === "personal_portal";
  const injuryDatesRequired =
    isPersonalPortalOrder ||
    formData.injuryType === "cumulative" ||
    formData.injuryType === "specific";

  const hasRequiredErrors =
    getError("facility") ||
    getError("facilityName") ||
    getError("type") ||
    getError("firstName") ||
    getError("lastName") ||
    (isPersonalPortalOrder &&
      (getError("dob") ||
        getError("driverLicenseNumber") ||
        getError("additionalDocumentFile") ||
        getError("injuryDateBegin") ||
        getError("injuryDateEnd")));

  const facilityHint =
    allowCreateFacility &&
    extractionMeta.facilityName &&
    formData.facility &&
    formData.creationSource !== "personal_portal" &&
    !facilityProfileIncomplete &&
    !facilityCreated &&
    !facilityReactivated
      ? `Matched from subpoena: ${extractionMeta.facilityName}`
      : "";

  return (
    <div className="space-y-5">
      <div className="rounded-[6px] bg-[#F8FAFC] px-3 py-2 text-[11px] font-medium text-[#64748B]">
        <span className="mr-2 text-red-500">*</span>
        <span>Required field</span>
      </div>

      {isPersonalPortalOrder ? (
        <div className="rounded-[6px] border border-[#BAE6FD] bg-[#F0F9FF] px-3 py-2 text-[11px] text-[#0C4A6E]">
          <p className="font-semibold text-[#0369A1]">
            Personal order — required fields
          </p>
          <p className="mt-1 leading-snug">
            First &amp; Last name, Date of birth, Treating facility,
            Specific doctor, Specific dates needed, Type of records, Driver&apos;s licence number,
            and Document. Marked with <span className="text-red-500">*</span>.
          </p>
        </div>
      ) : null}

      {orderEndedNoFacility ? (
        <div className="rounded-[6px] border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          This personal order is ended (<span className="font-semibold">No facility</span>).
          Facility create/add is locked here. Use{" "}
          <span className="font-semibold">Back to In Process</span> on Personal
          Orders to unlock it again.
        </div>
      ) : null}

      <div className="space-y-4">
        <div className="space-y-1">
          <FacilitySearchField
            label={
              isPersonalPortalOrder ? "Treating facility name" : "Facility"
            }
            value={formData.facilityName || ""}
            facilityId={formData.facility || ""}
            onInputChange={onFacilityInput}
            onSelect={onFacilitySelect}
            onBlur={onFacilityBlur}
            onCommit={onFacilityCommit}
            resolving={resolvingFacility}
            facilityProfileIncomplete={
              allowCreateFacility && facilityProfileIncomplete
            }
            facilityCreated={facilityCreated}
            facilityReactivated={facilityReactivated}
            pendingFacilityMatches={
              !readOnly && matchedFacilities.length > 0 && !formData.facility
            }
            returnToOrderPath={returnToOrderPath}
            onBeforeFacilityProfileNavigate={onBeforeFacilityProfileNavigate}
            allowCreateFacility={allowCreateFacility}
            hint={facilityHint}
            required
            error={
              getError("facility") ||
              getError("facilityName") ||
              (allowCreateFacility && facilityProfileIncomplete
                ? "Complete the facility profile to continue"
                : "")
            }
          />

          {!readOnly && matchedFacilities.length > 0 ? (
            <div className="rounded-[6px] border border-[#BAE6FD] bg-[#F0F9FF] px-3 py-2.5">
              <p className="text-[11px] font-semibold text-[#0369A1]">
                Matched facilities from our system — select one to add
              </p>
              <p className="mt-0.5 text-[10px] text-[#0284C7]">
                These names are similar to the facility extracted from the
                subpoena. Selected facility stays marked until you save the order.
              </p>
              <ul className="mt-2 space-y-1.5">
                {matchedFacilities.map(({ facility }) => {
                  const label =
                    facility.facility ||
                    facility.facilityName ||
                    facility.name ||
                    `Facility ${facility.id}`;
                  const filledInInput =
                    String(formData.facility || "") === String(facility.id) &&
                    String(clickedMatchFacilityId || "") === String(facility.id);
                  return (
                    <li key={facility.id}>
                      <button
                        type="button"
                        onClick={() => onMatchedFacilitySelect?.(facility)}
                        aria-pressed={filledInInput}
                        className={`flex w-full items-center gap-2 rounded-[5px] border px-2.5 py-1.5 text-left text-[12px] transition ${
                          filledInInput
                            ? "border-[#0097B2] bg-[#ECFEFF] text-[#0F766E]"
                            : "border-[#E0F2FE] bg-white text-[#334155] hover:border-[#67D8E8] hover:bg-[#F8FBFC]"
                        }`}
                      >
                        {filledInInput ? (
                          <span
                            className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-[#059669] bg-[#059669] text-[10px] font-bold text-white"
                            aria-hidden="true"
                          >
                            ✓
                          </span>
                        ) : null}
                        <span className="min-w-0 truncate font-medium">
                          {label}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          {showPersonalAddFacilityLink && (
              <Link
                href={(() => {
                  const req = formData.newFacilityRequest || {};
                  const params = new URLSearchParams();
                  const orderId = formData.id || formData.dbId;
                  if (orderId) params.set("linkOrderId", String(orderId));
                  params.set("linkSource", "personal");
                  if (returnToOrderPath) {
                    params.set("returnTo", returnToOrderPath);
                  }
                  const name =
                    formData.facilityName || req.facilityName || "";
                  const address =
                    req.facilityAddress || formData.facilityAddress || "";
                  if (name) params.set("facilityName", name);
                  if (address) params.set("address", address);
                  if (req.facilityCity) params.set("city", req.facilityCity);
                  if (req.facilityState) params.set("state", req.facilityState);
                  if (req.facilityZip) params.set("zip", formatZip(req.facilityZip));
                  return `/facilities/new?${params.toString()}`;
                })()}
                onClick={() => onBeforeFacilityProfileNavigate?.()}
                className="inline-flex text-[12px] font-semibold text-[#007F96] hover:underline"
              >
                Add this facility to system
              </Link>
            )}
        </div>

        <RecordTypeMultiSelect
          formData={formData}
          onChange={onChange}
          onBlur={onBlur}
          required
          error={getError("type")}
        />

        <NewOrderField
          label="Case #"
          name="caseNumber"
          value={formData.caseNumber}
          onChange={onChange}
          onBlur={onBlur}
          placeholder="Enter case number"
        />

        <NewOrderField
          label="SSN"
          name="ssn"
          value={formData.ssn}
          onChange={onChange}
          onBlur={onBlur}
          placeholder="123-45-6789"
          inputMode="numeric"
          maxLength={11}
          hint="SSN required if you have one"
          error={getError("ssn")}
        />

        <NewOrderField
          label="DOB"
          name="dob"
          value={formData.dob}
          onChange={onChange}
          onBlur={onBlur}
          type="date"
          required={isPersonalPortalOrder}
          error={getError("dob")}
        />

        {isPersonalPortalOrder ? (
          <NewOrderField
            label="Driver's licence number"
            name="driverLicenseNumber"
            value={formData.driverLicenseNumber || ""}
            onChange={onChange}
            onBlur={onBlur}
            placeholder="Driver's licence number"
            required
            maxLength={50}
            error={getError("driverLicenseNumber")}
            hint="From the personal portal request; edits are saved back to that request."
          />
        ) : null}
      </div>

      <Divider />

      <div>
        <h3 className="text-[13px] font-semibold text-[#111827]">Applicant</h3>
        <p className="mt-[2px] text-[11px] italic text-[#64748B]">
          Completion of this section is required
        </p>

        <div className="mt-4 space-y-4">
          <NewOrderField
            label="First Name"
            name="firstName"
            value={formData.firstName}
            onChange={onChange}
            onBlur={onBlur}
            placeholder="First name"
            required
            error={getError("firstName")}
          />

          <NewOrderField
            label="Middle Name"
            name="middleName"
            value={formData.middleName}
            onChange={onChange}
            onBlur={onBlur}
            placeholder="Middle name"
          />

          <NewOrderField
            label="Last Name"
            name="lastName"
            value={formData.lastName}
            onChange={onChange}
            onBlur={onBlur}
            placeholder="Last name"
            required
            error={getError("lastName")}
          />

          <NewOrderField
            label="AKA"
            name="aka"
            value={formData.aka}
            onChange={onChange}
            onBlur={onBlur}
            placeholder="Also known as"
          />

          <NewOrderField
            label="Defendant"
            name="defendant"
            value={formData.defendant}
            onChange={onChange}
            onBlur={onBlur}
            placeholder="Defendant name"
          />
        </div>
      </div>

      <Divider />

      <div>
        <h3 className="text-[13px] font-semibold text-[#111827]">
          {isPersonalPortalOrder
            ? "Specific dates needed"
            : "Date of Injury (Complete all relevant information):"}
          {injuryDatesRequired ? <span className="text-red-500"> *</span> : null}
        </h3>

        {isPersonalPortalOrder ? (
          <p className="mt-1 text-[11px] text-[#64748B]">
            Date range for records (e.g. 01/01/2013 through 02/02/2024)
          </p>
        ) : null}

        {isPersonalPortalOrder ? (
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <NewOrderField
              label="From"
              name="injuryDateBegin"
              value={formData.injuryDateBegin}
              onChange={onChange}
              onBlur={onBlur}
              type="date"
              required
              error={getError("injuryDateBegin")}
            />
            <NewOrderField
              label="Through"
              name="injuryDateEnd"
              value={formData.injuryDateEnd}
              onChange={onChange}
              onBlur={onBlur}
              type="date"
              required
              error={getError("injuryDateEnd")}
            />
          </div>
        ) : (
        <div className="mt-3 space-y-3">
          <div>
            <label className="flex flex-wrap items-center gap-2 text-[12px] text-[#475569]">
              <input
                type="radio"
                name="injuryType"
                value="specific"
                checked={formData.injuryType === "specific"}
                onChange={onChange}
                className="h-[13px] w-[13px] border-[#CBD5E1] accent-[#0097B2]"
              />
              <span>specific injury on this date:</span>
              <input
                type="date"
                name="injuryDate"
                value={formData.injuryDate}
                onChange={onChange}
                onBlur={onBlur}
                disabled={formData.injuryType !== "specific"}
                className={`h-[34px] rounded-[6px] border bg-white px-2 text-[12px] text-[#111827] outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-[#F8FAFC] disabled:text-[#94A3B8] ${
                  getError("injuryDate")
                    ? "border-red-500 focus:border-red-500 focus:ring-red-500/10"
                    : "border-[#E2E8F0] focus:border-[#0097B2] focus:ring-[#0097B2]/10"
                }`}
              />
            </label>
            {getError("injuryDate") ? (
              <p className="mt-1 text-[11px] font-medium text-red-500">
                {getError("injuryDate")}
              </p>
            ) : null}
          </div>

          <div>
            <label className="flex flex-wrap items-center gap-2 text-[12px] text-[#475569]">
              <input
                type="radio"
                name="injuryType"
                value="cumulative"
                checked={formData.injuryType === "cumulative"}
                onChange={onChange}
                className="h-[13px] w-[13px] border-[#CBD5E1] accent-[#0097B2]"
              />
              <span>cumulative injury which began on</span>
              <input
                type="date"
                name="injuryDateBegin"
                value={formData.injuryDateBegin}
                onChange={onChange}
                onBlur={onBlur}
                disabled={formData.injuryType !== "cumulative"}
                className={`h-[34px] rounded-[6px] border bg-white px-2 text-[12px] text-[#111827] outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-[#F8FAFC] disabled:text-[#94A3B8] ${
                  getError("injuryDateBegin")
                    ? "border-red-500 focus:border-red-500 focus:ring-red-500/10"
                    : "border-[#E2E8F0] focus:border-[#0097B2] focus:ring-[#0097B2]/10"
                }`}
              />
              <span>through</span>
              <input
                type="date"
                name="injuryDateEnd"
                value={formData.injuryDateEnd}
                onChange={onChange}
                onBlur={onBlur}
                disabled={formData.injuryType !== "cumulative"}
                className={`h-[34px] rounded-[6px] border bg-white px-2 text-[12px] text-[#111827] outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-[#F8FAFC] disabled:text-[#94A3B8] ${
                  getError("injuryDateEnd")
                    ? "border-red-500 focus:border-red-500 focus:ring-red-500/10"
                    : "border-[#E2E8F0] focus:border-[#0097B2] focus:ring-[#0097B2]/10"
                }`}
              />
            </label>
            {getError("injuryDateBegin") || getError("injuryDateEnd") ? (
              <p className="mt-1 text-[11px] font-medium text-red-500">
                {getError("injuryDateEnd") || getError("injuryDateBegin")}
              </p>
            ) : null}
          </div>
        </div>
        )}
      </div>

      <Divider />

      {!readOnly ? (
        <FileInput
          title="Upload Subpoena"
          onChange={(e) => onFileChange(e, "subpoenaFile")}
          error={getError("subpoenaFile")}
          accept=".pdf,application/pdf"
          statusText={
            formData.subpoenaFile || formData.subpoenaUrl
              ? "Choose File again will replace the existing document"
              : "PDF only"
          }
        />
      ) : null}

      {formData.subpoenaFile ? (
        <SelectedFileCard
          label={
            formData.subpoenaUrl
              ? "New subpoena (replaces current on save)"
              : "Selected subpoena"
          }
          fileName={displaySubpoenaName(formData)}
          onRemove={readOnly ? undefined : () => onRemoveExistingSubpoena?.()}
        />
      ) : null}

      {extractError && (
        <p className="text-[12px] font-medium text-amber-600">{extractError}</p>
      )}

      {formData.subpoenaExtractId && !extractingSubpoena && (
        <p className="text-[12px] font-medium text-[#059669]">
          Subpoena saved and form prefilled from extracted data.
        </p>
      )}

      {subpoenaActionMessage ? (
        <p className="text-[12px] font-medium text-[#059669]">
          {subpoenaActionMessage}
        </p>
      ) : null}

      {!formData.subpoenaFile && formData.subpoenaUrl && (
        <ExistingFileLink
          label="Current subpoena"
          name={displaySubpoenaName(formData)}
          href={toFileUrl(formData.subpoenaUrl)}
          onView={onViewExistingSubpoena}
          viewing={subpoenaViewing}
          viewError={subpoenaViewError}
          onRemove={
            readOnly ? undefined : () => onRemoveExistingSubpoena?.()
          }
        />
      )}

      {!formData.subpoenaFile && !formData.subpoenaUrl && subpoenaViewError ? (
        <p className="text-[12px] font-medium text-red-500">
          {subpoenaViewError}
        </p>
      ) : null}

      <div>
        <h3 className="mb-3 text-[13px] font-semibold text-[#111827]">
          {readOnly
            ? "Additional Documents"
            : isPersonalPortalOrder
              ? "Upload document (Driver's licence)"
              : "Upload Additional Document"}
          {!readOnly && isPersonalPortalOrder ? (
            <span className="text-red-500"> *</span>
          ) : null}
        </h3>

        {!readOnly ? (
          <FileInput
            compact
            onChange={(e) => onFileChange(e, "additionalDocumentFile")}
            error={getError("additionalDocumentFile")}
            statusText={
              formData.additionalDocumentFile
                ? formData.additionalDocumentFile.name
                : Array.isArray(formData.documents) && formData.documents.length > 0
                  ? "Add another document (existing files stay unless removed)"
                  : "No file chosen"
            }
          />
        ) : null}

        {formData.additionalDocumentFile ? (
          <div className="mt-3">
            <SelectedFileCard
              label="Selected document (will be added on save)"
              fileName={formData.additionalDocumentFile.name}
              onRemove={
                readOnly ? undefined : () => onRemoveFile?.("additionalDocumentFile")
              }
            />
          </div>
        ) : null}

        {Array.isArray(formData.documents) && formData.documents.length > 0 && (
          <div className="mt-3 space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#94A3B8]">
              Uploaded documents
            </p>

            {formData.documents.map((doc) => (
              <ExistingFileLink
                key={doc.id}
                label={doc.documentName || "Document"}
                name={doc.originalFileName}
                href={toFileUrl(doc.url)}
                onRemove={
                  readOnly
                    ? undefined
                    : () => onRemoveExistingDocument?.(doc.id)
                }
              />
            ))}
          </div>
        )}
      </div>

      {(submitAttempted || hasRequiredErrors) && hasRequiredErrors && (
        <div className="rounded-[6px] border border-red-200 bg-red-50 px-3 py-3 text-[12px] font-semibold text-red-600">
          ⓘ Please fill out all required fields
        </div>
      )}

      <Divider />

      <div>
        <h3 className="text-[13px] font-semibold text-[#111827]">Notes</h3>

        <p className="mt-3 text-[12px] font-semibold text-[#64748B]">
          Date By Callback Note
        </p>

        <div className="mt-2 rounded-[8px] border border-dashed border-[#CBD5E1] bg-[#F8FAFC] px-4 py-6 text-center text-[12px] text-[#94A3B8]">
          No notes logged yet. Notes will appear here after callbacks are
          recorded.
        </div>
      </div>
    </div>
  );
}

function ServeInfoForm({
  formData,
  onChange,
  onBlur,
  getError,
  onProviderInput,
  onProviderSelect,
  onProviderBlur,
  extractionMeta = {},
  missingDefaultDoctor = false,
  doctorCreated = false,
  resolvingDoctor = false,
  returnToOrderPath = "",
  onBeforeFacilityProfileNavigate,
  onUseDefaultDoctor,
  readOnly = false,
  isPersonalPortal = false,
  onDoctorBlur,
}) {
  return (
    <div className="space-y-5">
      <h3 className="text-[14px] font-semibold text-[#111827]">
        Serve Information
      </h3>

      <NewOrderField
        label="Order #"
        name="orderNumber"
        value={formData.orderNumber}
        onChange={onChange}
        onBlur={onBlur}
        placeholder="Auto-assigned on save (e.g. 0001-1 or 0001-1-2)"
        error={getError("orderNumber")}
        maxLength={50}
        disabled
        hint={
          formData.orderNumber
            ? undefined
            : "Assigned from patient + record types (0001-1, 0001-1-2, …)"
        }
      />

      <NewOrderField
        label="REC Number"
        name="recNumber"
        value={formData.recNumber}
        onChange={onChange}
        onBlur={onBlur}
        placeholder="Enter REC number"
        disabled={readOnly}
      />

      <Divider />

      <h3 className="text-[13px] font-semibold text-[#111827]">Company</h3>

      <ProviderSearchField
        label="Provider"
        value={formData.serveCompanyName}
        providerId={formData.providerId}
        onInputChange={onProviderInput}
        onSelect={onProviderSelect}
        onBlur={onProviderBlur}
        required={!isPersonalPortal}
        error={getError("serveCompanyName")}
        hint="Search existing providers or type a new company name"
      />
      {extractionMeta.providerName && formData.providerId && (
        <p className="-mt-3 text-[10px] font-medium text-[#059669]">
          {extractionMeta.providerCreated
            ? `New provider added: ${extractionMeta.providerName}`
            : `Matched existing provider: ${extractionMeta.providerName}`}
        </p>
      )}

      <NewOrderField
        label="Address"
        name="address"
        value={formData.address}
        onChange={onChange}
        onBlur={onBlur}
        placeholder="Street address"
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <NewOrderField
          label="ZIP"
          name="zip"
          value={formData.zip}
          onChange={onChange}
          onBlur={onBlur}
          placeholder="12345 or 12345-6789"
          inputMode="numeric"
          maxLength={10}
          error={getError("zip")}
        />

        <NewOrderField
          label="City"
          name="city"
          value={formData.city}
          onChange={onChange}
          onBlur={onBlur}
          placeholder="City"
          hint={
            !formData.city && formData.address && (formData.zip || formData.state)
              ? "City could not be parsed from the address. Please recheck."
              : undefined
          }
          hintTone="warning"
        />

        <NewOrderField
          label="State"
          name="state"
          value={formData.state}
          onChange={onChange}
          onBlur={onBlur}
          placeholder="State"
          maxLength={2}
          error={getError("state")}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <NewOrderField
          label="Phone"
          name="phone"
          value={formData.phone}
          onChange={onChange}
          onBlur={onBlur}
          placeholder="(XXX) XXX-XXXX"
          inputMode="numeric"
          maxLength={14}
          error={getError("phone")}
        />

        <NewOrderField
          label="Fax"
          name="fax"
          value={formData.fax}
          onChange={onChange}
          onBlur={onBlur}
          placeholder="(XXX) XXX-XXXX"
          inputMode="numeric"
          maxLength={14}
          error={getError("fax")}
        />
      </div>

      <NewOrderField
        label="Provider email"
        name="email"
        value={formData.email}
        onChange={onChange}
        onBlur={onBlur}
        placeholder="company@email.com"
        error={getError("email")}
      />

      <Divider />

      <h3 className="text-[13px] font-semibold text-[#111827]">Contact</h3>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <ContactCard
          number="1"
          prefix="contact1"
          formData={formData}
          onChange={onChange}
          onBlur={onBlur}
          getError={getError}
        />

        <ContactCard
          number="2"
          prefix="contact2"
          formData={formData}
          onChange={onChange}
          onBlur={onBlur}
          getError={getError}
        />
      </div>

      <Divider />

      <h3 className="text-[13px] font-semibold text-[#111827]">
        Dates and Records
      </h3>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-3">
          <NewOrderField
            label="Date Served"
            name="dateServed"
            value={formData.dateServed}
            onChange={onChange}
            onBlur={onBlur}
            type="date"
          />

          <NewOrderField
            label="Depo Due Date"
            name="depoDueDate"
            value={formData.depoDueDate}
            onChange={onChange}
            onBlur={onBlur}
            type="date"
          />

          <NewOrderField
            label="Delivery Date"
            name="deliveryDate"
            value={formData.deliveryDate}
            onChange={onChange}
            onBlur={onBlur}
            type="date"
          />

          <NewOrderField
            label="Date of Subpoena"
            name="subpoenaDate"
            value={formData.subpoenaDate}
            onChange={onChange}
            onBlur={onBlur}
            type="date"
          />

          <NewOrderField
            label="Ready Date"
            name="readyDate"
            value={formData.readyDate}
            type="date"
            disabled
            placeholder="-"
          />
          <NewOrderField
            label="Invoice Date"
            name="invoiceDate"
            value={formData.invoiceDate}
            type="date"
            disabled
            placeholder="-"
          />
          <NewOrderField
            label="Xray Invoice Date"
            name="xrayInvoiceDate"
            value={formData.xrayInvoiceDate}
            type="date"
            disabled
            placeholder="-"
          />
        </div>
      </div>

      <Divider />

      <NewOrderField
        label="Date Requested"
        name="dateRequested"
        value={formData.dateRequested}
        onChange={onChange}
        onBlur={onBlur}
        type="date"
      />

      <NewOrderField
        label="Specific Record"
        name="specificRecord"
        value={formData.specificRecord}
        onChange={onChange}
        onBlur={onBlur}
        placeholder="Specific record details"
      />

      <DoctorSearchField
        label="Specific Doctor"
        name="specificDoctor"
        value={formData.specificDoctor}
        facilityId={formData.facility}
        facilityName={formData.facilityName}
        specificDoctorIsDefault={formData.specificDoctorIsDefault}
        specificDoctorId={formData.specificDoctorId}
        extractedDoctorName={
          isPersonalPortal
            ? formData.requestedTreatingDoctor ||
              formData.newFacilityRequest?.treatingDoctor ||
              ""
            : extractionMeta.extractedDoctorName
        }
        onChange={onChange}
        onBlur={onBlur}
        onDoctorBlur={onDoctorBlur}
        required={isPersonalPortal}
        placeholder="Doctor name (optional)"
        error={
          getError("specificDoctor") ||
          (isPersonalPortal && missingDefaultDoctor
            ? "Add a default doctor to continue"
            : "")
        }
        missingDefaultDoctor={missingDefaultDoctor}
        doctorCreated={doctorCreated}
        resolvingDoctor={resolvingDoctor}
        returnToOrderPath={returnToOrderPath}
        onBeforeFacilityProfileNavigate={onBeforeFacilityProfileNavigate}
        onUseDefaultDoctor={
          readOnly || isPersonalPortal ? undefined : onUseDefaultDoctor
        }
        isPersonalPortal={isPersonalPortal}
        doctorNotInSystem={Boolean(formData.doctorNotInSystem)}
        facilityNotInSystem={Boolean(formData.facilityNotInSystem)}
        orderEndedNoFacility={
          isPersonalPortal && formData.personalPortalStatus === "no_facility"
        }
      />

      <DoctorAddressSearchField
        label="Full Address"
        name="fullAddress"
        value={formData.fullAddress}
        onChange={onChange}
        onBlur={onBlur}
        placeholder="Full address"
        error={getError("fullAddress")}
      />

      <Divider />

      <CheckboxOption
        label="Certificate of No Records"
        name="certificateNoRecords"
        checked={formData.certificateNoRecords}
        onChange={onChange}
      />

      {formData.certificateNoRecords && (
        <CertificateNoRecordsPanel
          formData={formData}
          onChange={onChange}
          onBlur={onBlur}
          getError={getError}
        />
      )}
    </div>
  );
}

function OrderSaveActionBar({ onSave, disabled, label, saveError = "" }) {
  return (
    <section className="shrink-0 rounded-[12px] border border-[#E2E8F0] bg-white px-3 py-4 shadow-sm sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-[720px] text-[11px] leading-[16px] text-[#64748B]">
          This button becomes clickable after you complete all mandatory fields
          in the cards above.
        </p>

        <button
          type="button"
          onClick={onSave}
          disabled={disabled}
          className={`flex h-[44px] w-full shrink-0 items-center justify-center gap-2 rounded-[8px] px-6 text-[13px] font-semibold transition sm:w-auto sm:min-w-[220px] ${
            disabled
              ? "cursor-not-allowed bg-[#E2E8F0] text-[#94A3B8]"
              : "bg-[#0097B2] text-white shadow-sm hover:bg-[#0086A0]"
          }`}
        >
          <SaveIcon />
          {label}
        </button>
      </div>

      {saveError && (
        <div className="mt-3 rounded-[6px] border border-red-200 bg-red-50 px-3 py-2 text-[12px] font-semibold text-red-600">
          {saveError}
        </div>
      )}
    </section>
  );
}

import {
  getPaymentChargeForType,
  dueAmountFromFee,
  parsePaymentAmount,
} from "@/lib/orders/paymentUtils";

function PaymentForm({
  formData,
  onChange,
  onBlur,
  getError,
  onValuesChange,
  readOnly = false,
}) {
  const invoiceFees = formData.invoiceFees;
  const prepaymentCharge = getPaymentChargeForType("prepayment", invoiceFees);
  const isPersonalPortalOrder = formData.creationSource === "personal_portal";
  const isCompanyPortalOrder = formData.creationSource === "company_portal";

  return (
    <div className="space-y-5">
      <h3 className="text-[14px] font-semibold text-[#111827]">
        Payment Details
      </h3>

      <PaymentChargeCard
        title="Prepayment Fee"
        chargeAmount={prepaymentCharge}
        paidAmount={formData.prepaymentPaid}
        showPaidField
        autoDueOnPaidChange
        capPaidToDue={!isPersonalPortalOrder && !isCompanyPortalOrder}
        paymentType="prepayment"
        theme="green"
        prefix="prepayment"
        formData={formData}
        onChange={onChange}
        onBlur={onBlur}
        getError={getError}
        onValuesChange={onValuesChange}
        checkLabel={isPersonalPortalOrder ? "Receipt Number" : "Check #"}
        checkPlaceholder={
          isPersonalPortalOrder ? "Receipt number" : "Check number"
        }
        checkDisplayValue={
          isPersonalPortalOrder
            ? Number(formData.prepaymentPaid) > 0
              ? formData.prepaymentCheck || ""
              : ""
            : null
        }
        checkReadOnly={readOnly || isPersonalPortalOrder}
        fieldsReadOnly={readOnly}
        paidReadOnly={readOnly}
        checkAllowAnyChars={isCompanyPortalOrder}
      />

      <PaymentChargeCard
        title="Xray Charge"
        paidAmount={formData.xrayPaid}
        showPaidField
        paidReadOnly={readOnly}
        fieldsReadOnly={readOnly}
        autoDueOnPaidChange
        capPaidToDue
        paymentType="xray"
        invoiceFees={invoiceFees}
        theme="blue"
        prefix="xray"
        formData={formData}
        onChange={onChange}
        onBlur={onBlur}
        getError={getError}
        onValuesChange={onValuesChange}
        disableCheckWhenZeroBalance
      />
    </div>
  );
}

function ContactCard({ number, prefix, formData, onChange, onBlur, getError }) {
  return (
    <div className="rounded-[8px] bg-[#F8FAFC] p-3">
      <h4 className="mb-3 text-[12px] font-semibold text-[#64748B]">
        Contact {number}
      </h4>

      <div className="space-y-3">
        <NewOrderField
          label="Name"
          name={`${prefix}Name`}
          value={formData[`${prefix}Name`]}
          onChange={onChange}
          onBlur={onBlur}
          placeholder="Contact name"
        />

        <NewOrderField
          label="Title"
          name={`${prefix}Title`}
          value={formData[`${prefix}Title`]}
          onChange={onChange}
          onBlur={onBlur}
          placeholder="Title"
        />

        <NewOrderField
          label="Phone"
          name={`${prefix}Phone`}
          value={formData[`${prefix}Phone`]}
          onChange={onChange}
          onBlur={onBlur}
          placeholder="(XXX) XXX-XXXX"
          inputMode="numeric"
          maxLength={14}
          error={getError(`${prefix}Phone`)}
        />

        <NewOrderField
          label="Fax"
          name={`${prefix}Fax`}
          value={formData[`${prefix}Fax`]}
          onChange={onChange}
          onBlur={onBlur}
          placeholder="(XXX) XXX-XXXX"
          inputMode="numeric"
          maxLength={14}
          error={getError(`${prefix}Fax`)}
        />

        <NewOrderField
          label="Email"
          name={`${prefix}Email`}
          value={formData[`${prefix}Email`]}
          onChange={onChange}
          onBlur={onBlur}
          placeholder="email@example.com"
          error={getError(`${prefix}Email`)}
        />
      </div>
    </div>
  );
}

function FileInput({
  title,
  onChange,
  error,
  compact = false,
  buttonLabel = "Choose File",
  statusText = "No file chosen",
  accept = ".pdf,.doc,.docx,.jpg,.jpeg,.png",
}) {
  const inputRef = useRef(null);

  return (
    <div className={compact ? "sm:pt-[2px]" : ""}>
      {title && (
        <h3 className="mb-3 text-[13px] font-semibold text-[#111827]">
          {title}
        </h3>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          onChange={onChange}
          accept={accept}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
        />

        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className={`inline-flex cursor-pointer items-center justify-center rounded-[6px] border border-[#E2E8F0] bg-white px-3 py-2 text-[12px] font-medium text-[#334155] shadow-sm transition hover:border-[#0097B2] hover:bg-[#F0FBFD] hover:text-[#007F96] hover:shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0097B2]/30 ${
            compact ? "whitespace-nowrap" : ""
          }`}
        >
          {buttonLabel}
        </button>

        <span className="max-w-[280px] text-[12px] text-[#94A3B8]">
          {statusText}
        </span>
      </div>

      {error && (
        <p className="mt-[5px] text-[11px] font-medium text-red-500">
          {error}
        </p>
      )}
    </div>
  );
}

function SelectedFileCard({ label, fileName, onRemove }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-[6px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2">
      <span className="min-w-0">
        <span className="block truncate text-[12px] font-semibold text-[#111827]">
          {label}
        </span>
        {fileName ? (
          <span className="block truncate text-[11px] text-[#64748B]">
            {fileName}
          </span>
        ) : null}
      </span>

      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="shrink-0 rounded-[6px] border border-red-200 bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-600 transition hover:bg-red-100"
        >
          Remove
        </button>
      ) : null}
    </div>
  );
}

function ExistingFileLink({
  label,
  name,
  href,
  onView,
  onRemove,
  viewing = false,
  viewError = "",
}) {
  const handleViewClick = (event) => {
    if (!onView) return;
    event.preventDefault();
    if (!viewing) {
      onView();
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3 rounded-[6px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2">
        <a
          href={href || "#"}
          target={onView ? undefined : "_blank"}
          rel="noopener noreferrer"
          onClick={handleViewClick}
          className="min-w-0 flex-1 hover:opacity-90"
        >
          <span className="block truncate text-[12px] font-semibold text-[#111827]">
            {label}
          </span>
          {name && (
            <span className="block truncate text-[11px] text-[#64748B]">
              {name}
            </span>
          )}
          <span className="mt-0.5 block text-[11px] font-semibold text-[#0097B2]">
            {viewing ? "Opening..." : "View"}
          </span>
        </a>

        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="shrink-0 rounded-[6px] border border-red-200 bg-red-50 px-2.5 py-1 text-[11px] font-semibold text-red-600 transition hover:bg-red-100"
          >
            Remove
          </button>
        ) : null}
      </div>
      {viewError ? (
        <p className="mt-1 text-[11px] font-medium text-red-500">{viewError}</p>
      ) : null}
    </div>
  );
}

function Divider() {
  return <div className="h-px w-full bg-[#E2E8F0]" />;
}

function OrderListBackButton({ label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group inline-flex items-center gap-2 rounded-[8px] py-1 pr-2.5 text-left transition-colors hover:bg-[#E6F7FA]/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0097B2]/30"
    >
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#E6F7FA] text-[#007F96] transition-colors group-hover:bg-[#0097B2] group-hover:text-white">
        <OrderBackArrowIcon />
      </span>
      <span className="text-[12px] font-semibold text-[#007F96] transition-colors group-hover:text-[#00667A]">
        {label}
      </span>
    </button>
  );
}

function OrderBackArrowIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M19 12H5M11 6l-6 6 6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}