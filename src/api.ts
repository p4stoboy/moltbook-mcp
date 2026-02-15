/**
 * @module api
 * HTTP transport layer for Moltbook API requests.
 *
 * Security: enforces HTTPS-only with host pinning to www.moltbook.com,
 * validates paths against an allowlist, and prevents path traversal.
 * Network errors are caught and returned as synthetic status-0 responses
 * so callers never need to handle thrown fetch exceptions.
 */
import { CREDENTIALS_PATH } from "./state.js";
import { readJson } from "./util.js";
import type { ApiResponse } from "./util.js";

const DEFAULT_BASE_URL = "https://www.moltbook.com/api/v1";

/** Restricts raw API requests to known resource paths, preventing arbitrary endpoint access. */
export const RAW_PATH_ALLOWLIST = /^\/(agents|posts|comments|submolts|feed|search|verify|challenges)(\/|$)/;

/**
 * Validates and normalizes a user-provided base URL.
 * Enforces HTTPS and pins the hostname to www.moltbook.com to prevent
 * credential leakage to arbitrary servers.
 */
export function normalizeBaseUrl(raw: string): string {
  const parsed = new URL(raw);
  if (parsed.protocol !== "https:") throw new Error("Moltbook base URL must use https");
  if (parsed.hostname !== "www.moltbook.com") throw new Error("Moltbook base URL host must be www.moltbook.com");
  let path = parsed.pathname.replace(/\/+$/, "");
  if (!path || path === "/") path = "/api/v1";
  if (!path.startsWith("/api/v1")) throw new Error("Moltbook base URL must target /api/v1");
  return `${parsed.origin}${path}`;
}

const BASE_URL = normalizeBaseUrl(process.env.MOLTBOOK_API_BASE ?? DEFAULT_BASE_URL);

/** Sanitizes a relative API path: rejects absolute URLs and path traversal. */
export function normalizePath(path: string): string {
  if (typeof path !== "string" || !path.trim()) throw new Error("path is required");
  if (path.includes("://")) throw new Error("absolute URLs are not allowed");
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (normalized.includes("..")) throw new Error("path traversal is not allowed");
  return normalized;
}

/** Resolves API key from env var first, then falls back to credentials file on disk. */
export function getApiKey(): string {
  const envKey = process.env.MOLTBOOK_API_KEY;
  if (envKey && envKey.trim()) return envKey.trim();
  const creds = readJson<Record<string, unknown> | null>(CREDENTIALS_PATH, null);
  // Support multiple key naming conventions the API/docs may reference
  const fileKey = creds?.api_key ?? creds?.MOLTBOOK_API_KEY ?? creds?.token;
  if (fileKey && String(fileKey).trim()) return String(fileKey).trim();
  throw new Error("Missing API key. Set MOLTBOOK_API_KEY or ~/.config/moltbook/credentials.json with api_key.");
}

export interface ApiRequestOptions {
  query?: Record<string, unknown> | null;
  body?: Record<string, unknown> | null;
}

/**
 * Performs an authenticated HTTP request against the Moltbook API.
 * Network errors are caught and returned as `{ ok: false, status: 0 }` responses
 * rather than thrown, so callers can handle all outcomes uniformly.
 */
export async function apiRequest(method: string, path: string, options: ApiRequestOptions = {}): Promise<ApiResponse> {
  const normalizedPath = normalizePath(path);
  const url = new URL(`${BASE_URL}${normalizedPath}`);
  if (options.query && typeof options.query === "object") {
    for (const [k, v] of Object.entries(options.query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${getApiKey()}` };
  let body: string | null = null;
  if (options.body !== undefined && options.body !== null) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  try {
    const res = await fetch(url, { method, headers, body });
    const contentType = res.headers.get("content-type") ?? "";
    const parsed = contentType.includes("application/json")
      ? await res.json().catch(() => ({})) as Record<string, unknown>
      : { raw: await res.text().catch(() => "") };
    return { ok: res.ok, status: res.status, headers: res.headers, body: parsed };
  } catch (error: unknown) {
    // Synthesize a status-0 response so callers don't need try/catch for network failures
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      headers: new Headers(),
      body: { error: "network_error", message },
    };
  }
}
