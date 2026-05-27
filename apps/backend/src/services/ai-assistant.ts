// apps/backend/src/services/ai-assistant.ts
//
// HPCSA Booklet 20 compliance gating for the AI health literacy assistant.
//
// Non-negotiables (CLAUDE.md — never violate):
//   • SYSTEM_PROMPT is immutable without SA health-law attorney written sign-off.
//     Changing the text changes system_prompt_sha256 in all future log rows,
//     breaking the continuous HPCSA evidence chain.
//   • Every call (allowed AND blocked, including pre-flight and timeouts) must
//     produce an ai_compliance_log row. The audit chain must have no gaps.
//   • system_prompt_sha256 in every log row is the evidence fingerprint.
//   • Do NOT add clinical-value extraction, diagnosis suggestions, or treatment
//     recommendations — those are SAHPRA Class B/C territory.

import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { pool } from "../db.js";
import { logger } from "../logger.js";

// ── System prompt — IMMUTABLE ─────────────────────────────────────────────────
// Modify only with written sign-off from a SA health-law attorney.
// Flag any proposed change to the user and request explicit confirmation.
export const SYSTEM_PROMPT =
  `You are a health literacy assistant for QuroVita, a South African patient health records platform. Your role is strictly limited to health education — not clinical advice.

You are PERMITTED to:
1. Define medical terms using WHO standard definitions
2. Explain in general terms what a type of test or procedure measures (generic physiology only)
3. Suggest questions the patient could ask their doctor or nurse at their next visit
4. Provide general health education information from recognised public health sources
5. Explain what a type of medication class does in general terms

You are STRICTLY FORBIDDEN from:
1. Interpreting, commenting on, or evaluating any specific patient test result or value
2. Telling a patient what their numbers, results, or findings mean for them personally
3. Suggesting, implying, or confirming any diagnosis
4. Recommending, suggesting, or commenting on any medication, dosage, or treatment plan — including existing ones
5. Analysing, summarising, or drawing conclusions from any uploaded patient document

If a question falls outside your permitted scope, respond: "I can only provide general health education information. Please discuss this with your doctor or healthcare provider."

End every response with: "This is general health information only. Please discuss your personal health with your doctor."

Respond in the same language as the user's question (English, isiZulu, or Sesotho).`;

// Computed at module load — recorded on every ai_compliance_log row.
export const SYSTEM_PROMPT_SHA256 = createHash("sha256")
  .update(SYSTEM_PROMPT)
  .digest("hex");

// ── i18n gate ─────────────────────────────────────────────────────────────────
// 🔴 HUMAN ACTION NEEDED: set to true ONLY after clinical advisor + native
// speaker sign-off on the isiZulu and Sesotho fallback translations below.
// This flag is a launch-readiness gate (BUILD_PLAN.md "Launch Readiness").
export const ZU_ST_TRANSLATIONS_REVIEWED = false;

// ── Safe fallback responses ───────────────────────────────────────────────────
// Returned (instead of model output) whenever a call is blocked.
export const SAFE_FALLBACK: Record<string, string> = {
  en: "I can only provide general health education information. Please discuss your personal health with your doctor or healthcare provider.",
  // 🔴 DRAFT — not yet reviewed by clinical advisor or native isiZulu speaker.
  zu: "Ngingasiza kuphela ngolwazi lwezemfundo yezempilo jikelele. Sicela uxoxe ngezempilo yakho nomtholampilo noma udokotela wakho.",
  // 🔴 DRAFT — not yet reviewed by clinical advisor or native Sesotho speaker.
  st: "Ke ka thusa feela ka tlhahisoleseding ya thuto ya bophelo. Ke a kopa bua le ngaka ya hao ka bophelo ba hao bo bo ikgethileng.",
};

// ── Violation patterns ────────────────────────────────────────────────────────
// Two sets: PRE_FLIGHT (applied to user INPUT — block before API call)
//           POST_GEN   (applied to model OUTPUT — catch what slipped past prompt)
//
// Do NOT modify these patterns without explicit user approval.
// They are part of the HPCSA evidence trail alongside the system prompt.

interface ViolationPattern {
  tag: string;
  pattern: RegExp;
}

// Applied to user INPUT before the Anthropic API call.
export const PRE_FLIGHT_PATTERNS: ViolationPattern[] = [
  {
    // "what does my HbA1c result mean", "explain my test results"
    tag: "preflight.interpret_request",
    pattern:
      /\b(interpret|explain|tell me (about|what))\b.{0,60}\bmy\b.{0,40}\b(result|value|test|level|count|report|number|reading|lab|finding|outcome)\b/i,
  },
  {
    // "is my CD4 count too low", "are my results concerning"
    tag: "preflight.is_my_x_bad",
    pattern:
      /\b(is|are|was|were)\s+my\b.{0,60}\b(bad|good|normal|abnormal|high|low|too\s+(high|low)|concerning|dangerous|okay|ok|fine|serious|worrying|elevated|reduced)\b/i,
  },
  {
    // "do I have diabetes", "could I have HIV", "am I positive"
    tag: "preflight.do_i_have",
    pattern:
      /\b(do i have|could i have|might i have|am i|have i got)\b.{0,80}\b(disease|condition|syndrome|disorder|infection|cancer|diabetes|hiv|tb|hypertension|anaemia|anemia|positive|negative)\b/i,
  },
  {
    // "should I stop my medication", "how much should I take"
    tag: "preflight.medication_advice",
    pattern:
      /\b(should i (take|stop|start|change|increase|decrease|switch|avoid)|can i stop|do i need to take|how much (should i|do i)|my (medication|medicine|tablets?|pills?|drugs?|dose|dosage))\b/i,
  },
  {
    // "what does my report mean", "what does this test show"
    tag: "preflight.what_does_mine_mean",
    pattern:
      /what does\b.{0,50}\b(my|mine|this|the)\b.{0,50}\b(mean|show|indicate|say|tell me|reveal|suggest)\b/i,
  },
];

// Applied to model OUTPUT after the Anthropic API call.
export const POST_GEN_PATTERNS: ViolationPattern[] = [
  {
    // "your HbA1c level is elevated", "your cholesterol count is high"
    // .{0,40} allows qualifiers between "your" and the noun (e.g. "HbA1c", "blood glucose")
    tag: "postgen.value_judgment",
    pattern:
      /\byour\b.{0,40}\b(value|level|count|reading|result|number|score)\b.{0,10}\b(is|are|appears?|seems?)\b.{0,10}\b(high|low|elevated|reduced|abnormal|normal|concerning|critical)\b/i,
  },
  {
    // "you may have type 2 diabetes", "this suggests a diagnosis of"
    tag: "postgen.diagnosis",
    pattern:
      /\b(you\s+(may|might|could|appear\s+to|seem\s+to)\s+have|this\s+(suggests?|indicates?|points\s+to|is\s+consistent\s+with)\s+(a\s+)?(diagnosis\s+of\s+)?)\b/i,
  },
  {
    // "you should start taking metformin", "I recommend stopping the dose"
    tag: "postgen.treatment_recommend",
    pattern:
      /\b(you\s+should\s+(take|start|stop|increase|decrease|switch|avoid)|i\s+(recommend|suggest|advise)\s+(taking|starting|stopping|increasing|decreasing))\b/i,
  },
  {
    // "your report shows elevated cholesterol", "your results indicate anaemia"
    tag: "postgen.document_analysis",
    pattern:
      /\byour\s+(report|document|results?|test\s+results?|lab\s+results?|scan|x-ray|ecg|ultrasound)\s+(show?s?|indicate?s?|reveal?s?|found|demonstrates?|confirm?s?)\b/i,
  },
  {
    // "elevated cholesterol level", "abnormal glucose reading"
    tag: "postgen.abnormal_flag",
    pattern:
      /\b(elevated|raised|reduced|abnormal|outside\s+(the\s+)?normal\s+(range|limit))\s+(level|value|count|reading|result|cholesterol|glucose|pressure|rate)\b/i,
  },
  {
    // "6.5 mmol/L", "200 mg/dL" — clinical values with units
    tag: "postgen.value_with_unit",
    pattern:
      /\b\d+(?:\.\d+)?\s*(?:mg\/dl|mmol\/l|g\/dl|cells\/mm3|cells\/[µu]l|bpm|mmhg|ng\/ml|iu\/l|u\/l|mcg\/dl)\b/i,
  },
  {
    // "your dose should be increased", "the dosage needs to be adjusted"
    tag: "postgen.dose_change",
    pattern:
      /\b(?:dose|dosage)\s+(?:should|needs?\s+to|must|could)\s+(?:be\s+)?(?:increas|decreas|adjust|chang|lower|rais|reduc)/i,
  },
];

// ── Types ─────────────────────────────────────────────────────────────────────

export type Verdict = "allowed" | "blocked";
export type Language = "en" | "zu" | "st";

export interface AssistantInput {
  userId: string;
  message: string;
  language: Language;
}

export interface AssistantResult {
  verdict: Verdict;
  text: string;
  violations: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function matchPatterns(text: string, patterns: ViolationPattern[]): string[] {
  return patterns.filter((p) => p.pattern.test(text)).map((p) => p.tag);
}

function resolveFallback(language: Language, extraTags: string[]): { text: string; tags: string[] } {
  if (language !== "en" && !ZU_ST_TRANSLATIONS_REVIEWED) {
    logger.warn({ language }, "assistant: i18n.unreviewed_fallback — using English safe fallback");
    return {
      text: SAFE_FALLBACK.en,
      tags: [...extraTags, "i18n.unreviewed_fallback"],
    };
  }
  return { text: SAFE_FALLBACK[language] ?? SAFE_FALLBACK.en, tags: extraTags };
}

let _client: Anthropic | undefined;

function getClient(): Anthropic {
  return (_client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));
}

async function writeComplianceLog(params: {
  userId: string;
  language: Language;
  userMessage: string;
  modelResponse: string | null;
  verdict: Verdict;
  violationTags: string[];
}): Promise<void> {
  const { userId, language, userMessage, modelResponse, verdict, violationTags } = params;
  await pool.query(
    `INSERT INTO ai_compliance_log
       (user_id, session_id, language, user_message, model_response,
        verdict, violation_tags, system_prompt_sha256)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, $7)`,
    [
      userId,
      language,
      userMessage,
      modelResponse,
      verdict,
      violationTags,
      SYSTEM_PROMPT_SHA256,
    ],
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function askAssistant(input: AssistantInput): Promise<AssistantResult> {
  const { userId, message, language } = input;

  // ── No-key stub ──────────────────────────────────────────────────────────────
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.warn({ userId }, "assistant: ANTHROPIC_API_KEY not set — returning stub");
    return { verdict: "allowed", text: "[AI assistant stub — set ANTHROPIC_API_KEY to enable]", violations: [] };
  }

  // ── Pre-flight check ────────────────────────────────────────────────────────
  // Block obvious clinical-interpretation requests before touching the API.
  // Still mandatory to log — audit chain must have no gaps.
  const preflightViolations = matchPatterns(message, PRE_FLIGHT_PATTERNS);
  if (preflightViolations.length > 0) {
    const { text, tags } = resolveFallback(language, preflightViolations);
    await writeComplianceLog({
      userId,
      language,
      userMessage: message,
      modelResponse: null,
      verdict: "blocked",
      violationTags: tags,
    });
    return { verdict: "blocked", text, violations: tags };
  }

  // ── Anthropic API call ──────────────────────────────────────────────────────
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  let modelText: string;
  try {
    const response = await getClient().messages.create(
      {
        model: "claude-sonnet-4-6",
        max_tokens: 600,
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: message }],
      },
      { signal: controller.signal },
    );
    clearTimeout(timeout);
    modelText = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");
  } catch (err) {
    clearTimeout(timeout);
    const isAbort = err instanceof Error && err.name === "AbortError";
    const tags = isAbort ? ["timeout"] : ["api_error"];
    logger.error({ err, userId, isAbort }, "assistant: API call failed");
    const { text, tags: fallbackTags } = resolveFallback(language, tags);
    await writeComplianceLog({
      userId,
      language,
      userMessage: message,
      modelResponse: null,
      verdict: "blocked",
      violationTags: fallbackTags,
    });
    return { verdict: "blocked", text, violations: fallbackTags };
  }

  // ── Post-generation check ───────────────────────────────────────────────────
  // The system prompt alone cannot guarantee the model won't slip.
  // Every response is scanned — any violation replaces output with safe fallback.
  const postgenViolations = matchPatterns(modelText, POST_GEN_PATTERNS);
  if (postgenViolations.length > 0) {
    logger.warn({ userId, postgenViolations }, "assistant: post-generation violation blocked");
    const { text, tags } = resolveFallback(language, postgenViolations);
    await writeComplianceLog({
      userId,
      language,
      userMessage: message,
      modelResponse: modelText,
      verdict: "blocked",
      violationTags: tags,
    });
    return { verdict: "blocked", text, violations: tags };
  }

  // ── Disclaimer append ───────────────────────────────────────────────────────
  const DISCLAIMER =
    "\n\nThis is general health information only. Please discuss your personal health with your doctor.";
  const finalText = modelText.includes("general health information only")
    ? modelText
    : modelText + DISCLAIMER;

  await writeComplianceLog({
    userId,
    language,
    userMessage: message,
    modelResponse: finalText,
    verdict: "allowed",
    violationTags: [],
  });

  return { verdict: "allowed", text: finalText, violations: [] };
}
