import Link from "next/link";

export default function OrderActionButton({
  children,
  icon,
  variant = "secondary",
  href,
  onClick,
}) {
  const isPrimary = variant === "primary";

  const className = `inline-flex h-[34px] w-full items-center justify-center gap-2 rounded-[6px] px-3 text-[12px] font-medium transition sm:w-auto ${
    isPrimary
      ? "bg-[#0097B2] text-white hover:bg-[#0086A0]"
      : "border border-[#E2E8F0] bg-[#F8FAFC] text-[#334155] hover:bg-white"
  }`;

  if (href) {
    return (
      <Link href={href} className={className} onClick={onClick}>
        {icon}
        {children}
      </Link>
    );
  }

  return (
    <button type="button" onClick={onClick} className={className}>
      {icon}
      {children}
    </button>
  );
}