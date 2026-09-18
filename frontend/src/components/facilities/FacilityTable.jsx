"use client";

import { useState } from "react";
import Link from "next/link";
import ConfirmModal from "@/components/ui/ConfirmModal";
import AlertModal from "@/components/ui/AlertModal";
import UploadDocumentsModal from "@/components/ui/UploadDocumentsModal";
import FacilityAddNoteModal from "@/components/facilities/FacilityAddNoteModal";
import FacilityOrdersModal from "@/components/facilities/FacilityOrdersModal";
import { uploadFacilityDocument } from "@/lib/facilities/facilityApi";

export default function FacilitiesTable({
  facilities,
  onDelete,
  canDelete = true,
  sortDir = "desc",
  onSortDirChange = null,
}) {
  const [deleteModal, setDeleteModal] = useState({
    open: false,
    facility: null,
  });

  const [uploadModal, setUploadModal] = useState({
    open: false,
    facility: null,
  });
  const [noteModal, setNoteModal] = useState({
    open: false,
    facility: null,
  });
  const [ordersModal, setOrdersModal] = useState({
    open: false,
    facility: null,
  });
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploadAlert, setUploadAlert] = useState({
    open: false,
    variant: "success",
    title: "",
    message: "",
  });

  const openDeleteModal = (facility) => {
    setDeleteModal({
      open: true,
      facility,
    });
  };

  const closeDeleteModal = () => {
    setDeleteModal({
      open: false,
      facility: null,
    });
  };

  const handleConfirmDelete = () => {
    if (!deleteModal.facility) return;

    onDelete(deleteModal.facility);
    closeDeleteModal();
  };

  const openUploadModal = (facility) => {
    setUploadError("");
    setUploadModal({
      open: true,
      facility,
    });
  };

  const closeUploadModal = () => {
    if (uploading) return;

    setUploadModal({
      open: false,
      facility: null,
    });
    setUploadError("");
  };

  const openNoteModal = (facility) => {
    setNoteModal({
      open: true,
      facility,
    });
  };

  const closeNoteModal = () => {
    setNoteModal({
      open: false,
      facility: null,
    });
  };

  const openOrdersModal = (facility) => {
    setOrdersModal({
      open: true,
      facility,
    });
  };

  const closeOrdersModal = () => {
    setOrdersModal({
      open: false,
      facility: null,
    });
  };

  const handleUploadDocuments = async ({ documentType, files }) => {
    if (!uploadModal.facility?.id || !files?.length) return;

    setUploading(true);
    setUploadError("");

    try {
      for (const file of files) {
        await uploadFacilityDocument(
          uploadModal.facility.id,
          file,
          documentType
        );
      }

      setUploadModal({
        open: false,
        facility: null,
      });
      setUploadError("");
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
      setUploadError(message);
      setUploadAlert({
        open: true,
        variant: "error",
        title: "Upload Failed",
        message,
      });
      throw err;
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
      <section className="min-h-0 flex-1 overflow-hidden rounded-[10px] border border-[#E2E8F0] bg-white shadow-sm">
        <div className="h-full overflow-auto">
          <table className="w-full min-w-[980px] border-collapse">
            <thead className="sticky top-0 z-10 bg-white">
              <tr className="border-b border-[#E2E8F0] text-left text-[11px] font-semibold text-[#475569]">
                <th className="w-[90px] px-5 py-3">
                  <FacilityIdSortHeader
                    sortDir={sortDir}
                    onSortDirChange={onSortDirChange}
                  />
                </th>
                <th className="w-[280px] px-5 py-3">Facility</th>
                <th className="w-[160px] px-5 py-3">City</th>
                <th className="w-[100px] px-5 py-3">Zip</th>
                <th className="w-[110px] px-5 py-3 text-center">Orders</th>
                <th className="w-[110px] px-5 py-3 text-center">Notes</th>
                <th className="w-[110px] px-5 py-3 text-center">Upload</th>
                {canDelete ? (
                  <th className="w-[110px] px-5 py-3 text-center">Delete</th>
                ) : null}
              </tr>
            </thead>

            <tbody>
              {facilities.map((facility) => (
                <tr
                  key={facility.id}
                  className="border-b border-[#F1F5F9] last:border-b-0 odd:bg-white even:bg-[#F8FBFC] hover:bg-[#F1F9FB]"
                >
                  <td className="px-5 py-4 text-[12px] text-[#64748B]">
                    {facility.id}
                  </td>

                  <td className="px-5 py-4">
                    <Link
                      href={`/facilities/${facility.id}/info`}
                      className="text-left text-[12px] font-semibold text-[#007F96] hover:underline"
                    >
                      {facility.facility}
                    </Link>
                  </td>

                  <td className="px-5 py-4 text-[12px] text-[#475569]">
                    {facility.city}
                  </td>

                  <td className="px-5 py-4 text-[12px] text-[#475569]">
                    {facility.zip}
                  </td>

                  <td className="px-5 py-4 text-center">
                    <button
                      type="button"
                      onClick={() => openOrdersModal(facility)}
                      className="inline-flex h-[28px] items-center justify-center gap-2 whitespace-nowrap rounded-[6px] border border-[#67D8E8] bg-[#E6F7FA] px-3 text-[11px] font-semibold text-[#007F96] hover:bg-[#DDF6FA]"
                    >
                      <OrdersIcon />
                      Orders
                    </button>
                  </td>

                  <td className="px-5 py-4 text-center">
                    <button
                      type="button"
                      onClick={() => openNoteModal(facility)}
                      className="inline-flex h-[28px] items-center justify-center gap-2 whitespace-nowrap rounded-[6px] border border-[#67D8E8] bg-[#E6F7FA] px-3 text-[11px] font-semibold text-[#007F96] hover:bg-[#DDF6FA]"
                    >
                      <NotesIcon />
                      Notes
                    </button>
                  </td>

                  <td className="px-5 py-4 text-center">
                    <button
                      type="button"
                      onClick={() => openUploadModal(facility)}
                      className="inline-flex h-[28px] items-center justify-center gap-2 whitespace-nowrap rounded-[6px] border border-[#93C5FD] bg-[#EFF6FF] px-3 text-[11px] font-semibold text-[#2563EB] hover:bg-[#DBEAFE]"
                    >
                      <UploadIcon />
                      Upload
                    </button>
                  </td>

                  {canDelete ? (
                    <td className="px-5 py-4 text-center">
                      <button
                        type="button"
                        onClick={() => openDeleteModal(facility)}
                        className="inline-flex h-[28px] items-center justify-center gap-2 whitespace-nowrap rounded-[6px] border border-red-200 bg-red-50 px-3 text-[11px] font-semibold text-red-500 hover:bg-red-100"
                      >
                        <TrashIcon />
                        Delete
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}

              {facilities.length === 0 && (
                <tr>
                  <td
                    colSpan={canDelete ? 8 : 7}
                    className="px-5 py-12 text-center text-[13px] text-[#94A3B8]"
                  >
                    No facilities found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <ConfirmModal
        open={deleteModal.open}
        title="Delete Facility"
        message={`Are you sure you want to delete ${
          deleteModal.facility?.facility || "this facility"
        }? This action cannot be undone.`}
        variant="danger"
        confirmLabel="Confirm"
        cancelLabel="Cancel"
        onCancel={closeDeleteModal}
        onConfirm={handleConfirmDelete}
      />

      <UploadDocumentsModal
        open={uploadModal.open}
        title="Upload Documents"
        onClose={closeUploadModal}
        onUpload={handleUploadDocuments}
        uploading={uploading}
        uploadError={uploadError}
      />

      <FacilityAddNoteModal
        isOpen={noteModal.open}
        facilityId={noteModal.facility?.id || ""}
        facilityName={noteModal.facility?.facility || ""}
        onClose={closeNoteModal}
      />

      <FacilityOrdersModal
        isOpen={ordersModal.open}
        facilityId={ordersModal.facility?.id || ""}
        facilityName={ordersModal.facility?.facility || ""}
        onClose={closeOrdersModal}
      />

      <AlertModal
        open={uploadAlert.open}
        title={uploadAlert.title}
        message={uploadAlert.message}
        variant={uploadAlert.variant}
        onClose={() => setUploadAlert((prev) => ({ ...prev, open: false }))}
      />
    </>
  );
}

function FacilityIdSortHeader({ sortDir, onSortDirChange }) {
  const activeDir =
    sortDir === "asc" || sortDir === "desc" ? sortDir : "desc";
  const canSort = typeof onSortDirChange === "function";

  return (
    <div className="inline-flex items-center gap-1.5">
      <span>ID</span>
      {canSort ? (
        <span className="inline-flex items-center gap-1">
          <button
            type="button"
            aria-label="Sort facility ID ascending"
            title="Ascending (lowest to highest)"
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
            aria-label="Sort facility ID descending"
            title="Descending (highest to lowest)"
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

function OrdersIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
      <path d="M7 4h10v16H7V4Z" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M10 8h4M10 12h4M10 16h3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function NotesIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
      <path d="M5 4h14v16H5V4Z" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 9h8M8 13h6" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 16V5M8 9l4-4 4 4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M5 19h14"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
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
