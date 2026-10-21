# AI development log

Running record of how AI tools were used, kept for the README's "what AI built vs. what I decided" section.

## Decisions made by the developer

- Providers: started with Groq + Gemini; switched to xAI (Grok) primary + Gemini fallback after the first live test (see debugging notes).
- Staff authentication and RBAC are in scope for the MVP (admin / staff / doctor).
- Patients choose from offered slots every time (no free-text times).
- Three doctors per clinic; other clinics must get their own isolated data.
- Bookings start as `pending` until staff confirm. Patient accounts are optional; anonymous booking is the default.
- Overall time budget: 24 hours.

## Prompts

### Prompt 1 (planning)
> Take inspiration from Confido Health... AI part via APIs (Hugging Face or similar). Lets plan it first.

Outcome: research on free LLM tiers, a scoped MVP, a server-controlled booking state machine with the LLM limited to intent/extraction/phrasing, and a phased plan.

### Prompt 2 (phase 1 build)
> Start phase 1: repo structure, schema, seed data and auth. Other clinics should get their own data. Time limit is 24 hours total.

Outcome: multi-clinic schema with RLS, seed and add-clinic scripts, staff auth and middleware, dashboard shell.

### Prompt 3 (phase 2 build)
> Lets start phase 2.

Outcome: emergency/medical safety rules, provider chain -> rules provider chain, Zod-validated intent and extraction, FAQ answerer restricted to the clinic knowledge base, ai_events logging, 30 unit tests with mocked network.

### Prompt 4 (phases 3 and 4)
> You build 3 and 4 same time as time is less.

Outcome: per-doctor slot engine (IST), server-controlled booking state machine (book / reschedule / cancel / status / FAQ / escalation), chat UI, 31 unit tests.

### Prompt 5 (phase 5)
> Make the dashboard more calming so that patients don't feel overwhelmed... take the reference of Confido Health and other competitors.

Outcome: calm design system, appointment and message queues, status actions with role rules, AI-suggested replies, automatic confirmation messages.

### Prompt 6 (fixes and phase 6)
> The confirmation is appearing only when I check status... it asks again for reference id and name... another patient should not see the previous chat history.

Outcome: chat remembers the verified booking, per-tab sessions, sturdier polling; then rate limits, admin demo reset, health check, security headers.

## Debugging notes

- Supabase `PGRST125 Invalid path specified in request URL` during seeding: `NEXT_PUBLIC_SUPABASE_URL` had `/rest/v1/` appended. The client adds that path itself, so the URL must be the bare project URL.

- Groq 401 / Gemini 404: the key started with `xai-` (an xAI key sent to Groq), and the Gemini model name carried a `models/` prefix. Fixed by adding xAI, requiring `XAI_MODEL`, stripping the prefix, and logging every attempt so a fallback can't hide a failure.
- 11 failing tests after a find-and-replace of groq to xai: tests set one provider key and deleted another; rewrote them around xAI-first.
- False positive in the clinical-advice guard ("Do I have to bring my ID?"): pattern narrowed to disease terms and regression tests added.

## Limitations / next improvements

See the Limitations section of the README.
