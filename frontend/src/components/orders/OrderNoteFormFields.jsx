"use client";

import { useRef } from "react";
import { MAX_NOTE_LENGTH, expandNoteUtcTokens } from "@/lib/orders/orderNoteUtils";
import { formatDateTimeLocalDisplay } from "@/lib/utils/dateUtils";

export default function OrderNoteFormFields({
  noteText,
  callbackDate,
  attachment,
  existingAttachmentUrl,
  errors = {},
  readOnly = false,
  callbackRequired = false,
  minCallbackDateTime = "",
  onNoteTextChange,
  onCallbackDateChange,
  onAttachmentChange,
}) {
  const fileInputRef = useRef(null);
  const displayNoteText = expandNoteUtcTokens(noteText || "");
  const lockNoteText = readOnly || /\[\[utc:/i.test(String(noteText || ""));

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-[6px] flex items-center justify-between gap-2">
          <label className="block text-[11px] font-semibold text-[#475569]">
            Note Text <span className="text-red-500">*</span>
          </label>

          {!readOnly && (
            <span
              className={`text-[10px] ${
                displayNoteText.length > MAX_NOTE_LENGTH
                  ? "text-red-500"
                  : "text-[#94A3B8]"
              }`}
            >
              {displayNoteText.length}/{MAX_NOTE_LENGTH}
            </span>
          )}
        </div>

        {lockNoteText ? (
          <p className="whitespace-pre-wrap rounded-[6px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-[12px] leading-[18px] text-[#334155]">
            {displayNoteText || "—"}
          </p>
        ) : (
          <textarea
            value={noteText}
            onChange={(e) => onNoteTextChange?.(e.target.value)}
            placeholder="Enter note..."
            rows={4}
            className={`w-full resize-none rounded-[6px] border bg-white px-3 py-2 text-[12px] text-[#111827] outline-none placeholder:text-[#94A3B8] focus:ring-2 ${
              errors.noteText
                ? "border-red-500 focus:border-red-500 focus:ring-red-500/10"
                : "border-[#CBD5E1] focus:border-[#0097B2] focus:ring-[#0097B2]/10"
            }`}
          />
        )}

        {errors.noteText && (
          <p className="mt-[5px] text-[11px] font-medium text-red-500">
            {errors.noteText}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-[6px] block text-[11px] font-semibold text-[#475569]">
            Callback Date & Time
            {callbackRequired ? <span className="text-red-500"> *</span> : null}
          </label>

          {readOnly ? (
            <p className="h-[36px] rounded-[6px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-[12px] text-[#334155]">
              {formatDateTimeLocalDisplay(callbackDate) || "—"}
            </p>
          ) : (
            <input
              type="datetime-local"
              value={callbackDate}
              min={minCallbackDateTime || undefined}
              required={callbackRequired}
              aria-required={callbackRequired || undefined}
              onChange={(e) => onCallbackDateChange?.(e.target.value)}
              className={`h-[36px] w-full rounded-[6px] border bg-white px-3 text-[12px] text-[#111827] outline-none focus:ring-2 ${
                errors.callbackDate
                  ? "border-red-500 focus:border-red-500 focus:ring-red-500/10"
                  : "border-[#CBD5E1] focus:border-[#0097B2] focus:ring-[#0097B2]/10"
              }`}
            />
          )}

          {errors.callbackDate && (
            <p className="mt-[5px] text-[11px] font-medium text-red-500">
              {errors.callbackDate}
            </p>
          )}
        </div>

        <div>
          <label className="mb-[6px] block text-[11px] font-semibold text-[#475569]">
            Attachment
          </label>

          {readOnly ? (
            existingAttachmentUrl ? (
              <a
                href={existingAttachmentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-[36px] items-center text-[11px] font-semibold text-[#0097B2] underline"
              >
                View attachment
              </a>
            ) : (
              <p className="h-[36px] text-[12px] text-[#94A3B8]">—</p>
            )
          ) : (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.doc,.docx,.jpg,.jpeg,.png"
                className="sr-only"
                tabIndex={-1}
                onChange={(e) => {
                  const file = e.target.files?.[0] || null;
                  onAttachmentChange?.(file);
                  e.target.value = "";
                }}
              />

              <div
                className={`flex h-[36px] min-w-0 items-center gap-2 rounded-[6px] border bg-white px-1 ${
                  errors.attachment ? "border-red-500" : "border-[#CBD5E1]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex h-[28px] shrink-0 items-center justify-center rounded-[4px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-[11px] font-medium text-[#334155] hover:bg-[#F1F5F9]"
                >
                  Choose file
                </button>

                <span
                  className="min-w-0 flex-1 truncate text-[11px] text-[#64748B]"
                  title={attachment?.name || ""}
                >
                  {attachment?.name || "No file chosen"}
                </span>
              </div>

              {!attachment && existingAttachmentUrl && (
                <a
                  href={existingAttachmentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-[5px] inline-block text-[10px] font-semibold text-[#0097B2] underline"
                >
                  Current attachment
                </a>
              )}

              {errors.attachment && (
                <p className="mt-[5px] text-[11px] font-medium text-red-500">
                  {errors.attachment}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
