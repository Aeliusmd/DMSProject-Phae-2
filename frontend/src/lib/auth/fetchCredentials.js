import { getTimezoneRequestHeaders } from "@/lib/utils/timezoneUtils";

export const CREDENTIALS_INCLUDE = { credentials: "include" };

export function withCredentials(options = {}) {
  const ngrokHeaders = { "ngrok-skip-browser-warning": "true" };

  return {
    ...options,
    credentials: "include",
    headers: getTimezoneRequestHeaders({
      ...ngrokHeaders,
      ...(options?.headers || {}),
    }),
  };
}
