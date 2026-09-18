"use client";

import { formatUtcInstant } from "@/lib/utils/timezoneUtils";

export default function ActivityLogTable({ logs, footer = null }) {
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-[#E2E8F0] bg-white shadow-sm">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full min-w-[1200px] border-collapse">
          <thead className="sticky top-0 z-10 bg-[#F8FAFC]">
            <tr className="border-b border-[#E2E8F0] text-left text-[11px] font-semibold text-[#475569]">
              <th className="w-[130px] px-5 py-3">Date &amp; Time</th>
              <th className="w-[170px] px-5 py-3">Action</th>
              <th className="w-[185px] px-5 py-3">Company</th>
              <th className="w-[120px] px-5 py-3">Module</th>
              <th className="w-[180px] px-5 py-3">Performed By</th>
              <th className="min-w-[380px] px-5 py-3">Details</th>
            </tr>
          </thead>

          <tbody>
            {logs.map((log) => (
              <tr
                key={log.id}
                className="border-b border-[#F1F5F9] last:border-b-0 odd:bg-white even:bg-[#FCFEFF] hover:bg-[#F8FBFC]"
              >
                <td className="px-5 py-4 align-middle">
                  <p className="text-[12px] text-[#475569]">
                    {formatUtcInstant(log.loggedAt, {
                      fallback: log.displayDate || log.date,
                    })}
                  </p>
                  {!log.loggedAt && !log.displayDate && log.time ? (
                    <p className="mt-1 text-[11px] text-[#64748B]">{log.time}</p>
                  ) : null}
                </td>

                <td className="px-5 py-4 align-middle">
                  <div className="flex items-center gap-3">
                    <ActionIcon module={log.module} action={log.action} />

                    <span className="text-[12px] font-semibold text-[#334155]">
                      {log.action}
                    </span>
                  </div>
                </td>

                <td className="px-5 py-4 align-middle text-[12px] text-[#475569]">
                  {log.company}
                </td>

                <td className="px-5 py-4 align-middle">
                  <ModuleBadge module={log.module} />
                </td>

                <td className="px-5 py-4 align-middle">
                  <div className="flex items-center gap-2">
                    <UserAvatar
                      initials={log.initials || getInitials(log.performedBy)}
                    />

                    <div className="min-w-0">
                      <p className="text-[12px] leading-tight text-[#475569]">
                        {log.performedBy}
                      </p>
                      {log.performerRole || log.role ? (
                        <p className="mt-0.5 text-[10px] font-medium leading-tight text-[#94A3B8]">
                          {log.performerRole || log.role}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </td>

                <td className="px-5 py-4 align-middle text-[12px] leading-[18px] text-[#64748B]">
                  {log.details}
                </td>
              </tr>
            ))}

            {logs.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-5 py-14 text-center text-[13px] text-[#94A3B8]"
                >
                  No activity logs found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {footer}
    </section>
  );
}

function UserAvatar({ initials }) {
  const colors = {
    SC: "#3B82F6",
    JD: "#475569",
    JW: "#8B5CF6",
    GH: "#F97316",
    MC: "#14B8A6",
    AW: "#EC4899",
    LT: "#22C55E",
    DK: "#06B6D4",
    RG: "#EAB308",
    ER: "#F43F5E",
  };

  return (
    <span
      className="flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-full text-[10px] font-semibold leading-none text-white"
      style={{
        backgroundColor: colors[initials] || "#3B82F6",
      }}
    >
      {initials}
    </span>
  );
}

function getInitials(name) {
  return name
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function ModuleBadge({ module }) {
  const styles = {
    Orders: "border-[#93C5FD] bg-[#EFF6FF] text-[#2563EB]",
    Billing: "border-[#FCD34D] bg-[#FFFBEB] text-[#B45309]",
    Employees: "border-[#86EFAC] bg-[#ECFDF5] text-[#059669]",
    Facilities: "border-[#7DD3FC] bg-[#F0F9FF] text-[#0369A1]",
    Processing: "border-[#DDD6FE] bg-[#F5F3FF] text-[#7C3AED]",
    Reports: "border-[#CBD5E1] bg-[#F1F5F9] text-[#475569]",
    Security: "border-red-200 bg-red-50 text-red-500",
    Wallet: "border-[#A7F3D0] bg-[#ECFDF5] text-[#047857]",
  };

  return (
    <span
      className={`inline-flex h-[24px] items-center justify-center rounded-full border px-3 text-[11px] font-semibold ${
        styles[module] || styles.Reports
      }`}
    >
      {module}
    </span>
  );
}

function ActionIcon({ module, action }) {
  const styles = {
    Orders: "bg-[#EFF6FF] text-[#2563EB]",
    Billing: "bg-[#FFFBEB] text-[#B45309]",
    Employees: "bg-[#ECFDF5] text-[#059669]",
    Facilities: "bg-[#F0F9FF] text-[#0369A1]",
    Processing: "bg-[#F5F3FF] text-[#7C3AED]",
    Reports: "bg-[#F1F5F9] text-[#475569]",
    Security: "bg-red-50 text-red-500",
    Wallet: "bg-[#ECFDF5] text-[#047857]",
  };

  return (
    <span
      className={`flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-[6px] ${
        styles[module] || styles.Reports
      }`}
    >
      {getActionIcon(action)}
    </span>
  );
}

function getActionIcon(action) {
  const lowerAction = action.toLowerCase();

  if (lowerAction.includes("x-ray") || lowerAction.includes("xray")) {
    return <XrayIcon />;
  }
  if (lowerAction.includes("invoice")) return <InvoiceIcon />;
  if (lowerAction.includes("employee")) return <EmployeeIcon />;
  if (lowerAction.includes("payment")) return <PaymentIcon />;
  if (lowerAction.includes("report")) return <ReportIcon />;
  if (lowerAction.includes("batch")) return <ProcessingIcon />;
  if (lowerAction.includes("upload")) return <UploadIcon />;
  if (lowerAction.includes("reminder")) return <ReminderIcon />;
  if (lowerAction.includes("cancel")) return <CancelIcon />;
  if (lowerAction.includes("written off") || lowerAction.includes("writeoff")) {
    return <WriteoffIcon />;
  }
  if (lowerAction.includes("security")) return <SecurityIcon />;

  return <OrderIcon />;
}

function OrderIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path d="M6 4h12v16H6V4Z" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9 9h6M9 13h6" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function InvoiceIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path
        d="M7 3h10v18l-2-1-2 1-2-1-2 1-2-1V3Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path d="M10 8h4M10 12h4" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function XrayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <rect x="4" y="5" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8 15l3-4 2 3 3-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function EmployeeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <circle cx="9" cy="8" r="3" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M3 20a6 6 0 0 1 12 0"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M18 8v6M21 11h-6"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function PaymentIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path d="M4 7h16v10H4V7Z" stroke="currentColor" strokeWidth="1.8" />
      <path d="M4 10h16" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function ReportIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path d="M6 20V4h12v16H6Z" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M9 9h6M9 13h6M9 17h4"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function ProcessingIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="7" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 8v4l3 2" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 16V5M8 9l4-4 4 4"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path d="M5 19h14" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function ReminderIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path
        d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 7h18s-3 0-3-7"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M10 19a2 2 0 0 0 4 0"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function CancelIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9 9l6 6M15 9l-6 6" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function WriteoffIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path
        d="M6 6h12M8 12h8M10 18h4"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  );
}

function SecurityIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 22s7-4 7-10V5l-7-3-7 3v7c0 6 7 10 7 10Z"
        stroke="currentColor"
        strokeWidth="1.8"
      />
    </svg>
  );
}