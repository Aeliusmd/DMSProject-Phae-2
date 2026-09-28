"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import PersonalPortalDashboardShell from "@/components/personal-request/PersonalPortalDashboardShell";
import RequestStepper from "@/components/personal-request/RequestStepper";
import PersonalFacilitySearchField from "@/components/personal-request/PersonalFacilitySearchField";
import {
  fetchPersonalRequestConfig,
} from "@/lib/personal-request/personalRequestApi";
import { submitAuthenticatedPersonalRequest } from "@/lib/personal-request/personalPortalAuthApi";
import {
  clearPersonalAuth,
  isPersonalAuthenticated,
  getStoredPersonalUser,
} from "@/lib/personal-request/personalPortalAuthStorage";
import {
  getDriverLicenseFileError,
  RECORD_TYPE_OPTIONS,
  toApiDate,
  validatePersonalRequestForm,
} from "@/lib/validations/personalRequestValidation";
import { applyApiFieldErrors, getApiErrorMessage } from "@/lib/apiErrorUtils";
import {
  loadPersonalRequestDraft,
  savePersonalRequestDraft,
  savePersonalRequestDraftDebounced,
} from "@/lib/personal-request/personalRequestDraft";

const INITIAL_FORM = {
  email: "",
  firstName: "",
  lastName: "",
  dob: "",
  facilityId: "",
  treatingFacilityName: "",
  treatingFacilityAddress: "",
  treatingDoctor: "",
  recordsDateBegin: "",
  recordsDateEnd: "",
  recordTypes: { medical: false, billing: false, xrays: false },
  driverLicenseNumber: "",
  driverLicenseFile: null,
  deliveryPreference: "download",
  mailAddress: "",
};

function FieldLabel({ children, required }) {
  return (
    <label className="mb-1.5 block text-[12px] font-semibold text-[#334155]">
      {children}
      {required ? <span className="text-red-500"> *</span> : null}
    </label>
  );
}

function FieldError({ message }) {
  if (!message) return null;
  return <p className="mt-1 text-[11px] font-medium text-red-500">{message}</p>;
}

function TextInput({
  name,
  value,
  onChange,
  onBlur,
  placeholder,
  type = "text",
  error,
}) {
  return (
    <input
      name={name}
      type={type}
      value={value}
      onChange={onChange}
      onBlur={onBlur}
      placeholder={placeholder}
      className={`h-[42px] w-full rounded-[8px] border bg-white px-3 text-[13px] text-[#111827] outline-none placeholder:text-[#94A3B8] focus:ring-2 ${
        error
          ? "border-red-500 focus:border-red-500 focus:ring-red-500/10"
          : "border-[#E2E8F0] focus:border-[#0097B2] focus:ring-[#0097B2]/10"
      }`}
    />
  );
}

function DateInput({ name, value, onChange, onBlur, error }) {
  return (
    <div className="relative">
      <input
        name={name}
        type="date"
        value={value}
        onChange={onChange}
        onBlur={onBlur}
        className={`h-[42px] w-full rounded-[8px] border bg-white px-3 pr-10 text-[13px] text-[#111827] outline-none focus:ring-2 ${
          error
            ? "border-red-500 focus:border-red-500 focus:ring-red-500/10"
            : "border-[#E2E8F0] focus:border-[#0097B2] focus:ring-[#0097B2]/10"
        }`}
      />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#94A3B8]">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <rect x="3" y="5" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.6" />
          <path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </span>
    </div>
  );
}

export default function PersonalNewRequestPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const canceled = searchParams.get("canceled") === "1";
  const fileInputRef = useRef(null);
  const draftHydratedRef = useRef(false);
  const accountUser = getStoredPersonalUser();

  const [config, setConfig] = useState({
    processingFee: "35.00",
    researchFee: "5.00",
    lookupDays: 7,
  });
  const [step, setStep] = useState(1);
  const [form, setForm] = useState(INITIAL_FORM);
  const [touched, setTouched] = useState({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [apiErrors, setApiErrors] = useState({});
  const [bannerError, setBannerError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [draftReady, setDraftReady] = useState(false);
  const emailVerified = true;

  useEffect(() => {
    if (!isPersonalAuthenticated()) {
      router.replace("/personalrequest/login");
    }
  }, [router]);

  useEffect(() => {
    if (draftHydratedRef.current) return;
    draftHydratedRef.current = true;

    const draft = loadPersonalRequestDraft();
    const baseForm = {
      ...INITIAL_FORM,
      ...(draft?.form || {}),
      firstName: accountUser?.firstName || draft?.form?.firstName || "",
      lastName: accountUser?.lastName || draft?.form?.lastName || "",
      email: accountUser?.email || draft?.form?.email || "",
      driverLicenseFile: null,
    };
    setForm(baseForm);

    if (canceled) {
      setStep(2);
      setBannerError(
        "Payment was canceled. Re-upload your driver's license if needed, then pay again."
      );
    } else if (draft?.step === 2) {
      setStep(2);
    }

    setDraftReady(true);
  }, [canceled, accountUser?.email, accountUser?.firstName, accountUser?.lastName]);

  useEffect(() => {
    fetchPersonalRequestConfig()
      .then((nextConfig) => {
        if (nextConfig?.researchFee) setConfig(nextConfig);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!draftReady) return;

    savePersonalRequestDraftDebounced({
      form: {
        ...form,
        driverLicenseFile: null,
      },
      emailVerified: true,
      emailVerificationToken: "authenticated",
      step,
    });
  }, [form, step, draftReady]);

  const formErrors = useMemo(
    () => ({
      ...validatePersonalRequestForm(form, { emailVerified: true }),
      ...apiErrors,
    }),
    [form, apiErrors]
  );

  const getError = (name) => {
    if (touched[name] || submitAttempted) return formErrors[name] || "";
    return "";
  };

  const handleChange = (e) => {
    const { name, value, type, checked, files } = e.target;

    if (type === "file") {
      const file = files?.[0] || null;
      e.target.value = "";

      if (!file) {
        setForm((prev) => ({ ...prev, driverLicenseFile: null }));
        setTouched((prev) => ({ ...prev, driverLicenseFile: true }));
        setApiErrors((prev) => {
          if (!prev.driverLicenseFile) return prev;
          const next = { ...prev };
          delete next.driverLicenseFile;
          return next;
        });
        return;
      }

      const fileError = getDriverLicenseFileError(file);
      if (fileError) {
        setForm((prev) => ({ ...prev, driverLicenseFile: null }));
        setTouched((prev) => ({ ...prev, driverLicenseFile: true }));
        setApiErrors((prev) => ({
          ...prev,
          driverLicenseFile: fileError,
        }));
        return;
      }

      setForm((prev) => ({ ...prev, driverLicenseFile: file }));
      setTouched((prev) => ({ ...prev, driverLicenseFile: true }));
      setApiErrors((prev) => {
        if (!prev.driverLicenseFile) return prev;
        const next = { ...prev };
        delete next.driverLicenseFile;
        return next;
      });
      return;
    }

    setForm((prev) => ({ ...prev, [name]: type === "checkbox" ? checked : value }));
  };

  const handleBlur = (e) => {
    setTouched((prev) => ({ ...prev, [e.target.name]: true }));
  };

  const toggleRecordType = (id) => {
    setForm((prev) => ({
      ...prev,
      recordTypes: {
        ...prev.recordTypes,
        [id]: !prev.recordTypes[id],
      },
    }));
    setTouched((prev) => ({ ...prev, recordTypes: true }));
  };

  // Account email replaces per-request OTP verification

  const selectedRecordLabels = RECORD_TYPE_OPTIONS.filter(
    (opt) => form.recordTypes[opt.id]
  ).map((opt) => opt.label);

  const handleContinueToPayment = () => {
    setSubmitAttempted(true);
    setBannerError("");
    setApiErrors({});

    const errors = validatePersonalRequestForm(form, { emailVerified: true });
    if (Object.keys(errors).length > 0) {
      setBannerError("Please complete all required fields before continuing.");
      return;
    }

    savePersonalRequestDraft({
      form: { ...form, driverLicenseFile: null },
      emailVerified: true,
      emailVerificationToken: "authenticated",
      step: 2,
    });

    setStep(2);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handlePay = async () => {
    setBannerError("");
    setApiErrors({});

    if (!form.driverLicenseFile) {
      setBannerError("Please go back and upload your driver's license before paying.");
      return;
    }

    setSubmitting(true);

    try {
      const selectedTypes = RECORD_TYPE_OPTIONS.filter(
        (opt) => form.recordTypes[opt.id]
      ).map((opt) => opt.id);

      const payload = new FormData();
      payload.append("firstName", form.firstName.trim());
      payload.append("lastName", form.lastName.trim());
      payload.append("dob", toApiDate(form.dob));
      payload.append("treatingFacilityName", form.treatingFacilityName.trim());
      payload.append("treatingFacilityAddress", form.treatingFacilityAddress.trim());
      if (form.treatingDoctor?.trim()) {
        payload.append("treatingDoctor", form.treatingDoctor.trim());
      }
      if (form.facilityId) {
        payload.append("facilityId", String(form.facilityId));
      }
      payload.append("recordsDateBegin", toApiDate(form.recordsDateBegin));
      payload.append("recordsDateEnd", toApiDate(form.recordsDateEnd));
      payload.append("recordTypes", JSON.stringify(selectedTypes));
      payload.append("driverLicenseNumber", form.driverLicenseNumber.trim());
      payload.append("deliveryPreference", form.deliveryPreference || "download");
      if (form.deliveryPreference === "mail" && form.mailAddress) {
        payload.append("mailAddress", form.mailAddress.trim());
      }
      payload.append("driverLicenseFile", form.driverLicenseFile);

      savePersonalRequestDraft({
        form: { ...form, driverLicenseFile: null },
        emailVerified: true,
        emailVerificationToken: "authenticated",
        step: 2,
      });

      const result = await submitAuthenticatedPersonalRequest(payload);
      const data = result?.data || result;

      if (data?.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }

      setBannerError("Unable to start payment. Please try again.");
    } catch (err) {
      if (err?.status === 401) {
        clearPersonalAuth();
        router.replace("/personalrequest/login");
        return;
      }
      const { fieldErrors, message } = applyApiFieldErrors(err);
      setApiErrors(fieldErrors);
      setBannerError(message || getApiErrorMessage(err, "Submission failed."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <PersonalPortalDashboardShell title="New Request">
      <div className="mx-auto w-full max-w-[720px]">
      <RequestStepper currentStep={step} />

      {!draftReady ? (
        <section className="rounded-[12px] border border-[#E5E7EB] bg-white p-6 shadow-sm sm:p-8">
          <p className="py-8 text-center text-[13px] text-[#64748B]">Loading…</p>
        </section>
      ) : null}

      {draftReady && step === 2 ? (
        <section className="rounded-[12px] border border-[#E5E7EB] bg-white p-6 shadow-sm sm:p-8">
          <div className="mb-6 text-center">
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-[#E6F7FA] text-[#0097B2]">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                <rect x="3" y="6" width="18" height="12" rx="2" stroke="currentColor" strokeWidth="1.7" />
                <path d="M3 10h18" stroke="currentColor" strokeWidth="1.7" />
              </svg>
            </div>
            <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-[#111827]">
              Payment — ${config.processingFee}
            </h1>
            <p className="mt-2 text-[13px] text-[#64748B]">
              A ${config.processingFee} processing fee is required to begin your personal
              records request. Your order number will be provided after payment.
            </p>
          </div>

          {bannerError ? (
            <div className="mb-5 rounded-[8px] border border-red-200 bg-red-50 px-4 py-3 text-[12px] text-red-700">
              {bannerError}
            </div>
          ) : null}

          <div className="rounded-[10px] border border-[#E5E7EB] bg-[#F8FAFC] p-4 sm:p-5">
            <p className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-[#64748B]">
              Request Summary
            </p>
            <dl className="space-y-2.5 text-[13px]">
              <div className="flex justify-between gap-4">
                <dt className="text-[#64748B]">Name</dt>
                <dd className="text-right font-medium text-[#111827]">
                  {form.firstName} {form.lastName}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[#64748B]">Email</dt>
                <dd className="text-right font-medium text-[#111827]">{form.email}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[#64748B]">DOB</dt>
                <dd className="text-right font-medium text-[#111827]">{form.dob || "—"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[#64748B]">Facility</dt>
                <dd className="text-right font-medium text-[#111827]">
                  {form.treatingFacilityName.trim() || "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[#64748B]">Facility address</dt>
                <dd className="text-right font-medium text-[#111827]">
                  {form.treatingFacilityAddress || "—"}
                </dd>
              </div>
              {form.treatingDoctor?.trim() ? (
                <div className="flex justify-between gap-4">
                  <dt className="text-[#64748B]">Treating doctor</dt>
                  <dd className="text-right font-medium text-[#111827]">
                    {form.treatingDoctor}
                  </dd>
                </div>
              ) : null}
              {!form.facilityId ? (
                <div className="rounded-[8px] border border-[#FDE68A] bg-[#FFFBEB] px-3 py-2 text-[12px] text-[#92400E]">
                  Facility not in our list — a ${config?.researchFee || "5.00"}{" "}
                  facility search fee will be added to your invoice and you will
                  be asked to pay when DMS creates and sends that invoice.
                </div>
              ) : (
                <p className="text-[11px] text-[#059669]">
                  Matched to a known facility in our list.
                </p>
              )}
              <div className="flex justify-between gap-4">
                <dt className="text-[#64748B]">Date Range</dt>
                <dd className="text-right font-medium text-[#111827]">
                  {form.recordsDateBegin} – {form.recordsDateEnd}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[#64748B]">Records</dt>
                <dd className="text-right font-medium text-[#111827]">
                  {selectedRecordLabels.join(", ") || "—"}
                </dd>
              </div>
              <div className="flex justify-between gap-4 border-t border-[#E2E8F0] pt-2.5">
                <dt className="font-semibold text-[#334155]">Total</dt>
                <dd className="font-semibold text-[#0097B2]">${config.processingFee}</dd>
              </div>
            </dl>
          </div>

          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              onClick={() => {
                setStep(1);
                setBannerError("");
              }}
              disabled={submitting}
              className="inline-flex h-[46px] flex-1 items-center justify-center rounded-[8px] border border-[#E2E8F0] bg-white text-[14px] font-semibold text-[#334155] hover:bg-[#F8FAFC] disabled:opacity-60"
            >
              Back
            </button>
            <button
              type="button"
              onClick={handlePay}
              disabled={submitting}
              className="inline-flex h-[46px] flex-[1.4] items-center justify-center rounded-[8px] bg-[#0097B2] text-[14px] font-semibold text-white hover:bg-[#0086A0] disabled:cursor-not-allowed disabled:bg-[#94A3B8]"
            >
              {submitting ? "Redirecting to Stripe..." : `Pay $${config.processingFee}`}
            </button>
          </div>

          <p className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-[#94A3B8]">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
              <rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" strokeWidth="1.7" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.7" />
            </svg>
            Secure payment processing
          </p>
        </section>
      ) : null}

      {draftReady && step === 1 ? (
      <section className="rounded-[12px] border border-[#E5E7EB] bg-white p-6 shadow-sm sm:p-8">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-[#E6F7FA] text-[#0097B2]">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"
                stroke="currentColor"
                strokeWidth="1.7"
              />
              <path d="M9 8h6M9 12h6M9 16h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
            </svg>
          </div>
          <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-[#111827]">
            Personal Records Request
          </h1>
          <p className="mt-2 text-[13px] text-[#64748B]">
            Request your own medical, billing, or imaging records. All fields marked with{" "}
            <span className="text-red-500">*</span> are required.
          </p>
          <p className="mt-3 text-[13px]">
            <Link
              href="/personalrequest/status"
              className="font-semibold text-[#0097B2] hover:underline"
            >
              Already paid? Check your request status →
            </Link>
          </p>
        </div>

        {bannerError ? (
          <div className="mb-5 rounded-[8px] border border-red-200 bg-red-50 px-4 py-3 text-[12px] text-red-700">
            {bannerError}
          </div>
        ) : null}

        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel required>First Name</FieldLabel>
              <TextInput
                name="firstName"
                value={form.firstName}
                onChange={handleChange}
                onBlur={handleBlur}
                placeholder="e.g. John"
                error={getError("firstName")}
              />
              <FieldError message={getError("firstName")} />
            </div>
            <div>
              <FieldLabel required>Last Name</FieldLabel>
              <TextInput
                name="lastName"
                value={form.lastName}
                onChange={handleChange}
                onBlur={handleBlur}
                placeholder="e.g. Smith"
                error={getError("lastName")}
              />
              <FieldError message={getError("lastName")} />
            </div>
          </div>

          <div>
            <FieldLabel required>Date of Birth</FieldLabel>
            <DateInput
              name="dob"
              value={form.dob}
              onChange={handleChange}
              onBlur={handleBlur}
              error={getError("dob")}
            />
            <FieldError message={getError("dob")} />
          </div>

          <div className="rounded-[10px] border border-[#A7F3D0] bg-[#F0FDF4] p-4">
            <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-[#0B7C8E]">
              Account email
            </div>
            <div className="flex items-center gap-3 rounded-[8px] border border-[#A7F3D0] bg-white px-3 py-2.5">
              <p className="flex-1 truncate text-[13px] text-[#111827]">
                {form.email || accountUser?.email || "—"}
              </p>
              <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[#059669]">
                Signed in
              </span>
            </div>
          </div>

          <div className="space-y-4 rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] p-4">
            <div>
              <h2 className="text-[14px] font-semibold text-[#111827]">
                Treating facility
              </h2>
              <p className="mt-1 text-[12px] text-[#64748B]">
                Search by facility name or address from the DMS facilities list.
                Selecting a match fills both fields. Facility name is optional;
                address is required. If the facility is not in our list, DMS will
                search for it. A ${config?.researchFee || "5.00"} facility search
                fee is added to your invoice only if we locate and add the
                facility, and you are asked to pay when that invoice is sent.
              </p>
            </div>

            <PersonalFacilitySearchField
              searchBy="name"
              value={form.treatingFacilityName}
              facilityId={form.facilityId}
              required={false}
              error={getError("treatingFacilityName")}
              onInputChange={(nextValue) => {
                setForm((prev) => ({
                  ...prev,
                  treatingFacilityName: nextValue,
                  facilityId: "",
                }));
              }}
              onSelect={(facility) => {
                setForm((prev) => ({
                  ...prev,
                  facilityId: facility.id ? String(facility.id) : "",
                  treatingFacilityName: facility.facilityName || "",
                  treatingFacilityAddress: facility.address || "",
                }));
                setTouched((prev) => ({
                  ...prev,
                  treatingFacilityName: true,
                  treatingFacilityAddress: true,
                }));
              }}
              onBlur={() =>
                setTouched((prev) => ({ ...prev, treatingFacilityName: true }))
              }
            />

            <div>
              <PersonalFacilitySearchField
                searchBy="address"
                value={form.treatingFacilityAddress}
                facilityId={form.facilityId}
                required
                error={getError("treatingFacilityAddress")}
                onInputChange={(nextValue) => {
                  setForm((prev) => ({
                    ...prev,
                    treatingFacilityAddress: nextValue,
                    facilityId: "",
                  }));
                }}
                onSelect={(facility) => {
                  setForm((prev) => ({
                    ...prev,
                    facilityId: facility.id ? String(facility.id) : "",
                    treatingFacilityName: facility.facilityName || "",
                    treatingFacilityAddress: facility.address || "",
                  }));
                  setTouched((prev) => ({
                    ...prev,
                    treatingFacilityName: true,
                    treatingFacilityAddress: true,
                  }));
                }}
                onBlur={() =>
                  setTouched((prev) => ({
                    ...prev,
                    treatingFacilityAddress: true,
                  }))
                }
              />
              {!form.facilityId && form.treatingFacilityAddress.trim() ? (
                <div className="mt-2 rounded-[8px] border border-[#FDE68A] bg-[#FFFBEB] px-3 py-2 text-[12px] text-[#92400E]">
                  This address is not linked to a known facility. A $
                  {config?.researchFee || "5.00"} facility search fee will be
                  added to your invoice only if we locate and add this facility.
                  You will be asked to pay when the invoice is sent.
                </div>
              ) : !form.facilityId ? (
                <p className="mt-1 text-[11px] text-[#64748B]">
                  Type an address to search DMS facilities. If it matches, the
                  facility name fills automatically.
                </p>
              ) : null}
            </div>

            <div>
              <FieldLabel>Treating Doctor Name (optional)</FieldLabel>
              <TextInput
                name="treatingDoctor"
                value={form.treatingDoctor}
                onChange={handleChange}
                onBlur={handleBlur}
                placeholder="e.g. Dr. Jane Smith"
                error={getError("treatingDoctor")}
              />
              <FieldError message={getError("treatingDoctor")} />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel required>Records From</FieldLabel>
              <DateInput
                name="recordsDateBegin"
                value={form.recordsDateBegin}
                onChange={handleChange}
                onBlur={handleBlur}
                error={getError("recordsDateBegin")}
              />
              <FieldError message={getError("recordsDateBegin")} />
            </div>
            <div>
              <FieldLabel required>Records To</FieldLabel>
              <DateInput
                name="recordsDateEnd"
                value={form.recordsDateEnd}
                onChange={handleChange}
                onBlur={handleBlur}
                error={getError("recordsDateEnd")}
              />
              <FieldError message={getError("recordsDateEnd")} />
            </div>
          </div>

          <div>
            <FieldLabel required>Type of Records Needed</FieldLabel>
            <div className="mt-1 flex flex-wrap gap-2">
              {RECORD_TYPE_OPTIONS.map((opt) => {
                const selected = Boolean(form.recordTypes[opt.id]);
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => toggleRecordType(opt.id)}
                    className={`rounded-full border px-4 py-2 text-[12px] font-semibold transition ${
                      selected
                        ? "border-[#0097B2] bg-[#E6F7FA] text-[#0097B2]"
                        : "border-[#E2E8F0] bg-white text-[#64748B] hover:border-[#CBD5E1]"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <FieldError message={getError("recordTypes")} />
          </div>

          <div>
            <FieldLabel required>Driver&apos;s License Number</FieldLabel>
            <TextInput
              name="driverLicenseNumber"
              value={form.driverLicenseNumber}
              onChange={handleChange}
              onBlur={handleBlur}
              placeholder="Enter license number"
              error={getError("driverLicenseNumber")}
            />
            <FieldError message={getError("driverLicenseNumber")} />
          </div>

          <div>
            <FieldLabel required>Upload Driver&apos;s License</FieldLabel>
            <p className="mb-2 text-[11px] text-[#64748B]">
              Required for identity verification. Accepted: JPEG, PNG, or PDF. Max 10MB.
            </p>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className={`flex w-full flex-col items-center justify-center rounded-[10px] border border-dashed px-4 py-8 transition ${
                getError("driverLicenseFile")
                  ? "border-red-400 bg-red-50"
                  : "border-[#CBD5E1] bg-[#F8FAFC] hover:border-[#0097B2] hover:bg-[#F0FDFF]"
              }`}
            >
              <span className="mb-2 text-[#94A3B8]">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M4 8h3l2-2h6l2 2h3v11H4V8Z"
                    stroke="currentColor"
                    strokeWidth="1.6"
                  />
                  <circle cx="12" cy="13" r="3.5" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              </span>
              {form.driverLicenseFile ? (
                <>
                  <span className="text-[13px] font-semibold text-[#111827]">
                    {form.driverLicenseFile.name}
                  </span>
                  <span className="mt-1 text-[11px] text-[#64748B]">Click to replace file</span>
                </>
              ) : (
                <>
                  <span className="text-[13px] font-semibold text-[#334155]">Click to upload</span>
                  <span className="mt-1 text-[11px] text-[#94A3B8]">JPEG, PNG, or PDF</span>
                </>
              )}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
              className="hidden"
              onChange={handleChange}
            />
            <FieldError message={getError("driverLicenseFile")} />
          </div>

          <button
            type="button"
            onClick={handleContinueToPayment}
            className="mt-2 flex h-[46px] w-full items-center justify-center gap-2 rounded-[8px] bg-[#0097B2] text-[14px] font-semibold text-white transition hover:bg-[#0086A0]"
          >
            Continue to Payment
            <span aria-hidden>→</span>
          </button>

          <p className="text-center text-[11px] text-[#94A3B8]">
            Processing fee: ${config.processingFee}. Payment is required before your
            request enters the queue.
          </p>
        </div>
      </section>
      ) : null}
      </div>
    </PersonalPortalDashboardShell>
  );
}
