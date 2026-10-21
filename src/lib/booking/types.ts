// Shared types for booking. No runtime imports, so the browser can import these safely.

export type DoctorCfg = {
  id: string;
  name: string;
  specialty: string;
  working_days: number[]; // 0 = Sunday ... 6 = Saturday
  start_time: string; // "09:00" or "09:00:00"
  end_time: string;
  slot_minutes: number;
};

export type Doctor = { id: string; name: string; specialty: string };

export type Slot = {
  doctorId: string;
  doctorName: string;
  start: string; // ISO (UTC)
  end: string;
  label: string; // e.g. "Thu 22 Oct, 10:30 AM" (clinic time, IST)
};

export type ApptView = {
  id: string;
  refCode: string;
  doctorId: string;
  doctorName: string;
  patientName: string;
  slotStart: string;
  status: string;
  reason: string;
};

/** What the chat page should render under the latest assistant message. */
export type Ui =
  | { type: "doctors"; doctors: Doctor[] }
  | { type: "slots"; slots: Slot[] }
  | { type: "confirm"; label: string }
  | { type: "booking"; appointment: ApptView; headline: string };

/** Button clicks from the chat page. Slots are referenced by index into server-side state, never by client data. */
export type Action =
  | { type: "intent"; intent: "book" | "reschedule" | "cancel" | "status" | "faq" | "staff" }
  | { type: "doctor"; doctorId: string } // a doctor id, or "any"
  | { type: "slot"; index: number }
  | { type: "confirm"; yes: boolean }
  | { type: "restart" };
