import { allow } from "@/lib/ratelimit";
import { NextResponse } from "next/server";
import { getStaff } from "@/lib/dashboard/auth";
import { answerFaq } from "@/lib/ai/analyze";

/** Workflow B: AI proposes a reply from the clinic knowledge base; staff edit and send. Never sent automatically. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await getStaff();
  if (!staff) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  if (!allow(`draft:${staff.user.id}`, 15, 60_000)) {
    return NextResponse.json({ error: "Please wait a moment before asking for another draft." }, { status: 429 });
  }
  const { id } = await params;

  const { data: conv } = await staff.supabase.from("conversations").select("id, clinic_id").eq("id", id).maybeSingle();
  if (!conv) return NextResponse.json({ error: "Conversation not found." }, { status: 404 });

  const [{ data: last }, { data: clinic }] = await Promise.all([
    staff.supabase
      .from("messages")
      .select("content")
      .eq("conversation_id", id)
      .eq("role", "patient")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    staff.supabase.from("clinics").select("faq_kb").eq("id", conv.clinic_id).maybeSingle(),
  ]);
  if (!last) return NextResponse.json({ draft: "", note: "No patient message to answer." });

  const r = await answerFaq(last.content, clinic?.faq_kb ?? {});
  if (!r.answerable || !r.answer) {
    return NextResponse.json({ draft: "", note: "The assistant couldn't draft a safe answer. Please write one yourself." });
  }
  return NextResponse.json({ draft: r.answer, note: "AI draft. Please review before sending." });
}
