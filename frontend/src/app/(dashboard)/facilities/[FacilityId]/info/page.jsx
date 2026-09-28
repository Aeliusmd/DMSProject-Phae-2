"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import DashboardShell from "@/components/layout/DashboardShell";
import ConfirmModal from "@/components/ui/ConfirmModal";
import AlertModal from "@/components/ui/AlertModal";
import UploadDocumentsModal from "@/components/ui/UploadDocumentsModal";
import DocumentPreviewModal from "@/components/facilities/DocumentPreviewModal";
import FacilityAddNoteModal from "@/components/facilities/FacilityAddNoteModal";
import { ApiRequestError } from "@/lib/auth/authApi";
import {
  mapApiErrors,
  shouldShowSubmitError,
  hasValidationErrors,
} from "@/lib/apiErrorUtils";
import {
  validateOrganizationName,
  validatePersonName,
} from "@/lib/validations/nameValidation";
import {
  ZIP_MAX_CHARS,
  ZIP_VALIDATION_MESSAGE,
  isValidZip,
  sanitizeZip,
} from "@/lib/validations/zipUtils";
import {
  createDoctors,
  deactivateDoctor,
  deleteFacilityDocument,
  getFacility,
  getFacilityDocuments,
  getFacilityNotes,
  downloadFacilityNoteAttachment,
  reactivateDoctor,
  setDefaultDoctor,
  updateDoctor,
  updateFacility,
  uploadFacilityDocument,
} from "@/lib/facilities/facilityApi";
import {
  FACILITY_EDIT_LOCK_MESSAGE,
  useFacilityEditLock,
} from "@/lib/facilities/useFacilityEditLock";

const CONTACT_NAME_FIELDS = [
  { field: "firstName", label: "First name" },
  { field: "middleName", label: "Middle name" },
  { field: "lastName", label: "Last name" },
];

const createEmptyDoctorInput = (id) => ({
  id,
  officeName: "",
  isDefault: false,
  firstName: "",
  middleName: "",
  lastName: "",
  phone: "",
  fax: "",
  email: "",
});

export default function FacilityDetailsPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnToOrderPath = getSafeOrderReturnPath(searchParams.get("returnTo"));
  const focusSection = searchParams.get("focus");

  const facilityId = String(
    params?.facilityId || params?.FacilityId || params?.id || ""
  );
  const { status: lockStatus, error: lockError } =
    useFacilityEditLock(facilityId);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [formData, setFormData] = useState(null);
  const [doctorInputs, setDoctorInputs] = useState([
    createEmptyDoctorInput("doctor-input-1"),
  ]);
  const [doctors, setDoctors] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [notes, setNotes] = useState([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [noteModalOpen, setNoteModalOpen] = useState(false);
  const [uploadingDocument, setUploadingDocument] = useState(false);
  const [uploadDocError, setUploadDocError] = useState("");
  const [previewDocument, setPreviewDocument] = useState(null);
  const [uploadAlert, setUploadAlert] = useState({
    open: false,
    variant: "success",
    title: "",
    message: "",
  });
  const [deleteDocumentModal, setDeleteDocumentModal] = useState({
    open: false,
    document: null,
  });
  const [deletingDocument, setDeletingDocument] = useState(false);
  const [errors, setErrors] = useState({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [creatingDoctors, setCreatingDoctors] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [doctorError, setDoctorError] = useState("");
  const [doctorErrors, setDoctorErrors] = useState({});
  const [doctorSubmitAttempted, setDoctorSubmitAttempted] = useState(false);
  const [returnDoctorId, setReturnDoctorId] = useState("");
  const [savedSnapshot, setSavedSnapshot] = useState(null);

  const [saveConfirmModal, setSaveConfirmModal] = useState({ open: false });
  const [returnToOrderModal, setReturnToOrderModal] = useState({ open: false });

  const [removeManagerModal, setRemoveManagerModal] = useState({
    open: false,
    manager: null,
  });

  const [deleteDoctorModal, setDeleteDoctorModal] = useState({
    open: false,
    doctor: null,
  });
  const [editDoctorModal, setEditDoctorModal] = useState({
    open: false,
    doctor: null,
  });
  const [editDoctorForm, setEditDoctorForm] = useState(null);
  const [editDoctorErrors, setEditDoctorErrors] = useState({});
  const [editDoctorSubmitAttempted, setEditDoctorSubmitAttempted] = useState(false);
  const [savingDoctor, setSavingDoctor] = useState(false);
  const [editDoctorError, setEditDoctorError] = useState("");

  const loadDocuments = useCallback(async () => {
    if (!facilityId) return;

    setDocumentsLoading(true);

    try {
      const data = await getFacilityDocuments(facilityId);
      setDocuments(data);
    } catch (err) {
      setSubmitError(err.message || "Failed to load documents");
    } finally {
      setDocumentsLoading(false);
    }
  }, [facilityId]);

  const loadNotes = useCallback(async () => {
    if (!facilityId) return;

    setNotesLoading(true);

    try {
      const data = await getFacilityNotes(facilityId);
      setNotes(data);
    } catch (err) {
      setSubmitError(err.message || "Failed to load notes");
    } finally {
      setNotesLoading(false);
    }
  }, [facilityId]);

  const loadFacility = useCallback(async () => {
    if (!facilityId) return;

    setLoading(true);
    setLoadError("");

    try {
      const facility = await getFacility(facilityId);

      const nextFormData = {
        ...facility,
        zip: sanitizeZip(facility.zip || facility.zipCode || ""),
        officeManagers:
          facility.officeManagers?.length > 0
            ? facility.officeManagers
            : [
                {
                  id: null,
                  firstName: "",
                  middleName: "",
                  lastName: "",
                  phone: "",
                  email: "",
                },
              ],
      };

      setFormData(nextFormData);
      setSavedSnapshot(normalizeFacilityFormData(nextFormData));
      setDoctors(facility.doctors || []);
    } catch (err) {
      setLoadError(err.message || "Failed to load facility");
    } finally {
      setLoading(false);
    }
  }, [facilityId]);

  useEffect(() => {
    if (lockStatus !== "held") return;
    loadFacility();
  }, [loadFacility, lockStatus]);

  useEffect(() => {
    if (lockStatus !== "held") return;
    loadDocuments();
  }, [loadDocuments, lockStatus]);

  useEffect(() => {
    if (lockStatus !== "held") return;
    loadNotes();
  }, [loadNotes, lockStatus]);

  useEffect(() => {
    if (focusSection !== "doctors" || loading) return undefined;

    const doctorNamePrefill = `${searchParams.get("doctorName") || ""}`.trim();
    if (doctorNamePrefill) {
      const parts = doctorNamePrefill.split(/\s+/).filter(Boolean);
      const firstName = parts[0] || "";
      const lastName = parts.length > 1 ? parts[parts.length - 1] : "";
      const middleName =
        parts.length > 2 ? parts.slice(1, -1).join(" ") : "";
      setDoctorInputs([
        {
          ...createEmptyDoctorInput(`doctor-input-${Date.now()}`),
          firstName,
          middleName,
          lastName,
        },
      ]);
    }

    const timer = setTimeout(() => {
      document
        .getElementById("facility-doctors")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 150);

    return () => clearTimeout(timer);
  }, [focusSection, loading, searchParams]);

  const handleChange = (e) => {
    const { name, value } = e.target;

    let nextValue = value;

    if (name === "phone" || name === "fax") {
      nextValue = formatPhone(value);
    }

    if (name === "zip") {
      nextValue = sanitizeZip(value);
    }

    if (name === "state") {
      nextValue = value.replace(/[^a-zA-Z]/g, "").toUpperCase().slice(0, 2);
    }

    setFormData((prev) => ({
      ...prev,
      [name]: nextValue,
    }));
    setSubmitError("");

    if (submitAttempted) {
      const fieldError = validateFacilityField(name, nextValue);

      setErrors((prev) => {
        const nextErrors = { ...prev };

        if (fieldError) {
          nextErrors[name] = fieldError;
        } else {
          delete nextErrors[name];
        }

        return nextErrors;
      });
    }
  };

  const handleManagerChange = (managerId, field, value) => {
    let nextValue = value;

    if (field === "phone") {
      nextValue = formatPhone(value);
    }

    setFormData((prev) => ({
      ...prev,
      officeManagers: prev.officeManagers.map((manager) =>
        manager.id === managerId ? { ...manager, [field]: nextValue } : manager
      ),
    }));
    setSubmitError("");

    if (submitAttempted && formData) {
      const managerIndex = (formData.officeManagers || []).findIndex(
        (manager) => manager.id === managerId
      );
      if (managerIndex >= 0) {
        const errorKey = `managers.${managerIndex}.${field}`;
        const fieldError = validateManagerField(field, nextValue);
        setErrors((prev) => {
          const nextErrors = { ...prev };
          if (fieldError) {
            nextErrors[errorKey] = fieldError;
          } else {
            delete nextErrors[errorKey];
          }
          return nextErrors;
        });
      }
    }
  };

  const handleAddManager = () => {
    setFormData((prev) => ({
      ...prev,
      officeManagers: [
        ...prev.officeManagers,
        {
          id: `new-${Date.now()}`,
          firstName: "",
          middleName: "",
          lastName: "",
          phone: "",
          email: "",
        },
      ],
    }));
  };

  const openRemoveManagerModal = (manager) => {
    setRemoveManagerModal({
      open: true,
      manager,
    });
  };

  const closeRemoveManagerModal = () => {
    setRemoveManagerModal({
      open: false,
      manager: null,
    });
  };

  const handleRemoveManager = (manager) => {
    openRemoveManagerModal(manager);
  };

  const persistFacilityUpdate = async (data) => {
    const officeManagers = data.officeManagers.map((manager) => ({
      id: typeof manager.id === "number" ? manager.id : null,
      firstName: manager.firstName,
      middleName: manager.middleName,
      lastName: manager.lastName,
      phone: manager.phone,
      email: manager.email,
    }));

    const updated = await updateFacility(facilityId, {
      facilityName: data.facilityName,
      firstName: data.firstName,
      middleName: data.middleName,
      lastName: data.lastName,
      address: data.address,
      zipCode: sanitizeZip(data.zip),
      city: data.city,
      state: data.state,
      phone: data.phone,
      fax: data.fax,
      email: data.email,
      ipAddresses: data.ipAddresses,
      officeManagers,
    });

    const nextFormData = {
      ...updated,
      zip: updated.zip || updated.zipCode || "",
    };

    setFormData(nextFormData);
    setSavedSnapshot(normalizeFacilityFormData(nextFormData));

    return nextFormData;
  };

  const handleConfirmRemoveManager = async () => {
    const manager = removeManagerModal.manager;

    if (!manager || !formData) return;

    const updatedManagers = formData.officeManagers.filter(
      (item) => item.id !== manager.id
    );

    const nextFormData = {
      ...formData,
      officeManagers:
        updatedManagers.length > 0
          ? updatedManagers
          : [
              {
                id: null,
                firstName: "",
                middleName: "",
                lastName: "",
                phone: "",
                email: "",
              },
            ],
    };

    if (typeof manager.id === "number") {
      setSaving(true);
      setSubmitError("");

      try {
        await persistFacilityUpdate(nextFormData);
      } catch (err) {
        setSubmitError(err.message || "Failed to remove office manager");
      } finally {
        setSaving(false);
        closeRemoveManagerModal();
      }

      return;
    }

    setFormData(nextFormData);
    closeRemoveManagerModal();
  };

  const handleDoctorInputChange = (doctorId, field, value) => {
    let nextValue = value;

    if (field === "phone" || field === "fax") {
      nextValue = formatPhone(value);
    }

    setDoctorInputs((prev) =>
      prev.map((doctor) =>
        doctor.id === doctorId ? { ...doctor, [field]: nextValue } : doctor
      )
    );
    setDoctorError("");

    if (doctorSubmitAttempted) {
      const doctorIndex = doctorInputs.findIndex((doctor) => doctor.id === doctorId);
      if (doctorIndex >= 0) {
        const errorKey = `doctors.${doctorIndex}.${field}`;
        const fieldError = validateDoctorField(field, nextValue, {
          firstName:
            field === "firstName"
              ? nextValue
              : doctorInputs[doctorIndex].firstName,
          lastName:
            field === "lastName" ? nextValue : doctorInputs[doctorIndex].lastName,
          officeName:
            field === "officeName"
              ? nextValue
              : doctorInputs[doctorIndex].officeName,
        });
        setDoctorErrors((prev) => {
          const nextErrors = { ...prev };
          if (fieldError) {
            nextErrors[errorKey] = fieldError;
          } else {
            delete nextErrors[errorKey];
          }
          return nextErrors;
        });
      }
    }
  };

  const handleDoctorCheckboxChange = (doctorId, checked) => {
    setDoctorInputs((prev) =>
      prev.map((doctor) =>
        doctor.id === doctorId
          ? { ...doctor, isDefault: checked }
          : checked
          ? { ...doctor, isDefault: false }
          : doctor
      )
    );
  };

  const handleAddDoctorInput = () => {
    setDoctorInputs((prev) => [
      ...prev,
      createEmptyDoctorInput(`doctor-input-${Date.now()}`),
    ]);
  };

  const handleRemoveDoctorInput = (doctorId) => {
    setDoctorInputs((prev) => prev.filter((doctor) => doctor.id !== doctorId));
  };

  const openDeleteDoctorModal = (doctor) => {
    setDeleteDoctorModal({
      open: true,
      doctor,
    });
  };

  const openEditDoctorModal = (doctor) => {
    setEditDoctorModal({
      open: true,
      doctor,
    });
    setEditDoctorForm(doctorRowToEditForm(doctor));
    setEditDoctorErrors({});
    setEditDoctorSubmitAttempted(false);
    setEditDoctorError("");
  };

  const closeEditDoctorModal = () => {
    setEditDoctorModal({
      open: false,
      doctor: null,
    });
    setEditDoctorForm(null);
    setEditDoctorErrors({});
    setEditDoctorSubmitAttempted(false);
    setEditDoctorError("");
  };

  const handleEditDoctorFieldChange = (field, value) => {
    let nextValue = value;

    if (field === "phone" || field === "fax") {
      nextValue = formatPhone(value);
    }

    setEditDoctorForm((prev) => ({
      ...prev,
      [field]: nextValue,
    }));
    setEditDoctorError("");

    if (editDoctorSubmitAttempted && editDoctorForm) {
      const candidate = {
        ...editDoctorForm,
        [field]: nextValue,
      };
      const fieldError = validateDoctorField(field, nextValue, candidate);
      setEditDoctorErrors((prev) => {
        const nextErrors = { ...prev };
        const key = `doctors.0.${field}`;
        if (fieldError) {
          nextErrors[key] = fieldError;
        } else {
          delete nextErrors[key];
        }
        return nextErrors;
      });
    }
  };

  const handleEditDoctorDefaultChange = (checked) => {
    setEditDoctorForm((prev) => ({
      ...prev,
      isDefault: checked,
    }));
  };

  const getEditDoctorFieldError = (field) => {
    if (!editDoctorSubmitAttempted) return "";
    return editDoctorErrors[`doctors.0.${field}`] || "";
  };

  const handleSaveEditDoctor = async () => {
    if (!editDoctorModal.doctor || !editDoctorForm) return;

    setEditDoctorSubmitAttempted(true);
    setEditDoctorError("");

    const validationErrors = validateDoctorsForm([editDoctorForm]);
    setEditDoctorErrors(validationErrors);

    if (Object.keys(validationErrors).length > 0) return;

    setSavingDoctor(true);

    try {
      await updateDoctor(
        facilityId,
        editDoctorModal.doctor.id,
        editDoctorForm
      );
      const refreshed = await getFacility(facilityId);
      setDoctors(refreshed.doctors || []);
      closeEditDoctorModal();
    } catch (err) {
      let mappedErrors = {};
      if (err instanceof ApiRequestError && err.errors) {
        mappedErrors = mapApiErrors(err.errors);
        setEditDoctorErrors((prev) => ({ ...prev, ...mappedErrors }));
      }
      const fallbackMessage = err.message || "Failed to update doctor";
      setEditDoctorError(
        shouldShowSubmitError(fallbackMessage, mappedErrors) ? fallbackMessage : ""
      );
    } finally {
      setSavingDoctor(false);
    }
  };

  const closeDeleteDoctorModal = () => {
    setDeleteDoctorModal({
      open: false,
      doctor: null,
    });
  };

  const handleConfirmDeleteDoctor = async () => {
    if (!deleteDoctorModal.doctor) return;

    try {
      const updated = await deactivateDoctor(
        facilityId,
        deleteDoctorModal.doctor.id
      );

      setDoctors((prev) =>
        prev.map((doctor) =>
          doctor.id === updated.id ? updated : doctor
        )
      );

      const refreshed = await getFacility(facilityId);
      setDoctors(refreshed.doctors || []);
    } catch (err) {
      setSubmitError(err.message || "Failed to deactivate doctor");
    } finally {
      closeDeleteDoctorModal();
    }
  };

  const handleReactivateDoctor = async (doctor) => {
    try {
      await reactivateDoctor(facilityId, doctor.id);
      const refreshed = await getFacility(facilityId);
      setDoctors(refreshed.doctors || []);
    } catch (err) {
      setSubmitError(err.message || "Failed to reactivate doctor");
    }
  };

  const handleSetDefaultDoctor = async (doctor) => {
    try {
      await setDefaultDoctor(facilityId, doctor.id);
      const refreshed = await getFacility(facilityId);
      setDoctors(refreshed.doctors || []);
    } catch (err) {
      setSubmitError(err.message || "Failed to set default doctor");
    }
  };

  const clientValidationErrors = useMemo(
    () => (formData ? validateFacilityForm(formData) : {}),
    [formData]
  );
  const isFormInvalid = hasValidationErrors(clientValidationErrors);

  const handleSaveFacility = () => {
    if (!formData) return;

    setSubmitAttempted(true);
    setSubmitError("");

    const validationErrors = validateFacilityForm(formData);
    setErrors(validationErrors);

    if (Object.keys(validationErrors).length > 0) return;

    if (!hasFacilityChanges(formData, savedSnapshot)) {
      if (returnToOrderPath) {
        setReturnToOrderModal({ open: true });
      }
      return;
    }

    setSaveConfirmModal({ open: true });
  };

  const closeSaveConfirmModal = () => {
    setSaveConfirmModal({ open: false });
  };

  const confirmSaveFacility = async () => {
    if (!formData) return;

    closeSaveConfirmModal();
    setSaving(true);
    setSubmitError("");

    try {
      await persistFacilityUpdate(formData);

      // Return to the edit order even when this new facility still needs a
      // doctor. The order page will clear the previous facility's doctor and
      // show its existing "add doctor" action for the newly selected facility.
      if (returnToOrderPath) {
        setReturnToOrderModal({ open: true });
        return;
      }

      if (!returnToOrderPath) {
        router.push("/facilities");
      }
    } catch (err) {
      let mappedErrors = {};
      if (err instanceof ApiRequestError && err.errors) {
        mappedErrors = mapApiErrors(err.errors);
        setErrors((prev) => ({ ...prev, ...mappedErrors }));
      }
      const fallbackMessage = err.message || "Failed to update facility";
      setSubmitError(
        shouldShowSubmitError(fallbackMessage, mappedErrors) ? fallbackMessage : ""
      );
    } finally {
      setSaving(false);
    }
  };

  const handleCreateDoctors = async () => {
    setDoctorSubmitAttempted(true);
    setDoctorError("");

    const doctorsToCreate = doctorInputs
      .map(({ officeName, firstName, middleName, lastName, phone, fax, email, isDefault }) => ({
        officeName,
        firstName,
        middleName,
        lastName,
        phone,
        fax,
        email,
        isDefault,
      }))
      .filter(
        (doctor) =>
          doctor.officeName?.trim() ||
          doctor.firstName?.trim() ||
          doctor.lastName?.trim() ||
          doctor.phone?.trim() ||
          doctor.fax?.trim() ||
          doctor.email?.trim()
      );

    if (doctorsToCreate.length === 0) {
      setDoctorError("Add at least one doctor with details");
      return;
    }

    const validationErrors = validateDoctorsForm(doctorsToCreate);
    setDoctorErrors(validationErrors);

    if (Object.keys(validationErrors).length > 0) return;

    setCreatingDoctors(true);

    try {
      const existingDoctorIds = new Set(
        doctors.map((doctor) => String(doctor.id))
      );
      const savedDoctors = await createDoctors(facilityId, doctorsToCreate);
      const refreshed = await getFacility(facilityId);
      setDoctors(refreshed.doctors || []);
      setDoctorInputs([createEmptyDoctorInput(`doctor-input-${Date.now()}`)]);
      setDoctorSubmitAttempted(false);
      setDoctorErrors({});

      const newlyCreatedDoctors = savedDoctors.filter(
        (doctor) => !existingDoctorIds.has(String(doctor.id))
      );
      const doctorToApply =
        newlyCreatedDoctors.find((doctor) => doctor.defaultDoctor) ||
        newlyCreatedDoctors[0] ||
        null;
      setReturnDoctorId(doctorToApply?.id ? String(doctorToApply.id) : "");

      if (returnToOrderPath) {
        setReturnToOrderModal({ open: true });
      }
    } catch (err) {
      let mappedErrors = {};
      if (err instanceof ApiRequestError && err.errors) {
        mappedErrors = mapApiErrors(err.errors);
        setDoctorErrors((prev) => ({ ...prev, ...mappedErrors }));
      }
      const fallbackMessage = err.message || "Failed to create doctors";
      setDoctorError(
        shouldShowSubmitError(fallbackMessage, mappedErrors) ? fallbackMessage : ""
      );
    } finally {
      setCreatingDoctors(false);
    }
  };

  const getError = (field) => {
    if (!submitAttempted) return "";
    return errors[field] || "";
  };

  const getDoctorInputError = (index, field) => {
    if (!doctorSubmitAttempted) return "";
    return doctorErrors[`doctors.${index}.${field}`] || "";
  };

  if (lockStatus === "blocked") {
    return (
      <DashboardShell>
        <div className="pointer-events-none mx-auto w-full max-w-[1220px] select-none blur-[4px]">
          <div className="flex flex-col gap-5">
            <h1 className="text-[18px] font-semibold text-[#111827]">
              Facility Information
            </h1>
            <section className="min-h-[420px] rounded-[10px] border border-[#E2E8F0] bg-white px-5 py-5 shadow-sm">
              <div className="h-5 w-48 rounded bg-[#E2E8F0]" />
              <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
                <div className="h-10 rounded bg-[#F1F5F9]" />
                <div className="h-10 rounded bg-[#F1F5F9]" />
                <div className="h-10 rounded bg-[#F1F5F9]" />
              </div>
              <div className="mt-4 h-10 rounded bg-[#F1F5F9]" />
              <div className="mt-4 h-10 rounded bg-[#F1F5F9]" />
            </section>
          </div>
        </div>
        <AlertModal
          open
          variant="error"
          title="Facility is being edited"
          message={FACILITY_EDIT_LOCK_MESSAGE}
          confirmLabel="OK"
          onClose={() => router.push("/facilities")}
        />
      </DashboardShell>
    );
  }

  if (lockStatus === "checking" || (lockStatus === "held" && loading)) {
    return (
      <DashboardShell>
        <div className="flex min-h-[calc(100vh-92px)] items-center justify-center text-[13px] text-[#64748B]">
          Loading facility...
        </div>
      </DashboardShell>
    );
  }

  if (lockStatus === "error" || loadError || !formData) {
    return (
      <DashboardShell>
        <div className="flex min-h-[calc(100vh-92px)] flex-col items-center justify-center gap-4">
          <p className="text-[13px] font-semibold text-red-600">{lockError || loadError || "Facility not found"}</p>
          <Link
            href="/facilities"
            className="text-[12px] font-semibold text-[#007F96] hover:underline"
          >
            Back to Facilities
          </Link>
        </div>
      </DashboardShell>
    );
  }

  const handleUploadDocuments = async ({ documentType, files }) => {
    if (!files?.length) return;

    setUploadingDocument(true);
    setUploadDocError("");

    try {
      for (const file of files) {
        await uploadFacilityDocument(facilityId, file, documentType);
      }

      await loadDocuments();
      setUploadModalOpen(false);
      setUploadDocError("");
      setUploadAlert({
        open: true,
        variant: "success",
        title: "Upload Successful",
        message:
          files.length > 1
            ? `${files.length} documents were uploaded successfully.`
            : "Document was uploaded successfully.",
      });
    } catch (err) {
      const message = err.message || "Failed to upload document";
      setUploadDocError(message);
      setUploadAlert({
        open: true,
        variant: "error",
        title: "Upload Failed",
        message,
      });
      throw err;
      throw err;
    } finally {
      setUploadingDocument(false);
    }
  };

  const openDeleteDocumentModal = (document) => {
    setDeleteDocumentModal({
      open: true,
      document,
    });
  };

  const closeDeleteDocumentModal = () => {
    if (deletingDocument) return;

    setDeleteDocumentModal({
      open: false,
      document: null,
    });
  };

  const handleConfirmDeleteDocument = async () => {
    if (!deleteDocumentModal.document) return;

    setDeletingDocument(true);

    try {
      await deleteFacilityDocument(facilityId, deleteDocumentModal.document.id);

      if (previewDocument?.id === deleteDocumentModal.document.id) {
        setPreviewDocument(null);
      }

      await loadDocuments();
      setUploadAlert({
        open: true,
        variant: "success",
        title: "Document Deleted",
        message: "The document was deleted successfully.",
      });
    } catch (err) {
      setUploadAlert({
        open: true,
        variant: "error",
        title: "Delete Failed",
        message: err.message || "Failed to delete document",
      });
    } finally {
      setDeletingDocument(false);
      setDeleteDocumentModal({
        open: false,
        document: null,
      });
    }
  };

  const openUploadModal = () => {
    setUploadDocError("");
    setUploadModalOpen(true);
  };

  const closeUploadModal = () => {
    if (uploadingDocument) return;
    setUploadModalOpen(false);
    setUploadDocError("");
  };

  return (
    <DashboardShell>
      <div className="mx-auto flex w-full max-w-[1220px] flex-col gap-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="text-[18px] font-semibold text-[#111827]">
            Facility Information
          </h1>

          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/facilities"
              className="inline-flex h-[36px] items-center justify-center gap-2 rounded-[6px] border border-[#E2E8F0] bg-white px-4 text-[12px] font-semibold text-[#475569] shadow-sm hover:bg-[#F8FAFC]"
            >
              <ArrowLeftIcon />
              Facilities
            </Link>
          </div>
        </div>

        <section className="rounded-[10px] border border-[#E2E8F0] bg-white px-5 py-5 shadow-sm">
          <h2 className="mb-5 text-[13px] font-semibold text-[#111827]">
            Facility Information
          </h2>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_330px]">
            <TextField
              label="Facility Name"
              name="facilityName"
              value={formData.facilityName}
              onChange={handleChange}
              required
              error={getError("facilityName")}
              hint="Please leave blank spaces between numbers, names or words"
            />

            {/* <SelectField
              label="Parent Company"
              name="parentCompany"
              value={formData.parentCompany}
              onChange={handleChange}
              options={[
                "Smith & Associates",
                "Martinez Legal Group",
                "Pacific Law Partners",
                "Williams & Co.",
              ]}
            /> */}
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <TextField
              label="First Name"
              name="firstName"
              value={formData.firstName}
              onChange={handleChange}
              error={getError("firstName")}
            />

            <TextField
              label="Middle Name"
              name="middleName"
              value={formData.middleName}
              onChange={handleChange}
              error={getError("middleName")}
            />

            <TextField
              label="Last Name"
              name="lastName"
              value={formData.lastName}
              onChange={handleChange}
              error={getError("lastName")}
            />
          </div>

          <div className="mt-4">
            <TextField
              label="Facility Street Address / PO Box"
              name="address"
              value={formData.address}
              onChange={handleChange}
              hint="Please leave blank spaces between numbers, names or words"
            />
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-[110px_minmax(0,1fr)_90px]">
            <TextField
              label="Zip Code"
              name="zip"
              value={formData.zip}
              onChange={handleChange}
              error={getError("zipCode")}
              maxLength={ZIP_MAX_CHARS}
              placeholder="12345 or 12345-6789"
            />

            <TextField
              label="City"
              name="city"
              value={formData.city}
              onChange={handleChange}
            />

            <TextField
              label="State"
              name="state"
              value={formData.state}
              onChange={handleChange}
              error={getError("state")}
            />
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            <TextField
              label="Phone"
              name="phone"
              value={formData.phone}
              onChange={handleChange}
              placeholder="XXX-XXX-XXXX"
              error={getError("phone")}
            />

            <TextField
              label="Fax"
              name="fax"
              value={formData.fax}
              onChange={handleChange}
              placeholder="XXX-XXX-XXXX"
              error={getError("fax")}
            />
          </div>

          <div className="mt-4">
            <TextField
              label="Email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              placeholder="email"
              error={getError("email")}
            />
          </div>

          <Divider />

          <h2 className="mb-4 text-[13px] font-semibold text-[#111827]">
            Office Managers
          </h2>

          <div className="space-y-4">
            {formData.officeManagers.map((manager, index) => (
              <OfficeManagerCard
                key={manager.id ?? `manager-${index}`}
                manager={manager}
                index={index}
                showRemove={formData.officeManagers.length > 1}
                onChange={handleManagerChange}
                onRemove={handleRemoveManager}
              />
            ))}
          </div>

          <button
            type="button"
            onClick={handleAddManager}
            className="mt-4 inline-flex h-[36px] items-center justify-center gap-2 rounded-[7px] border border-dashed border-[#0097B2] bg-[#E6F7FA] px-4 text-[12px] font-semibold text-[#007F96] hover:bg-[#DDF6FA]"
          >
            <PlusCircleIcon />
            Add Manager
          </button>

          <div className="mt-5">
            <TextAreaField
              label="IP Addresses"
              name="ipAddresses"
              value={formData.ipAddresses}
              onChange={handleChange}
              placeholder="WHITE LIST OF IP ADDRESSES (ONE IP ADDRESS PER LINE)"
              hint="one ip address per line"
            />
          </div>

          {submitError && (
            <div className="mt-4 rounded-[7px] border border-red-200 bg-red-50 px-3 py-3 text-[12px] font-semibold text-red-600">
              {submitError}
            </div>
          )}

          {submitAttempted && isFormInvalid && (
            <div className="mt-4 rounded-[7px] border border-red-200 bg-red-50 px-3 py-3 text-[12px] font-semibold text-red-600">
              Please fill out all required facility fields before saving.
            </div>
          )}

          <button
            type="button"
            onClick={handleSaveFacility}
            disabled={saving}
            className="mt-5 inline-flex h-[38px] items-center justify-center rounded-[6px] bg-[#0097B2] px-6 text-[12px] font-semibold text-white hover:bg-[#0086A0] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </section>

        <section
          id="facility-doctors"
          className="rounded-[10px] border border-[#E2E8F0] bg-white px-5 py-5 shadow-sm"
        >
          <h2 className="mb-5 text-[13px] font-semibold text-[#111827]">
            New Doctor
          </h2>

          <div className="space-y-4">
            {doctorInputs.map((doctor, index) => (
              <DoctorInputCard
                key={doctor.id}
                doctor={doctor}
                index={index}
                showRemove={doctorInputs.length > 1}
                onChange={handleDoctorInputChange}
                onDefaultChange={handleDoctorCheckboxChange}
                onRemove={handleRemoveDoctorInput}
                getError={(field) => getDoctorInputError(index, field)}
              />
            ))}
          </div>

          {doctorError && (
            <div className="mt-4 rounded-[7px] border border-red-200 bg-red-50 px-3 py-3 text-[12px] font-semibold text-red-600">
              {doctorError}
            </div>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleAddDoctorInput}
              className="inline-flex h-[36px] items-center justify-center gap-2 rounded-[6px] border border-[#67D8E8] bg-[#E6F7FA] px-4 text-[12px] font-semibold text-[#007F96] hover:bg-[#DDF6FA]"
            >
              <PlusIcon />
              Add Doctor
            </button>

            <button
              type="button"
              onClick={handleCreateDoctors}
              disabled={creatingDoctors}
              className="inline-flex h-[36px] items-center justify-center rounded-[6px] bg-[#0097B2] px-5 text-[12px] font-semibold text-white hover:bg-[#0086A0] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {creatingDoctors ? "Creating..." : "Create Doctors"}
            </button>
          </div>
        </section>

        <DoctorsTable
          doctors={doctors}
          onEdit={openEditDoctorModal}
          onDelete={openDeleteDoctorModal}
          onReactivate={handleReactivateDoctor}
          onSetDefault={handleSetDefaultDoctor}
        />

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          <NotesCard
            notes={notes}
            loading={notesLoading}
            onNewNote={() => setNoteModalOpen(true)}
            onDownloadAttachment={(attachment) =>
              downloadFacilityNoteAttachment(
                facilityId,
                attachment.downloadUrl,
                attachment.fileName
              )
            }
          />
          <UploadedDocumentsCard
            documents={documents}
            loading={documentsLoading}
            onNewUpload={openUploadModal}
            onSelectDocument={setPreviewDocument}
            onDeleteDocument={openDeleteDocumentModal}
          />
        </div>
      </div>

      <ConfirmModal
        open={saveConfirmModal.open}
        title="Save Changes"
        message="Save the updated facility details?"
        variant="warning"
        confirmLabel="Yes"
        cancelLabel="No"
        onCancel={closeSaveConfirmModal}
        onConfirm={confirmSaveFacility}
      />

      <ConfirmModal
        open={returnToOrderModal.open}
        title="Return to order?"
        message="Facility details were saved. Do you want to go back to the order you were working on?"
        variant="warning"
        confirmLabel="Yes, go to order"
        cancelLabel="Stay on facility"
        onCancel={() => setReturnToOrderModal({ open: false })}
        onConfirm={() => {
          setReturnToOrderModal({ open: false });
          const separator = returnToOrderPath.includes("?") ? "&" : "?";
          const facilityQuery = facilityId
            ? `&applyFacilityId=${encodeURIComponent(facilityId)}`
            : "";
          const doctorQuery = returnDoctorId
            ? `&applyDoctorId=${encodeURIComponent(returnDoctorId)}`
            : "";
          router.push(
            `${returnToOrderPath}${separator}facilityRefresh=1${facilityQuery}${doctorQuery}`
          );
        }}
      />

      <ConfirmModal
        open={removeManagerModal.open}
        title="Remove Office Manager"
        message={`Remove ${formatManagerName(
          removeManagerModal.manager
        )} from this facility?`}
        variant="danger"
        confirmLabel="Remove"
        cancelLabel="No"
        onCancel={closeRemoveManagerModal}
        onConfirm={handleConfirmRemoveManager}
      />

      <EditDoctorModal
        open={editDoctorModal.open}
        doctor={editDoctorModal.doctor}
        form={editDoctorForm}
        saving={savingDoctor}
        error={editDoctorError}
        getError={getEditDoctorFieldError}
        onChange={handleEditDoctorFieldChange}
        onDefaultChange={handleEditDoctorDefaultChange}
        onCancel={closeEditDoctorModal}
        onSave={handleSaveEditDoctor}
      />

      <ConfirmModal
        open={deleteDoctorModal.open}
        title="Deactivate Doctor"
        message={`Are you sure you want to deactivate ${
          deleteDoctorModal.doctor?.doctor || "this doctor"
        }?`}
        variant="danger"
        confirmLabel="Deactivate"
        cancelLabel="Cancel"
        onCancel={closeDeleteDoctorModal}
        onConfirm={handleConfirmDeleteDoctor}
      />

      <ConfirmModal
        open={deleteDocumentModal.open}
        title="Delete Document"
        message={`Are you sure you want to delete ${
          deleteDocumentModal.document?.documentName ||
          deleteDocumentModal.document?.name ||
          "this document"
        }?`}
        variant="danger"
        confirmLabel="Yes"
        cancelLabel="No"
        onCancel={closeDeleteDocumentModal}
        onConfirm={handleConfirmDeleteDocument}
      />

      <AlertModal
        open={uploadAlert.open}
        title={uploadAlert.title}
        message={uploadAlert.message}
        variant={uploadAlert.variant}
        onClose={() => setUploadAlert((prev) => ({ ...prev, open: false }))}
      />

      <UploadDocumentsModal
        open={uploadModalOpen}
        title="Upload Documents"
        onClose={closeUploadModal}
        onUpload={handleUploadDocuments}
        uploading={uploadingDocument}
        uploadError={uploadDocError}
      />

      <DocumentPreviewModal
        open={Boolean(previewDocument)}
        facilityId={facilityId}
        selectedDocument={previewDocument}
        onClose={() => setPreviewDocument(null)}
      />

      <FacilityAddNoteModal
        isOpen={noteModalOpen}
        facilityId={facilityId}
        facilityName={formData?.facilityName || ""}
        onClose={() => setNoteModalOpen(false)}
        onSaved={() => loadNotes()}
      />
    </DashboardShell>
  );
}

function doctorRowToEditForm(doctor) {
  return {
    officeName: doctor?.officeName || doctor?.office || "",
    firstName: doctor?.firstName || "",
    middleName: doctor?.middleName || "",
    lastName: doctor?.lastName || "",
    phone: doctor?.phone || "",
    fax: doctor?.fax || "",
    email: doctor?.email || "",
    isDefault: Boolean(doctor?.defaultDoctor),
  };
}

function EditDoctorModal({
  open,
  doctor,
  form,
  saving,
  error,
  getError,
  onChange,
  onDefaultChange,
  onCancel,
  onSave,
}) {
  if (!open || !form) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 px-4 py-6 backdrop-blur-[2px]">
      <section className="max-h-[90vh] w-full max-w-[720px] overflow-y-auto rounded-[10px] bg-white px-5 py-5 shadow-2xl">
        <div className="mb-4">
          <h2 className="text-[15px] font-semibold text-[#111827]">Edit Doctor</h2>
          <p className="mt-1 text-[12px] text-[#64748B]">
            {doctor?.doctor || "Update doctor details"}
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_160px] lg:items-end">
          <TextField
            label="Office Name"
            value={form.officeName}
            onChange={(e) => onChange("officeName", e.target.value)}
            placeholder="Office Name"
            hint="Office"
            error={getError("officeName")}
          />

          <label className="mb-[10px] flex items-center gap-2 text-[12px] text-[#475569]">
            <input
              type="checkbox"
              checked={form.isDefault}
              disabled={!doctor?.active}
              onChange={(e) => onDefaultChange(e.target.checked)}
              className="h-[13px] w-[13px] rounded border-[#CBD5E1] accent-[#0097B2] disabled:opacity-50"
            />
            Default Doctor
          </label>
        </div>

        <p className="mt-2 text-[11px] text-[#64748B]">First, Middle, Last Name</p>

        <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-3">
          <TextField
            value={form.firstName}
            onChange={(e) => onChange("firstName", e.target.value)}
            placeholder="First Name"
            error={getError("firstName")}
          />
          <TextField
            value={form.middleName}
            onChange={(e) => onChange("middleName", e.target.value)}
            placeholder="Middle Name"
          />
          <TextField
            value={form.lastName}
            onChange={(e) => onChange("lastName", e.target.value)}
            placeholder="Last Name"
          />
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <TextField
            label="Phone"
            value={form.phone}
            onChange={(e) => onChange("phone", e.target.value)}
            placeholder="XXX-XXX-XXXX"
            error={getError("phone")}
          />
          <TextField
            label="Fax"
            value={form.fax}
            onChange={(e) => onChange("fax", e.target.value)}
            placeholder="XXX-XXX-XXXX"
            error={getError("fax")}
          />
        </div>

        <div className="mt-4">
          <TextField
            label="Email"
            value={form.email}
            onChange={(e) => onChange("email", e.target.value)}
            error={getError("email")}
          />
        </div>

        {error && (
          <div className="mt-4 rounded-[7px] border border-red-200 bg-red-50 px-3 py-3 text-[12px] font-semibold text-red-600">
            {error}
          </div>
        )}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-[36px] items-center justify-center rounded-[6px] bg-[#F8FAFC] px-4 text-[12px] font-semibold leading-none text-[#334155] hover:bg-[#E2E8F0]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className="inline-flex h-[36px] items-center justify-center rounded-[6px] bg-[#0097B2] px-5 text-[12px] font-semibold leading-none text-white hover:bg-[#0086A0] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "Saving..." : "Save Changes"}
          </button>
        </div>
      </section>
    </div>
  );
}

function DoctorInputCard({
  doctor,
  index,
  showRemove,
  onChange,
  onDefaultChange,
  onRemove,
  getError,
}) {
  return (
    <div className="rounded-[9px] border border-[#E2E8F0] bg-white px-4 py-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="text-[11px] font-semibold text-[#64748B]">
          Doctor {index + 1}
        </h3>

        {showRemove && (
          <button
            type="button"
            onClick={() => onRemove(doctor.id)}
            className="inline-flex h-[28px] items-center justify-center gap-1 rounded-[6px] border border-red-200 bg-red-50 px-3 text-[11px] font-semibold text-red-500 hover:bg-red-100"
          >
            <TrashIcon />
            Remove
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_160px] lg:items-end">
        <TextField
          label="Office Name"
          value={doctor.officeName}
          onChange={(e) => onChange(doctor.id, "officeName", e.target.value)}
          placeholder="Office Name"
          hint="Office"
          error={getError?.("officeName")}
        />

        <label className="mb-[10px] flex items-center gap-2 text-[12px] text-[#475569]">
          <input
            type="checkbox"
            checked={doctor.isDefault}
            onChange={(e) => onDefaultChange(doctor.id, e.target.checked)}
            className="h-[13px] w-[13px] rounded border-[#CBD5E1] accent-[#0097B2]"
          />
          Default Doctor
        </label>
      </div>

      <p className="mt-2 text-[11px] text-[#64748B]">
        First, Middle, Last Name
      </p>

      <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-3">
        <TextField
          value={doctor.firstName}
          onChange={(e) => onChange(doctor.id, "firstName", e.target.value)}
          placeholder="First Name"
          error={getError?.("firstName")}
        />

        <TextField
          value={doctor.middleName}
          onChange={(e) => onChange(doctor.id, "middleName", e.target.value)}
          placeholder="Middle Name"
        />

        <TextField
          value={doctor.lastName}
          onChange={(e) => onChange(doctor.id, "lastName", e.target.value)}
          placeholder="Last Name"
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <TextField
          label="Phone"
          value={doctor.phone}
          onChange={(e) => onChange(doctor.id, "phone", e.target.value)}
          placeholder="XXX-XXX-XXXX"
          error={getError?.("phone")}
        />

        <TextField
          label="Fax"
          value={doctor.fax}
          onChange={(e) => onChange(doctor.id, "fax", e.target.value)}
          placeholder="XXX-XXX-XXXX"
          error={getError?.("fax")}
        />
      </div>

      <div className="mt-4">
        <TextField
          label="Email"
          value={doctor.email}
          onChange={(e) => onChange(doctor.id, "email", e.target.value)}
          error={getError?.("email")}
        />
      </div>
    </div>
  );
}

function OfficeManagerCard({
  manager,
  index,
  showRemove,
  onChange,
  onRemove,
}) {
  return (
    <div className="rounded-[9px] border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-4">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="text-[11px] font-semibold text-[#64748B]">
          Manager {index + 1}
        </h3>

        {showRemove && (
          <button
            type="button"
            onClick={() => onRemove(manager)}
            className="inline-flex h-[28px] items-center justify-center gap-1 rounded-[6px] border border-red-200 bg-red-50 px-3 text-[11px] font-semibold text-red-500 hover:bg-red-100"
          >
            <TrashIcon />
            Remove
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <TextField
          label="First Name"
          value={manager.firstName}
          onChange={(e) => onChange(manager.id, "firstName", e.target.value)}
        />

        <TextField
          label="Middle Name"
          value={manager.middleName}
          onChange={(e) => onChange(manager.id, "middleName", e.target.value)}
        />

        <TextField
          label="Last Name"
          value={manager.lastName}
          onChange={(e) => onChange(manager.id, "lastName", e.target.value)}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
        <TextField
          label="Phone"
          value={manager.phone}
          onChange={(e) => onChange(manager.id, "phone", e.target.value)}
          placeholder="XXX-XXX-XXXX"
        />

        <TextField
          label="Email"
          value={manager.email}
          onChange={(e) => onChange(manager.id, "email", e.target.value)}
        />
      </div>
    </div>
  );
}

function DoctorsTable({ doctors, onEdit, onDelete, onReactivate, onSetDefault }) {
  return (
    <section className="overflow-hidden rounded-[10px] border border-[#E2E8F0] bg-white shadow-sm">
      <div className="max-h-[360px] overflow-auto">
        <table className="w-full min-w-[1060px] border-collapse">
          <thead className="sticky top-0 z-10 bg-[#F8FAFC]">
            <tr className="border-b border-[#E2E8F0] text-left text-[11px] font-semibold text-[#475569]">
              <th className="w-[60px] px-5 py-3">ID</th>
              <th className="w-[190px] px-5 py-3">Office</th>
              <th className="w-[200px] px-5 py-3">Doctor</th>
              <th className="w-[140px] px-5 py-3">Phone</th>
              <th className="w-[140px] px-5 py-3">Fax</th>
              <th className="w-[230px] px-5 py-3">Email</th>
              <th className="w-[110px] px-5 py-3 text-center">Default</th>
              <th className="w-[90px] px-5 py-3 text-center">Active</th>
              <th className="w-[140px] px-5 py-3 text-center">Actions</th>
            </tr>
          </thead>

          <tbody>
            {doctors.map((doctor) => (
              <tr
                key={doctor.id}
                className="border-b border-[#F1F5F9] last:border-b-0 odd:bg-white even:bg-[#F8FBFC]"
              >
                <td className="px-5 py-4 text-[12px] text-[#64748B]">
                  {doctor.id}
                </td>

                <td className="px-5 py-4 text-[12px] text-[#334155]">
                  {doctor.office}
                </td>

                <td className="px-5 py-4 text-[12px] font-semibold text-[#111827]">
                  {doctor.doctor}
                </td>

                <td className="px-5 py-4 text-[12px] text-[#475569]">
                  {doctor.phone}
                </td>

                <td className="px-5 py-4 text-[12px] text-[#475569]">
                  {doctor.fax}
                </td>

                <td className="px-5 py-4 text-[12px] text-[#475569]">
                  {doctor.email}
                </td>

                <td className="px-5 py-4 text-center">
                  {doctor.defaultDoctor ? (
                    <StatusPill label="Yes" />
                  ) : doctor.active ? (
                    <button
                      type="button"
                      onClick={() => onSetDefault(doctor)}
                      className="text-[11px] font-semibold text-[#007F96] hover:underline"
                    >
                      Set Default
                    </button>
                  ) : (
                    <span className="text-[12px] text-[#94A3B8]">No</span>
                  )}
                </td>

                <td className="px-5 py-4 text-center">
                  {doctor.active ? (
                    <StatusPill label="Active" />
                  ) : (
                    <InactivePill />
                  )}
                </td>

                <td className="px-5 py-4">
                  <div className="flex flex-col items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onEdit(doctor)}
                      className="inline-flex h-[28px] w-full min-w-[88px] items-center justify-center gap-2 rounded-[6px] border border-[#67D8E8] bg-[#E6F7FA] px-3 text-[11px] font-semibold text-[#007F96] hover:bg-[#DDF6FA]"
                    >
                      <PencilIcon />
                      Edit
                    </button>

                    {doctor.active ? (
                      <button
                        type="button"
                        onClick={() => onDelete(doctor)}
                        className="inline-flex h-[28px] w-full min-w-[88px] items-center justify-center gap-2 rounded-[6px] border border-red-200 bg-red-50 px-3 text-[11px] font-semibold text-red-500 hover:bg-red-100"
                      >
                        <DeactivateIcon />
                        Deactivate
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onReactivate(doctor)}
                        className="inline-flex h-[28px] w-full min-w-[88px] items-center justify-center gap-2 rounded-[6px] border border-[#67D8E8] bg-[#E6F7FA] px-3 text-[11px] font-semibold text-[#007F96] hover:bg-[#DDF6FA]"
                      >
                        <ActivateIcon />
                        Activate
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}

            {doctors.length === 0 && (
              <tr>
                <td
                  colSpan={9}
                  className="px-5 py-12 text-center text-[13px] text-[#94A3B8]"
                >
                  No doctors found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function NotesCard({
  notes,
  loading,
  onNewNote,
  onDownloadAttachment,
}) {
  return (
    <section className="rounded-[10px] border border-[#E2E8F0] bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold text-[#111827]">Notes</h2>

        <button
          type="button"
          onClick={onNewNote}
          className="inline-flex h-[28px] items-center justify-center gap-1 rounded-[6px] border border-[#67D8E8] bg-[#E6F7FA] px-3 text-[11px] font-semibold text-[#007F96] hover:bg-[#DDF6FA]"
        >
          <PlusIcon />
          New Note
        </button>
      </div>

      <div className="max-h-[360px] overflow-auto">
        <table className="w-full min-w-[460px] border-collapse">
          <thead className="sticky top-0 z-10 bg-[#F8FAFC]">
            <tr className="border-b border-[#E2E8F0] text-left text-[11px] font-semibold text-[#475569]">
              <th className="w-[110px] px-4 py-3">Date</th>
              <th className="w-[120px] px-4 py-3">By</th>
              <th className="px-4 py-3">Note</th>
            </tr>
          </thead>

          <tbody>
            {loading && (
              <tr>
                <td
                  colSpan={3}
                  className="px-4 py-8 text-center text-[12px] text-[#94A3B8]"
                >
                  Loading notes...
                </td>
              </tr>
            )}

            {!loading &&
              notes.map((note) => (
                <tr
                  key={note.id}
                  className="border-b border-[#F1F5F9] last:border-b-0 odd:bg-white even:bg-[#F8FBFC]"
                >
                  <td className="px-4 py-4 text-[12px] text-[#64748B]">
                    {note.date}
                  </td>

                  <td className="px-4 py-4 text-[12px] text-[#334155]">
                    {note.by}
                  </td>

                  <td className="px-4 py-4 text-[12px] leading-[18px] text-[#334155]">
                    <p>{note.note}</p>

                    {note.attachments?.length ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {note.attachments.map((attachment) => (
                          <button
                            key={attachment.id}
                            type="button"
                            onClick={() => onDownloadAttachment?.(attachment)}
                            className="rounded-[5px] border border-[#BAE6FD] bg-[#F0F9FF] px-2 py-1 text-[10px] font-semibold text-[#0369A1] hover:bg-[#E0F2FE]"
                          >
                            {attachment.fileName}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}

            {!loading && notes.length === 0 && (
              <tr>
                <td
                  colSpan={3}
                  className="px-4 py-8 text-center text-[12px] text-[#94A3B8]"
                >
                  No notes found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function UploadedDocumentsCard({
  documents,
  loading,
  onNewUpload,
  onSelectDocument,
  onDeleteDocument,
}) {
  return (
    <section className="rounded-[10px] border border-[#E2E8F0] bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[13px] font-semibold text-[#111827]">
          Uploaded Documents
        </h2>

        <button
          type="button"
          onClick={onNewUpload}
          className="inline-flex h-[28px] items-center justify-center gap-1 rounded-[6px] border border-[#67D8E8] bg-[#E6F7FA] px-3 text-[11px] font-semibold text-[#007F96]"
        >
          <UploadTinyIcon />
          New Upload
        </button>
      </div>

      <div className="max-h-[360px] overflow-auto">
        <table className="w-full min-w-[640px] border-collapse">
          <thead className="sticky top-0 z-10 bg-[#F8FAFC]">
            <tr className="border-b border-[#E2E8F0] text-left text-[11px] font-semibold text-[#475569]">
              <th className="px-4 py-3">Document</th>
              <th className="w-[120px] px-4 py-3">Date</th>
              <th className="w-[120px] px-4 py-3 text-center">Document Type</th>
              <th className="w-[80px] px-4 py-3 text-center">File Type</th>
              <th className="w-[90px] px-4 py-3 text-center">Delete</th>
            </tr>
          </thead>

          <tbody>
            {loading && (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-8 text-center text-[12px] text-[#94A3B8]"
                >
                  Loading documents...
                </td>
              </tr>
            )}

            {!loading &&
              documents.map((upload) => (
                <tr
                  key={upload.id}
                  className="border-b border-[#F1F5F9] last:border-b-0 odd:bg-white even:bg-[#F8FBFC]"
                >
                  <td className="px-4 py-4">
                    <button
                      type="button"
                      onClick={() => onSelectDocument(upload)}
                      className="text-left text-[12px] font-semibold text-[#007F96] hover:underline"
                    >
                      {upload.documentName || upload.name}
                    </button>
                  </td>

                  <td className="px-4 py-4 text-[12px] text-[#64748B]">
                    {upload.date}
                  </td>

                  <td className="px-4 py-4 text-center">
                    <span className="inline-flex h-[24px] items-center rounded-full bg-[#E6F7FA] px-3 text-[11px] font-semibold text-[#007F96]">
                      {upload.documentType}
                    </span>
                  </td>

                  <td className="px-4 py-4 text-center">
                    <span className="inline-flex h-[24px] items-center rounded-full bg-[#F1F5F9] px-3 text-[11px] font-semibold text-[#64748B]">
                      {upload.fileType}
                    </span>
                  </td>

                  <td className="px-4 py-4 text-center">
                    <button
                      type="button"
                      onClick={() => onDeleteDocument(upload)}
                      className="inline-flex h-[28px] items-center justify-center gap-1 rounded-[6px] border border-red-200 bg-red-50 px-3 text-[11px] font-semibold text-red-500 hover:bg-red-100"
                    >
                      <TrashIcon />
                      Delete
                    </button>
                  </td>
                </tr>
              ))}

            {!loading && documents.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-8 text-center text-[12px] text-[#94A3B8]"
                >
                  No documents uploaded yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TextField({
  label,
  name,
  value,
  onChange,
  placeholder = "",
  required = false,
  hint = "",
  type = "text",
  error = "",
  maxLength,
}) {
  return (
    <div className="min-w-0">
      {label && (
        <label className="mb-[6px] block text-[11px] font-medium text-[#475569]">
          {label}
          {required && <span className="text-red-500"> *</span>}
        </label>
      )}

      <input
        type={type}
        name={name}
        value={value || ""}
        onChange={onChange}
        placeholder={placeholder}
        maxLength={maxLength}
        className={`h-[38px] w-full rounded-[6px] border bg-white px-3 text-[12px] text-[#111827] outline-none placeholder:text-[#94A3B8] focus:ring-2 ${
          error
            ? "border-red-500 focus:border-red-500 focus:ring-red-500/10"
            : "border-[#CBD5E1] focus:border-[#0097B2] focus:ring-[#0097B2]/10"
        }`}
      />

      <div className="mt-[5px] min-h-[15px]">
        {error ? (
          <p className="text-[11px] font-medium text-red-500">{error}</p>
        ) : hint ? (
          <p className="text-[10px] text-[#94A3B8]">{hint}</p>
        ) : null}
      </div>
    </div>
  );
}

function TextAreaField({
  label,
  name,
  value,
  onChange,
  placeholder = "",
  hint = "",
}) {
  return (
    <div>
      <label className="mb-[6px] block text-[11px] font-medium text-[#475569]">
        {label}
      </label>

      <textarea
        name={name}
        value={value || ""}
        onChange={onChange}
        placeholder={placeholder}
        rows={5}
        className="w-full resize-none rounded-[6px] border border-[#CBD5E1] bg-white px-3 py-3 text-[12px] leading-[18px] text-[#111827] outline-none placeholder:text-[#94A3B8] focus:border-[#0097B2] focus:ring-2 focus:ring-[#0097B2]/10"
      />

      {hint && <p className="mt-[5px] text-[10px] text-[#94A3B8]">{hint}</p>}
    </div>
  );
}

function SelectField({ label, name, value, onChange, options }) {
  return (
    <div>
      <label className="mb-[6px] block text-[11px] font-medium text-[#475569]">
        {label}
      </label>

      <select
        name={name}
        value={value || ""}
        onChange={onChange}
        className="h-[38px] w-full rounded-[6px] border border-[#CBD5E1] bg-white px-3 text-[12px] text-[#111827] outline-none focus:border-[#0097B2] focus:ring-2 focus:ring-[#0097B2]/10"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </div>
  );
}

function StatusPill({ label }) {
  return (
    <span className="inline-flex h-[24px] items-center rounded-full bg-[#ECFDF5] px-3 text-[11px] font-semibold text-[#059669]">
      {label}
    </span>
  );
}

function InactivePill() {
  return (
    <span className="inline-flex h-[24px] items-center rounded-full bg-[#FEF2F2] px-3 text-[11px] font-semibold text-[#DC2626]">
      Inactive
    </span>
  );
}

function normalizeFacilityFormData(data) {
  return {
    facilityName: data.facilityName?.trim() || "",
    firstName: data.firstName?.trim() || "",
    middleName: data.middleName?.trim() || "",
    lastName: data.lastName?.trim() || "",
    address: data.address?.trim() || "",
    zip: sanitizeZip(data.zip || data.zipCode || ""),
    city: data.city?.trim() || "",
    state: data.state?.trim() || "",
    phone: data.phone?.trim() || "",
    fax: data.fax?.trim() || "",
    email: data.email?.trim() || "",
    ipAddresses: data.ipAddresses?.trim() || "",
    officeManagers: (data.officeManagers || []).map((manager) => ({
      id: typeof manager.id === "number" ? manager.id : null,
      firstName: manager.firstName?.trim() || "",
      middleName: manager.middleName?.trim() || "",
      lastName: manager.lastName?.trim() || "",
      phone: manager.phone?.trim() || "",
      email: manager.email?.trim() || "",
    })),
  };
}

function hasFacilityChanges(formData, savedSnapshot) {
  if (!savedSnapshot) return true;

  return (
    JSON.stringify(normalizeFacilityFormData(formData)) !==
    JSON.stringify(savedSnapshot)
  );
}

function formatManagerName(manager) {
  if (!manager) return "this office manager";

  const name = [manager.firstName, manager.middleName, manager.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();

  return name || "this office manager";
}

function validateFacilityForm(data) {
  const errors = {};

  if (!data.facilityName?.trim()) {
    errors.facilityName = "Facility name is required";
  } else {
    const facilityNameError = validateOrganizationName(data.facilityName, {
      fieldLabel: "Facility name",
    });
    if (facilityNameError) errors.facilityName = facilityNameError;
  }

  if (data.email?.trim() && !isValidEmail(data.email)) {
    errors.email = "Enter a valid email address";
  }

  CONTACT_NAME_FIELDS.forEach(({ field, label }) => {
    const nameError = validatePersonName(data[field], { fieldLabel: label });
    if (nameError) errors[field] = nameError;
  });

  if (data.zip && !isValidZip(data.zip)) {
    errors.zipCode = ZIP_VALIDATION_MESSAGE;
  }

  if (data.state && data.state.length !== 2) {
    errors.state = "State must be 2 letters";
  }

  if (data.phone && getDigits(data.phone).length !== 10) {
    errors.phone = "Enter a valid 10 digit number";
  }

  if (data.fax && getDigits(data.fax).length !== 10) {
    errors.fax = "Enter a valid 10 digit number";
  }

  (data.officeManagers || []).forEach((manager, index) => {
    ["firstName", "middleName", "lastName"].forEach((nameField) => {
      const label =
        nameField === "firstName"
          ? "Manager first name"
          : nameField === "middleName"
            ? "Manager middle name"
            : "Manager last name";
      const nameError = validatePersonName(manager[nameField], { fieldLabel: label });
      if (nameError) errors[`managers.${index}.${nameField}`] = nameError;
    });

    if (manager.phone && getDigits(manager.phone).length !== 10) {
      errors[`managers.${index}.phone`] = "Enter a valid 10 digit number";
    }

    if (manager.email && !isValidEmail(manager.email)) {
      errors[`managers.${index}.email`] = "Enter a valid email address";
    }
  });

  return errors;
}

function validateFacilityField(field, value) {
  if (!value?.trim()) {
    if (field === "facilityName") return "Facility name is required";
    // Email is optional for facilities (including batch-scan auto-created).
    return "";
  }

  const contactNameField = CONTACT_NAME_FIELDS.find(
    (item) => item.field === field
  );

  if (contactNameField) {
    return validatePersonName(value, { fieldLabel: contactNameField.label });
  }

  if (field === "facilityName" && value) {
    const facilityNameError = validateOrganizationName(value, {
      fieldLabel: "Facility name",
    });
    if (facilityNameError) return facilityNameError;
  }

  if (field === "email" && value && !isValidEmail(value)) {
    return "Enter a valid email address";
  }

  if (field === "zip" && value && !isValidZip(value)) {
    return ZIP_VALIDATION_MESSAGE;
  }

  if (field === "state" && value && value.length !== 2) {
    return "State must be 2 letters";
  }

  if ((field === "phone" || field === "fax") && value) {
    if (getDigits(value).length !== 10) return "Enter a valid 10 digit number";
  }

  return "";
}

function validateManagerField(field, value) {
  if ((field === "firstName" || field === "middleName" || field === "lastName") && value) {
    const label =
      field === "firstName"
        ? "Manager first name"
        : field === "middleName"
          ? "Manager middle name"
          : "Manager last name";
    const nameError = validatePersonName(value, { fieldLabel: label });
    if (nameError) return nameError;
  }

  if (field === "email" && value && !isValidEmail(value)) {
    return "Enter a valid email address";
  }

  if (field === "phone" && value && getDigits(value).length !== 10) {
    return "Enter a valid 10 digit number";
  }

  return "";
}

function validateDoctorField(field, value, candidate = {}) {
  if (field === "officeName" && !`${value || ""}`.trim()) {
    return "Office name is required";
  }

  if (field === "officeName" && value) {
    const officeNameError = validateOrganizationName(value, {
      fieldLabel: "Office name",
    });
    if (officeNameError) return officeNameError;
  }

  if (
    (field === "firstName" || field === "lastName") &&
    !`${candidate.firstName || ""}`.trim() &&
    !`${candidate.lastName || ""}`.trim()
  ) {
    return "Doctor first or last name is required";
  }

  if ((field === "firstName" || field === "middleName" || field === "lastName") && value) {
    const label =
      field === "firstName"
        ? "Doctor first name"
        : field === "middleName"
          ? "Doctor middle name"
          : "Doctor last name";
    const nameError = validatePersonName(value, { fieldLabel: label });
    if (nameError) return nameError;
  }

  if ((field === "phone" || field === "fax") && value && getDigits(value).length !== 10) {
    return "Enter a valid 10 digit number";
  }

  if (field === "email" && value && !isValidEmail(value)) {
    return "Enter a valid email address";
  }

  return "";
}

function validateDoctorsForm(doctors) {
  const errors = {};

  doctors.forEach((doctor, index) => {
    if (!doctor.officeName?.trim()) {
      errors[`doctors.${index}.officeName`] = "Office name is required";
    } else {
      const officeNameError = validateOrganizationName(doctor.officeName, {
        fieldLabel: "Office name",
      });
      if (officeNameError) errors[`doctors.${index}.officeName`] = officeNameError;
    }

    if (!doctor.firstName?.trim() && !doctor.lastName?.trim()) {
      errors[`doctors.${index}.firstName`] =
        "Doctor first or last name is required";
    }

    ["firstName", "middleName", "lastName"].forEach((nameField) => {
      const label =
        nameField === "firstName"
          ? "Doctor first name"
          : nameField === "middleName"
            ? "Doctor middle name"
            : "Doctor last name";
      const nameError = validatePersonName(doctor[nameField], { fieldLabel: label });
      if (nameError) errors[`doctors.${index}.${nameField}`] = nameError;
    });

    if (doctor.phone && getDigits(doctor.phone).length !== 10) {
      errors[`doctors.${index}.phone`] = "Enter a valid 10 digit number";
    }

    if (doctor.fax && getDigits(doctor.fax).length !== 10) {
      errors[`doctors.${index}.fax`] = "Enter a valid 10 digit number";
    }

    if (doctor.email && !isValidEmail(doctor.email)) {
      errors[`doctors.${index}.email`] = "Enter a valid email address";
    }
  });

  return errors;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

function getDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function getSafeOrderReturnPath(value) {
  const path = `${value || ""}`.trim();
  if (!path.startsWith("/orders/new")) return "";
  return path;
}

function formatPhone(value) {
  const digits = getDigits(value).slice(0, 10);

  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)}-${digits.slice(3)}`;

  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function Divider() {
  return <div className="my-5 h-px w-full bg-[#E2E8F0]" />;
}

function ArrowLeftIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path
        d="M19 12H5M11 6l-6 6 6 6"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlusCircleIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M12 8v8M8 12h8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 5v14M5 12h14"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function UploadTinyIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 16V5M8 9l4-4 4 4M5 19h14"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
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

function DeactivateIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.9" />
      <path
        d="M8 12h8"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ActivateIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.9" />
      <path
        d="M8 12h8M12 8v8"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  );
}