import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockFs } from "../helpers/mock-fs.js";

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

describe("Integration: full write success flow", () => {
  it("completes a write and updates last_write_at", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 201,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ id: "post_1", title: "Hello" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { STATE_PATH } = await import("../../src/state.js");
    mockFs.files.set(STATE_PATH, JSON.stringify({ safe_mode: false }));

    const { runApiTool } = await import("../../src/guards.js");
    const result = await runApiTool("moltbook_post_create", "POST", "/posts", { body: { title: "Hello" } });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.id).toBe("post_1");

    const savedState = JSON.parse(mockFs.files.get(STATE_PATH)!);
    expect(savedState.last_write_at).not.toBeNull();
  });
});

describe("Integration: blocked by suspension", () => {
  it("blocks write when account is suspended", async () => {
    const { STATE_PATH } = await import("../../src/state.js");
    mockFs.files.set(STATE_PATH, JSON.stringify({
      suspension: { active: true, reason: "Terms violation", until: "2030-01-01T00:00:00Z", seen_at: new Date().toISOString() },
    }));

    const { runApiTool } = await import("../../src/guards.js");
    const result = await runApiTool("moltbook_post_create", "POST", "/posts", { body: { title: "test" } });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("account_suspended");
    expect(result.isError).toBe(true);
  });
});

describe("Integration: auto-solve verification challenge", () => {
  it("auto-solves digit expression challenge transparently", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: false, status: 403,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve({
            verification_code: "vc_123",
            challenge: { challenge: "10 + 5", verification_code: "vc_123" },
          }),
          text: () => Promise.resolve(""),
        });
      }
      return Promise.resolve({
        ok: true, status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ verified: true, message: "Challenge solved" }),
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
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe("Integration: unsolvable verification falls back to blocking", () => {
  it("blocks when challenge cannot be auto-solved", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false, status: 403,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({
        verification_code: "vc_999",
        challenge: { challenge: "What color is the sky on Mars?", verification_code: "vc_999" },
      }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { STATE_PATH } = await import("../../src/state.js");
    mockFs.files.set(STATE_PATH, JSON.stringify({ safe_mode: false }));

    const { runApiTool } = await import("../../src/guards.js");
    const result = await runApiTool("moltbook_post_create", "POST", "/posts", { body: { title: "test" } });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("verification_required");
    expect(parsed.pending_verification).toBeDefined();
  });
});

describe("Integration: rate limiting cooldown", () => {
  it("sets cooldown and blocks subsequent writes", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false, status: 429,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ error: "rate_limited", retry_after_seconds: 120 }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { STATE_PATH } = await import("../../src/state.js");
    mockFs.files.set(STATE_PATH, JSON.stringify({ safe_mode: false }));

    const { runApiTool } = await import("../../src/guards.js");
    // First call: rate limited
    await runApiTool("moltbook_post_create", "POST", "/posts", { body: { title: "test" } });

    // Check cooldown was set
    const savedState = JSON.parse(mockFs.files.get(STATE_PATH)!);
    expect(savedState.cooldowns.write_until).not.toBeNull();
    expect(savedState.cooldowns.post_until).not.toBeNull();
  });
});

describe("Integration: safe mode write interval", () => {
  it("blocks rapid consecutive writes in safe mode", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 201,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ id: "1" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { STATE_PATH } = await import("../../src/state.js");
    // Set last_write_at to just now - safe mode should block second write
    mockFs.files.set(STATE_PATH, JSON.stringify({
      safe_mode: true,
      last_write_at: new Date().toISOString(),
    }));

    const { runApiTool } = await import("../../src/guards.js");
    const result = await runApiTool("moltbook_post_create", "POST", "/posts", { body: { title: "test" } });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("safe_mode_write_interval");
  });
});

describe("Integration: handleVerify auto-solve from challenge text", () => {
  it("auto-solves challenge and submits answer", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ verified: true }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { STATE_PATH } = await import("../../src/state.js");
    mockFs.files.set(STATE_PATH, JSON.stringify({}));

    const { handleVerify } = await import("../../src/verify.js");
    const result = await handleVerify({ challenge: "7 * 6" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.verified).toBe(true);

    // Check that the correct answer was sent
    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.answer).toBe("42.00");
  });
});

describe("Integration: re-challenge on verify", () => {
  it("detects re-challenge and updates state", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false, status: 403,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({
        verification_code: "vc_new",
        challenge: { challenge: "What is 99 + 1?", verification_code: "vc_new" },
      }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { STATE_PATH } = await import("../../src/state.js");
    mockFs.files.set(STATE_PATH, JSON.stringify({
      pending_verification: {
        source_tool: "moltbook_verify",
        detected_at: new Date().toISOString(),
        verification_code: "vc_old",
        challenge: "old challenge",
        prompt: null,
        expires_at: null,
      },
    }));

    const { handleVerify } = await import("../../src/verify.js");
    const result = await handleVerify({ answer: "wrong_answer" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe("verification_still_required");

    const savedState = JSON.parse(mockFs.files.get(STATE_PATH)!);
    expect(savedState.pending_verification.verification_code).toBe("vc_new");
    expect(savedState.offense_count).toBe(1);
  });
});

describe("Integration: health check flow", () => {
  it("detects suspension from health check response", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // /agents/status
        return Promise.resolve({
          ok: true, status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve({ status: "suspended", reason: "spam" }),
          text: () => Promise.resolve(""),
        });
      }
      // /agents/me
      return Promise.resolve({
        ok: true, status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ name: "test-agent" }),
        text: () => Promise.resolve(""),
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const { STATE_PATH } = await import("../../src/state.js");
    mockFs.files.set(STATE_PATH, JSON.stringify({}));

    // We need to call registerTools and invoke the health tool handler
    const registeredTools: Record<string, (...args: unknown[]) => unknown> = {};
    const mockServer = {
      tool: vi.fn((...args: unknown[]) => {
        const name = args[0] as string;
        const handler = args[args.length - 1] as (...args: unknown[]) => unknown;
        registeredTools[name] = handler;
      }),
    };

    const { registerTools } = await import("../../src/tools.js");
    registerTools(mockServer as never);

    const healthResult = await registeredTools["moltbook_health"]({}) as { content: Array<{ text: string }> };
    const parsed = JSON.parse(healthResult.content[0].text);
    expect(parsed.suspension.active).toBe(true);
    expect(parsed.suspension.reason).toBe("spam");
  });
});
