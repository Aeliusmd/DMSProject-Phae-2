"use client";

import { useMemo, useState } from "react";
import CreateInvoiceModal from "@/components/orders/CreateInvoiceModal";
import { API_BASE_URL } from "@/config/api";
import {
  resolveRushLabel,
  buildRushBadgeTooltip,
  RUSH_LEVEL_STYLES,
} from "@/lib/orders/rushUtils";

function toFileUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  const origin = API_BASE_URL.replace(/\/api\/?$/, "");
  return `${origin}${path.startsWith("/") ? "" : "/"}${path}`;
}

const allColumns = [
  { key: "select", label: "", width: 34, minimum: true },
  { key: "orderNo", label: "Order #", width: 100, minimum: true },
  { key: "status", label: "Status", width: 120, minimum: true },
  { key: "invoice", label: "Invoice", width: 120, minimum: true },
  { key: "subpoenaDate", label: "Subpoena Date", width: 105 },
  { key: "dateServed", label: "Date Served", width: 105 },
  { key: "applicant", label: "Applicant", width: 120, minimum: true },
  { key: "caseNumber", label: "Case Number", width: 120, minimum: true },
  { key: "dob", label: "DOB", width: 85 },
  { key: "ssn", label: "SSN", width: 100 },
  { key: "provider", label: "Provider on Subpoena", width: 170 },
  { key: "recordsRequested", label: "Records Requested", width: 175 },
  { key: "doctor", label: "Doctor", width: 140 },
  { key: "address", label: "Address", width: 230 },
  { key: "rush", label: "Rush", width: 72, minimum: true },
];

export default function ReportsOrdersTable({
  orders,
  minimumColumns,
  recordsPerPage = 25,
}) {
  const [selectedInvoiceOrder, setSelectedInvoiceOrder] = useState(null);
  const [collapsedColumns, setCollapsedColumns] = useState([]);
  const [prevOrders, setPrevOrders] = useState(orders);
  const [currentPage, setCurrentPage] = useState(1);

  const visibleColumns = useMemo(() => {
    return allColumns.filter((column) => {
      const allowedByMinimum = minimumColumns ? column.minimum : true;
      const notCollapsed = !collapsedColumns.includes(column.key);

      return allowedByMinimum && notCollapsed;
    });
  }, [minimumColumns, collapsedColumns]);

  const restorableColumns = useMemo(() => {
    return allColumns.filter((column) => collapsedColumns.includes(column.key));
  }, [collapsedColumns]);

  const tableMinWidth = useMemo(() => {
    return visibleColumns.reduce((total, column) => total + column.width, 0);
  }, [visibleColumns]);

  const totalPages = Math.max(1, Math.ceil(orders.length / recordsPerPage));

  if (orders !== prevOrders) {
    setPrevOrders(orders);
    setCurrentPage(1);
  }

  const safeCurrentPage = Math.min(currentPage, totalPages);

  if (currentPage !== safeCurrentPage) {
    setCurrentPage(safeCurrentPage);
  }

  const paginatedOrders = useMemo(() => {
    const startIndex = (safeCurrentPage - 1) * recordsPerPage;
    return orders.slice(startIndex, startIndex + recordsPerPage);
  }, [orders, safeCurrentPage, recordsPerPage]);

  const startRecord =
    orders.length === 0 ? 0 : (safeCurrentPage - 1) * recordsPerPage + 1;
  const endRecord = Math.min(safeCurrentPage * recordsPerPage, orders.length);

  const isVisible = (key) => visibleColumns.some((column) => column.key === key);

  const collapseColumn = (key) => {
    setCollapsedColumns((prev) => {
      if (prev.includes(key)) return prev;
      return [...prev, key];
    });
  };

  const restoreColumn = (key) => {
    setCollapsedColumns((prev) => prev.filter((columnKey) => columnKey !== key));
  };

  const restoreAllColumns = () => {
    setCollapsedColumns([]);
  };

  const handleOpenCreateInvoice = (order) => {
    setSelectedInvoiceOrder({
      id: order.orderNo,
      dbId: order.dbId,
      court: "N/A",
      applicant: order.applicant || "N/A",
      company: {
        name: order.provider || "N/A",
      },
    });
  };

  return (
    <>
      <section className="min-h-0 flex-1 overflow-hidden bg-white">
        {restorableColumns.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2">
            <span className="text-[11px] font-semibold text-[#64748B]">
              Hidden columns:
            </span>

            {restorableColumns.map((column) => (
              <button
                key={column.key}
                type="button"
                onClick={() => restoreColumn(column.key)}
                className="inline-flex h-[23px] items-center rounded-[4px] border border-[#CBD5E1] bg-white px-2 text-[10px] font-semibold text-[#334155] hover:bg-[#E6F7FA] hover:text-[#007F96]"
              >
                + {column.label || "Select"}
              </button>
            ))}

            <button
              type="button"
              onClick={restoreAllColumns}
              className="ml-1 text-[10px] font-semibold text-[#007F96] hover:underline"
            >
              Restore all
            </button>
          </div>
        )}

        <div className="h-full max-h-[calc(100vh-240px)] overflow-auto">
          <table
            className="w-full border-collapse text-[10px]"
            style={{ minWidth: `${Math.max(tableMinWidth, 900)}px` }}
          >
            <thead className="sticky top-0 z-20 bg-white">
              <tr className="border-b border-[#CBD5E1] text-left text-[10px] font-semibold text-[#111827]">
                {isVisible("select") && (
                  <th
                    className="border-r border-[#E2E8F0] px-2 py-2"
                    style={{ width: 34 }}
                  >
                    <input type="checkbox" className="h-[11px] w-[11px]" />
                  </th>
                )}

                {isVisible("orderNo") && (
                  <ReportHeader
                    label="Order #"
                    width={100}
                    onCollapse={() => collapseColumn("orderNo")}
                    sortable
                  />
                )}

                {isVisible("status") && (
                  <ReportHeader
                    label="Status"
                    width={120}
                    onCollapse={() => collapseColumn("status")}
                  />
                )}

                {isVisible("invoice") && (
                  <ReportHeader
                    label="Invoice"
                    width={120}
                    onCollapse={() => collapseColumn("invoice")}
                  />
                )}

                {isVisible("subpoenaDate") && (
                  <ReportHeader
                    label="Subpoena Date"
                    width={105}
                    onCollapse={() => collapseColumn("subpoenaDate")}
                    sortable
                  />
                )}

                {isVisible("dateServed") && (
                  <ReportHeader
                    label="Date Served"
                    width={105}
                    onCollapse={() => collapseColumn("dateServed")}
                    sortable
                  />
                )}

                {isVisible("applicant") && (
                  <ReportHeader
                    label="Applicant"
                    width={120}
                    onCollapse={() => collapseColumn("applicant")}
                    sortable
                  />
                )}

                {isVisible("caseNumber") && (
                  <ReportHeader
                    label="Case Number"
                    width={120}
                    onCollapse={() => collapseColumn("caseNumber")}
                    sortable
                  />
                )}

                {isVisible("dob") && (
                  <ReportHeader
                    label="DOB"
                    width={85}
                    onCollapse={() => collapseColumn("dob")}
                    sortable
                  />
                )}

                {isVisible("ssn") && (
                  <ReportHeader
                    label="SSN"
                    width={100}
                    onCollapse={() => collapseColumn("ssn")}
                  />
                )}

                {isVisible("provider") && (
                  <ReportHeader
                    label="Provider on Subpoena"
                    width={170}
                    onCollapse={() => collapseColumn("provider")}
                  />
                )}

                {isVisible("recordsRequested") && (
                  <ReportHeader
                    label="Records Requested"
                    width={175}
                    onCollapse={() => collapseColumn("recordsRequested")}
                  />
                )}

                {isVisible("doctor") && (
                  <ReportHeader
                    label="Doctor"
                    width={140}
                    onCollapse={() => collapseColumn("doctor")}
                    sortable
                  />
                )}

                {isVisible("address") && (
                  <ReportHeader
                    label="Address"
                    width={230}
                    onCollapse={() => collapseColumn("address")}
                  />
                )}

                {isVisible("rush") && (
                  <ReportHeader
                    label="Rush"
                    width={72}
                    onCollapse={() => collapseColumn("rush")}
                    center
                  />
                )}
              </tr>
            </thead>

            <tbody>
              {paginatedOrders.map((order) => {
                const rushLabel = resolveRushLabel(order);

                return (
                  <tr
                    key={`${order.id}-${order.orderNo}`}
                    className="border-b border-[#E2E8F0] odd:bg-white even:bg-[#F8FBFC] hover:bg-[#EFF8FA]"
                  >
                    {isVisible("select") && (
                      <td className="border-r border-[#E2E8F0] px-2 py-2 align-top">
                        <input type="checkbox" className="h-[11px] w-[11px]" />
                      </td>
                    )}

                    {isVisible("orderNo") && (
                      <td className="border-r border-[#E2E8F0] px-2 py-2 align-top">
                        <button
                          type="button"
                          className="block text-left text-[10px] font-bold leading-[13px] text-[#007F96] hover:underline"
                        >
                          {order.orderNo}
                        </button>

                        <p className="mt-[2px] text-[9px] leading-[12px] text-[#64748B]">
                          {order.subNo}
                        </p>

                        {order.recNumber ? (
                          <p className="mt-[2px] text-[9px] leading-[12px] font-semibold text-[#334155]">
                            REC {order.recNumber}
                          </p>
                        ) : null}

                        {order.subpoenaUrl ? (
                          <a
                            href={toFileUrl(order.subpoenaUrl)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-[2px] block text-left text-[9px] font-semibold leading-[12px] text-[#111827] hover:underline"
                          >
                            Review Subpoena
                          </a>
                        ) : (
                          <span className="mt-[2px] block text-[9px] leading-[12px] text-[#94A3B8]">
                            No subpoena
                          </span>
                        )}
                      </td>
                    )}

                    {isVisible("status") && (
                      <td className="border-r border-[#E2E8F0] px-2 py-2 align-top">
                        <StatusBlock status={order.status} />
                      </td>
                    )}

                    {isVisible("invoice") && (
                      <td className="border-r border-[#E2E8F0] px-2 py-2 align-top">
                        <InvoiceBlock
                          order={order}
                          onCreateInvoice={() => handleOpenCreateInvoice(order)}
                        />
                      </td>
                    )}

                    {isVisible("subpoenaDate") && (
                      <ReportCell>{formatShortDate(order.subpoenaDate)}</ReportCell>
                    )}

                    {isVisible("dateServed") && (
                      <ReportCell>{formatShortDate(order.dateServed)}</ReportCell>
                    )}

                    {isVisible("applicant") && (
                      <ReportCell bold>{order.applicant}</ReportCell>
                    )}

                    {isVisible("caseNumber") && (
                      <ReportCell>{order.caseNumber}</ReportCell>
                    )}

                    {isVisible("dob") && (
                      <ReportCell danger>{formatDob(order.dob)}</ReportCell>
                    )}

                    {isVisible("ssn") && <ReportCell>{order.ssn}</ReportCell>}

                    {isVisible("provider") && (
                      <ReportCell>{order.provider}</ReportCell>
                    )}

                    {isVisible("recordsRequested") && (
                      <ReportCell>{order.recordsRequested}</ReportCell>
                    )}

                    {isVisible("doctor") && <ReportCell>{order.doctor}</ReportCell>}

                    {isVisible("address") && (
                      <td className="border-r border-[#E2E8F0] px-2 py-2 align-top text-[10px] leading-[14px] text-[#111827]">
                        <div className="max-w-[220px] break-words">
                          {order.address}
                        </div>
                      </td>
                    )}

                    {isVisible("rush") && (
                      <td className="px-2 py-2 text-center align-middle">
                        <RushBadge rush={rushLabel} order={order} />
                      </td>
                    )}
                  </tr>
                );
              })}

              {orders.length === 0 && (
                <tr>
                  <td
                    colSpan={visibleColumns.length}
                    className="px-5 py-14 text-center text-[13px] text-[#94A3B8]"
                  >
                    No report orders found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <ReportsPagination
          currentPage={safeCurrentPage}
          totalPages={totalPages}
          startRecord={startRecord}
          endRecord={endRecord}
          totalRecords={orders.length}
          onPageChange={setCurrentPage}
        />
      </section>

      <CreateInvoiceModal
        isOpen={Boolean(selectedInvoiceOrder)}
        order={selectedInvoiceOrder}
        returnToPath="/reports"
        onClose={() => setSelectedInvoiceOrder(null)}
      />
    </>
  );
}

function ReportsPagination({
  currentPage,
  totalPages,
  startRecord,
  endRecord,
  totalRecords,
  onPageChange,
}) {
  const pages = Array.from({ length: totalPages }, (_, index) => index + 1);

  return (
    <div className="flex flex-col gap-3 border-t border-[#E2E8F0] bg-white px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-[11px] text-[#475569]">
        Showing {startRecord}-{endRecord} of {totalRecords} records
      </p>

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          disabled={currentPage === 1}
          onClick={() => onPageChange(Math.max(currentPage - 1, 1))}
          className="inline-flex h-[34px] min-w-[82px] items-center justify-center rounded-[6px] border border-[#E2E8F0] bg-white px-3 text-[15px] font-medium text-[#64748B] hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-40"
        >
          ‹ Prev
        </button>

        {pages.map((page) => (
          <button
            key={page}
            type="button"
            onClick={() => onPageChange(page)}
            className={`inline-flex h-[34px] min-w-[42px] items-center justify-center rounded-[6px] border px-3 text-[15px] font-medium ${
              currentPage === page
                ? "border-[#111827] bg-[#111827] text-white"
                : "border-[#E2E8F0] bg-white text-[#111827] hover:bg-[#F8FAFC]"
            }`}
          >
            {page}
          </button>
        ))}

        <button
          type="button"
          disabled={currentPage === totalPages}
          onClick={() => onPageChange(Math.min(currentPage + 1, totalPages))}
          className="inline-flex h-[34px] min-w-[82px] items-center justify-center rounded-[6px] border border-[#E2E8F0] bg-white px-3 text-[15px] font-medium text-[#111827] hover:bg-[#F8FAFC] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next ›
        </button>
      </div>
    </div>
  );
}

function ReportHeader({
  label,
  width,
  onCollapse,
  sortable = false,
  center = false,
}) {
  return (
    <th
      className={`border-r border-[#E2E8F0] px-2 py-2 ${
        center ? "text-center" : "text-left"
      }`}
      style={{ width }}
    >
      <div
        className={`flex items-center gap-1 ${
          center ? "justify-center" : "justify-between"
        }`}
      >
        <span className="truncate">
          {label} {sortable && <span className="text-[#94A3B8]">↕</span>}
        </span>

        <button
          type="button"
          onClick={onCollapse}
          title={`Collapse ${label}`}
          className="flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[3px] text-[10px] text-[#94A3B8] hover:bg-[#E6F7FA] hover:text-[#007F96]"
        >
          ‹
        </button>
      </div>
    </th>
  );
}

function InvoiceBlock({ order, onCreateInvoice }) {
  if (!order.invoiced) {
    return (
      <button
        type="button"
        onClick={onCreateInvoice}
        className="text-[9px] font-semibold leading-[12px] text-[#111827] hover:underline"
      >
        Create Invoice
      </button>
    );
  }

  return (
    <div className="space-y-[2px]">
      <p className="text-[9px] font-semibold leading-[12px] text-[#111827]">
        Invoiced
      </p>

      <p className="text-[9px] leading-[12px] text-[#111827]">
        {order.invoiceAmount}
      </p>

      {order.invoicePaid && (
        <p className="text-[9px] font-semibold leading-[12px] text-[#059669]">
          Paid
        </p>
      )}

      {!order.invoicePaid && order.invoiceStatus !== "Written Off" && (
        <p className="text-[9px] font-semibold leading-[12px] text-[#EA580C]">
          {order.invoiceStatus || "Unpaid"}
        </p>
      )}
    </div>
  );
}

function StatusBlock({ status }) {
  return (
    <div className="space-y-[2px] text-[9px] font-bold leading-[12px] text-[#111827]">
      <p className="text-[10px] font-semibold text-[#007F96]">{status || "—"}</p>
    </div>
  );
}

function ReportCell({ children, bold = false, danger = false }) {
  return (
    <td
      className={`border-r border-[#E2E8F0] px-2 py-2 align-top text-[10px] leading-[14px] ${
        danger ? "text-[#EA580C]" : "text-[#111827]"
      } ${bold ? "font-semibold" : ""}`}
    >
      {children}
    </td>
  );
}

function RushBadge({ rush, order }) {
  if (!rush) {
    return <span className="text-[10px] text-[#94A3B8]">–</span>;
  }

  const tooltip = buildRushBadgeTooltip(order, rush);

  return (
    <span
      title={tooltip}
      aria-label={tooltip || rush}
      className={`inline-flex h-[20px] min-w-[46px] items-center justify-center rounded-[3px] border px-2 text-[9px] font-bold leading-none ${
        RUSH_LEVEL_STYLES[rush] || RUSH_LEVEL_STYLES["Rush 1"]
      }`}
    >
      {rush}
    </span>
  );
}

function formatShortDate(dateValue) {
  if (!dateValue) return "";

  const [year, month, day] = dateValue.split("-");
  return `${month}/${day}/${year.slice(2)}`;
}

function formatDob(dateValue) {
  if (!dateValue) return "";

  const parts = dateValue.split("/");
  if (parts.length !== 3) return dateValue;

  const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2].slice(-4);
  return `${parts[0]}/${parts[1]}/${year}`;
}