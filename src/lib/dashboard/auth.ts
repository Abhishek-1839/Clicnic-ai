import { createClient } from "@/lib/supabase/server";
import type { Role } from "./transitions";

/** Signed-in dashboard user + RLS-bound client, or null. */
export async function getStaff() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data: profile } = await supabase
    .from("profiles")
    .select("role, full_name, clinic_id")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile) return null;
  return { supabase, user, role: profile.role as Role, clinicId: profile.clinic_id as string, name: profile.full_name as string };
}
