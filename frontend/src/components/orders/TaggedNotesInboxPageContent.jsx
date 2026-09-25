"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  getTaggedNotesInbox,
  markAllTaggedNotesAsRead,
  markTaggedNoteAsRead,
} from "@/lib/orders/orderNoteTagApi";
import { getApiErrorMessage } from "@/lib/apiErrorUtils";
import { useDataRefresh } from "@/lib/liveRefresh/useDataRefresh";

export default function TaggedNotesInboxPageContent() {
  const [notes, setNotes] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [markingAll, setMarkingAll] = useState(false);

  const loadInbox = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true);
      setError("");
    }
    try {
      const data = await getTaggedNotesInbox({ limit: 100, offset: 0 });
      setNotes(data.notes);
      setUnreadCount(data.unreadCount);
    } catch (err) {
      if (!silent) {
        setNotes([]);
        setUnreadCount(0);
        setError(getApiErrorMessage(err, "Failed to load tagged notes"));
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInbox();
  }, [loadInbox]);

  useDataRefresh(() => loadInbox({ silent: true }), {
    paused: markingAll,
  });

  const handleMarkRead = async (tagId) => {
    const target = notes.find((item) => item.tagId === tagId);
    if (!target || target.isRead) return;

    try {
      const nextUnread = await markTaggedNoteAsRead(tagId);
      setUnreadCount(nextUnread);
      setNotes((prev) =>
        prev.map((item) =>
          item.tagId === tagId ? { ...item, isRead: true } : item
        )
      );
    } catch {
      setError("Failed to mark note as read");
    }
  };

  const handleMarkAllRead = async () => {
    setMarkingAll(true);
    try {
      const nextUnread = await markAllTaggedNotesAsRead();
      setUnreadCount(nextUnread);
      setNotes((prev) => prev.map((item) => ({ ...item, isRead: true })));
    } catch {
      setError("Failed to mark all notes as read");
    } finally {
      setMarkingAll(false);
    }
  };

  return (
    <div className="flex min-h-[calc(100vh-92px)] min-w-0 flex-col gap-5 overflow-hidden">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-[18px] font-semibold text-[#111827]">
            Tagged Notes
          </h1>
          <p className="mt-1 text-[12px] text-[#64748B]">
            {loading
              ? "Loading tagged notes..."
              : unreadCount > 0
                ? `${unreadCount} unseen tagged note${unreadCount === 1 ? "" : "s"}`
                : "All tagged notes are seen"}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleMarkAllRead}
            disabled={markingAll || unreadCount === 0}
            className="inline-flex h-[34px] items-center justify-center rounded-[6px] border border-[#E2E8F0] bg-white px-3 text-[12px] font-semibold text-[#334155] hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {markingAll ? "Updating..." : "Mark all as seen"}
          </button>
        </div>
      </div>

      {error ? (
        <p className="rounded-[6px] border border-[#FEE2E2] bg-[#FEF2F2] px-3 py-2 text-[11px] font-medium text-red-600">
          {error}
        </p>
      ) : null}

      <section className="min-h-0 flex-1 overflow-hidden rounded-[10px] border border-[#E2E8F0] bg-white">
        <div className="max-h-[calc(100vh-220px)] overflow-y-auto">
          {loading ? (
            <p className="px-5 py-8 text-[12px] text-[#64748B]">Loading...</p>
          ) : notes.length === 0 ? (
            <p className="px-5 py-8 text-[12px] text-[#64748B]">
              No tagged notes yet.
            </p>
          ) : (
            <ul className="divide-y divide-[#F1F5F9]">
              {notes.map((item) => (
                <li
                  key={item.tagId}
                  className={`px-5 py-4 ${item.isRead ? "bg-white" : "bg-[#F0F9FF]"}`}
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {!item.isRead ? (
                          <span className="rounded-full bg-[#0369A1] px-2 py-0.5 text-[10px] font-semibold text-white">
                            Unseen
                          </span>
                        ) : (
                          <span className="rounded-full bg-[#E2E8F0] px-2 py-0.5 text-[10px] font-semibold text-[#64748B]">
                            Seen
                          </span>
                        )}
                        <Link
                          href={`/orders?highlight=${item.orderId}`}
                          className="text-[13px] font-semibold text-[#0369A1] hover:underline"
                        >
                          Order {item.orderNumber || item.orderId}
                        </Link>
                        {item.caseNumber ? (
                          <span className="text-[11px] text-[#64748B]">
                            Case {item.caseNumber}
                          </span>
                        ) : null}
                      </div>

                      <p className="mt-2 whitespace-pre-wrap text-[12px] leading-5 text-[#334155]">
                        {item.note}
                      </p>

                      <div className="mt-3 grid gap-1 text-[11px] text-[#64748B] sm:grid-cols-2">
                        <p>
                          <span className="font-semibold text-[#475569]">
                            Sent by:
                          </span>{" "}
                          {item.taggedByName || item.authorName || "—"}
                        </p>
                        <p>
                          <span className="font-semibold text-[#475569]">
                            Date & time:
                          </span>{" "}
                          {item.taggedAtDisplay || item.noteDateDisplay || "—"}
                        </p>
                        <p>
                          <span className="font-semibold text-[#475569]">
                            Applicant:
                          </span>{" "}
                          {item.applicant || "—"}
                        </p>
                      </div>
                    </div>

                    {!item.isRead ? (
                      <button
                        type="button"
                        onClick={() => handleMarkRead(item.tagId)}
                        className="inline-flex h-[30px] shrink-0 items-center justify-center rounded-[6px] border border-[#BAE6FD] bg-white px-3 text-[11px] font-semibold text-[#0369A1] hover:bg-[#E0F2FE]"
                      >
                        Mark as seen
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
