export type Role = "admin" | "staff" | "doctor" | "patient";
export type StaffRole = Exclude<Role, "patient">;

export const STAFF_ROLES: StaffRole[] = ["admin", "staff", "doctor"];

export type AppointmentStatus = "pending" | "confirmed" | "cancelled" | "completed" | "no_show";

export type Profile = {
  role: Role;
  full_name: string;
  clinic_id: string | null;
};
