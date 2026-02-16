import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockFs } from "../helpers/mock-fs.js";
import { futureIso, pastIso } from "../helpers/fixtures.js";

const mockFs = createMockFs();
vi.mock("fs", () => ({
  readFileSync: mockFs.readFileSync,
  writeFileSync: mockFs.writeFileSync,
  mkdirSync: mockFs.mkdirSync,
}));

const { loadState, saveState, clearExpiredState, STATE_PATH, DEFAULT_STATE, MAX_VERIFICATION_AGE_MS } = await import("../../src/state.js");

describe("loadState", () => {
  beforeEach(() => {
    mockFs.files.clear();
  });

  it("returns default state when file does not exist", () => {
    const state = loadState();
    expect(state).toEqual(DEFAULT_STATE);
  });

  it("returns default state when file contains invalid JSON", () => {
    mockFs.files.set(STATE_PATH, "not json");
    const state = loadState();
    expect(state).toEqual(DEFAULT_STATE);
  });

  it("returns default state when file contains null", () => {
    mockFs.files.set(STATE_PATH, "null");
    const state = loadState();
    expect(state).toEqual(DEFAULT_STATE);
  });

  it("loads state from file", () => {
    mockFs.files.set(STATE_PATH, JSON.stringify({ safe_mode: false, offense_count: 3 }));
    const state = loadState();
    expect(state.safe_mode).toBe(false);
    expect(state.offense_count).toBe(3);
  });

  it("merges with default state for missing fields", () => {
    mockFs.files.set(STATE_PATH, JSON.stringify({ offense_count: 5 }));
    const state = loadState();
    expect(state.safe_mode).toBe(true); // default
    expect(state.offense_count).toBe(5);
    expect(state.pending_verification).toBeNull(); // default
  });

  it("merges suspension with defaults", () => {
    mockFs.files.set(STATE_PATH, JSON.stringify({ suspension: { active: true } }));
    const state = loadState();
    expect(state.suspension.active).toBe(true);
    expect(state.suspension.reason).toBeNull(); // default
    expect(state.suspension.until).toBeNull(); // default
  });

  it("merges cooldowns with defaults", () => {
    mockFs.files.set(STATE_PATH, JSON.stringify({ cooldowns: { post_until: "2030-01-01T00:00:00Z" } }));
    const state = loadState();
    expect(state.cooldowns.post_until).toBe("2030-01-01T00:00:00Z");
    expect(state.cooldowns.comment_until).toBeNull(); // default
    expect(state.cooldowns.write_until).toBeNull(); // default
  });

  it("returns a fresh copy each time", () => {
    const state1 = loadState();
    const state2 = loadState();
    expect(state1).not.toBe(state2);
    expect(state1).toEqual(state2);
  });
});

describe("saveState", () => {
  beforeEach(() => {
    mockFs.files.clear();
  });

  it("writes state to the STATE_PATH", () => {
    const state = { ...DEFAULT_STATE, offense_count: 7 };
    saveState(state);
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      STATE_PATH,
      expect.stringContaining('"offense_count": 7'),
      "utf-8",
    );
  });

  it("creates directory recursively", () => {
    saveState(DEFAULT_STATE);
    expect(mockFs.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
  });

  it("round-trips through loadState", () => {
    const state = { ...DEFAULT_STATE, safe_mode: false, offense_count: 42 };
    saveState(state);
    const loaded = loadState();
    expect(loaded.safe_mode).toBe(false);
    expect(loaded.offense_count).toBe(42);
  });
});

describe("clearExpiredState", () => {
  it("clears expired pending verification", () => {
    const state = {
      ...DEFAULT_STATE,
      pending_verification: {
        source_tool: "test",
        detected_at: pastIso(),
        verification_code: "abc",
        challenge: null,
        prompt: null,
        expires_at: pastIso(),
      },
    };
    clearExpiredState(state);
    expect(state.pending_verification).toBeNull();
  });

  it("keeps non-expired pending verification", () => {
    const state = {
      ...DEFAULT_STATE,
      pending_verification: {
        source_tool: "test",
        detected_at: pastIso(),
        verification_code: "abc",
        challenge: null,
        prompt: null,
        expires_at: futureIso(),
      },
    };
    clearExpiredState(state);
    expect(state.pending_verification).not.toBeNull();
  });

  it("clears expired cooldowns", () => {
    const state = {
      ...DEFAULT_STATE,
      cooldowns: {
        post_until: pastIso(),
        comment_until: pastIso(),
        write_until: pastIso(),
      },
    };
    clearExpiredState(state);
    expect(state.cooldowns.post_until).toBeNull();
    expect(state.cooldowns.comment_until).toBeNull();
    expect(state.cooldowns.write_until).toBeNull();
  });

  it("keeps non-expired cooldowns", () => {
    const future = futureIso();
    const state = {
      ...DEFAULT_STATE,
      cooldowns: {
        post_until: future,
        comment_until: future,
        write_until: future,
      },
    };
    clearExpiredState(state);
    expect(state.cooldowns.post_until).toBe(future);
    expect(state.cooldowns.comment_until).toBe(future);
    expect(state.cooldowns.write_until).toBe(future);
  });

  it("clears zombie verification with null expires_at when detected_at exceeds max age", () => {
    const oldTimestamp = new Date(Date.now() - MAX_VERIFICATION_AGE_MS - 60_000).toISOString();
    const state = {
      ...DEFAULT_STATE,
      pending_verification: {
        source_tool: "test",
        detected_at: oldTimestamp,
        verification_code: null,
        challenge: null,
        prompt: null,
        expires_at: null,
      },
    };
    clearExpiredState(state);
    expect(state.pending_verification).toBeNull();
  });

  it("keeps recent verification with null expires_at when under max age", () => {
    const recentTimestamp = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    const state = {
      ...DEFAULT_STATE,
      pending_verification: {
        source_tool: "test",
        detected_at: recentTimestamp,
        verification_code: "abc",
        challenge: null,
        prompt: null,
        expires_at: null,
      },
    };
    clearExpiredState(state);
    expect(state.pending_verification).not.toBeNull();
  });

  it("immediately clears verification with no verification_code and no challenge regardless of age", () => {
    const recentTimestamp = new Date(Date.now() - 1_000).toISOString(); // 1 second ago
    const state = {
      ...DEFAULT_STATE,
      pending_verification: {
        source_tool: "moltbook_verify",
        detected_at: recentTimestamp,
        verification_code: null,
        challenge: null,
        prompt: "Include the verification_code from your content creation response",
        expires_at: null,
      },
    };
    clearExpiredState(state);
    expect(state.pending_verification).toBeNull();
  });

  it("keeps verification with a challenge but no verification_code", () => {
    const recentTimestamp = new Date(Date.now() - 1_000).toISOString();
    const state = {
      ...DEFAULT_STATE,
      pending_verification: {
        source_tool: "test",
        detected_at: recentTimestamp,
        verification_code: null,
        challenge: "What is 2 + 3?",
        prompt: null,
        expires_at: null,
      },
    };
    clearExpiredState(state);
    expect(state.pending_verification).not.toBeNull();
  });

  it("keeps verification with a verification_code but no challenge", () => {
    const recentTimestamp = new Date(Date.now() - 1_000).toISOString();
    const state = {
      ...DEFAULT_STATE,
      pending_verification: {
        source_tool: "test",
        detected_at: recentTimestamp,
        verification_code: "v123",
        challenge: null,
        prompt: null,
        expires_at: null,
      },
    };
    clearExpiredState(state);
    expect(state.pending_verification).not.toBeNull();
  });

  it("handles null cooldown values", () => {
    const state = {
      ...DEFAULT_STATE,
      cooldowns: {
        post_until: null,
        comment_until: null,
        write_until: null,
      },
    };
    clearExpiredState(state);
    expect(state.cooldowns.post_until).toBeNull();
    expect(state.cooldowns.comment_until).toBeNull();
    expect(state.cooldowns.write_until).toBeNull();
  });
});
