import { request } from "@/lib/auth/authApi";

export async function getTaggableStaff({ search = "" } = {}) {
  const params = new URLSearchParams();
  if (search) params.set("search", search);
  const query = params.toString();
  const data = await request(
    `/order-note-tags/taggable-staff${query ? `?${query}` : ""}`,
    { auth: true }
  );
  return data?.data?.staff || [];
}

export async function getTaggedNotesInbox({ limit = 50, offset = 0 } = {}) {
  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  const data = await request(`/order-note-tags/inbox?${params.toString()}`, {
    auth: true,
  });
  return {
    notes: data?.data?.notes || [],
    unreadCount: Number(data?.data?.unreadCount || 0),
  };
}

export async function getTaggedNotesUnreadCount() {
  const data = await request("/order-note-tags/unread-count", { auth: true });
  return Number(data?.data?.unreadCount || 0);
}

export async function markTaggedNoteAsRead(tagId) {
  const data = await request(`/order-note-tags/${tagId}/read`, {
    method: "PATCH",
    auth: true,
  });
  return Number(data?.data?.unreadCount || 0);
}

export async function markAllTaggedNotesAsRead() {
  const data = await request("/order-note-tags/read-all", {
    method: "PATCH",
    auth: true,
  });
  return Number(data?.data?.unreadCount || 0);
}
