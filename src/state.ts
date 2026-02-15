/**
 * @module state
 * Persistent local state management for the Moltbook MCP server.
 *
 * Tracks write guards (suspension, pending verification, cooldowns) and
 * safe-mode throttling. State is persisted to disk as JSON so it survives
 * server restarts and is shared across tool invocations.
 */
import { homedir } from "os";
import { join } from "path";
import { isFutureIso, readJson, writeJson } from "./util.js";

/** Captured when a write triggers a verification challenge that hasn't been resolved yet. */
export interface PendingVerification {
  source_tool: string;
  detected_at: string;
  verification_code: string | null;
  challenge: string | null;
  prompt: string | null;
  expires_at: string | null;
}

/**
 * Full local state for the MCP server.
 * - `safe_mode`: rate-limits writes to one per SAFE_WRITE_INTERVAL_MS to avoid accidental spam
 * - `pending_verification`: blocks all writes until the challenge is solved
 * - `suspension`: blocks all writes when the account is suspended/banned
 * - `cooldowns`: per-write-type rate-limit tracking from API retry-after headers
 * - `offense_count`: incremented on each failed verification attempt
 * - `last_write_at`: timestamp of last successful write (for safe-mode throttling)
 */
export interface MoltbookState {
  safe_mode: boolean;
  pending_verification: PendingVerification | null;
  suspension: { active: boolean; reason: string | null; until: string | null; seen_at: string | null };
  cooldowns: { post_until: string | null; comment_until: string | null; write_until: string | null };
  offense_count: number;
  last_write_at: string | null;
}

export const CREDENTIALS_PATH = join(homedir(), ".config", "moltbook", "credentials.json");
export const STATE_PATH = join(homedir(), ".config", "moltbook", "mcp_state.json");

export const DEFAULT_STATE: MoltbookState = {
  safe_mode: true,
  pending_verification: null,
  suspension: { active: false, reason: null, until: null, seen_at: null },
  cooldowns: { post_until: null, comment_until: null, write_until: null },
  offense_count: 0,
  last_write_at: null,
};

/** Loads state from disk, merging with defaults to handle schema additions gracefully. */
export function loadState(): MoltbookState {
  const state = readJson<Partial<MoltbookState> | null>(STATE_PATH, null);
  if (!state || typeof state !== "object") return { ...DEFAULT_STATE };
  return {
    ...DEFAULT_STATE,
    ...state,
    suspension: { ...DEFAULT_STATE.suspension, ...(state.suspension ?? {}) },
    cooldowns: { ...DEFAULT_STATE.cooldowns, ...(state.cooldowns ?? {}) },
  };
}

/** Persists state to disk, creating the config directory if needed. */
export function saveState(state: MoltbookState): void {
  writeJson(STATE_PATH, state);
}

/** Clears expired verification challenges and cooldowns so stale blocks don't persist. */
export function clearExpiredState(state: MoltbookState): void {
  if (state.pending_verification?.expires_at) {
    const ts = Date.parse(state.pending_verification.expires_at);
    if (Number.isFinite(ts) && ts < Date.now()) state.pending_verification = null;
  }
  for (const key of ["post_until", "comment_until", "write_until"] as const) {
    if (!isFutureIso(state.cooldowns[key])) state.cooldowns[key] = null;
  }
}
