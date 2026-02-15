/**
 * @module guards
 * Write-guard layer that sits between MCP tool handlers and the raw API.
 *
 * Every state-mutating tool call flows through `runApiTool`, which:
 * 1. Checks local write blocks (suspension > verification > cooldown > safe-mode)
 * 2. Executes the API request
 * 3. Scans the response for suspension signals and updates state
 * 4. Extracts retry-after durations and sets per-type cooldowns
 * 5. Detects verification challenges, attempts auto-solve, and falls back to blocking
 *
 * This ensures the agent self-throttles and never spams the API after a block.
 */
import { apiRequest } from "./api.js";
import type { ApiRequestOptions } from "./api.js";
import { clearExpiredState, loadState, saveState } from "./state.js";
import {
  extractRetrySeconds,
  extractSuspension,
  extractVerification,
  isFutureIso,
  makeResult,
  nowIso,
} from "./util.js";
import { autoVerify } from "./verify.js";
import type { MoltbookState } from "./state.js";
import type { ToolResult } from "./util.js";

/** Minimum interval between writes in safe mode (prevents accidental spam). */
export const SAFE_WRITE_INTERVAL_MS = 15000;

/**
 * Tools that mutate server state. Includes aliases (e.g. moltbook_comment)
 * and moltbook_raw_request since non-GET raw requests can write data.
 */
export const WRITE_TOOLS = new Set([
  "moltbook_post_create",
  "moltbook_post_delete",
  "moltbook_comment_create",
  "moltbook_comment",
  "moltbook_vote",
  "moltbook_vote_post",
  "moltbook_vote_comment",
  "moltbook_submolt_create",
  "moltbook_subscribe",
  "moltbook_unsubscribe",
  "moltbook_follow",
  "moltbook_unfollow",
  "moltbook_profile_update",
  "moltbook_setup_owner_email",
  "moltbook_raw_request",
]);

export interface WriteBlockResult {
  code: string;
  message: string;
  until?: string | null;
}

/** Maps a tool name to its write category for per-type cooldown tracking. */
export function classifyWriteKind(toolName: string): string {
  if (toolName.includes("post")) return "post";
  if (toolName.includes("comment")) return "comment";
  if (toolName.includes("vote")) return "vote";
  return "write";
}

/**
 * Checks whether writes are currently blocked, in priority order:
 * 1. Account suspension (hard block)
 * 2. Pending verification challenge (must solve first)
 * 3. API-imposed cooldown (from retry-after headers)
 * 4. Safe-mode write interval (local throttle)
 * Returns null if the write is allowed.
 */
export function checkWriteBlocked(state: MoltbookState, _toolName: string): WriteBlockResult | null {
  if (state.suspension?.active) {
    return { code: "account_suspended", message: state.suspension.reason ?? "Account suspended", until: state.suspension.until ?? null };
  }
  if (state.pending_verification) {
    return { code: "blocked_by_pending_verification", message: "Verification challenge pending. Call moltbook_challenge_status then moltbook_verify." };
  }
  if (isFutureIso(state.cooldowns?.write_until)) {
    return { code: "write_cooldown_active", message: `Write cooldown active until ${state.cooldowns.write_until}` };
  }
  if (state.safe_mode && state.last_write_at && Date.now() - Date.parse(state.last_write_at) < SAFE_WRITE_INTERVAL_MS) {
    return { code: "safe_mode_write_interval", message: `Safe mode allows one write every ${Math.round(SAFE_WRITE_INTERVAL_MS / 1000)}s.` };
  }
  return null;
}

export interface RunApiToolOptions extends ApiRequestOptions {
  isWrite?: boolean;
}

/**
 * Central orchestrator for all tool API calls.
 * Flow: guard check -> API request -> suspension detection -> cooldown extraction
 *       -> verification detection -> auto-verify attempt -> fallback blocking
 */
export async function runApiTool(toolName: string, method: string, path: string, options: RunApiToolOptions = {}): Promise<ToolResult> {
  const state = loadState();
  clearExpiredState(state);
  const isWrite = options.isWrite === true || WRITE_TOOLS.has(toolName);

  // Pre-flight: block writes if any guard condition is active
  if (isWrite) {
    const blocked = checkWriteBlocked(state, toolName);
    if (blocked) {
      saveState(state);
      return makeResult({ ok: false, tool: toolName, error: blocked }, true);
    }
  }

  const response = await apiRequest(method, path, options);

  // Post-flight: scan response for suspension signals
  const suspension = extractSuspension(response);
  if (suspension) {
    state.suspension = { active: true, reason: suspension.reason, until: suspension.until ? String(suspension.until) : null, seen_at: nowIso() };
  } else if (toolName === "moltbook_status" && response.ok) {
    // A successful status check with no suspension signals clears a prior suspension
    const status = String(response.body?.status ?? "").toLowerCase();
    if (!status.includes("suspend") && !status.includes("ban")) {
      state.suspension = { active: false, reason: null, until: null, seen_at: nowIso() };
    }
  }

  // Extract rate-limit info and set per-type cooldowns
  if (isWrite) {
    const retrySeconds = extractRetrySeconds(response);
    if (retrySeconds > 0) {
      const until = new Date(Date.now() + retrySeconds * 1000).toISOString();
      state.cooldowns.write_until = until;
      const kind = classifyWriteKind(toolName);
      if (kind === "post") state.cooldowns.post_until = until;
      if (kind === "comment") state.cooldowns.comment_until = until;
    }
  }

  // Detect verification challenges on write responses
  const verification = isWrite ? extractVerification(response) : null;
  if (verification) {
    // Try auto-solve before blocking
    const autoResult = await autoVerify(verification, response.body);
    if (autoResult?.success) {
      // Challenge solved transparently — treat as successful write
      state.last_write_at = nowIso();
      saveState(state);
      return makeResult({
        ok: true,
        tool: toolName,
        data: autoResult.response.body,
        auto_verified: true,
        original_write_response: response.body,
        http: { status: autoResult.response.status },
      });
    }
    // Auto-solve failed — fall back to blocking with attempt tracking
    if (autoResult) {
      // Solver produced an answer but API rejected it
      state.pending_verification = {
        source_tool: toolName, detected_at: nowIso(), ...verification,
        attempt_count: 1,
        auto_attempted: true,
        failed_answers: [autoResult.attemptedAnswer],
      };
    } else {
      // Solver couldn't parse the challenge
      state.pending_verification = {
        source_tool: toolName, detected_at: nowIso(), ...verification,
        attempt_count: 0,
        auto_attempted: false,
        failed_answers: [],
      };
    }
  }
  if (response.ok && isWrite && !verification) state.last_write_at = nowIso();
  saveState(state);

  if (verification) {
    return makeResult({
      ok: false,
      tool: toolName,
      error: { code: "verification_required", message: "Verification is required before additional writes. Auto-solve failed; use moltbook_verify manually." },
      pending_verification: state.pending_verification,
      http: { status: response.status, body: response.body },
    });
  }
  if (!response.ok) {
    return makeResult({
      ok: false,
      tool: toolName,
      error: {
        code: response.status === 429 ? "rate_limited" : "request_failed",
        message: response.body?.error ?? response.body?.message ?? `Request failed with status ${response.status}`,
      },
      retry_after_seconds: extractRetrySeconds(response) || null,
      http: { status: response.status, body: response.body },
    }, true);
  }
  return makeResult({ ok: true, tool: toolName, data: response.body, http: { status: response.status } });
}
