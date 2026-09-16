"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Sidebar from "@/components/layout/Sidebar";
import Topbar from "@/components/layout/Topbar";
import ImpersonationBanner from "@/components/layout/ImpersonationBanner";
import DailyReminderPopup from "@/components/notifications/DailyReminderPopup";
import {
  clearPendingOrderListFilterRestores,
  shouldKeepPendingOrderListFilterRestore,
} from "@/lib/orders/orderListFilterStorage";

const MOBILE_QUERY = "(max-width: 767px)";

/**
 * @param {{ children: import("react").ReactNode, lockScroll?: boolean }} props
 * lockScroll: New/Edit Order — only card panels scroll, never the page.
 */
export default function DashboardShell({ children, lockScroll = false }) {
  const pathname = usePathname();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    if (!shouldKeepPendingOrderListFilterRestore(pathname)) {
      clearPendingOrderListFilterRestores();
    }
  }, [pathname]);

  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY);

    const apply = () => {
      const mobile = media.matches;
      setIsMobile(mobile);
      if (mobile) {
        setIsSidebarCollapsed(true);
      }
    };

    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (!isMobile || isSidebarCollapsed) return undefined;

    const onKeyDown = (event) => {
      if (event.key === "Escape") setIsSidebarCollapsed(true);
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMobile, isSidebarCollapsed]);

  const closeMobileSidebar = () => {
    if (isMobile) setIsSidebarCollapsed(true);
  };

  const contentPadClass = isMobile
    ? "pl-0"
    : isSidebarCollapsed
      ? "pl-[72px]"
      : "pl-[190px]";

  return (
    <div
      className="fixed inset-0 z-0 overflow-hidden text-[#111827]"
      style={{ background: "#F8FAFC" }}
    >
      <DailyReminderPopup />

      {isMobile && !isSidebarCollapsed ? (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-30 bg-black/40 md:hidden"
          onClick={closeMobileSidebar}
        />
      ) : null}

      <Sidebar
        isCollapsed={isSidebarCollapsed}
        isMobile={isMobile}
        onNavigate={closeMobileSidebar}
      />

      <div
        className={`flex h-full min-w-0 flex-col overflow-hidden transition-all duration-300 ${contentPadClass}`}
      >
        <Topbar
          onToggleSidebar={() => setIsSidebarCollapsed((prev) => !prev)}
          sidebarExpanded={!isSidebarCollapsed}
        />
        <ImpersonationBanner />

        <main
          className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-4 sm:px-5 lg:px-6"
          style={{ background: "#F8FAFC" }}
        >
          <div
            className={`mx-auto flex min-h-0 w-full max-w-[1600px] flex-1 flex-col ${
              lockScroll
                ? "overflow-hidden"
                : "overflow-x-hidden overflow-y-auto [&>*]:shrink-0"
            }`}
            style={{ background: "#F8FAFC" }}
          >
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
