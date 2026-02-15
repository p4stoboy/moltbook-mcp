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
