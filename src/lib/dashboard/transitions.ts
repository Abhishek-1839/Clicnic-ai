// Pure rules for who may move an appointment to which status, and the patient-facing wording.
export type Status = "pending" | "confirmed" | "cancelled" | "completed" | "no_show";
export type Role = "admin" | "staff" | "doctor" | "patient";

export const STATUSES: Status[] = ["pending", "confirmed", "cancelled", "completed", "no_show"];

export const STATUS_LABEL: Record<Status, string> = {
  pending: "Awaiting confirmation",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
  completed: "Completed",
  no_show: "Did not attend",
};

const FLOW: Record<Status, Status[]> = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["completed", "no_show", "cancelled"],
  cancelled: [],
  completed: [],
  no_show: [],
};

/** Statuses the given role may move an appointment to from its current status. */
export function allowedNext(role: Role, from: Status): Status[] {
  const next = FLOW[from] ?? [];
  if (role === "admin" || role === "staff") return next;
  if (role === "doctor") return next.filter((s) => s === "completed" || s === "no_show");
  return [];
}

export function canTransition(role: Role, from: Status, to: Status): boolean {
  return allowedNext(role, from).includes(to);
}

/** Message dropped into the patient's chat when staff change a status. Null = no message. */
export function statusMessage(
  to: Status,
  a: { refCode: string; doctorName: string; when: string }
): string | null {
  switch (to) {
    case "confirmed":
      return `Good news! Your appointment ${a.refCode} with ${a.doctorName} on ${a.when} is now confirmed. We look forward to seeing you. If plans change, just tell me here and I'll help.`;
    case "cancelled":
      return `Your appointment ${a.refCode} with ${a.doctorName} on ${a.when} has been cancelled by the clinic. You're welcome to book a new time here whenever you like.`;
    default:
      return null;
  }
}

/** Plain-language urgency ordering for the inquiry queue: urgent first, then oldest waiting. */
export function sortInquiries<T extends { urgent: boolean; updated_at: string }>(rows: T[]): T[] {
  return [...rows].sort((x, y) => {
    if (x.urgent !== y.urgent) return x.urgent ? -1 : 1;
    return new Date(x.updated_at).getTime() - new Date(y.updated_at).getTime();
  });
}

export function validReply(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const t = text.trim();
  return t.length > 0 && t.length <= 1000 ? t : null;
}
