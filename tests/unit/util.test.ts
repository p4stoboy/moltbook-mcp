import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockFs } from "../helpers/mock-fs.js";
import { makeApiResponse } from "../helpers/fixtures.js";

// Mock fs before importing util
const mockFs = createMockFs();
vi.mock("fs", () => ({
  readFileSync: mockFs.readFileSync,
  writeFileSync: mockFs.writeFileSync,
  mkdirSync: mockFs.mkdirSync,
}));

const {
  nowIso,
  safeJsonParse,
  readJson,
  writeJson,
  requireString,
  isFutureIso,
  makeResult,
  collectStrings,
  extractRetrySeconds,
  extractSuspension,
  extractVerification,
} = await import("../../src/util.js");

describe("nowIso", () => {
  it("returns an ISO 8601 date string", () => {
    const result = nowIso();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(() => new Date(result)).not.toThrow();
  });

  it("returns a value close to current time", () => {
    const before = Date.now();
    const result = new Date(nowIso()).getTime();
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after);
  });
});

describe("safeJsonParse", () => {
  it("parses valid JSON", () => {
    expect(safeJsonParse('{"a":1}', null)).toEqual({ a: 1 });
  });

  it("returns fallback for invalid JSON", () => {
    expect(safeJsonParse("not json", "fallback")).toBe("fallback");
  });

  it("returns fallback for empty string", () => {
    expect(safeJsonParse("", 42)).toBe(42);
  });
});

describe("readJson", () => {
  beforeEach(() => {
    mockFs.files.clear();
  });

  it("reads and parses JSON from a file", () => {
    mockFs.files.set("/test.json", '{"key":"value"}');
    expect(readJson("/test.json", null)).toEqual({ key: "value" });
  });

  it("returns fallback when file does not exist", () => {
    expect(readJson("/nonexistent.json", { default: true })).toEqual({ default: true });
  });

  it("returns fallback when file contains invalid JSON", () => {
    mockFs.files.set("/bad.json", "not json");
    expect(readJson("/bad.json", null)).toBeNull();
  });
});

describe("writeJson", () => {
  beforeEach(() => {
    mockFs.files.clear();
  });

  it("writes JSON to a file with pretty printing", () => {
    writeJson("/out.json", { hello: "world" });
    expect(mockFs.mkdirSync).toHaveBeenCalled();
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      "/out.json",
      expect.stringContaining('"hello": "world"'),
      "utf-8",
    );
  });

  it("creates parent directory with recursive option", () => {
    writeJson("/a/b/c.json", {});
    expect(mockFs.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
  });
});

describe("requireString", () => {
  it("returns trimmed string for valid input", () => {
    expect(requireString("  hello  ", "field")).toBe("hello");
  });

  it("throws for empty string", () => {
    expect(() => requireString("", "name")).toThrow("name is required");
  });

  it("throws for whitespace-only string", () => {
    expect(() => requireString("   ", "name")).toThrow("name is required");
  });

  it("throws for non-string input", () => {
    expect(() => requireString(123, "name")).toThrow("name is required");
  });

  it("throws for null/undefined", () => {
    expect(() => requireString(null, "name")).toThrow("name is required");
    expect(() => requireString(undefined, "name")).toThrow("name is required");
  });
});

describe("isFutureIso", () => {
  it("returns true for future ISO date", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(isFutureIso(future)).toBe(true);
  });

  it("returns false for past ISO date", () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(isFutureIso(past)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isFutureIso(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isFutureIso(undefined)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isFutureIso("")).toBe(false);
  });

  it("returns false for invalid date string", () => {
    expect(isFutureIso("not-a-date")).toBe(false);
  });
});

describe("makeResult", () => {
  it("returns ToolResult with JSON text content", () => {
    const result = makeResult({ ok: true, data: "test" });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true, data: "test" });
  });

  it("sets isError=false by default", () => {
    const result = makeResult({ ok: true });
    expect(result.isError).toBe(false);
  });

  it("sets isError=true when specified", () => {
    const result = makeResult({ ok: false }, true);
    expect(result.isError).toBe(true);
  });
});

describe("collectStrings", () => {
  it("collects strings from a string", () => {
    expect(collectStrings("hello")).toEqual(["hello"]);
  });

  it("collects strings from an array", () => {
    expect(collectStrings(["a", "b"])).toEqual(["a", "b"]);
  });

  it("collects strings from nested objects", () => {
    expect(collectStrings({ x: "a", y: { z: "b" } })).toEqual(["a", "b"]);
  });

  it("returns empty array for null/undefined", () => {
    expect(collectStrings(null)).toEqual([]);
    expect(collectStrings(undefined)).toEqual([]);
  });

  it("stops at depth 5", () => {
    const deep = { a: { b: { c: { d: { e: { f: "too deep" } } } } } };
    const result = collectStrings(deep);
    expect(result).not.toContain("too deep");
  });
});

describe("extractRetrySeconds", () => {
  it("extracts retry_after_seconds from body", () => {
    const response = makeApiResponse({ body: { retry_after_seconds: 30 } });
    expect(extractRetrySeconds(response)).toBe(30);
  });

  it("extracts retry_after_minutes from body", () => {
    const response = makeApiResponse({ body: { retry_after_minutes: 2 } });
    expect(extractRetrySeconds(response)).toBe(120);
  });

  it("extracts retry_after from body", () => {
    const response = makeApiResponse({ body: { retry_after: 45 } });
    expect(extractRetrySeconds(response)).toBe(45);
  });

  it("extracts numeric retry-after header", () => {
    const headers = new Headers({ "retry-after": "60" });
    const response = makeApiResponse({ headers, body: {} });
    expect(extractRetrySeconds(response)).toBe(60);
  });

  it("returns 0 when no retry info present", () => {
    const response = makeApiResponse({ body: {} });
    expect(extractRetrySeconds(response)).toBe(0);
  });
});

describe("extractSuspension", () => {
  it("detects suspension from status field", () => {
    const response = makeApiResponse({ body: { status: "suspended", reason: "spam" } });
    expect(extractSuspension(response)).toEqual({ reason: "spam", until: null });
  });

  it("detects ban from status field", () => {
    const response = makeApiResponse({ body: { status: "banned", reason: "abuse" } });
    expect(extractSuspension(response)).toEqual({ reason: "abuse", until: null });
  });

  it("detects suspended text in body", () => {
    const response = makeApiResponse({ body: { message: "Your account has been suspended" } });
    expect(extractSuspension(response)).toBeTruthy();
  });

  it("returns null for normal response", () => {
    const response = makeApiResponse({ body: { status: "active" } });
    expect(extractSuspension(response)).toBeNull();
  });

  it("extracts until from suspended_until", () => {
    const response = makeApiResponse({
      body: { status: "suspended", reason: "test", suspended_until: "2030-01-01T00:00:00Z" },
    });
    const result = extractSuspension(response);
    expect(result?.until).toBe("2030-01-01T00:00:00Z");
  });
});

describe("extractVerification", () => {
  it("extracts verification from challenge object", () => {
    const response = makeApiResponse({
      status: 403,
      ok: false,
      body: {
        challenge: {
          verification_code: "abc123",
          challenge: "What is 2 + 3?",
          prompt: "Solve this math problem",
        },
      },
    });
    const result = extractVerification(response);
    expect(result).not.toBeNull();
    expect(result!.verification_code).toBe("abc123");
    expect(result!.challenge).toBe("What is 2 + 3?");
  });

  it("extracts verification_code from top level", () => {
    const response = makeApiResponse({
      status: 403,
      ok: false,
      body: { verification_code: "xyz", math_challenge: "5 + 5" },
    });
    const result = extractVerification(response);
    expect(result).not.toBeNull();
    expect(result!.verification_code).toBe("xyz");
  });

  it("returns null for normal ok response without code", () => {
    const response = makeApiResponse({ body: { data: "ok" } });
    expect(extractVerification(response)).toBeNull();
  });

  it("returns null when no verification keywords or code present", () => {
    const response = makeApiResponse({
      status: 400,
      ok: false,
      body: { error: "bad request" },
    });
    expect(extractVerification(response)).toBeNull();
  });

  it("returns null for keywords-only error with no code or challenge (zombie prevention)", () => {
    const response = makeApiResponse({
      status: 400,
      ok: false,
      body: {
        error: "Invalid verification attempt",
        message: "Include the verification_code from your content creation response",
      },
    });
    expect(extractVerification(response)).toBeNull();
  });

  it("returns non-null when verification_code is present without challenge text", () => {
    const response = makeApiResponse({
      status: 403,
      ok: false,
      body: { verification_code: "abc123", message: "Verification required" },
    });
    const result = extractVerification(response);
    expect(result).not.toBeNull();
    expect(result!.verification_code).toBe("abc123");
  });

  it("returns non-null when challenge text is present without code", () => {
    const response = makeApiResponse({
      status: 403,
      ok: false,
      body: { challenge_text: "What is 2 + 3?", message: "Solve this challenge" },
    });
    const result = extractVerification(response);
    expect(result).not.toBeNull();
    expect(result!.challenge).toBe("What is 2 + 3?");
  });
});
