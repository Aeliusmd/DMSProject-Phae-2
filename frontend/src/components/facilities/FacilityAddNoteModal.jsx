"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import useIsClient from "@/hooks/useIsClient";
import {
  createFacilityNote,
  downloadFacilityNoteAttachment,
  getFacilityNotes,
} from "@/lib/facilities/facilityApi";
import { applyApiFieldErrors, getApiErrorMessage, hasValidationErrors } from "@/lib/apiErrorUtils";
import { validateNoHtmlMarkup } from "@/lib/validations/nameValidation";

const ALLOWED_FILE_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "text/plain",
];

const MAX_FILE_SIZE_MB = 15;
const MAX_FILES = 10;

export default function FacilityAddNoteModal({
  isOpen,
  facilityId,
  facilityName = "",
  onClose,
  onSaved,
}) {
  const mounted = useIsClient();
  const [note, setNote] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [notes, setNotes] = useState([]);
  const [loadingNotes, setLoadingNotes] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState("");
  const [attachmentError, setAttachmentError] = useState("");
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef(null);

  const clientValidationErrors = useMemo(() => {
    const nextErrors = {};
    if (!note.trim()) {
      nextErrors.note = "Note is required";
    } else {
      const markupError = validateNoHtmlMarkup(note, { fieldLabel: "Note" });
      if (markupError) nextErrors.note = markupError;
    }
    return nextErrors;
  }, [note]);

  const isFormInvalid = hasValidationErrors(clientValidationErrors);

  const loadNotes = useCallback(async () => {
    if (!facilityId) return;

    setLoadingNotes(true);

    try {
      const data = await getFacilityNotes(facilityId);
      setNotes(data);
    } catch (err) {
      setError(err.message || "Failed to load notes");
    } finally {
      setLoadingNotes(false);
    }
  }, [facilityId]);

  useEffect(() => {
    if (!isOpen || !facilityId) return;

    setNote("");
    setAttachments([]);
    setFieldErrors({});
    setError("");
    setAttachmentError("");
    setSaving(false);
    loadNotes();
  }, [isOpen, facilityId, loadNotes]);

  useEffect(() => {
    if (!isOpen) return undefined;

    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [isOpen]);

  if (!mounted || !isOpen || !facilityId) return null;

  const handleNoteChange = (e) => {
    const value = e.target.value.slice(0, 500);
    setNote(value);
    setFieldErrors((prev) => {
      if (!prev.note) return prev;
      const next = { ...prev };
      delete next.note;
      return next;
    });
    if (error) {
      setError("");
    }
  };

  const handleAttachmentChange = (event) => {
    const selected = Array.from(event.target.files || []);
    event.target.value = "";

    if (!selected.length) return;

    if (attachments.length + selected.length > MAX_FILES) {
      setAttachmentError(`You can upload up to ${MAX_FILES} files per note`);
      return;
    }

    const nextError = selected.find((file) => {
      if (!ALLOWED_FILE_TYPES.includes(file.type)) {
        return "Only PDF, Word, image, or text files are allowed";
      }

      if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
        return `Each file must be less than ${MAX_FILE_SIZE_MB} MB`;
      }

      return "";
    });

    if (nextError) {
      setAttachmentError(nextError);
      return;
    }

    setAttachmentError("");
    setAttachments((prev) => [...prev, ...selected]);
  };

  const handleRemoveAttachment = (index) => {
    setAttachments((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
    setAttachmentError("");
  };

  const handleSave = async () => {
    const nextErrors = { ...clientValidationErrors };
    setFieldErrors(nextErrors);

    if (Object.keys(nextErrors).length > 0) {
      setError("");
      return;
    }

    setSaving(true);
    setError("");
    setFieldErrors({});

    try {
      const created = await createFacilityNote(facilityId, {
        note: note.trim(),
        attachments,
      });

      setNotes((prev) => [created, ...prev]);
      setNote("");
      setAttachments([]);
      onSaved?.(created);
      onClose();
    } catch (err) {
      const { fieldErrors: apiErrors, message } = applyApiFieldErrors(err);

      if (Object.keys(apiErrors).length > 0) {
        setFieldErrors(apiErrors);
      }

      setError(message || getApiErrorMessage(err, "Failed to save note"));
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadAttachment = async (attachment) => {
    try {
      await downloadFacilityNoteAttachment(
        facilityId,
        attachment.downloadUrl,
        attachment.fileName
      );
    } catch (err) {
      setError(err.message || "Failed to download attachment");
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 px-4 py-6 backdrop-blur-[2px]">
      <section className="flex max-h-[92vh] w-full max-w-[980px] flex-col overflow-hidden rounded-[10px] bg-white shadow-2xl">
        <div className="flex shrink-0 items-center justify-between border-b border-[#E2E8F0] px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold text-[#111827]">
              {facilityName || "Facility"} - Notes
            </h2>
            <p className="mt-1 text-[11px] text-[#64748B]">
              Add a note and optionally attach files.
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="flex h-[30px] w-[30px] items-center justify-center rounded-[6px] text-[18px] text-[#94A3B8] hover:bg-[#F8FAFC] hover:text-[#334155] disabled:opacity-60"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-5 overflow-hidden px-5 py-5 xl:grid-cols-2">
          <div className="flex min-h-0 flex-col overflow-hidden rounded-[10px] border border-[#E2E8F0] bg-white px-4 py-4">
            <h3 className="mb-4 shrink-0 text-[13px] font-semibold text-[#111827]">
              Add Note
            </h3>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
              <FacilityInput label="Facility" value={facilityName} disabled />

              <div>
                <label className="mb-2 block text-[12px] font-semibold text-[#64748B]">
                  Note <span className="text-red-500">*</span>
                </label>

                <textarea
                  value={note}
                  onChange={handleNoteChange}
                  className={`h-[130px] w-full resize-none rounded-[6px] border bg-white px-3 py-3 text-[12px] leading-[20px] text-[#111827] outline-none focus:ring-2 ${
                    fieldErrors.note || error
                      ? "border-red-500 focus:border-red-500 focus:ring-red-500/10"
                      : "border-[#CBD5E1] focus:border-[#0097B2] focus:ring-[#0097B2]/10"
                  }`}
                />

                <div className="mt-1 flex items-center justify-between">
                  <p className="text-[11px] font-medium text-red-500">
                    {fieldErrors.note || error}
                  </p>
                  <p className="text-[11px] text-[#94A3B8]">{note.length}/500</p>
                </div>
              </div>

              <div>
                <label className="mb-2 block text-[12px] font-semibold text-[#64748B]">
                  Attachments
                </label>

                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.gif,.webp,.txt"
                  onChange={handleAttachmentChange}
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden="true"
                />

                <div
                  className={`flex h-[36px] min-w-0 items-center gap-2 rounded-[6px] border bg-white px-1 ${
                    attachmentError ? "border-red-500" : "border-[#CBD5E1]"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex h-[28px] shrink-0 items-center justify-center rounded-[4px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-[11px] font-medium text-[#334155] hover:bg-[#F1F5F9]"
                  >
                    Choose Files
                  </button>

                  <span className="min-w-0 flex-1 truncate text-[11px] text-[#64748B]">
                    {attachments.length === 0
                      ? "No file chosen"
                      : attachments.length === 1
                        ? attachments[0].name
                        : `${attachments.length} files chosen`}
                  </span>
                </div>

                <p className="mt-1 text-[10px] text-[#94A3B8]">
                  PDF, Word, image, or text files. Up to {MAX_FILES} files,{" "}
                  {MAX_FILE_SIZE_MB} MB each.
                </p>

                {attachmentError ? (
                  <p className="mt-1 text-[11px] font-medium text-red-500">
                    {attachmentError}
                  </p>
                ) : null}

                {attachments.length > 0 ? (
                  <ul className="mt-2 max-h-[120px] space-y-1.5 overflow-y-auto pr-1">
                    {attachments.map((file, index) => (
                      <li
                        key={`${file.name}-${index}`}
                        className="flex items-center justify-between gap-2 rounded-[6px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-[11px] text-[#334155]"
                      >
                        <span className="truncate">{file.name}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveAttachment(index)}
                          className="shrink-0 font-semibold text-[#94A3B8] hover:text-red-500"
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>

              <div className="pt-1">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || isFormInvalid}
                  className="inline-flex h-[36px] min-w-[74px] items-center justify-center rounded-[6px] bg-[#0097B2] px-5 text-[12px] font-semibold text-white hover:bg-[#0086A0] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </div>

          <NotesHistoryPanel
            notes={notes}
            loading={loadingNotes}
            onDownloadAttachment={handleDownloadAttachment}
          />
        </div>
      </section>
    </div>,
    document.body
  );
}

function NotesHistoryPanel({ notes, loading, onDownloadAttachment }) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-[10px] border border-[#E2E8F0] bg-white px-4 py-4">
      <h3 className="mb-4 shrink-0 text-[13px] font-semibold text-[#111827]">
        Notes History
      </h3>

      <div className="min-h-0 max-h-[360px] flex-1 overflow-auto">
        <table className="w-full min-w-[420px] border-collapse">
          <thead className="sticky top-0 z-10 bg-[#F8FAFC]">
            <tr className="border-b border-[#E2E8F0] text-left text-[11px] font-semibold text-[#475569]">
              <th className="w-[100px] px-3 py-3">Date</th>
              <th className="w-[110px] px-3 py-3">By</th>
              <th className="px-3 py-3">Note</th>
            </tr>
          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td
                  colSpan={3}
                  className="px-3 py-8 text-center text-[12px] text-[#94A3B8]"
                >
                  Loading notes...
                </td>
              </tr>
            ) : null}

            {!loading &&
              notes.map((item) => (
                <tr
                  key={item.id}
                  className="border-b border-[#F1F5F9] last:border-b-0 hover:bg-[#F8FAFC]"
                >
                  <td className="px-3 py-3 align-top text-[12px] text-[#475569]">
                    {item.date}
                  </td>

                  <td className="px-3 py-3 align-top text-[12px] text-[#475569]">
                    {item.by}
                  </td>

                  <td className="px-3 py-3 align-top text-[12px] leading-[20px] text-[#334155]">
                    <p>{item.note}</p>

                    {item.attachments?.length ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {item.attachments.map((attachment) => (
                          <button
                            key={attachment.id}
                            type="button"
                            onClick={() => onDownloadAttachment(attachment)}
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

            {!loading && notes.length === 0 ? (
              <tr>
                <td
                  colSpan={3}
                  className="px-3 py-8 text-center text-[12px] text-[#94A3B8]"
                >
                  No notes found.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FacilityInput({ label, value, disabled = false }) {
  return (
    <div>
      <label className="mb-2 block text-[12px] font-semibold text-[#64748B]">
        {label}
      </label>

      <input
        type="text"
        value={value}
        disabled={disabled}
        readOnly
        className="h-[38px] w-full rounded-[6px] border border-[#CBD5E1] bg-[#F8FAFC] px-3 text-[12px] text-[#111827] outline-none"
      />
    </div>
  );
}
