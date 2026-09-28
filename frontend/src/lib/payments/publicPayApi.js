import { API_BASE_URL } from "@/config/api";
import { ApiRequestError } from "@/lib/auth/authApi";
import { isNetworkError, NETWORK_UNAVAILABLE_MESSAGE } from "@/lib/networkErrors";

async function safeFetch(url, options) {
  try {
    const headers = {
      "ngrok-skip-browser-warning": "true",
      ...(options?.headers || {}),
    };

    return await fetch(url, { ...options, headers });
  } catch (error) {
    if (isNetworkError(error)) {
      throw new ApiRequestError(NETWORK_UNAVAILABLE_MESSAGE, 0);
    }
    throw error;
  }
}

async function parseResponse(response) {
  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new ApiRequestError(
      body?.message || "Request failed",
      response.status,
      body?.errors || null
    );
  }

  return body?.data ?? body;
}

export async function fetchPaymentPage(token) {
  const response = await safeFetch(
    `${API_BASE_URL}/public/pay/${encodeURIComponent(token)}`,
    { cache: "no-store" }
  );
  return parseResponse(response);
}

export async function startCheckout(token, invoiceType) {
  const response = await safeFetch(
    `${API_BASE_URL}/public/pay/${encodeURIComponent(token)}/checkout`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invoiceType }),
    }
  );
  return parseResponse(response);
}

export async function fetchCheckoutResult(token, sessionId) {
  const params = new URLSearchParams();
  params.set("session_id", sessionId);

  const response = await safeFetch(
    `${API_BASE_URL}/public/pay/${encodeURIComponent(token)}/result?${params.toString()}`,
    { cache: "no-store" }
  );
  return parseResponse(response);
}

export function getReceiptDownloadUrl(sessionId, token) {
  const params = new URLSearchParams();
  params.set("token", token);
  return `${API_BASE_URL}/public/pay/receipt/${encodeURIComponent(sessionId)}?${params.toString()}`;
}
