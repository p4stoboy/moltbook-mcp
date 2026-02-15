import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockFs } from "../helpers/mock-fs.js";
import { makeState, futureIso, pastIso } from "../helpers/fixtures.js";

const mockFs = createMockFs();
vi.mock("fs", () => ({
  readFileSync: mockFs.readFileSync,
  writeFileSync: mockFs.writeFileSync,
  mkdirSync: mockFs.mkdirSync,
}));

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  mockFs.files.clear();
  process.env = { ...originalEnv };
  process.env.MOLTBOOK_API_BASE = "https://www.moltbook.com/api/v1";
  process.env.MOLTBOOK_API_KEY = "test-key";
});

afterEach(() => {
  process.env = originalEnv;
  vi.unstubAllGlobals();
});

describe("WRITE_TOOLS", () => {
  it("contains post_create", async () => {
    const { WRITE_TOOLS } = await import("../../src/guards.js");
    expect(WRITE_TOOLS.has("moltbook_post_create")).toBe(true);
  });

  it("contains comment_create", async () => {
    const { WRITE_TOOLS } = await import("../../src/guards.js");
    expect(WRITE_TOOLS.has("moltbook_comment_create")).toBe(true);
  });

  it("contains vote_post", async () => {
    const { WRITE_TOOLS } = await import("../../src/guards.js");
    expect(WRITE_TOOLS.has("moltbook_vote_post")).toBe(true);
  });

  it("contains raw_request", async () => {
    const { WRITE_TOOLS } = await import("../../src/guards.js");
    expect(WRITE_TOOLS.has("moltbook_raw_request")).toBe(true);
  });

  it("does not contain read-only tools", async () => {
    const { WRITE_TOOLS } = await import("../../src/guards.js");
    expect(WRITE_TOOLS.has("moltbook_posts_list")).toBe(false);
    expect(WRITE_TOOLS.has("moltbook_post_get")).toBe(false);
    expect(WRITE_TOOLS.has("moltbook_me")).toBe(false);
  });

  it("contains follow/unfollow", async () => {
    const { WRITE_TOOLS } = await import("../../src/guards.js");
    expect(WRITE_TOOLS.has("moltbook_follow")).toBe(true);
    expect(WRITE_TOOLS.has("moltbook_unfollow")).toBe(true);
  });
});

describe("classifyWriteKind", () => {
  it("returns post for post tools", async () => {
    const { classifyWriteKind } = await import("../../src/guards.js");
    expect(classifyWriteKind("moltbook_post_create")).toBe("post");
    expect(classifyWriteKind("moltbook_post_delete")).toBe("post");
  });

  it("returns comment for comment tools", async () => {
    const { classifyWriteKind } = await import("../../src/guards.js");
    expect(classifyWriteKind("moltbook_comment_create")).toBe("comment");
    expect(classifyWriteKind("moltbook_comment")).toBe("comment");
  });

  it("returns vote for vote-only tools", async () => {
    const { classifyWriteKind } = await import("../../src/guards.js");
    expect(classifyWriteKind("moltbook_vote")).toBe("vote");
  });

  it("returns post for vote_post (post takes priority)", async () => {
    const { classifyWriteKind } = await import("../../src/guards.js");
    expect(classifyWriteKind("moltbook_vote_post")).toBe("post");
  });

  it("returns comment for vote_comment (comment takes priority)", async () => {
    const { classifyWriteKind } = await import("../../src/guards.js");
    expect(classifyWriteKind("moltbook_vote_comment")).toBe("comment");
  });

  it("returns write for other tools", async () => {
    const { classifyWriteKind } = await import("../../src/guards.js");
    expect(classifyWriteKind("moltbook_follow")).toBe("write");
    expect(classifyWriteKind("moltbook_subscribe")).toBe("write");
  });
});

describe("checkWriteBlocked", () => {
  it("blocks when suspended", async () => {
    const { checkWriteBlocked } = await import("../../src/guards.js");
    const state = makeState({ suspension: { active: true, reason: "spam", until: null, seen_at: null } });
    const result = checkWriteBlocked(state, "moltbook_post_create");
    expect(result).not.toBeNull();
    expect(result!.code).toBe("account_suspended");
  });

  it("blocks when verification pending", async () => {
    const { checkWriteBlocked } = await import("../../src/guards.js");
    const state = makeState({
      pending_verification: {
        source_tool: "test", detected_at: "", verification_code: null,
        challenge: null, prompt: null, expires_at: null,
      },
    });
    const result = checkWriteBlocked(state, "moltbook_post_create");
    expect(result).not.toBeNull();
    expect(result!.code).toBe("blocked_by_pending_verification");
  });

  it("blocks during write cooldown", async () => {
    const { checkWriteBlocked } = await import("../../src/guards.js");
    const state = makeState({ cooldowns: { post_until: null, comment_until: null, write_until: futureIso() } });
    const result = checkWriteBlocked(state, "moltbook_post_create");
    expect(result).not.toBeNull();
    expect(result!.code).toBe("write_cooldown_active");
  });

  it("blocks during safe mode interval", async () => {
    const { checkWriteBlocked } = await import("../../src/guards.js");
    const state = makeState({ safe_mode: true, last_write_at: new Date().toISOString() });
    const result = checkWriteBlocked(state, "moltbook_post_create");
    expect(result).not.toBeNull();
    expect(result!.code).toBe("safe_mode_write_interval");
  });

  it("does not block safe mode when interval has passed", async () => {
    const { checkWriteBlocked } = await import("../../src/guards.js");
    const state = makeState({ safe_mode: true, last_write_at: pastIso(20_000) });
    const result = checkWriteBlocked(state, "moltbook_post_create");
    expect(result).toBeNull();
  });

  it("does not block safe mode when safe_mode is off", async () => {
    const { checkWriteBlocked } = await import("../../src/guards.js");
    const state = makeState({ safe_mode: false, last_write_at: new Date().toISOString() });
    const result = checkWriteBlocked(state, "moltbook_post_create");
    expect(result).toBeNull();
  });

  it("returns null when nothing blocks", async () => {
    const { checkWriteBlocked } = await import("../../src/guards.js");
    const state = makeState();
    const result = checkWriteBlocked(state, "moltbook_post_create");
    expect(result).toBeNull();
  });

  it("suspension takes priority over verification", async () => {
    const { checkWriteBlocked } = await import("../../src/guards.js");
    const state = makeState({
      suspension: { active: true, reason: "banned", until: null, seen_at: null },
      pending_verification: {
        source_tool: "test", detected_at: "", verification_code: null,
        challenge: null, prompt: null, expires_at: null,
      },
    });
    const result = checkWriteBlocked(state, "moltbook_post_create");
    expect(result!.code).toBe("account_suspended");
  });
});

describe("runApiTool", () => {
  it("makes successful read request", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ data: "posts" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { STATE_PATH } = await import("../../src/state.js");
    mockFs.files.set(STATE_PATH, JSON.stringify({ safe_mode: true }));
    const { runApiTool } = await import("../../src/guards.js");
    const result = await runApiTool("moltbook_posts_list", "GET", "/posts");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({ data: "posts" });
  });

  it("blocks write tool when suspended", async () => {
    const { STATE_PATH } = await import("../../src/state.js");
    mockFs.files.set(STATE_PATH, JSON.stringify({
      suspension: { active: true, reason: "banned", until: null, seen_at: null },
    }));
    const { runApiTool } = await import("../../src/guards.js");
    const result = await runApiTool("moltbook_post_create", "POST", "/posts", { body: { title: "test" } });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("account_suspended");
  });

  it("blocks write tool when verification pending", async () => {
    const { STATE_PATH } = await import("../../src/state.js");
    mockFs.files.set(STATE_PATH, JSON.stringify({
      pending_verification: {
        source_tool: "test", detected_at: "", verification_code: "abc",
        challenge: null, prompt: null, expires_at: null,
      },
    }));
    const { runApiTool } = await import("../../src/guards.js");
    const result = await runApiTool("moltbook_post_create", "POST", "/posts", { body: { title: "test" } });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("blocked_by_pending_verification");
  });

  it("handles verification challenge with auto-solve", async () => {
    // Response triggers verification, auto-solve succeeds
    const callCount = { value: 0 };
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount.value++;
      if (callCount.value === 1) {
        // First call: write that triggers verification
        return Promise.resolve({
          ok: false, status: 403,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve({
            verification_code: "v123",
            challenge: { challenge: "2 + 3", verification_code: "v123" },
          }),
          text: () => Promise.resolve(""),
        });
      }
      // Second call: auto-verify succeeds
      return Promise.resolve({
        ok: true, status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ verified: true }),
        text: () => Promise.resolve(""),
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const { STATE_PATH } = await import("../../src/state.js");
    mockFs.files.set(STATE_PATH, JSON.stringify({ safe_mode: false }));

    const { runApiTool } = await import("../../src/guards.js");
    const result = await runApiTool("moltbook_post_create", "POST", "/posts", { body: { title: "test" } });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.auto_verified).toBe(true);
  });

  it("handles rate limiting", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false, status: 429,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ error: "rate_limited", retry_after_seconds: 30 }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { STATE_PATH } = await import("../../src/state.js");
    mockFs.files.set(STATE_PATH, JSON.stringify({ safe_mode: false }));
    const { runApiTool } = await import("../../src/guards.js");
    const result = await runApiTool("moltbook_post_create", "POST", "/posts", { body: { title: "test" } });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("rate_limited");
  });

  it("detects suspension in API response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false, status: 403,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ status: "suspended", reason: "abuse" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { STATE_PATH } = await import("../../src/state.js");
    mockFs.files.set(STATE_PATH, JSON.stringify({}));
    const { runApiTool } = await import("../../src/guards.js");
    await runApiTool("moltbook_posts_list", "GET", "/posts");

    // Check that suspension was saved
    const savedContent = mockFs.files.get(STATE_PATH);
    expect(savedContent).toBeDefined();
    const savedState = JSON.parse(savedContent!);
    expect(savedState.suspension.active).toBe(true);
  });

  it("clears suspension on successful status check", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ status: "active" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { STATE_PATH } = await import("../../src/state.js");
    mockFs.files.set(STATE_PATH, JSON.stringify({
      suspension: { active: true, reason: "old", until: null, seen_at: null },
    }));
    const { runApiTool } = await import("../../src/guards.js");
    await runApiTool("moltbook_status", "GET", "/agents/status");

    const savedContent = mockFs.files.get(STATE_PATH);
    const savedState = JSON.parse(savedContent!);
    expect(savedState.suspension.active).toBe(false);
  });

  it("sets write cooldown from retry_after", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false, status: 429,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ error: "too many", retry_after_seconds: 60 }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { STATE_PATH } = await import("../../src/state.js");
    mockFs.files.set(STATE_PATH, JSON.stringify({ safe_mode: false }));
    const { runApiTool } = await import("../../src/guards.js");
    await runApiTool("moltbook_post_create", "POST", "/posts", { body: { title: "test" } });

    const savedContent = mockFs.files.get(STATE_PATH);
    const savedState = JSON.parse(savedContent!);
    expect(savedState.cooldowns.write_until).not.toBeNull();
    expect(savedState.cooldowns.post_until).not.toBeNull();
  });

  it("updates last_write_at on successful write", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ id: "1" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { STATE_PATH } = await import("../../src/state.js");
    mockFs.files.set(STATE_PATH, JSON.stringify({ safe_mode: false }));
    const { runApiTool } = await import("../../src/guards.js");
    await runApiTool("moltbook_post_create", "POST", "/posts", { body: { title: "test" } });

    const savedContent = mockFs.files.get(STATE_PATH);
    const savedState = JSON.parse(savedContent!);
    expect(savedState.last_write_at).not.toBeNull();
  });

  it("does not check write blocks for read tools", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { STATE_PATH } = await import("../../src/state.js");
    // State has pending verification which would block writes
    mockFs.files.set(STATE_PATH, JSON.stringify({
      pending_verification: {
        source_tool: "test", detected_at: "", verification_code: "abc",
        challenge: null, prompt: null, expires_at: null,
      },
    }));
    const { runApiTool } = await import("../../src/guards.js");
    const result = await runApiTool("moltbook_posts_list", "GET", "/posts");
    const parsed = JSON.parse(result.content[0].text);
    // Should succeed because it's a read tool
    expect(parsed.ok).toBe(true);
  });

  it("uses isWrite override", async () => {
    const { STATE_PATH } = await import("../../src/state.js");
    mockFs.files.set(STATE_PATH, JSON.stringify({
      pending_verification: {
        source_tool: "test", detected_at: "", verification_code: "abc",
        challenge: null, prompt: null, expires_at: null,
      },
    }));
    const { runApiTool } = await import("../../src/guards.js");
    const result = await runApiTool("moltbook_raw_request", "POST", "/posts", { isWrite: true });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("blocked_by_pending_verification");
  });

  it("records auto-verify failure with attempt tracking", async () => {
    // First call: write triggers verification with solvable challenge
    // Second call: auto-verify submits answer but API rejects it
    const callCount = { value: 0 };
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount.value++;
      if (callCount.value === 1) {
        return Promise.resolve({
          ok: false, status: 403,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve({
            verification_code: "v123",
            challenge: { challenge: "2 + 3", verification_code: "v123" },
          }),
          text: () => Promise.resolve(""),
        });
      }
      // Auto-verify fails
      return Promise.resolve({
        ok: false, status: 400,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ error: "wrong answer" }),
        text: () => Promise.resolve(""),
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const { STATE_PATH } = await import("../../src/state.js");
    mockFs.files.set(STATE_PATH, JSON.stringify({ safe_mode: false }));

    const { runApiTool } = await import("../../src/guards.js");
    await runApiTool("moltbook_post_create", "POST", "/posts", { body: { title: "test" } });

    const savedState = JSON.parse(mockFs.files.get(STATE_PATH)!);
    expect(savedState.pending_verification.attempt_count).toBe(1);
    expect(savedState.pending_verification.auto_attempted).toBe(true);
    expect(savedState.pending_verification.failed_answers).toEqual(["5.00"]);
  });

  it("records solver-cant-parse with zero attempts", async () => {
    // Write triggers verification with unsolvable challenge
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false, status: 403,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({
        verification_code: "v456",
        challenge: { challenge: "unsolvable gibberish no numbers", verification_code: "v456" },
      }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { STATE_PATH } = await import("../../src/state.js");
    mockFs.files.set(STATE_PATH, JSON.stringify({ safe_mode: false }));

    const { runApiTool } = await import("../../src/guards.js");
    await runApiTool("moltbook_post_create", "POST", "/posts", { body: { title: "test" } });

    const savedState = JSON.parse(mockFs.files.get(STATE_PATH)!);
    expect(savedState.pending_verification.attempt_count).toBe(0);
    expect(savedState.pending_verification.auto_attempted).toBe(false);
    expect(savedState.pending_verification.failed_answers).toEqual([]);
  });
});
