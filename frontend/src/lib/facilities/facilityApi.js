import { request, authFetch, ApiRequestError } from "@/lib/auth/authApi";
import {
  assertOpenableDocumentBlob,
  getDocumentOpenErrorMessage,
  readFileResponseErrorMessage,
} from "@/lib/utils/documentOpenErrors";

export { ApiRequestError };

function buildFacilitiesQuery(filters = {}) {
  const params = new URLSearchParams();
  if (filters.search?.trim()) params.set("search", filters.search.trim());
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.pageSize) params.set("pageSize", String(filters.pageSize));
  if (filters.cursor) params.set("cursor", String(filters.cursor));
  if (filters.pagination) params.set("pagination", String(filters.pagination));
  if (filters.sortDir === "asc" || filters.sortDir === "desc") {
    params.set("sortDir", filters.sortDir);
  }
  const queryString = params.toString();
  return queryString ? `?${queryString}` : "";
}

export async function getFacilities(filters = {}) {
  const data = await request(`/facilities${buildFacilitiesQuery(filters)}`, {
    auth: true,
  });
  return data?.data?.facilities || [];
}

export async function getFacilitiesPaginated(filters = {}) {
  const data = await request(`/facilities${buildFacilitiesQuery(filters)}`, {
    auth: true,
  });

  return {
    facilities: data?.data?.facilities || [],
    pagination: data?.data?.pagination || {
      pageSize: Number(filters.pageSize) || 10,
      hasMore: false,
      nextCursor: null,
    },
  };
}

export async function searchFacilities(query) {
  const params = new URLSearchParams();
  params.set("q", query);

  const data = await request(`/facilities/search?${params.toString()}`, {
    auth: true,
  });

  return data?.data?.facilities || [];
}

export async function resolveFacility(payload = {}) {
  const data = await request("/facilities/resolve", {
    method: "POST",
    auth: true,
    body: payload,
  });

  return {
    facility: data?.data?.facility || null,
    created: Boolean(data?.data?.created),
    reactivated: Boolean(data?.data?.reactivated),
  };
}

export async function resolveFacilityDoctor(facilityId, payload = {}) {
  const data = await request(`/facilities/${facilityId}/doctors/resolve`, {
    method: "POST",
    auth: true,
    body: payload,
  });

  return {
    doctor: data?.data?.doctor || null,
    doctorName: data?.data?.doctorName || "",
    created: Boolean(data?.data?.created),
    usedDefault: Boolean(data?.data?.usedDefault),
    missingDefault: Boolean(data?.data?.missingDefault),
    doctorMissing: Boolean(data?.data?.doctorMissing),
  };
}

export async function getFacility(id) {
  const data = await request(`/facilities/${id}`, { auth: true });
  return data?.data?.facility || null;
}

export async function createFacility(payload) {
  const data = await request("/facilities", {
    method: "POST",
    auth: true,
    body: payload,
  });

  return data?.data?.facility;
}

export async function updateFacility(id, payload) {
  const data = await request(`/facilities/${id}`, {
    method: "PUT",
    auth: true,
    body: payload,
  });

  return data?.data?.facility;
}

export async function deleteFacility(id) {
  await request(`/facilities/${id}`, {
    method: "DELETE",
    auth: true,
  });
}

export async function createDoctors(facilityId, doctors) {
  const data = await request(`/facilities/${facilityId}/doctors`, {
    method: "POST",
    auth: true,
    body: { doctors },
  });

  return data?.data?.doctors || [];
}

export async function updateDoctor(facilityId, doctorId, doctor) {
  const data = await request(`/facilities/${facilityId}/doctors/${doctorId}`, {
    method: "PUT",
    auth: true,
    body: doctor,
  });

  return data?.data?.doctor;
}

export async function deactivateDoctor(facilityId, doctorId) {
  const data = await request(
    `/facilities/${facilityId}/doctors/${doctorId}/deactivate`,
    {
      method: "PATCH",
      auth: true,
    }
  );

  return data?.data?.doctor;
}

export async function reactivateDoctor(facilityId, doctorId) {
  const data = await request(
    `/facilities/${facilityId}/doctors/${doctorId}/reactivate`,
    {
      method: "PATCH",
      auth: true,
    }
  );

  return data?.data?.doctor;
}

export async function setDefaultDoctor(facilityId, doctorId) {
  const data = await request(
    `/facilities/${facilityId}/doctors/${doctorId}/default`,
    {
      method: "PATCH",
      auth: true,
    }
  );

  return data?.data?.doctor;
}

export async function getFacilityDocuments(facilityId) {
  const data = await request(`/facilities/${facilityId}/documents`, {
    auth: true,
  });

  return data?.data?.documents || [];
}

export async function uploadFacilityDocument(facilityId, file, documentType) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("documentType", documentType);

  const response = await authFetch(`/facilities/${facilityId}/documents`, {
    method: "POST",
    body: formData,
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiRequestError(
      data?.message || "Failed to upload document",
      response.status,
      data?.errors || null
    );
  }

  return data?.data?.document;
}

async function fetchFacilityDocumentBlob(
  facilityId,
  documentId,
  action = "preview"
) {
  const response = await authFetch(
    `/facilities/${facilityId}/documents/${documentId}/${action}`
  );

  if (!response.ok) {
    const rawMessage = await readFileResponseErrorMessage(
      response,
      "Unable to open this document."
    );
    throw new ApiRequestError(
      getDocumentOpenErrorMessage(
        new ApiRequestError(rawMessage, response.status),
        "document"
      ),
      response.status
    );
  }

  const blob = await response.blob();
  return assertOpenableDocumentBlob(blob, "document");
}

export async function getFacilityDocumentPreviewBlob(facilityId, documentId) {
  return fetchFacilityDocumentBlob(facilityId, documentId, "preview");
}

export async function downloadFacilityDocument(
  facilityId,
  documentId,
  fileName
) {
  const blob = await fetchFacilityDocumentBlob(
    facilityId,
    documentId,
    "download"
  );

  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = fileName || "document";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

export async function deleteFacilityDocument(facilityId, documentId) {
  await request(`/facilities/${facilityId}/documents/${documentId}`, {
    method: "DELETE",
    auth: true,
  });
}

export async function getFacilityNotes(facilityId) {
  const data = await request(`/facilities/${facilityId}/notes`, { auth: true });
  return data?.data?.notes || [];
}

export async function createFacilityNote(facilityId, { note, attachments = [] } = {}) {
  const formData = new FormData();
  formData.append("note", note ?? "");

  attachments.forEach((file) => {
    formData.append("attachments", file);
  });

  const data = await request(`/facilities/${facilityId}/notes`, {
    method: "POST",
    auth: true,
    body: formData,
  });

  return data?.data?.note;
}

export async function downloadFacilityNoteAttachment(
  facilityId,
  downloadPath,
  fileName
) {
  const normalizedPath = `${downloadPath || ""}`.replace(/^\/+/, "");
  const response = await authFetch(`/${normalizedPath}`);

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new ApiRequestError(
      data?.message || "Failed to download attachment",
      response.status
    );
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = fileName || "attachment";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}
