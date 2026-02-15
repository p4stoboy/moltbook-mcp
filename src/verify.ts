/**
 * @module verify
 * Challenge solver for Moltbook verification challenges.
 *
 * Algorithm overview:
 * Challenges arrive as either digit expressions ("3 + 5 * 2") or obfuscated
 * English number-word sentences ("What is thuuurteen adddds sevvven?").
 *
 * Two-path solver design:
 * 1. **Digit path** (fast): regex-extracts arithmetic expressions with digits and
 *    operators, evaluates via `Function()`. Tried first as a quick win.
 * 2. **Word path** (robust): normalizes text by stripping non-alpha chars and
 *    collapsing consecutive duplicate letters ("thuuurteen" -> "thirtein"),
 *    then fuzzy-matches tokens against number-word dictionaries using
 *    subsequence matching with tight length bounds. Detects the arithmetic
 *    operation from keywords in the original (non-deduped) text, then computes.
 *
 * The dedup strategy collapses repeated letters ("eee" -> "e") to handle the
 * API's intentional character-stretching obfuscation. Fuzzy matching uses
 * `candidate.length <= word.length + 2` to prevent false positives (e.g.
 * "antena" should not match "ten" even though "ten" is a subsequence).
 * Filler words exclude operation keywords so they act as natural separators
 * between number operands during extraction.
 */
import { apiRequest, normalizePath } from "./api.js";
import type { ApiResponse } from "./util.js";
import { clearExpiredState, loadState, saveState } from "./state.js";
import { extractSuspension, extractVerification, makeResult, nowIso } from "./util.js";
import type { ToolResult } from "./util.js";

// ── Helpers ──

/**
 * Collapse consecutive duplicate letters: "oo" -> "o", "ee" -> "e".
 * Handles the API's character-stretching obfuscation (e.g. "thuuurteen").
 */
function dedup(s: string): string {
  return s.replace(/(.)\1+/g, "$1");
}

/**
 * Build a lookup dictionary with deduped keys and a longest-first sorted key
 * list for greedy fuzzy matching.
 */
function buildDict(src: Record<string, number>): { dict: Record<string, number>; keys: string[] } {
  const dict: Record<string, number> = {};
  for (const [k, v] of Object.entries(src)) dict[dedup(k)] = v;
  return { dict, keys: Object.keys(dict).sort((a, b) => b.length - a.length) };
}

// ── Number word dictionaries (keys are deduped to match normalized text) ──

/** Ones and teens: 0-19 as English words (source form before dedup). */
const ONES_SRC: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};

/** Tens: 20-90 as English words (source form before dedup). */
const TENS_SRC: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const ONES = buildDict(ONES_SRC);
const TENS = buildDict(TENS_SRC);

// ── Filler words to skip during number extraction ──
// These are in their DEDUPED form (matching normalized text).
// Operation keywords (adds, minus, times, etc.) are intentionally EXCLUDED
// so they act as natural separators between number words.

/**
 * Words to skip when scanning for number tokens. Stored in deduped form.
 * Operation keywords are intentionally omitted so "adds", "times", etc.
 * break the token stream and separate number operands.
 */
const FILLER = new Set([
  "um", "uh", "uhm", "like", "so", "but", "the", "a", "an", "is", "are",
  "at", "of", "in", "its", "it", "this", "that", "and", "or", "to", "by",
  "for", "on", "if", "be", "do", "has", "have", "was", "were", "with",
  "what", "whats", "how", "much", "many", "force", "total",
  "newtons", "notons", "neutons", "netons",  // deduped forms of "newtons" variants
  "meters", "centimeters",
  "claw", "claws", "antena", "touch",        // "antena" = deduped "antenna"
  "lobster", "lobsters", "sped", "then", "when", "from",
  "cmentiners",                               // deduped garbled "centimeters"
].map(dedup));

// ── Text normalization ──

export function normalizeChallenge(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")       // strip all non-alpha non-space
    .replace(/(.)\1+/g, "$1")       // collapse consecutive duplicate letters
    .replace(/\s+/g, " ")           // collapse whitespace
    .trim();
}

// ── Fuzzy matching via subsequence check ──

/** Returns true if every character of `word` appears in `candidate` in order. */
function isSubsequence(word: string, candidate: string): boolean {
  let wi = 0;
  for (let ci = 0; ci < candidate.length && wi < word.length; ci++) {
    if (candidate[ci] === word[wi]) wi++;
  }
  return wi === word.length;
}

/**
 * Fuzzy-matches a candidate token against a number-word dictionary.
 * Exact match is tried first, then subsequence matching with tight length bounds
 * (word.length +2 / -1) to prevent false positives like "antena" matching "ten".
 */
function fuzzyMatch(candidate: string, db: { dict: Record<string, number>; keys: string[] }): { word: string; value: number } | null {
  if (candidate in db.dict) return { word: candidate, value: db.dict[candidate]! };
  for (const word of db.keys) {
    // Length bounds: candidate can be at most word.length + 2 chars longer (prevents "antena" matching "ten")
    // and at least word.length - 1 chars
    if (candidate.length <= word.length + 2 && candidate.length >= word.length - 1
        && isSubsequence(word, candidate)) {
      return { word, value: db.dict[word]! };
    }
  }
  return null;
}

// ── Extract numbers from normalized text ──

export function extractNumbers(text: string): number[] {
  const tokens = text.split(" ").filter(t => t.length > 0 && !FILLER.has(t));
  const numbers: number[] = [];
  let i = 0;

  while (i < tokens.length) {
    let matched = false;

    // Try joining 3, 2, or 1 consecutive tokens (prefer greedy multi-token joins for split words)
    for (const span of [3, 2, 1]) {
      if (i + span > tokens.length) continue;
      const candidate = tokens.slice(i, i + span).join("");

      // Check TENS first (to handle compound like "thirty five")
      const tensMatch = fuzzyMatch(candidate, TENS);
      if (tensMatch) {
        let onesVal = 0;
        let onesSpan = 0;
        // Peek ahead for a ones word (1-9) to form compound number
        for (const os of [1, 2]) {
          if (i + span + os > tokens.length) continue;
          const onesCand = tokens.slice(i + span, i + span + os).join("");
          const onesMatch = fuzzyMatch(onesCand, ONES);
          if (onesMatch && onesMatch.value >= 1 && onesMatch.value <= 9) {
            onesVal = onesMatch.value;
            onesSpan = os;
            break;
          }
        }
        numbers.push(tensMatch.value + onesVal);
        i += span + onesSpan;
        matched = true;
        break;
      }

      // Check ONES/teens
      const onesMatch = fuzzyMatch(candidate, ONES);
      if (onesMatch) {
        numbers.push(onesMatch.value);
        i += span;
        matched = true;
        break;
      }
    }

    if (!matched) i++;
  }

  return numbers;
}

// ── Operation detection ──
// Runs on lightly-normalized text (lowercased, non-alpha stripped, whitespace collapsed,
// but WITHOUT letter dedup — so "subtracts" stays "subtracts", not "subtracts" → "subtracts").

export type Op = "add" | "sub" | "mul" | "div";

/**
 * Light normalization for operation detection: lowercases and strips non-alpha,
 * but does NOT dedup letters. This preserves word boundaries like "subtracts"
 * so operation-keyword regexes match reliably.
 */
function lightNormalize(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
}

export function detectOperation(text: string): Op {
  if (/\b(times|multipl\w*|product)\b/.test(text)) return "mul";
  if (/\b(divid\w*|ratio|split)\b/.test(text)) return "div";
  if (/\b(subtract\w*|slow\w*|remain\w*|minus|less|reduce\w*)\b/.test(text)) return "sub";
  return "add";
}

// ── Compute result ──

export function compute(numbers: number[], op: Op): number | null {
  if (numbers.length < 2) return null;
  switch (op) {
    case "add": return numbers.reduce((a, b) => a + b, 0);
    case "sub": return numbers.reduce((a, b) => a - b);
    case "mul": return numbers.reduce((a, b) => a * b);
    case "div": return numbers[1]! === 0 ? null : numbers[0]! / numbers[1]!;
  }
}

// ── Digit-based expression solver (fast path) ──

export function solveDigitExpression(challenge: string): string | null {
  const allMatches = [...challenge.matchAll(/[\d+\-*/().^ ]+/g)];
  if (!allMatches.length) return null;

  const candidates = allMatches
    .map(m => m[0].trim())
    .filter(s => s.length > 0 && /[+\-*/^]/.test(s) && /\d/.test(s));
  if (!candidates.length) return null;

  const expr = candidates.reduce((a, b) => a.length >= b.length ? a : b);
  if (expr.length > 200 || !/^[\d+\-*/().^ ]+$/.test(expr)) return null;

  try {
    const jsExpr = expr.replace(/\^/g, "**");
    const result = Function(`"use strict"; return (${jsExpr})`)() as number;
    if (!Number.isFinite(result)) return null;
    return result.toFixed(2);
  } catch {
    return null;
  }
}

// ── Main solver: two-path approach ──

export function solveChallenge(challenge: string): string | null {
  // Fast path: try numeric digit expression
  const digitResult = solveDigitExpression(challenge);
  if (digitResult !== null) return digitResult;

  // Word path: parse obfuscated English number words
  const normalized = normalizeChallenge(challenge);
  const numbers = extractNumbers(normalized);
  if (numbers.length < 2) return null;
  const op = detectOperation(lightNormalize(challenge));
  const result = compute(numbers, op);
  if (result === null || !Number.isFinite(result)) return null;
  return result.toFixed(2);
}

export interface AutoVerifyResult {
  success: boolean;
  response: ApiResponse;
}

/**
 * Attempts to auto-solve a verification challenge and POST the answer.
 * Returns { success, response } if an answer was computed and submitted,
 * or null if the challenge couldn't be parsed/solved.
 */
export async function autoVerify(
  verification: { verification_code: string | null; challenge: string | null; prompt: string | null },
  body: Record<string, unknown>,
): Promise<AutoVerifyResult | null> {
  // Find challenge text from all possible sources
  const challengeText =
    verification.challenge ??
    verification.prompt ??
    (typeof body.challenge === "string" ? body.challenge : null) ??
    (typeof body.math_challenge === "string" ? body.math_challenge : null) ??
    (typeof body.question === "string" ? body.question : null) ??
    null;

  if (!challengeText) return null;

  const answer = solveChallenge(challengeText);
  if (!answer) return null;

  const verifyBody: Record<string, string> = { answer };
  if (verification.verification_code) {
    verifyBody.verification_code = verification.verification_code;
  }

  const response = await apiRequest("POST", "/verify", { body: verifyBody });
  return { success: response.ok, response };
}

/**
 * MCP tool handler for manual verification.
 * Accepts a challenge string (auto-solved) or a raw answer, formats it,
 * POSTs to /verify, and updates local state based on the outcome.
 */
export async function handleVerify(args: Record<string, unknown>): Promise<ToolResult> {
  const state = loadState();
  clearExpiredState(state);

  const rawAnswer = args.answer ?? args.solution;
  const rawChallenge = typeof args.challenge === "string" ? args.challenge : undefined;

  // If a challenge string is provided, try auto-solving it
  let answer: string | undefined;
  if (rawChallenge && typeof rawChallenge === "string") {
    const solved = solveChallenge(rawChallenge);
    if (solved) answer = solved;
  }
  // Fall back to the user-provided answer
  if (!answer && rawAnswer !== undefined && rawAnswer !== null && String(rawAnswer).trim() !== "") {
    answer = String(rawAnswer).trim();
    // If the answer looks numeric, format to 2 decimal places
    const asNum = Number(answer);
    if (Number.isFinite(asNum)) {
      answer = asNum.toFixed(2);
    }
  }

  if (!answer) {
    return makeResult({ ok: false, tool: "moltbook_verify", error: { code: "missing_answer", message: "Provide answer or challenge text to auto-solve." } }, true);
  }

  const verificationCode = (args.verification_code as string | undefined) ?? state.pending_verification?.verification_code ?? null;
  const body: Record<string, string> = { answer };
  if (verificationCode) body.verification_code = verificationCode;
  if (args.challenge_id) body.challenge_id = String(args.challenge_id);

  const endpoint = args.path ? normalizePath(String(args.path)) : "/verify";
  const response = await apiRequest("POST", endpoint, { body });

  const suspension = extractSuspension(response);
  if (suspension) {
    state.suspension = { active: true, reason: suspension.reason, until: suspension.until ? String(suspension.until) : null, seen_at: nowIso() };
  }

  const verification = extractVerification(response);
  if (verification) {
    state.pending_verification = { source_tool: "moltbook_verify", detected_at: nowIso(), ...verification };
    state.offense_count += 1;
  } else if (response.ok) {
    state.pending_verification = null;
    state.last_write_at = nowIso();
  }
  saveState(state);

  if (verification) {
    return makeResult({
      ok: false,
      tool: "moltbook_verify",
      error: { code: "verification_still_required", message: "Verification did not clear; check code/answer and retry carefully." },
      pending_verification: state.pending_verification,
      http: { status: response.status, body: response.body },
    });
  }
  if (!response.ok) {
    return makeResult({
      ok: false,
      tool: "moltbook_verify",
      error: { code: "verify_failed", message: (response.body?.error ?? response.body?.message ?? `Verification failed with status ${response.status}`) as string },
      http: { status: response.status, body: response.body },
    }, true);
  }
  return makeResult({ ok: true, tool: "moltbook_verify", verified: true, endpoint, data: response.body });
}
