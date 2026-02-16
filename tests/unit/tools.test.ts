import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockFs } from "../helpers/mock-fs.js";
import { makeState, pastIso, futureIso } from "../helpers/fixtures.js";

const mockFs = createMockFs();
vi.mock("fs", () => ({
  readFileSync: mockFs.readFileSync,
  writeFileSync: mockFs.writeFileSync,
  mkdirSync: mockFs.mkdirSync,
}));

const mockApiRequest = vi.fn();
vi.mock("../../src/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api.js")>();
  return { ...actual, apiRequest: mockApiRequest };
});

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  mockFs.files.clear();
  mockApiRequest.mockReset();
  process.env = { ...originalEnv };
  process.env.MOLTBOOK_API_BASE = "https://www.moltbook.com/api/v1";
  process.env.MOLTBOOK_API_KEY = "test-key";
});

afterEach(() => {
  process.env = originalEnv;
});

describe("registerTools", () => {
  it("registers all expected tool names", async () => {
    const registeredTools: string[] = [];
    const mockServer = {
      tool: vi.fn((...args: unknown[]) => {
        registeredTools.push(args[0] as string);
      }),
    };

    const { registerTools } = await import("../../src/tools.js");
    registerTools(mockServer as never);

    const expectedTools = [
      "moltbook_health",
      "moltbook_write_guard_status",
      "moltbook_challenge_status",
      "moltbook_verify",
      "moltbook_status",
      "moltbook_me",
      "moltbook_profile",
      "moltbook_profile_update",
      "moltbook_setup_owner_email",
      "moltbook_posts_list",
      "moltbook_feed",
      "moltbook_feed_personal",
      "moltbook_post_get",
      "moltbook_post",
      "moltbook_post_create",
      "moltbook_post_delete",
      "moltbook_comments_list",
      "moltbook_comment_create",
      "moltbook_comment",
      "moltbook_vote_post",
      "moltbook_vote",
      "moltbook_vote_comment",
      "moltbook_search",
      "moltbook_submolts_list",
      "moltbook_submolts",
      "moltbook_submolt_get",
      "moltbook_submolt_create",
      "moltbook_subscribe",
      "moltbook_unsubscribe",
      "moltbook_follow",
      "moltbook_unfollow",
      "moltbook_raw_request",
    ];

    for (const name of expectedTools) {
      expect(registeredTools).toContain(name);
    }
  });

  it("registers exactly the expected number of tools", async () => {
    const mockServer = { tool: vi.fn() };
    const { registerTools } = await import("../../src/tools.js");
    registerTools(mockServer as never);
    expect(mockServer.tool).toHaveBeenCalledTimes(32);
  });

  it("passes description as second argument for each tool", async () => {
    const mockServer = { tool: vi.fn() };
    const { registerTools } = await import("../../src/tools.js");
    registerTools(mockServer as never);

    for (const call of mockServer.tool.mock.calls) {
      expect(typeof call[1]).toBe("string");
      expect((call[1] as string).length).toBeGreaterThan(0);
    }
  });

  it("passes handler function as last argument for each tool", async () => {
    const mockServer = { tool: vi.fn() };
    const { registerTools } = await import("../../src/tools.js");
    registerTools(mockServer as never);

    for (const call of mockServer.tool.mock.calls) {
      const lastArg = call[call.length - 1];
      expect(typeof lastArg).toBe("function");
    }
  });
});

describe("moltbook_health handler", () => {
  /** Register tools and extract the health handler from the mock server. */
  async function getHealthHandler() {
    const mockServer = { tool: vi.fn() };
    const { registerTools } = await import("../../src/tools.js");
    registerTools(mockServer as never);
    const healthCall = mockServer.tool.mock.calls.find(
      (c: unknown[]) => c[0] === "moltbook_health",
    );
    // handler is the last argument (after name, description, schema)
    return healthCall![healthCall!.length - 1] as () => Promise<{ content: { text: string }[] }>;
  }

  function seedState(state: ReturnType<typeof makeState>) {
    // Dynamically resolve STATE_PATH from the state module to match the mock fs
    const { join } = require("path") as typeof import("path");
    const { homedir } = require("os") as typeof import("os");
    const statePath = join(homedir(), ".config", "moltbook", "mcp_state.json");
    mockFs.files.set(statePath, JSON.stringify(state));
    return statePath;
  }

  function stubApiOk() {
    mockApiRequest.mockResolvedValue({ ok: true, status: 200, headers: new Headers(), body: {} });
  }

  it("clears expired verification from state", async () => {
    stubApiOk();
    const statePath = seedState(makeState({
      pending_verification: {
        source_tool: "test",
        detected_at: pastIso(31 * 60 * 1000), // 31 min ago, exceeds MAX_VERIFICATION_AGE_MS
        verification_code: null,
        challenge: null,
        prompt: null,
        expires_at: null,
      },
    }));

    const handler = await getHealthHandler();
    const result = await handler();
    const parsed = JSON.parse(result.content[0].text);

    // Expired verification should have been cleared
    expect(parsed.pending_verification).toBeNull();

    // State on disk should also be cleared
    const saved = JSON.parse(mockFs.files.get(statePath)!);
    expect(saved.pending_verification).toBeNull();
  });

  it("clears verification with expired expires_at", async () => {
    stubApiOk();
    const statePath = seedState(makeState({
      pending_verification: {
        source_tool: "test",
        detected_at: new Date().toISOString(),
        verification_code: "v123",
        challenge: "2+2",
        prompt: null,
        expires_at: pastIso(60_000), // expired 1 min ago
      },
    }));

    const handler = await getHealthHandler();
    await handler();

    const saved = JSON.parse(mockFs.files.get(statePath)!);
    expect(saved.pending_verification).toBeNull();
  });

  it("returns blocked_for_writes true when pending_verification exists", async () => {
    stubApiOk();
    seedState(makeState({
      pending_verification: {
        source_tool: "test",
        detected_at: new Date().toISOString(),
        verification_code: "v123",
        challenge: "2+2",
        prompt: null,
        expires_at: futureIso(60_000), // still valid
      },
    }));

    const handler = await getHealthHandler();
    const result = await handler();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.blocked_for_writes).toBe(true);
    expect(parsed.pending_verification).not.toBeNull();
  });

  it("returns blocked_for_writes true when suspended", async () => {
    mockApiRequest.mockResolvedValue({
      ok: true, status: 200, headers: new Headers(),
      body: { status: "suspended", reason: "abuse" },
    });
    seedState(makeState({
      suspension: { active: true, reason: "abuse", until: null, seen_at: null },
    }));

    const handler = await getHealthHandler();
    const result = await handler();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.blocked_for_writes).toBe(true);
  });

  it("returns blocked_for_writes false when state is clean", async () => {
    stubApiOk();
    seedState(makeState());

    const handler = await getHealthHandler();
    const result = await handler();
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.blocked_for_writes).toBe(false);
    expect(parsed.pending_verification).toBeNull();
  });
});
