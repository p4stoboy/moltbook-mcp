import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.hoisted runs before vi.mock hoisting, so mockFs is available in the factory
const { mockFs } = vi.hoisted(() => {
  const files = new Map<string, string>();
  const readFileSync = vi.fn((path: string) => {
    const content = files.get(path);
    if (content === undefined) {
      const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return content;
  });
  const writeFileSync = vi.fn((path: string, content: string) => {
    files.set(path, content);
  });
  const mkdirSync = vi.fn();
  return { mockFs: { files, readFileSync, writeFileSync, mkdirSync } };
});

vi.mock("fs", () => ({
  readFileSync: mockFs.readFileSync,
  writeFileSync: mockFs.writeFileSync,
  mkdirSync: mockFs.mkdirSync,
}));

// Static import of pure functions (no I/O dependencies)
import {
  solveChallenge,
  solveDigitExpression,
  normalizeChallenge,
  extractNumbers,
  detectOperation,
  compute,
} from "../../src/verify.js";

// ── solveDigitExpression ──

describe("solveDigitExpression", () => {
  it("solves basic addition", () => {
    expect(solveDigitExpression("What is 2 + 3?")).toBe("5.00");
  });

  it("solves subtraction", () => {
    expect(solveDigitExpression("Calculate 10 - 4")).toBe("6.00");
  });

  it("solves multiplication", () => {
    expect(solveDigitExpression("Compute 6 * 7")).toBe("42.00");
  });

  it("solves division", () => {
    expect(solveDigitExpression("What is 20 / 4?")).toBe("5.00");
  });

  it("solves expressions with exponents using ^", () => {
    expect(solveDigitExpression("2^3")).toBe("8.00");
  });

  it("solves expressions with parentheses", () => {
    expect(solveDigitExpression("(2 + 3) * 4")).toBe("20.00");
  });

  it("returns null for text without digits", () => {
    expect(solveDigitExpression("hello world")).toBeNull();
  });

  it("returns null for text without operators", () => {
    expect(solveDigitExpression("42")).toBeNull();
  });

  it("returns null for expression longer than 200 chars", () => {
    const longExpr = "1 + " + "1 + ".repeat(100) + "1";
    expect(solveDigitExpression(longExpr)).toBeNull();
  });

  it("handles multi-digit numbers", () => {
    expect(solveDigitExpression("100 + 200")).toBe("300.00");
  });

  it("handles decimal results", () => {
    expect(solveDigitExpression("7 / 2")).toBe("3.50");
  });

  it("picks the longest candidate expression", () => {
    expect(solveDigitExpression("ignore 1+1 but compute 10 + 20 + 30")).toBe("60.00");
  });

  it("returns null for division by zero (Infinity)", () => {
    expect(solveDigitExpression("1 / 0")).toBeNull();
  });

  it("returns null for invalid expression syntax", () => {
    expect(solveDigitExpression("1 ++ 2")).toBeNull();
  });
});

// ── normalizeChallenge ──

describe("normalizeChallenge", () => {
  it("lowercases text", () => {
    expect(normalizeChallenge("HELLO World")).toBe("helo world");
  });

  it("strips non-alpha characters", () => {
    expect(normalizeChallenge("hello-world! 123")).toBe("heloworld");
  });

  it("deduplicates consecutive letters", () => {
    expect(normalizeChallenge("hellooo")).toBe("helo");
  });

  it("collapses whitespace", () => {
    expect(normalizeChallenge("a   b   c")).toBe("a b c");
  });

  it("trims leading/trailing space", () => {
    expect(normalizeChallenge("  hello  ")).toBe("helo");
  });
});

// ── extractNumbers ──

describe("extractNumbers", () => {
  it("extracts single number word", () => {
    expect(extractNumbers("five")).toEqual([5]);
  });

  it("extracts multiple number words", () => {
    expect(extractNumbers("three five")).toEqual([3, 5]);
  });

  it("extracts teen numbers", () => {
    expect(extractNumbers("thirteen")).toEqual([13]);
  });

  it("extracts tens", () => {
    expect(extractNumbers("twenty")).toEqual([20]);
  });

  it("extracts compound tens+ones", () => {
    expect(extractNumbers("twenty three")).toEqual([23]);
  });

  it("skips filler words", () => {
    expect(extractNumbers("the five and three")).toEqual([5, 3]);
  });

  it("handles zero", () => {
    expect(extractNumbers("zero")).toEqual([0]);
  });

  it("handles ten", () => {
    expect(extractNumbers("ten")).toEqual([10]);
  });

  it("handles nineteen", () => {
    expect(extractNumbers("nineteen")).toEqual([19]);
  });

  it("extracts from normalized text with deduped letters", () => {
    expect(extractNumbers("thre")).toEqual([3]);
  });

  it("returns empty for no number words", () => {
    expect(extractNumbers("the quick brown fox")).toEqual([]);
  });

  it("handles forty two compound", () => {
    expect(extractNumbers("forty two")).toEqual([42]);
  });

  it("handles ninety nine compound", () => {
    expect(extractNumbers("ninety nine")).toEqual([99]);
  });

  it("handles split word tokens joined together", () => {
    expect(extractNumbers("twen ty")).toEqual([20]);
  });
});

// ── detectOperation ──

describe("detectOperation", () => {
  it("detects times as mul", () => {
    expect(detectOperation("times")).toBe("mul");
  });

  it("detects multiply as mul", () => {
    expect(detectOperation("multiply these")).toBe("mul");
  });

  it("detects multiplied as mul", () => {
    expect(detectOperation("multiplied by")).toBe("mul");
  });

  it("detects product as mul", () => {
    expect(detectOperation("the product of")).toBe("mul");
  });

  it("detects divide as div", () => {
    expect(detectOperation("divide these numbers")).toBe("div");
  });

  it("detects ratio as div", () => {
    expect(detectOperation("ratio of")).toBe("div");
  });

  it("detects subtract as sub", () => {
    expect(detectOperation("subtract from")).toBe("sub");
  });

  it("detects minus as sub", () => {
    expect(detectOperation("minus the")).toBe("sub");
  });

  it("detects less as sub", () => {
    expect(detectOperation("less than")).toBe("sub");
  });

  it("defaults to add for no keywords", () => {
    expect(detectOperation("combine these")).toBe("add");
  });

  it("defaults to add for empty string", () => {
    expect(detectOperation("")).toBe("add");
  });
});

// ── compute ──

describe("compute", () => {
  it("adds multiple numbers", () => {
    expect(compute([1, 2, 3], "add")).toBe(6);
  });

  it("subtracts left to right", () => {
    expect(compute([10, 3, 2], "sub")).toBe(5);
  });

  it("multiplies multiple numbers", () => {
    expect(compute([2, 3, 4], "mul")).toBe(24);
  });

  it("divides first by second", () => {
    expect(compute([20, 5], "div")).toBe(4);
  });

  it("returns null for division by zero", () => {
    expect(compute([10, 0], "div")).toBeNull();
  });

  it("returns null for fewer than 2 numbers", () => {
    expect(compute([5], "add")).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(compute([], "add")).toBeNull();
  });

  it("handles add with two numbers", () => {
    expect(compute([7, 3], "add")).toBe(10);
  });

  it("handles sub with two numbers", () => {
    expect(compute([9, 4], "sub")).toBe(5);
  });
});

// ── solveChallenge word path ──

describe("solveChallenge (word path)", () => {
  it("solves addition word problem", () => {
    expect(solveChallenge("five plus three")).toBe("8.00");
  });

  it("solves subtraction word problem", () => {
    expect(solveChallenge("ten minus three")).toBe("7.00");
  });

  it("solves multiplication word problem", () => {
    expect(solveChallenge("four times five")).toBe("20.00");
  });

  it("solves division word problem", () => {
    expect(solveChallenge("twenty divided by four")).toBe("5.00");
  });

  it("prefers digit expression over word path", () => {
    expect(solveChallenge("What is 2 + 3? five plus three")).toBe("5.00");
  });

  it("returns null for unsolvable challenge", () => {
    expect(solveChallenge("what is the meaning of life")).toBeNull();
  });

  it("returns null for single number", () => {
    expect(solveChallenge("five")).toBeNull();
  });
});

// ── autoVerify ──
// These tests need vi.resetModules + dynamic import because autoVerify calls apiRequest

describe("autoVerify", () => {
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

  it("returns null when no challenge text available", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    const { autoVerify } = await import("../../src/verify.js");
    const result = await autoVerify(
      { verification_code: null, challenge: null, prompt: null },
      {},
    );
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null when challenge is unsolvable", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    const { autoVerify } = await import("../../src/verify.js");
    const result = await autoVerify(
      { verification_code: null, challenge: "unsolvable gibberish no numbers here", prompt: null },
      {},
    );
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("solves challenge and calls apiRequest", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ verified: true }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { autoVerify } = await import("../../src/verify.js");
    const result = await autoVerify(
      { verification_code: "code123", challenge: "2 + 3", prompt: null },
      {},
    );
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    // Verify the fetch was called with the answer
    const [, fetchOpts] = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchOpts.body);
    expect(body.answer).toBe("5.00");
    expect(body.verification_code).toBe("code123");
  });

  it("uses prompt when challenge is null", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { autoVerify } = await import("../../src/verify.js");
    const result = await autoVerify(
      { verification_code: null, challenge: null, prompt: "4 + 4" },
      {},
    );
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
  });

  it("uses body.challenge when verification fields are null", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { autoVerify } = await import("../../src/verify.js");
    const result = await autoVerify(
      { verification_code: null, challenge: null, prompt: null },
      { challenge: "3 + 3" },
    );
    expect(result).not.toBeNull();
  });

  it("uses body.math_challenge as fallback", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { autoVerify } = await import("../../src/verify.js");
    const result = await autoVerify(
      { verification_code: null, challenge: null, prompt: null },
      { math_challenge: "1 + 1" },
    );
    expect(result).not.toBeNull();
  });

  it("does not include verification_code when null", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { autoVerify } = await import("../../src/verify.js");
    await autoVerify(
      { verification_code: null, challenge: "5 + 5", prompt: null },
      {},
    );
    const [, fetchOpts] = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchOpts.body);
    expect(body).not.toHaveProperty("verification_code");
  });

  it("returns success=false when API returns not ok", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false, status: 400,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ error: "bad" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { autoVerify } = await import("../../src/verify.js");
    const result = await autoVerify(
      { verification_code: null, challenge: "2 + 2", prompt: null },
      {},
    );
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
  });

  it("uses body.question as fallback", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { autoVerify } = await import("../../src/verify.js");
    const result = await autoVerify(
      { verification_code: null, challenge: null, prompt: null },
      { question: "7 + 7" },
    );
    expect(result).not.toBeNull();
  });
});

// ── handleVerify ──
// Uses real modules with mocked I/O (fetch + fs)

describe("handleVerify", () => {
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

  function setStateFile(state: Record<string, unknown>) {
    // We need to know STATE_PATH but can't import it without loading the module.
    // Instead, set up the file in mockFs based on the known path pattern.
    const os = require("os");
    const path = require("path");
    const statePath = path.join(os.homedir(), ".config", "moltbook", "mcp_state.json");
    mockFs.files.set(statePath, JSON.stringify(state));
  }

  it("auto-solves from challenge arg", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ verified: true }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);
    setStateFile({});

    const { handleVerify } = await import("../../src/verify.js");
    const result = await handleVerify({ challenge: "2 + 3" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.verified).toBe(true);
  });

  it("uses user-provided answer when no challenge", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ verified: true }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);
    setStateFile({});

    const { handleVerify } = await import("../../src/verify.js");
    const result = await handleVerify({ answer: "42" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
  });

  it("returns error when no answer or challenge", async () => {
    setStateFile({});

    const { handleVerify } = await import("../../src/verify.js");
    const result = await handleVerify({});
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe("missing_answer");
  });

  it("formats numeric answer to 2 decimals", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ verified: true }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);
    setStateFile({});

    const { handleVerify } = await import("../../src/verify.js");
    await handleVerify({ answer: "42" });
    const [, fetchOpts] = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchOpts.body);
    expect(body.answer).toBe("42.00");
  });

  it("detects suspension in verify response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false, status: 403,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ status: "suspended", reason: "abuse" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);
    setStateFile({});

    const { handleVerify } = await import("../../src/verify.js");
    await handleVerify({ answer: "10" });

    // Check saved state
    const os = require("os");
    const path = require("path");
    const statePath = path.join(os.homedir(), ".config", "moltbook", "mcp_state.json");
    const savedState = JSON.parse(mockFs.files.get(statePath)!);
    expect(savedState.suspension.active).toBe(true);
  });

  it("detects re-challenge in verify response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false, status: 403,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({
        verification_code: "new_code",
        challenge: { challenge: "What color is the sky?", verification_code: "new_code" },
      }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);
    setStateFile({});

    const { handleVerify } = await import("../../src/verify.js");
    const result = await handleVerify({ answer: "wrong" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe("verification_still_required");

    const os = require("os");
    const path = require("path");
    const statePath = path.join(os.homedir(), ".config", "moltbook", "mcp_state.json");
    const savedState = JSON.parse(mockFs.files.get(statePath)!);
    expect(savedState.offense_count).toBe(1);
  });

  it("uses verification_code from state when not in args", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ verified: true }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);
    setStateFile({
      pending_verification: {
        source_tool: "test", detected_at: "", verification_code: "state_code",
        challenge: null, prompt: null, expires_at: null,
      },
    });

    const { handleVerify } = await import("../../src/verify.js");
    await handleVerify({ answer: "5" });
    const [, fetchOpts] = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchOpts.body);
    expect(body.verification_code).toBe("state_code");
  });

  it("uses custom path when specified", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ verified: true }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);
    setStateFile({});

    const { handleVerify } = await import("../../src/verify.js");
    await handleVerify({ answer: "5", path: "/verify/custom" });
    const [url] = mockFetch.mock.calls[0];
    expect(url.toString()).toContain("/verify/custom");
  });

  it("clears pending verification on success", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ verified: true }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);
    setStateFile({
      pending_verification: {
        source_tool: "test", detected_at: "", verification_code: "abc",
        challenge: null, prompt: null, expires_at: null,
      },
    });

    const { handleVerify } = await import("../../src/verify.js");
    await handleVerify({ answer: "5" });

    const os = require("os");
    const path = require("path");
    const statePath = path.join(os.homedir(), ".config", "moltbook", "mcp_state.json");
    const savedState = JSON.parse(mockFs.files.get(statePath)!);
    expect(savedState.pending_verification).toBeNull();
  });

  it("handles API error response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false, status: 500,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ error: "internal server error" }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);
    setStateFile({});

    const { handleVerify } = await import("../../src/verify.js");
    const result = await handleVerify({ answer: "5" });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error.code).toBe("verify_failed");
  });

  it("accepts solution arg as alias for answer", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ verified: true }),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);
    setStateFile({});

    const { handleVerify } = await import("../../src/verify.js");
    const result = await handleVerify({ solution: "10" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
  });

  it("includes challenge_id in request body when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);
    setStateFile({});

    const { handleVerify } = await import("../../src/verify.js");
    await handleVerify({ answer: "5", challenge_id: "ch_123" });
    const [, fetchOpts] = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchOpts.body);
    expect(body.challenge_id).toBe("ch_123");
  });

  it("prefers auto-solved answer over user-provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
    });
    vi.stubGlobal("fetch", mockFetch);
    setStateFile({});

    const { handleVerify } = await import("../../src/verify.js");
    await handleVerify({ answer: "999", challenge: "2 + 3" });
    const [, fetchOpts] = mockFetch.mock.calls[0];
    const body = JSON.parse(fetchOpts.body);
    // Should use auto-solved 5.00 not user-provided 999
    expect(body.answer).toBe("5.00");
  });
});
