import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness + config check for the deploy. Reports which pieces are configured, never any secret values. */
export function GET() {
  const has = (k: string) => !!process.env[k]?.trim();
  return NextResponse.json({
    ok: true,
    supabase: has("NEXT_PUBLIC_SUPABASE_URL") && has("NEXT_PUBLIC_SUPABASE_ANON_KEY") && has("SUPABASE_SERVICE_ROLE_KEY"),
    ai: { xai: has("XAI_API_KEY") && has("XAI_MODEL"), gemini: has("GEMINI_API_KEY") },
    time: new Date().toISOString(),
  });
}
