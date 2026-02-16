/**
 * @module util
 * Shared utility functions: JSON I/O, response parsing, and MCP tool result helpers.
 *
 * Includes heuristic extractors for suspension signals, verification challenges,
 * and retry-after values from API responses. These scan multiple body fields
 * because the Moltbook API uses varied terminology across endpoints.
 */
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

/** Normalized shape for all API responses (both success and failure). */
export interface ApiResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
}

/** MCP tool return type — always JSON-serialized text content. */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Returns the current time as an ISO-8601 string. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Parse JSON without throwing; returns `fallback` on any parse error. */
export function safeJsonParse<T>(input: string, fallback: T): T {
  try {
    return JSON.parse(input) as T;
  } catch {
    return fallback;
  }
}

/** Read and parse a JSON file from disk, returning `fallback` if missing or malformed. */
export function readJson<T>(filePath: string, fallback: T): T {
  try {
    return safeJsonParse(readFileSync(filePath, "utf-8"), fallback);
  } catch {
    return fallback;
  }
}

/** Atomically write JSON to disk, creating parent directories if needed. */
export function writeJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

/** Validates that a value is a non-empty string; throws with `field` name on failure. */
export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

/** Returns true if the ISO timestamp is in the future (used for cooldown checks). */
export function isFutureIso(value: string | null | undefined): boolean {
  if (!value) return false;
  const ts = Date.parse(value);
  return Number.isFinite(ts) && ts > Date.now();
}

/** Wraps a payload as an MCP-compliant tool result with JSON-serialized text content. */
export function makeResult(payload: Record<string, unknown>, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

/**
 * Recursively collects all string values from a nested object/array structure.
 * Depth-limited to 5 to prevent infinite recursion on circular structures.
 */
export function collectStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 5 || value === null || value === undefined) return out;
  if (typeof value === "string") { out.push(value); return out; }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return out;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, out, depth + 1);
  }
  return out;
}

/**
 * Extracts retry-after duration (in seconds) from an API response.
 * Checks body fields first (seconds, minutes, generic), then the Retry-After header
 * (supports both delta-seconds and HTTP-date formats).
 */
export function extractRetrySeconds(response: ApiResponse): number {
  const body = response.body ?? {};
  const fromBody =
    Number(body.retry_after_seconds) ||
    (Number(body.retry_after_minutes) ? Number(body.retry_after_minutes) * 60 : 0) ||
    Number(body.retry_after) ||
    0;
  if (Number.isFinite(fromBody) && fromBody > 0) return Math.floor(fromBody);
  const header = response.headers?.get?.("retry-after");
  if (!header) return 0;
  const asNum = Number(header);
  if (Number.isFinite(asNum) && asNum > 0) return Math.floor(asNum);
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) return Math.max(0, Math.floor((asDate - Date.now()) / 1000));
  return 0;
}

/**
 * Detects account suspension/ban signals in an API response.
 * Scans both the `status` field and all string values in the body because
 * the API uses varied terminology ("suspended", "temporary ban", "temp ban").
 */
export function extractSuspension(response: ApiResponse): { reason: string; until: string | null } | null {
  const body = response.body ?? {};
  const status = String(body.status ?? "").toLowerCase();
  const text = collectStrings(body).join(" | ").toLowerCase();
  const active =
    status.includes("suspend") ||
    status.includes("ban") ||
    text.includes("suspended") ||
    text.includes("temporary ban") ||
    text.includes("temp ban");
  if (!active) return null;
  return {
    reason: String(body.reason ?? body.error ?? body.message ?? "Account suspended"),
    until: (body.suspended_until ?? body.ban_expires_at ?? body.until ?? null) as string | null,
  };
}

/**
 * Detects a verification challenge in an API response.
 * Uses a two-gate heuristic: first scans all strings for challenge keywords,
 * then only triggers on error responses (status >= 400) unless a verification
 * code is explicitly present. This avoids false positives on successful responses
 * that happen to mention "challenge" in content.
 */
export function extractVerification(response: ApiResponse): { verification_code: string | null; challenge: string | null; prompt: string | null; expires_at: string | null } | null {
  const body = response.body ?? {};
  const text = collectStrings(body).join(" | ");
  const hasKeyword = /verification|verify|challenge|math|captcha/i.test(text);
  const challengeObj = body.challenge as Record<string, unknown> | undefined;
  const data = body.data as Record<string, unknown> | undefined;
  const code =
    body.verification_code ??
    body.verificationCode ??
    challengeObj?.verification_code ??
    challengeObj?.code ??
    data?.verification_code ??
    null;
  if (!hasKeyword && !code) return null;
  // Gate: don't treat successful responses as challenges unless a code was returned
  if (response.status < 400 && !code) return null;
  const challengeText = (
    challengeObj?.challenge ?? challengeObj?.prompt ?? challengeObj?.question ??
    body.challenge_text ?? body.math_challenge ?? body.question ??
    null
  ) as string | null;
  // Keywords alone without actionable data means an informational error, not a real challenge
  if (!code && typeof challengeText !== "string") return null;
  return {
    verification_code: code ? String(code) : null,
    challenge: typeof challengeText === "string" ? challengeText : null,
    prompt: (challengeObj?.prompt ?? body.hint ?? body.message ?? body.error ?? null) as string | null,
    expires_at: (challengeObj?.expires_at ?? body.expires_at ?? null) as string | null,
  };
}
