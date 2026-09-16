"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import NotificationsModal from "@/components/layout/NotificationsModal";
import { getStoredUser } from "@/lib/auth/authStorage";
import { isEmployee, isManager } from "@/lib/auth/roles";
import { getNotifications } from "@/lib/notifications/notificationsApi";
import { getTaggedNotesUnreadCount } from "@/lib/orders/orderNoteTagApi";

export default function Topbar({ onToggleSidebar, sidebarExpanded = false }) {
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [taggedUnreadCount, setTaggedUnreadCount] = useState(0);
  const notificationButtonRef = useRef(null);

  const user = getStoredUser();
  const displayName = user?.name || "User";
  const initials = getInitials(displayName);
  const showTaggedNotesMailbox = isEmployee(user) || isManager(user);

  const loadNotifications = useCallback(async () => {
    try {
      const data = await getNotifications({ limit: 8 });
      setNotifications(data.notifications);
      setUnreadCount(data.unreadCount);
    } catch {
      setNotifications([]);
      setUnreadCount(0);
    }
  }, []);

  const loadTaggedUnread = useCallback(async () => {
    if (!showTaggedNotesMailbox) {
      setTaggedUnreadCount(0);
      return;
    }

    try {
      const count = await getTaggedNotesUnreadCount();
      setTaggedUnreadCount(count);
    } catch {
      setTaggedUnreadCount(0);
    }
  }, [showTaggedNotesMailbox]);

  useEffect(() => {
    loadNotifications();
    loadTaggedUnread();

    const interval = setInterval(() => {
      loadNotifications();
      loadTaggedUnread();
    }, 60000);
    return () => clearInterval(interval);
  }, [loadNotifications, loadTaggedUnread]);

  return (
    <header className="z-30 flex min-h-[52px] shrink-0 items-center gap-2 border-b border-[#E2E8F0] bg-white px-2 py-2 sm:gap-3 sm:px-[18px]">
      <button
        type="button"
        onClick={onToggleSidebar}
        aria-label={sidebarExpanded ? "Collapse navigation" : "Open navigation"}
        aria-expanded={sidebarExpanded}
        className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[6px] text-[#0097B2] hover:bg-[#E6F7FA]"
      >
        <MenuIcon />
      </button>

      <div className="min-w-0 flex-1" />

      <div className="flex shrink-0 items-center gap-2 sm:gap-[18px]">
        <div className="relative">
          <button
            ref={notificationButtonRef}
            type="button"
            onClick={() => setIsNotificationsOpen((prev) => !prev)}
            className={`relative flex h-[30px] w-[30px] items-center justify-center rounded-[6px] hover:bg-[#F8FAFC] ${
              unreadCount > 0 ? "notification-bell-unread" : "text-[#64748B]"
            } ${
              isNotificationsOpen && unreadCount === 0
                ? "bg-[#F8FAFC] text-[#0097B2]"
                : ""
            } ${
              isNotificationsOpen && unreadCount > 0
                ? "bg-[#FFF1F2] text-[#F87171]"
                : ""
            }`}
            aria-label={
              unreadCount > 0
                ? `Open notifications, ${unreadCount} unread`
                : "Open notifications"
            }
          >
            <BellIcon />

            {unreadCount > 0 && (
              <span className="notification-bell-dot absolute right-[7px] top-[6px] h-[6px] w-[6px] rounded-full" />
            )}
          </button>

          <NotificationsModal
            open={isNotificationsOpen}
            notifications={notifications}
            unreadCount={unreadCount}
            triggerRef={notificationButtonRef}
            onClose={() => setIsNotificationsOpen(false)}
            onRefresh={loadNotifications}
          />
        </div>

        {showTaggedNotesMailbox ? (
          <Link
            href="/tagged-notes"
            className={`relative flex h-[30px] w-[30px] items-center justify-center rounded-[6px] hover:bg-[#F8FAFC] ${
              taggedUnreadCount > 0 ? "text-[#0369A1]" : "text-[#64748B]"
            }`}
            aria-label={
              taggedUnreadCount > 0
                ? `Open tagged notes, ${taggedUnreadCount} unseen`
                : "Open tagged notes"
            }
            title="Tagged notes"
          >
            <MailboxIcon />
            {taggedUnreadCount > 0 ? (
              <span className="absolute -right-1 -top-1 inline-flex min-h-[16px] min-w-[16px] items-center justify-center rounded-full bg-[#DC2626] px-1 text-[9px] font-bold leading-none text-white">
                {taggedUnreadCount > 99 ? "99+" : taggedUnreadCount}
              </span>
            ) : null}
          </Link>
        ) : null}

        <button
          type="button"
          className="flex shrink-0 items-center gap-[7px] rounded-[6px] px-1 py-1 hover:bg-[#F8FAFC] sm:gap-[9px]"
        >
          <div className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-[#BDECF3] text-[11px] font-medium text-[#007F96]">
            {initials}
          </div>

          <p className="hidden text-[13px] font-medium text-[#111827] sm:block">
            {displayName}
          </p>
        </button>
      </div>
    </header>
  );
}

function getInitials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return "U";
  }

  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }

  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

function MenuIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 7h16M4 12h16M4 17h16"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
      <path
        d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 7h18s-3 0-3-7Z"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M10 19a2 2 0 0 0 4 0"
        stroke="currentColor"
        strokeWidth="1.7"
      />
    </svg>
  );
}

function MailboxIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 8.5h11a3.5 3.5 0 0 1 3.5 3.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8.5Z"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M4 10.5V8a2 2 0 0 1 2-2h7"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M15 12h3.5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}
