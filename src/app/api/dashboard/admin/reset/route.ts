import { NextResponse } from "next/server";
import { getStaff } from "@/lib/dashboard/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { resetDemoData } from "@/lib/demo/reset";

export async function POST() {
  const staff = await getStaff();
  if (!staff) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  if (staff.role !== "admin") return NextResponse.json({ error: "Admins only." }, { status: 403 });
  try {
    const r = await resetDemoData(createAdminClient(), staff.clinicId);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Reset failed." }, { status: 400 });
  }
}
