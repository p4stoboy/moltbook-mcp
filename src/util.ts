import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

export interface ApiResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function safeJsonParse<T>(input: string, fallback: T): T {
  try {
    return JSON.parse(input) as T;
  } catch {
    return fallback;
  }
}

export function readJson<T>(filePath: string, fallback: T): T {
  try {
    return safeJsonParse(readFileSync(filePath, "utf-8"), fallback);
  } catch {
    return fallback;
  }
}

export function writeJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

export function isFutureIso(value: string | null | undefined): boolean {
  if (!value) return false;
  const ts = Date.parse(value);
  return Number.isFinite(ts) && ts > Date.now();
}

export function makeResult(payload: Record<string, unknown>, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError };
}

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
  if (response.status < 400 && !code) return null;
  const challengeText = (
    challengeObj?.challenge ?? challengeObj?.prompt ?? challengeObj?.question ??
    body.challenge_text ?? body.math_challenge ?? body.question ??
    null
  ) as string | null;
  return {
    verification_code: code ? String(code) : null,
    challenge: typeof challengeText === "string" ? challengeText : null,
    prompt: (challengeObj?.prompt ?? body.hint ?? body.message ?? body.error ?? null) as string | null,
    expires_at: (challengeObj?.expires_at ?? body.expires_at ?? null) as string | null,
  };
}
