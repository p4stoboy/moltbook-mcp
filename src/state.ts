import { homedir } from "os";
import { join } from "path";
import { isFutureIso, readJson, writeJson } from "./util.js";

export interface PendingVerification {
  source_tool: string;
  detected_at: string;
  verification_code: string | null;
  challenge: string | null;
  prompt: string | null;
  expires_at: string | null;
}

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

export function saveState(state: MoltbookState): void {
  writeJson(STATE_PATH, state);
}

export function clearExpiredState(state: MoltbookState): void {
  if (state.pending_verification?.expires_at) {
    const ts = Date.parse(state.pending_verification.expires_at);
    if (Number.isFinite(ts) && ts < Date.now()) state.pending_verification = null;
  }
  for (const key of ["post_until", "comment_until", "write_until"] as const) {
    if (!isFutureIso(state.cooldowns[key])) state.cooldowns[key] = null;
  }
}
