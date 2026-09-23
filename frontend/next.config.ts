import type { NextConfig } from "next";

function getBackendOrigin() {
  const backendUrl =
    process.env.BACKEND_URL ||
    process.env.NEXT_PUBLIC_BACKEND_URL ||
    "http://localhost:5000";

  try {
    return new URL(backendUrl).origin;
  } catch {
    return "http://localhost:5000";
  }
}

function getPublicApiBaseUrl() {
  return process.env.NEXT_PUBLIC_API_BASE_URL || "/api";
}

function getApiOrigin() {
  const apiBase = getPublicApiBaseUrl();

  if (apiBase.startsWith("/")) {
    return getBackendOrigin();
  }

  try {
    return new URL(apiBase).origin;
  } catch {
    return getBackendOrigin();
  }
}

const STRIPE_ORIGINS = [
  "https://checkout.stripe.com",
  "https://js.stripe.com",
  "https://hooks.stripe.com",
  "https://pay.stripe.com",
  "https://api.stripe.com",
];

function buildContentSecurityPolicy(isDev: boolean) {
  const apiOrigin = getApiOrigin();
  const publicApiBase = getPublicApiBaseUrl();
  const usesSameOriginApi = publicApiBase.startsWith("/");

  const scriptSrc = ["'self'", "'unsafe-inline'"];
  if (isDev) {
    scriptSrc.push("'unsafe-eval'");
  }

  const connectSrc = usesSameOriginApi
    ? ["'self'", ...STRIPE_ORIGINS]
    : ["'self'", apiOrigin, ...STRIPE_ORIGINS];

  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    `form-action 'self' ${STRIPE_ORIGINS.join(" ")}`,
    `script-src ${scriptSrc.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' blob: data: ${apiOrigin}`,
    "font-src 'self' data:",
    `connect-src ${connectSrc.join(" ")}`,
    `frame-src 'self' blob: ${apiOrigin} ${STRIPE_ORIGINS.join(" ")}`,
    "worker-src 'self' blob:",
    `media-src 'self' blob: ${apiOrigin}`,
  ];

  if (!isDev && process.env.CSP_UPGRADE_INSECURE_REQUESTS === "true") {
    directives.push("upgrade-insecure-requests");
  }

  return directives.join("; ");
}

const isDev = process.env.NODE_ENV !== "production";
const cspHeaderName =
  process.env.CSP_REPORT_ONLY === "true"
    ? "Content-Security-Policy-Report-Only"
    : "Content-Security-Policy";
const cspValue = buildContentSecurityPolicy(isDev);

const nextConfig: NextConfig = {
  // Batch scan + subpoena extraction can take >30s; default rewrite proxy
  // timeout causes "socket hang up" before the backend responds.
  experimental: {
    proxyTimeout: 600_000,
  },
  async rewrites() {
    const backendOrigin = getBackendOrigin();

    return [
      {
        source: "/api/:path*",
        destination: `${backendOrigin}/api/:path*`,
      },
      {
        source: "/uploads/:path*",
        destination: `${backendOrigin}/uploads/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value:
              "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          { key: cspHeaderName, value: cspValue },
        ],
      },
    ];
  },
};

export default nextConfig;
