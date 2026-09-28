const styles = {
  Active: "bg-[#DCFCE7] text-[#15803D]",
  "No Subpoena": "bg-[#F1F5F9] text-[#334155]",
  "Ready to Pickup": "bg-[#CCFBF1] text-[#0F766E]",
  Ready: "bg-[#DBEAFE] text-[#1D4ED8]",
  Completed: "bg-[#DCFCE7] text-[#15803D]",
  Cancelled: "bg-[#FEE2E2] text-[#DC2626]",
  Deleted: "bg-[#FEE2E2] text-[#991B1B]",
  "No Records": "bg-[#F1F5F9] text-[#334155]",
  "Write Offs": "bg-[#FEE2E2] text-[#DC2626]",
  "In Process": "bg-[#DBEAFE] text-[#1D4ED8]",
  Invoice: "bg-[#FEF3C7] text-[#B45309]",
  Paid: "bg-[#ECFDF5] text-[#047857]",
  Released: "bg-[#DCFCE7] text-[#15803D]",
  "Pending Payment": "bg-[#FEE2E2] text-[#B91C1C]",
};

export default function OrderStatusBadge({ status }) {
  return (
    <span
      className={`order-status-badge inline-flex whitespace-nowrap rounded-full px-[8px] py-[3px] text-[11px] font-medium leading-none ${
        styles[status] || "bg-[#F1F5F9] text-[#334155]"
      }`}
    >
      {status}
    </span>
  );
}