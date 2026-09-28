import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  getBlockedRouteRedirect,
  isPortalRouteBlocked,
} from "@/lib/portalNavigationVisibility";

function continueRequest(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("ngrok-skip-browser-warning", "true");

  return NextResponse.next({
    request: { headers: requestHeaders },
  });
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!isPortalRouteBlocked(pathname)) {
    return continueRequest(request);
  }

  return NextResponse.redirect(
    new URL(getBlockedRouteRedirect(pathname), request.url)
  );
}

export const config = {
  matcher: [
    "/landingpage",
    "/landingpage/:path*",
    "/company-portal",
    "/company-portal/:path*",
    "/personalrequest",
    "/personalrequest/:path*",
    "/Subpoenaupload",
    "/Subpoenaupload/:path*",
    "/company-orders",
    "/company-orders/:path*",
    "/personal-orders",
    "/personal-orders/:path*",
    "/orders/unprocessed",
    "/orders/unprocessed/:path*",
    "/api/:path*",
    "/uploads/:path*",
  ],
};
