import { NextResponse } from "next/server";
import { getStaff } from "@/lib/dashboard/auth";
import { validReply } from "@/lib/dashboard/transitions";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await getStaff();
  if (!staff) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  if (staff.role !== "admin" && staff.role !== "staff") {
    return NextResponse.json({ error: "Only front-desk staff can reply to patients." }, { status: 403 });
  }
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { text?: unknown; aiAssisted?: boolean; resolve?: boolean };
  const text = validReply(body.text);
  if (!text) return NextResponse.json({ error: "Write a message (up to 1000 characters)." }, { status: 400 });

  const { data: conv } = await staff.supabase.from("conversations").select("id, clinic_id").eq("id", id).maybeSingle();
  if (!conv) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });

  const { error } = await staff.supabase.from("messages").insert({
    conversation_id: conv.id,
    clinic_id: conv.clinic_id,
    role: "staff",
    content: text,
    ai_generated: body.aiAssisted === true, // staff reviewed and sent an AI draft
    review_status: "sent",
  });
  if (error) return NextResponse.json({ error: "Could not send. Please try again." }, { status: 500 });

  await staff.supabase
    .from("conversations")
    .update({ status: body.resolve === false ? "awaiting_staff" : "resolved", urgent: false })
    .eq("id", conv.id);
  return NextResponse.json({ ok: true });
}
