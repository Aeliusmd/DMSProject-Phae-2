import { request, authFetch, ApiRequestError } from "@/lib/auth/authApi";
import {
  assertOpenableDocumentBlob,
  getDocumentOpenErrorMessage,
  readFileResponseErrorMessage,
} from "@/lib/utils/documentOpenErrors";

async function fetchPdfBlob(path, documentLabel) {
  const response = await authFetch(path);

  if (!response.ok) {
    const rawMessage = await readFileResponseErrorMessage(
      response,
      `Unable to open this ${documentLabel}.`
    );
    throw new ApiRequestError(
      getDocumentOpenErrorMessage(
        new ApiRequestError(rawMessage, response.status),
        documentLabel
      ),
      response.status
    );
  }

  const blob = await response.blob();
  return assertOpenableDocumentBlob(blob, documentLabel);
}

function buildOrdersQuery(filters = {}) {
  const params = new URLSearchParams();

  if (filters.facility) params.set("facility", filters.facility);
  if (filters.company) params.set("company", filters.company);
  if (filters.year) params.set("year", filters.year);
  if (filters.period) params.set("period", filters.period);
  if (filters.status) params.set("status", filters.status);
  if (filters.rushLevel) params.set("rushLevel", filters.rushLevel);
  if (filters.creationSource) params.set("creationSource", filters.creationSource);
  if (filters.portalStatus) params.set("portalStatus", filters.portalStatus);
  if (filters.excludeCompleted) params.set("excludeCompleted", "1");
  if (filters.sortDir) params.set("sortDir", filters.sortDir);
  if (filters.search?.trim()) params.set("search", filters.search.trim());
  if (filters.createdFrom) params.set("createdFrom", filters.createdFrom);
  if (filters.createdTo) params.set("createdTo", filters.createdTo);
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.page) params.set("page", String(filters.page));
  if (filters.pageSize) params.set("pageSize", String(filters.pageSize));
  if (filters.cursor) params.set("cursor", String(filters.cursor));
  if (filters.pagination) params.set("pagination", String(filters.pagination));
  if (filters.creationSource) {
    params.set("creationSource", String(filters.creationSource));
  }

  const queryString = params.toString();
  return queryString ? `?${queryString}` : "";
}

const FILE_FIELDS = ["subpoenaFile", "additionalDocumentFile"];

function isFileLike(value) {
  return (
    (typeof File !== "undefined" && value instanceof File) ||
    (typeof Blob !== "undefined" && value instanceof Blob)
  );
}

function buildOrderFormData(payload = {}) {
  const formData = new FormData();

  Object.entries(payload).forEach(([key, value]) => {
    if (FILE_FIELDS.includes(key)) return;
    if (value === undefined || value === null) return;
    if (typeof value === "boolean") {
      formData.append(key, String(value));
      return;
    }
    // Skip arrays/objects (e.g. the documents list returned in edit mode).
    if (typeof value === "object") return;

    formData.append(key, value);
  });

  FILE_FIELDS.forEach((field) => {
    const file = payload[field];
    if (!isFileLike(file)) return;
    // Extract already has the PDF; sending it again would write a unused copy.
    if (field === "subpoenaFile" && `${payload.subpoenaExtractId || ""}`.trim()) {
      return;
    }
    formData.append(field, file);
  });

  return formData;
}

export async function getOrders(filters = {}) {
  const data = await request(`/orders${buildOrdersQuery(filters)}`, {
    auth: true,
    cache: "no-store",
  });

  return data?.data?.orders || [];
}

export async function getOrdersPaginated(filters = {}) {
  const data = await request(`/orders${buildOrdersQuery(filters)}`, {
    auth: true,
    cache: "no-store",
  });

  return {
    orders: data?.data?.orders || [],
    pagination: data?.data?.pagination || {
      pageSize: Number(filters.pageSize) || 10,
      hasMore: false,
      nextCursor: null,
    },
  };
}

export async function getOrderFilterCompanies() {
  const data = await request("/orders/companies", { auth: true });
  return data?.data?.companies || [];
}

export async function searchOrderDoctors(query, { facility = "" } = {}) {
  const params = new URLSearchParams();
  params.set("q", query);
  if (facility) params.set("facility", String(facility));

  const data = await request(`/orders/doctors/search?${params.toString()}`, {
    auth: true,
  });

  return data?.data?.doctors || [];
}

export async function searchOrderDoctorAddresses(query) {
  const params = new URLSearchParams();
  params.set("q", query);

  const data = await request(`/orders/doctor-addresses/search?${params.toString()}`, {
    auth: true,
  });

  return data?.data?.addresses || [];
}

export async function getOrderStats() {
  const data = await request("/orders/stats", { auth: true });
  return data?.data?.stats || null;
}

export async function getOrder(id) {
  const data = await request(`/orders/${id}`, { auth: true });
  return data?.data?.order || null;
}

export async function createOrder(payload) {
  const data = await request("/orders", {
    method: "POST",
    auth: true,
    body: buildOrderFormData(payload),
  });

  return data?.data?.order || data?.data?.orders?.[0] || null;
}

export async function updateOrder(id, payload) {
  const data = await request(`/orders/${id}`, {
    method: "PUT",
    auth: true,
    body: buildOrderFormData(payload),
  });

  return data?.data?.order;
}

export async function updateOrderFacility(id, { facilityId, facilityName = "" } = {}) {
  const data = await request(`/orders/${id}/facility`, {
    method: "PATCH",
    auth: true,
    body: {
      facility: facilityId,
      facilityName,
    },
  });

  return data?.data?.order;
}

export async function deleteOrderAdditionalDocument(orderId, documentId) {
  const data = await request(`/orders/${orderId}/documents/${documentId}`, {
    method: "DELETE",
    auth: true,
  });
  return data?.data?.order;
}

export async function removeOrderSubpoena(orderId) {
  const data = await request(`/orders/${orderId}/subpoena`, {
    method: "DELETE",
    auth: true,
  });
  return data?.data?.order;
}

export async function deleteOrder(id, { reason } = {}) {
  await request(`/orders/${id}`, {
    method: "DELETE",
    auth: true,
    body: { reason },
  });
}

export async function cancelOrder(id, { reason }) {
  const data = await request(`/orders/${id}/cancel`, {
    method: "POST",
    auth: true,
    body: { reason },
  });

  return data?.data?.order;
}

export async function restoreOrder(id) {
  const data = await request(`/orders/${id}/restore`, {
    method: "POST",
    auth: true,
  });

  return data?.data?.order;
}

export async function getOrderReminders(scope = "my") {
  const data = await request(`/orders/reminders?scope=${scope}`, {
    auth: true,
  });
  return data?.data?.reminders || [];
}

export async function getDueRemindersToday() {
  const data = await request("/orders/reminders/due-today", { auth: true });
  return {
    reminders: data?.data?.reminders || [],
    enabled: data?.data?.enabled !== false,
  };
}

export async function getOrderNotes(id, { includeCalled = false, noteId = null } = {}) {
  const params = new URLSearchParams();
  if (includeCalled) params.set("includeCalled", "1");
  if (noteId) params.set("noteId", String(noteId));
  const query = params.toString() ? `?${params.toString()}` : "";
  const data = await request(`/orders/${id}/notes${query}`, { auth: true });
  return data?.data?.notes || [];
}

export async function getOrderNotesPaginated(
  id,
  {
    includeCalled = false,
    cursor = null,
    pageSize = 10,
    fromDate = "",
    toDate = "",
  } = {}
) {
  const params = new URLSearchParams();
  if (includeCalled) params.set("includeCalled", "1");
  if (cursor) params.set("cursor", String(cursor));
  params.set("pagination", "keyset");
  params.set("pageSize", String(pageSize));
  if (fromDate) params.set("fromDate", fromDate);
  if (toDate) params.set("toDate", toDate);

  const query = params.toString() ? `?${params.toString()}` : "";
  const data = await request(`/orders/${id}/notes${query}`, { auth: true });

  return {
    notes: data?.data?.notes || [],
    pagination: data?.data?.pagination || {
      type: "keyset",
      pageSize: Number(pageSize) || 10,
      hasMore: false,
      nextCursor: null,
    },
  };
}

export async function createOrderNote(
  id,
  { note, callbackDate, attachment, taggedEmployeeIds = [] }
) {
  const formData = new FormData();
  formData.append("note", note ?? "");

  if (callbackDate) {
    formData.append("callbackDate", callbackDate);
  }

  if (attachment) {
    formData.append("attachment", attachment);
  }

  if (Array.isArray(taggedEmployeeIds) && taggedEmployeeIds.length > 0) {
    formData.append("taggedEmployeeIds", JSON.stringify(taggedEmployeeIds));
  }

  const data = await request(`/orders/${id}/notes`, {
    method: "POST",
    auth: true,
    body: formData,
  });

  return data?.data?.notes || [];
}

export async function updateOrderNote(
  orderId,
  noteId,
  { note, callbackDate, attachment, markCalled = false } = {}
) {
  const formData = new FormData();
  formData.append("note", note ?? "");

  if (callbackDate) {
    formData.append("callbackDate", callbackDate);
  }

  if (markCalled) {
    formData.append("markCalled", "true");
  }

  if (attachment) {
    formData.append("attachment", attachment);
  }

  const data = await request(`/orders/${orderId}/notes/${noteId}`, {
    method: "PUT",
    auth: true,
    body: formData,
  });

  return data?.data || { notes: [], activityLogs: [] };
}

export async function getOrderActivityLogs(id) {
  const data = await request(`/orders/${id}/activity-logs`, { auth: true });
  return data?.data?.logs || [];
}

export async function getOrderActivityLogsPaginated(
  id,
  { cursor = null, pageSize = 10, search = "" } = {}
) {
  const params = new URLSearchParams();
  params.set("pagination", "keyset");
  params.set("pageSize", String(pageSize));
  if (cursor) params.set("cursor", String(cursor));
  if (search?.trim()) params.set("search", search.trim());

  const data = await request(`/orders/${id}/activity-logs?${params.toString()}`, {
    auth: true,
  });

  return {
    logs: data?.data?.logs || [],
    pagination: data?.data?.pagination || {
      type: "keyset",
      pageSize: Number(pageSize) || 10,
      hasMore: false,
      nextCursor: null,
    },
  };
}

export async function uploadBatchScan(file, { chosenFacilityId } = {}) {
  const formData = new FormData();
  formData.append("file", file);
  if (chosenFacilityId) {
    formData.append("chosenFacilityId", String(chosenFacilityId));
  }

  const data = await request("/orders/batch-scan", {
    method: "POST",
    auth: true,
    body: formData,
  });

  return data?.data || null;
}

export async function uploadMedicalRecordsScan(
  orderId,
  files,
  { recordType = "medical" } = {}
) {
  const formData = new FormData();
  const fileList = (Array.isArray(files) ? files : [files]).filter(Boolean);

  for (const file of fileList) {
    formData.append("file", file);
  }

  const params = new URLSearchParams();
  if (recordType) params.set("recordType", recordType);
  const query = params.toString() ? `?${params.toString()}` : "";

  const data = await request(`/orders/${orderId}/scan-medical-records${query}`, {
    method: "POST",
    auth: true,
    body: formData,
  });

  return data?.data?.order || null;
}

export async function removeMedicalRecords(orderId, { recordType = null } = {}) {
  const params = new URLSearchParams();
  if (recordType) params.set("recordType", recordType);
  const query = params.toString() ? `?${params.toString()}` : "";

  const data = await request(`/orders/${orderId}/medical-records${query}`, {
    method: "DELETE",
    auth: true,
  });

  return data?.data?.order || null;
}

export async function uploadSingleSubpoena(file) {
  const formData = new FormData();
  formData.append("file", file);

  const data = await request("/orders/subpoena/upload", {
    method: "POST",
    auth: true,
    body: formData,
  });

  return data?.data || null;
}

export async function getUnprocessedSubpoenas() {
  const data = await request("/orders/unprocessed", { auth: true });
  return Array.isArray(data?.data) ? data.data : [];
}

export async function getUnprocessedSubpoenaById(extractId) {
  const data = await request(`/orders/unprocessed/${extractId}`, { auth: true });
  return data?.data || null;
}

export async function fetchUnprocessedSubpoenaPdf(extractId) {
  return fetchPdfBlob(
    `/orders/unprocessed/${extractId}/file`,
    "subpoena PDF"
  );
}

export async function fetchOrderSubpoenaPdf(orderId) {
  return fetchPdfBlob(`/orders/${orderId}/subpoena/file`, "subpoena PDF");
}

export async function fetchOrderMedicalRecordsPdf(
  orderId,
  { recordType = "medical", recordId = null } = {}
) {
  const params = new URLSearchParams();
  if (recordType) params.set("recordType", recordType);
  if (recordId) params.set("recordId", String(recordId));
  const query = params.toString() ? `?${params.toString()}` : "";
  return fetchPdfBlob(
    `/orders/${orderId}/medical-records/file${query}`,
    "medical records PDF"
  );
}

export async function fetchOrderPrintInvoicePdf(orderId) {
  return fetchPdfBlob(`/orders/${orderId}/invoice/print`, "invoice PDF");
}

export async function fetchOrderPrintXrayInvoicePdf(orderId) {
  return fetchPdfBlob(
    `/orders/${orderId}/invoice/xray/print`,
    "X-Ray invoice PDF"
  );
}

export async function mailCompletedOrder(orderId, payload = {}) {
  const body = {};

  if (Array.isArray(payload.emails) && payload.emails.length) {
    body.emails = payload.emails;
  } else if (payload.email) {
    body.email = payload.email;
    if (Array.isArray(payload.additionalEmails) && payload.additionalEmails.length) {
      body.additionalEmails = payload.additionalEmails;
    }
  }

  if (payload.deliveryDate) {
    body.deliveryDate = payload.deliveryDate;
  }

  const data = await request(`/orders/${orderId}/mail`, {
    method: "POST",
    auth: true,
    body,
  });

  return data?.data || {};
}

export async function sendCopyServiceLetter(orderId, payload = {}) {
  const data = await request(`/orders/${orderId}/send-copy-letter`, {
    method: "POST",
    auth: true,
    body: payload,
  });

  return data?.data || {};
}

export async function sendCertificateOfRecords(orderId, payload = {}) {
  const body = {};

  if (Array.isArray(payload.emails) && payload.emails.length) {
    body.emails = payload.emails;
  } else if (payload.email) {
    body.email = payload.email;
    if (Array.isArray(payload.additionalEmails) && payload.additionalEmails.length) {
      body.additionalEmails = payload.additionalEmails;
    }
  }

  if (payload.sentDate) {
    body.sentDate = payload.sentDate;
  }

  const data = await request(`/orders/${orderId}/send-certificate-of-records`, {
    method: "POST",
    auth: true,
    body,
  });

  return data?.data || {};
}

export async function sendCnrRecord(orderId, payload = {}) {
  const body = {};

  if (Array.isArray(payload.emails) && payload.emails.length) {
    body.emails = payload.emails;
  } else if (payload.email) {
    body.email = payload.email;
    if (Array.isArray(payload.additionalEmails) && payload.additionalEmails.length) {
      body.additionalEmails = payload.additionalEmails;
    }
  }

  if (payload.sentDate) {
    body.sentDate = payload.sentDate;
  }

  const data = await request(`/orders/${orderId}/send-cnr-record`, {
    method: "POST",
    auth: true,
    body,
  });

  return data?.data || {};
}

export async function recordOrderPickup(orderId, payload = {}) {
  const data = await request(`/orders/${orderId}/pickup`, {
    method: "POST",
    auth: true,
    body: payload,
  });

  return data?.data || {};
}

export async function recordOrderFax(orderId, payload = {}) {
  const data = await request(`/orders/${orderId}/fax`, {
    method: "POST",
    auth: true,
    body: payload,
  });

  return data?.data || {};
}

export async function getCompanyOrderStats() {
  const data = await request("/company-orders/stats", {
    auth: true,
    cache: "no-store",
  });
  return (
    data?.data || {
      totalOrders: 0,
      inProcess: 0,
      invoice: 0,
      paid: 0,
      released: 0,
    }
  );
}

export async function updateCompanyOrderStage(orderId, status) {
  const data = await request(`/company-orders/${orderId}/stage`, {
    method: "PATCH",
    auth: true,
    body: { status },
  });
  return data?.data || {};
}

export async function emailCompanyOrderRecords(orderId, payload = {}) {
  const data = await request(`/company-orders/${orderId}/email-records`, {
    method: "POST",
    auth: true,
    body: payload,
  });
  return data?.data || {};
}

export async function getCompanyOrderNewFacility(orderId) {
  const data = await request(`/company-orders/${orderId}/new-facility`, {
    auth: true,
    cache: "no-store",
  });
  return data?.data || {};
}

export async function linkCompanyOrderFacility(orderId, facilityId) {
  const data = await request(`/company-orders/${orderId}/link-facility`, {
    method: "POST",
    auth: true,
    body: { facilityId },
  });
  return data?.data || {};
}

export async function markCompanyOrderNoFacility(orderId) {
  const data = await request(`/company-orders/${orderId}/no-facility`, {
    method: "POST",
    auth: true,
  });
  return data?.data || {};
}

export async function restoreCompanyOrderInProcess(orderId) {
  const data = await request(`/company-orders/${orderId}/restore-in-process`, {
    method: "POST",
    auth: true,
  });
  return data?.data || {};
}

export async function getPersonalOrderNewFacility(orderId) {
  const data = await request(`/personal-orders/${orderId}/new-facility`, {
    auth: true,
    cache: "no-store",
  });
  return data?.data || {};
}

export async function linkPersonalOrderFacility(orderId, facilityId) {
  const data = await request(`/personal-orders/${orderId}/link-facility`, {
    method: "POST",
    auth: true,
    body: { facilityId },
  });
  return data?.data || {};
}

export async function markPersonalOrderNoFacility(orderId) {
  const data = await request(`/personal-orders/${orderId}/no-facility`, {
    method: "POST",
    auth: true,
  });
  return data?.data || {};
}

export async function restorePersonalOrderInProcess(orderId) {
  const data = await request(`/personal-orders/${orderId}/restore-in-process`, {
    method: "POST",
    auth: true,
  });
  return data?.data || {};
}
