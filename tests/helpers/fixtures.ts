import type { MoltbookState } from "../../src/state.js";
import type { ApiResponse } from "../../src/util.js";

export function makeState(overrides: Partial<MoltbookState> = {}): MoltbookState {
  return {
    safe_mode: true,
    pending_verification: null,
    suspension: { active: false, reason: null, until: null, seen_at: null },
    cooldowns: { post_until: null, comment_until: null, write_until: null },
    offense_count: 0,
    last_write_at: null,
    ...overrides,
  };
}

export function makeApiResponse(overrides: Partial<ApiResponse> = {}): ApiResponse {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: {},
    ...overrides,
  };
}

export function futureIso(ms = 60_000): string {
  return new Date(Date.now() + ms).toISOString();
}

export function pastIso(ms = 60_000): string {
  return new Date(Date.now() - ms).toISOString();
}
