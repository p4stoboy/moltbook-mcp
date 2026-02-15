import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockFs } from "../helpers/mock-fs.js";

const mockFs = createMockFs();
vi.mock("fs", () => ({
  readFileSync: mockFs.readFileSync,
  writeFileSync: mockFs.writeFileSync,
  mkdirSync: mockFs.mkdirSync,
}));

// We need to set a valid env before importing api.ts because BASE_URL evaluates at import time
const originalEnv = { ...process.env };

describe("normalizeBaseUrl", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("accepts default moltbook URL", async () => {
    process.env.MOLTBOOK_API_BASE = "https://www.moltbook.com/api/v1";
    const { normalizeBaseUrl } = await import("../../src/api.js");
    expect(normalizeBaseUrl("https://www.moltbook.com/api/v1")).toBe("https://www.moltbook.com/api/v1");
  });

  it("strips trailing slashes", async () => {
    process.env.MOLTBOOK_API_BASE = "https://www.moltbook.com/api/v1";
    const { normalizeBaseUrl } = await import("../../src/api.js");
    expect(normalizeBaseUrl("https://www.moltbook.com/api/v1/")).toBe("https://www.moltbook.com/api/v1");
  });

  it("throws for non-https protocol", async () => {
    process.env.MOLTBOOK_API_BASE = "https://www.moltbook.com/api/v1";
    const { normalizeBaseUrl } = await import("../../src/api.js");
    expect(() => normalizeBaseUrl("http://www.moltbook.com/api/v1")).toThrow("https");
  });

  it("throws for wrong hostname", async () => {
    process.env.MOLTBOOK_API_BASE = "https://www.moltbook.com/api/v1";
    const { normalizeBaseUrl } = await import("../../src/api.js");
    expect(() => normalizeBaseUrl("https://evil.com/api/v1")).toThrow("moltbook.com");
  });

  it("throws for non /api/v1 path", async () => {
    process.env.MOLTBOOK_API_BASE = "https://www.moltbook.com/api/v1";
    const { normalizeBaseUrl } = await import("../../src/api.js");
    expect(() => normalizeBaseUrl("https://www.moltbook.com/api/v2")).toThrow("/api/v1");
  });

  it("defaults empty path to /api/v1", async () => {
    process.env.MOLTBOOK_API_BASE = "https://www.moltbook.com/api/v1";
    const { normalizeBaseUrl } = await import("../../src/api.js");
    expect(normalizeBaseUrl("https://www.moltbook.com")).toBe("https://www.moltbook.com/api/v1");
  });

  it("defaults root path to /api/v1", async () => {
    process.env.MOLTBOOK_API_BASE = "https://www.moltbook.com/api/v1";
    const { normalizeBaseUrl } = await import("../../src/api.js");
    expect(normalizeBaseUrl("https://www.moltbook.com/")).toBe("https://www.moltbook.com/api/v1");
  });
});

describe("normalizePath", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env.MOLTBOOK_API_BASE = "https://www.moltbook.com/api/v1";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("prefixes path with /", async () => {
    const { normalizePath } = await import("../../src/api.js");
    expect(normalizePath("posts")).toBe("/posts");
  });

  it("keeps leading /", async () => {
    const { normalizePath } = await import("../../src/api.js");
    expect(normalizePath("/posts")).toBe("/posts");
  });

  it("throws for absolute URLs", async () => {
    const { normalizePath } = await import("../../src/api.js");
    expect(() => normalizePath("https://example.com/posts")).toThrow("absolute URLs");
  });

  it("throws for path traversal", async () => {
    const { normalizePath } = await import("../../src/api.js");
    expect(() => normalizePath("/../etc/passwd")).toThrow("path traversal");
  });

  it("throws for empty string", async () => {
    const { normalizePath } = await import("../../src/api.js");
    expect(() => normalizePath("")).toThrow("path is required");
  });

  it("throws for whitespace-only string", async () => {
    const { normalizePath } = await import("../../src/api.js");
    expect(() => normalizePath("   ")).toThrow("path is required");
  });
});

describe("getApiKey", () => {
  beforeEach(() => {
    vi.resetModules();
    mockFs.files.clear();
    process.env = { ...originalEnv };
    process.env.MOLTBOOK_API_BASE = "https://www.moltbook.com/api/v1";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns env var when set", async () => {
    process.env.MOLTBOOK_API_KEY = "env-key-123";
    const { getApiKey } = await import("../../src/api.js");
    expect(getApiKey()).toBe("env-key-123");
  });

  it("trims env var", async () => {
    process.env.MOLTBOOK_API_KEY = "  env-key-123  ";
    const { getApiKey } = await import("../../src/api.js");
    expect(getApiKey()).toBe("env-key-123");
  });

  it("reads from credentials file when no env var", async () => {
    delete process.env.MOLTBOOK_API_KEY;
    const { CREDENTIALS_PATH } = await import("../../src/state.js");
    mockFs.files.set(CREDENTIALS_PATH, JSON.stringify({ api_key: "file-key-456" }));
    const { getApiKey } = await import("../../src/api.js");
    expect(getApiKey()).toBe("file-key-456");
  });

  it("throws when no key available", async () => {
    delete process.env.MOLTBOOK_API_KEY;
    const { getApiKey } = await import("../../src/api.js");
    expect(() => getApiKey()).toThrow("Missing API key");
  });
});

describe("RAW_PATH_ALLOWLIST", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env.MOLTBOOK_API_BASE = "https://www.moltbook.com/api/v1";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("allows /agents path", async () => {
    const { RAW_PATH_ALLOWLIST } = await import("../../src/api.js");
    expect(RAW_PATH_ALLOWLIST.test("/agents")).toBe(true);
  });

  it("allows /posts/123", async () => {
    const { RAW_PATH_ALLOWLIST } = await import("../../src/api.js");
    expect(RAW_PATH_ALLOWLIST.test("/posts/123")).toBe(true);
  });

  it("allows /verify", async () => {
    const { RAW_PATH_ALLOWLIST } = await import("../../src/api.js");
    expect(RAW_PATH_ALLOWLIST.test("/verify")).toBe(true);
  });

  it("rejects /admin", async () => {
    const { RAW_PATH_ALLOWLIST } = await import("../../src/api.js");
    expect(RAW_PATH_ALLOWLIST.test("/admin")).toBe(false);
  });

  it("rejects /users", async () => {
    const { RAW_PATH_ALLOWLIST } = await import("../../src/api.js");
    expect(RAW_PATH_ALLOWLIST.test("/users")).toBe(false);
  });
});

describe("apiRequest", () => {
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

  it("makes GET request with auth header", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ data: "ok" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { apiRequest } = await import("../../src/api.js");
    const result = await apiRequest("GET", "/posts");
    expect(result.ok).toBe(true);
    expect(result.body).toEqual({ data: "ok" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url.toString()).toContain("/api/v1/posts");
    expect(options.headers.Authorization).toBe("Bearer test-key");
  });

  it("makes POST request with JSON body", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ id: "1" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { apiRequest } = await import("../../src/api.js");
    const result = await apiRequest("POST", "/posts", { body: { title: "test" } });
    expect(result.ok).toBe(true);
    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(options.body)).toEqual({ title: "test" });
  });

  it("handles query parameters", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { apiRequest } = await import("../../src/api.js");
    await apiRequest("GET", "/posts", { query: { sort: "new", limit: 10 } });
    const [url] = mockFetch.mock.calls[0];
    expect(url.toString()).toContain("sort=new");
    expect(url.toString()).toContain("limit=10");
  });

  it("handles network errors gracefully", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection refused")));

    const { apiRequest } = await import("../../src/api.js");
    const result = await apiRequest("GET", "/posts");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.body.error).toBe("network_error");
    expect(result.body.message).toBe("Connection refused");
  });

  it("handles non-JSON responses", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      json: () => Promise.reject(new Error("not json")),
      text: () => Promise.resolve("plain text response"),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { apiRequest } = await import("../../src/api.js");
    const result = await apiRequest("GET", "/posts");
    expect(result.body).toEqual({ raw: "plain text response" });
  });

  it("skips undefined and null query params", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { apiRequest } = await import("../../src/api.js");
    await apiRequest("GET", "/posts", { query: { sort: "new", empty: undefined, nil: null } });
    const [url] = mockFetch.mock.calls[0];
    const urlStr = url.toString();
    expect(urlStr).toContain("sort=new");
    expect(urlStr).not.toContain("empty");
    expect(urlStr).not.toContain("nil");
  });
});
