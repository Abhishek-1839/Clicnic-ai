type Tone = "neutral" | "amber" | "green" | "red" | "blue";

// Soft tinted dots instead of loud borders: information without alarm.
const DOT: Record<Tone, string> = {
  neutral: "bg-slate-300",
  amber: "bg-amber-300",
  green: "bg-emerald-300",
  red: "bg-rose-300",
  blue: "bg-sky-300",
};

export function StatCard({
  label,
  value,
  tone = "neutral",
  hint,
}: {
  label: string;
  value: number | string;
  tone?: Tone;
  hint?: string;
}) {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${DOT[tone]}`} aria-hidden />
        <p className="text-sm text-slate-600">{label}</p>
      </div>
      <p className="mt-3 text-4xl font-light tabular-nums text-slate-900">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}
