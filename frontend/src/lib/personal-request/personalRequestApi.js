import { API_BASE_URL } from "@/config/api";
import { ApiRequestError } from "@/lib/auth/authApi";
import { isNetworkError, NETWORK_UNAVAILABLE_MESSAGE } from "@/lib/networkErrors";

async function safeFetch(url, options = {}) {
  try {
    return await fetch(url, {
      ...options,
      headers: {
        "ngrok-skip-browser-warning": "true",
        ...(options.headers || {}),
      },
    });
  } catch (error) {
    if (isNetworkError(error)) {
      throw new ApiRequestError(NETWORK_UNAVAILABLE_MESSAGE, 0);
    }
    throw error;
  }
}

async function parseResponse(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw new ApiRequestError(
      body?.message || "Request failed",
      response.status,
      body?.errors || []
    );
  }

  return body?.data ?? body;
}

export async function fetchPersonalRequestConfig() {
  const response = await safeFetch(
    `${API_BASE_URL}/public/personal-request/config`,
    { cache: "no-store" }
  );
  return parseResponse(response);
}

export async function sendPersonalRequestOtp(email) {
  const response = await safeFetch(
    `${API_BASE_URL}/public/personal-request/verify-email`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }
  );
  return parseResponse(response);
}

export async function confirmPersonalRequestOtp({ email, sessionToken, code }) {
  const response = await safeFetch(
    `${API_BASE_URL}/public/personal-request/confirm-email`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, sessionToken, code }),
    }
  );
  return parseResponse(response);
}

export async function submitPersonalRequest(formData) {
  const response = await safeFetch(
    `${API_BASE_URL}/public/personal-request/submit`,
    {
      method: "POST",
      body: formData,
    }
  );
  return parseResponse(response);
}

export async function fetchPersonalRequestResult(requestId, sessionId) {
  const params = new URLSearchParams({
    request_id: String(requestId),
    session_id: String(sessionId),
  });
  const response = await safeFetch(
    `${API_BASE_URL}/public/personal-request/result?${params}`,
    { cache: "no-store" }
  );
  return parseResponse(response);
}

export async function lookupPersonalRequestStatus(payload) {
  const response = await safeFetch(
    `${API_BASE_URL}/public/personal-request/status`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  return parseResponse(response);
}

export async function updatePersonalRequestEmail(payload) {
  const response = await safeFetch(
    `${API_BASE_URL}/public/personal-request/update-email`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  return parseResponse(response);
}

export async function searchPersonalRequestFacilities(query) {
  const params = new URLSearchParams();
  params.set("q", query);
  const response = await safeFetch(
    `${API_BASE_URL}/public/personal-request/facilities?${params.toString()}`,
    { cache: "no-store" }
  );
  const data = await parseResponse(response);
  return data?.facilities || [];
}
