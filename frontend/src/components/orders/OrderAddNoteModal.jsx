"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import useIsClient from "@/hooks/useIsClient";
import { createOrderNote } from "@/lib/orders/orderApi";
import { getTaggableStaff } from "@/lib/orders/orderNoteTagApi";
import {
  getNoteAttachmentError,
  validateNoteForm,
} from "@/lib/orders/orderNoteUtils";
import OrderNoteFormFields from "@/components/orders/OrderNoteFormFields";
import { getMinFutureDateTimeLocal } from "@/lib/utils/dateUtils";
import { applyApiFieldErrors, getApiErrorMessage } from "@/lib/apiErrorUtils";
import { getStoredUser } from "@/lib/auth/authStorage";
import { isAdmin } from "@/lib/auth/roles";

export default function OrderAddNoteModal({ isOpen, order, onClose, onSaved }) {
  const mounted = useIsClient();
  const user = getStoredUser();
  const canTagWorkers = isAdmin(user);
  const [noteText, setNoteText] = useState("");
  const [callbackDate, setCallbackDate] = useState("");
  const [attachment, setAttachment] = useState(null);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [staffOptions, setStaffOptions] = useState([]);
  const [staffLoading, setStaffLoading] = useState(false);
  const [staffError, setStaffError] = useState("");
  const [staffSearch, setStaffSearch] = useState("");
  const [selectedWorkers, setSelectedWorkers] = useState([]);

  const orderId = order?.dbId ?? order?.id ?? null;

  useEffect(() => {
    if (!isOpen) return;
    setNoteText("");
    setCallbackDate("");
    setAttachment(null);
    setErrors({});
    setShowTagPicker(false);
    setStaffOptions([]);
    setStaffError("");
    setStaffSearch("");
    setSelectedWorkers([]);
  }, [isOpen, orderId]);

  useEffect(() => {
    if (!isOpen) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !showTagPicker || !canTagWorkers) return;

    let cancelled = false;
    const timeout = setTimeout(async () => {
      setStaffLoading(true);
      setStaffError("");
      try {
        const staff = await getTaggableStaff({ search: staffSearch.trim() });
        if (!cancelled) setStaffOptions(staff);
      } catch (err) {
        if (!cancelled) {
          setStaffOptions([]);
          setStaffError(getApiErrorMessage(err, "Failed to load workers"));
        }
      } finally {
        if (!cancelled) setStaffLoading(false);
      }
    }, 200);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [isOpen, showTagPicker, canTagWorkers, staffSearch]);

  const minCallbackDateTime = useMemo(
    () => getMinFutureDateTimeLocal(),
    [isOpen, orderId]
  );

  const noteValidationErrors = useMemo(
    () =>
      validateNoteForm({
        noteText,
        callbackDate,
        attachment,
      }),
    [noteText, callbackDate, attachment]
  );

  const displayedErrors = useMemo(
    () => ({
      ...noteValidationErrors,
      ...errors,
    }),
    [noteValidationErrors, errors]
  );

  const isNoteInvalid = Boolean(
    noteValidationErrors.noteText || noteValidationErrors.attachment
  );

  const selectedWorkerIds = useMemo(
    () => selectedWorkers.map((worker) => Number(worker.id)),
    [selectedWorkers]
  );

  if (!mounted || !isOpen || !order) return null;

  const clearError = (field) => {
    setErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  };

  const handleAttachmentChange = (file) => {
    if (!file) {
      setAttachment(null);
      clearError("attachment");
      return;
    }

    const attachmentError = getNoteAttachmentError(file);
    if (attachmentError) {
      setAttachment(null);
      setErrors((prev) => ({ ...prev, attachment: attachmentError }));
      return;
    }

    setAttachment(file);
    clearError("attachment");
  };

  const toggleWorker = (worker) => {
    const id = Number(worker.id);
    setSelectedWorkers((prev) => {
      if (prev.some((item) => Number(item.id) === id)) {
        return prev.filter((item) => Number(item.id) !== id);
      }
      return [...prev, worker];
    });
  };

  const handleSave = async () => {
    const nextErrors = validateNoteForm({
      noteText,
      callbackDate,
      attachment,
      requireCallbackDate: true,
    });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setSaving(true);
    try {
      await createOrderNote(orderId, {
        note: noteText.trim(),
        callbackDate,
        attachment,
        taggedEmployeeIds: canTagWorkers ? selectedWorkerIds : [],
      });
      onSaved?.();
      onClose?.();
    } catch (err) {
      const { fieldErrors, message } = applyApiFieldErrors(err, {
        note: "noteText",
        file: "attachment",
      });

      setErrors((prev) => ({
        ...prev,
        ...fieldErrors,
        ...(Object.keys(fieldErrors).length === 0
          ? { noteText: getApiErrorMessage(err, "Failed to save note") }
          : {}),
      }));

      if (message && Object.keys(fieldErrors).length > 0) {
        setErrors((prev) => ({ ...prev, submit: message }));
      }
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/45 px-4 py-6 backdrop-blur-[2px]">
      <section className="flex max-h-[calc(100vh-44px)] w-full max-w-[720px] flex-col overflow-hidden rounded-[8px] bg-white shadow-2xl">
        <ModalHeader order={order} title="Add New Note" onClose={onClose} />

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <OrderNoteFormFields
            noteText={noteText}
            callbackDate={callbackDate}
            attachment={attachment}
            errors={displayedErrors}
            callbackRequired
            minCallbackDateTime={minCallbackDateTime}
            onNoteTextChange={(value) => {
              setNoteText(value);
              clearError("noteText");
            }}
            onCallbackDateChange={(value) => {
              setCallbackDate(value);
              clearError("callbackDate");
            }}
            onAttachmentChange={handleAttachmentChange}
          />

          {canTagWorkers ? (
            <div className="mt-4 rounded-[8px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[12px] font-semibold text-[#334155]">
                    Tag a worker
                  </p>
                  <p className="mt-0.5 text-[10px] text-[#64748B]">
                    Optional. Tagged workers will see this note in their mailbox.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowTagPicker((prev) => !prev)}
                  className="inline-flex h-[30px] items-center justify-center rounded-[6px] border border-[#BAE6FD] bg-white px-3 text-[11px] font-semibold text-[#0369A1] hover:bg-[#F0F9FF]"
                >
                  {showTagPicker ? "Hide workers" : "Tag a worker"}
                </button>
              </div>

              {selectedWorkers.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {selectedWorkers.map((worker) => (
                    <span
                      key={worker.id}
                      className="inline-flex items-center gap-1 rounded-full border border-[#BAE6FD] bg-[#F0F9FF] px-2 py-1 text-[10px] font-medium text-[#0369A1]"
                    >
                      {worker.name}
                      <button
                        type="button"
                        onClick={() => toggleWorker(worker)}
                        className="text-[#0284C7] hover:text-[#0C4A6E]"
                        aria-label={`Remove ${worker.name}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}

              {showTagPicker ? (
                <div className="mt-3 rounded-[6px] border border-[#E2E8F0] bg-white p-3">
                  <input
                    type="text"
                    value={staffSearch}
                    onChange={(event) => setStaffSearch(event.target.value)}
                    placeholder="Search employees and managers..."
                    className="h-[34px] w-full rounded-[6px] border border-[#E2E8F0] px-3 text-[12px] text-[#334155] outline-none focus:border-[#007F96] focus:ring-2 focus:ring-[#007F96]/10"
                  />

                  {staffError ? (
                    <p className="mt-2 text-[11px] font-medium text-red-500">
                      {staffError}
                    </p>
                  ) : null}

                  <div className="mt-2 max-h-[180px] space-y-1 overflow-y-auto">
                    {staffLoading ? (
                      <p className="px-1 py-2 text-[11px] text-[#64748B]">
                        Loading workers...
                      </p>
                    ) : staffOptions.length === 0 ? (
                      <p className="px-1 py-2 text-[11px] text-[#64748B]">
                        No workers found.
                      </p>
                    ) : (
                      staffOptions.map((worker) => {
                        const checked = selectedWorkerIds.includes(
                          Number(worker.id)
                        );
                        return (
                          <label
                            key={worker.id}
                            className="flex cursor-pointer items-center gap-2 rounded-[6px] px-2 py-2 text-[12px] text-[#334155] hover:bg-[#F8FAFC]"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleWorker(worker)}
                              className="h-[14px] w-[14px] accent-[#0097B2]"
                            />
                            <span className="min-w-0 flex-1 truncate font-medium">
                              {worker.name}
                            </span>
                            <span className="shrink-0 text-[10px] text-[#64748B]">
                              {worker.role}
                            </span>
                          </label>
                        );
                      })
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {errors.submit ? (
            <p className="mt-3 text-[11px] font-medium text-red-500">
              {errors.submit}
            </p>
          ) : null}

          <div className="mt-4">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || isNoteInvalid}
              className="inline-flex h-[32px] items-center justify-center rounded-[6px] bg-[#0097B2] px-4 text-[11px] font-semibold text-white hover:bg-[#0086A0] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "Saving..." : "Save Note"}
            </button>
          </div>
        </div>
      </section>
    </div>,
    document.body
  );
}

function ModalHeader({ order, title, onClose }) {
  return (
    <div className="flex h-[48px] shrink-0 items-start justify-between border-b border-[#E2E8F0] px-5 py-3">
      <div className="min-w-0">
        <h2 className="text-[13px] font-semibold text-[#111827]">
          {title} — {order.id}
        </h2>
        <p className="mt-[3px] truncate text-[10px] text-[#007F96]">
          {order.applicant}
        </p>
      </div>

      <button
        type="button"
        onClick={onClose}
        className="flex h-[24px] w-[24px] items-center justify-center rounded-[5px] text-[16px] leading-none text-[#94A3B8] hover:bg-[#F1F5F9] hover:text-[#334155]"
        aria-label="Close modal"
      >
        ×
      </button>
    </div>
  );
}
