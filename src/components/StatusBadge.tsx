import { STATUS_LABEL, type Status } from "@/lib/dashboard/transitions";

const STYLE: Record<Status, string> = {
  pending: "bg-amber-50 text-amber-800",
  confirmed: "bg-emerald-50 text-emerald-800",
  cancelled: "bg-rose-50 text-rose-800",
  completed: "bg-sky-50 text-sky-800",
  no_show: "bg-slate-100 text-slate-600",
};

export function StatusBadge({ status }: { status: Status }) {
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STYLE[status]}`}>{STATUS_LABEL[status]}</span>;
}
