// Heuristics that keep the assistant administrative-only.
// These are best-effort filters, not a guarantee; the system prompts also forbid clinical advice
// and anything flagged here is routed to a human instead of being answered by the AI.

/** The patient is asking for clinical advice (diagnosis, medication, severity). Route to staff / clinician. */
export function asksForClinicalAdvice(text: string): boolean {
  const t = text.toLowerCase();
  return [
    /\bshould i (take|stop|start|use)\b/,
    /\bwhat (medicine|medication|drug|tablet|pill)s?\b/,
    /\b(dose|dosage|how (much|many) (mg|tablets?|pills?))\b/,
    /\bis (it|this) (serious|dangerous|cancer|contagious|normal)\b/,
    /\bdiagnos\w*/,
    /\bwhat (is|could|might) (this|it|my \w+) be\b/,
    /\bhome remed\w*/,
    /\b(side effects?|interactions?) of\b/,
    /\b(do i|could i) have (a |an |the )?(cancer|diabetes|infection|disease|virus|covid|allerg\w*|condition|disorder)\b/,
  ].some((re) => re.test(t));
}

/** An AI-generated reply that sounds like a diagnosis or treatment instruction. Must never be shown. */
export function looksLikeClinicalAdvice(reply: string): boolean {
  const t = reply.toLowerCase();
  return [
    /\byou (likely|probably|may|might|could) have\b/,
    /\byou (have|are suffering from) (a |an )?[a-z ]*(infection|disease|disorder|syndrome|allergy|cancer|diabetes)\b/,
    /\b(this|it) (is|sounds like|looks like|could be|might be) (a |an )?[a-z ]*(infection|disease|disorder|syndrome|allergy|cancer)\b/,
    /\btake \d+(\.\d+)? ?(mg|ml|mcg|tablets?|pills?|capsules?)\b/,
    /\b(i recommend|you should|try) (taking|using|applying) [a-z ]*(medicine|medication|ointment|cream|antibiotic|painkiller|ibuprofen|paracetamol)\b/,
    /\bprescri(be|bed|ption)\b/,
  ].some((re) => re.test(t));
}
