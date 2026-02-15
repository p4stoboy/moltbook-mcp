#!/usr/bin/env node
// API Monitor — standalone ESM script, zero external dependencies.
// Checks Moltbook API endpoints against a saved snapshot and opens/updates
// a GitHub Issue when changes are detected.

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = join(__dirname, "..", "api-snapshot.json");
const API_BASE = "https://www.moltbook.com/api/v1";
const SKILL_MD_URL = "https://www.moltbook.com/skill.md";
const API_KEY = process.env.MOLTBOOK_API_KEY || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const UPDATE_SNAPSHOT = process.argv.includes("--update-snapshot");

// Repo info from GitHub Actions environment
const GITHUB_REPO = process.env.GITHUB_REPOSITORY || "";
const ISSUE_TITLE = "API Monitor: Changes Detected";
const ISSUE_LABEL = "api-monitor";

// ── Endpoint definitions ──────────────────────────────────────────────

const ENDPOINTS = [
  { name: "GET /posts", path: "/posts", auth: false },
  { name: "GET /submolts", path: "/submolts", auth: false },
  { name: "GET /submolts/general", path: "/submolts/general", auth: false },
  {
    name: "GET /search?q=test&type=posts&limit=1",
    path: "/search?q=test&type=posts&limit=1",
    auth: false,
  },
  { name: "GET /agents/me", path: "/agents/me", auth: true },
  { name: "GET /agents/status", path: "/agents/status", auth: true },
];

// ── Helpers ───────────────────────────────────────────────────────────

async function fetchEndpoint(endpoint) {
  if (endpoint.auth && !API_KEY) {
    return null; // skip auth endpoints when no key is available
  }

  const headers = {};
  if (endpoint.auth) {
    headers["Authorization"] = `Bearer ${API_KEY}`;
  }

  try {
    const res = await fetch(`${API_BASE}${endpoint.path}`, { headers });
    const body = await res.json();
    const shape = Array.isArray(body) ? "array" : typeof body === "object" && body !== null ? "object" : typeof body;
    const keys = typeof body === "object" && body !== null && !Array.isArray(body)
      ? Object.keys(body).sort()
      : [];

    return { status: res.status, shape, keys };
  } catch (err) {
    return { status: -1, shape: "error", keys: [], error: err.message };
  }
}

async function fetchSkillMdHash() {
  try {
    const res = await fetch(SKILL_MD_URL);
    const text = await res.text();
    return createHash("sha256").update(text).digest("hex");
  } catch (err) {
    return `error:${err.message}`;
  }
}

function compareEndpoint(name, prev, curr) {
  if (!prev || !curr) return null;

  const diffs = [];
  if (prev.status !== curr.status) {
    diffs.push(`status: ${prev.status} -> ${curr.status}`);
  }
  if (prev.shape !== curr.shape) {
    diffs.push(`shape: ${prev.shape} -> ${curr.shape}`);
  }

  const prevKeys = (prev.keys || []).join(",");
  const currKeys = (curr.keys || []).join(",");
  if (prevKeys !== currKeys) {
    const added = (curr.keys || []).filter((k) => !(prev.keys || []).includes(k));
    const removed = (prev.keys || []).filter((k) => !(curr.keys || []).includes(k));
    const parts = [];
    if (added.length) parts.push(`added: ${added.join(", ")}`);
    if (removed.length) parts.push(`removed: ${removed.join(", ")}`);
    diffs.push(`keys: ${parts.join("; ")}`);
  }

  return diffs.length ? { endpoint: name, diffs } : null;
}

// ── GitHub Issue management ───────────────────────────────────────────

async function githubApi(path, options = {}) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.log("No GITHUB_TOKEN or GITHUB_REPOSITORY — skipping issue management.");
    return null;
  }

  const url = `https://api.github.com/repos/${GITHUB_REPO}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`GitHub API error ${res.status}: ${text}`);
    return null;
  }

  return res.json();
}

async function findOpenIssue() {
  const issues = await githubApi(
    `/issues?labels=${ISSUE_LABEL}&state=open&per_page=1`
  );
  return issues && issues.length > 0 ? issues[0] : null;
}

async function createOrCommentIssue(body) {
  const existing = await findOpenIssue();

  if (existing) {
    console.log(`Adding comment to existing issue #${existing.number}`);
    await githubApi(`/issues/${existing.number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  } else {
    console.log("Creating new issue");
    await githubApi("/issues", {
      method: "POST",
      body: JSON.stringify({
        title: ISSUE_TITLE,
        labels: [ISSUE_LABEL],
        body,
      }),
    });
  }
}

function formatIssueBody(changes, skillMdChanged, prevHash, currHash) {
  const lines = [
    `## API Changes Detected`,
    "",
    `**Date:** ${new Date().toISOString()}`,
    "",
  ];

  if (changes.length > 0) {
    lines.push("### Endpoint Changes", "");
    for (const c of changes) {
      lines.push(`**${c.endpoint}**`);
      for (const d of c.diffs) {
        lines.push(`- ${d}`);
      }
      lines.push("");
    }
  }

  if (skillMdChanged) {
    lines.push("### skill.md Hash Changed", "");
    lines.push(`- Previous: \`${prevHash}\``);
    lines.push(`- Current:  \`${currHash}\``);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  // Load snapshot
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, "utf-8"));
  } catch {
    console.error("Could not read snapshot file at", SNAPSHOT_PATH);
    process.exit(1);
  }

  console.log("Fetching endpoint data...");

  // Fetch all endpoints
  const results = {};
  for (const ep of ENDPOINTS) {
    const data = await fetchEndpoint(ep);
    if (data) {
      results[ep.name] = data;
      console.log(`  ${ep.name}: ${data.status} (${data.shape})`);
    } else {
      console.log(`  ${ep.name}: skipped (no auth key)`);
    }
  }

  // Fetch skill.md hash
  const skillMdHash = await fetchSkillMdHash();
  console.log(`  skill.md hash: ${skillMdHash.substring(0, 16)}...`);

  // Update snapshot mode
  if (UPDATE_SNAPSHOT) {
    const newSnapshot = {
      generated: new Date().toISOString(),
      endpoints: results,
      skillMdHash,
    };
    await writeFile(SNAPSHOT_PATH, JSON.stringify(newSnapshot, null, 2) + "\n");
    console.log("\nSnapshot updated:", SNAPSHOT_PATH);
    return;
  }

  // Compare against snapshot
  const changes = [];
  for (const ep of ENDPOINTS) {
    const prev = snapshot.endpoints[ep.name];
    const curr = results[ep.name];
    const diff = compareEndpoint(ep.name, prev, curr);
    if (diff) changes.push(diff);
  }

  const skillMdChanged =
    snapshot.skillMdHash !== "placeholder" && snapshot.skillMdHash !== skillMdHash;

  if (changes.length === 0 && !skillMdChanged) {
    console.log("\nNo changes detected.");
    return;
  }

  console.log(`\n${changes.length} endpoint change(s) detected.`);
  if (skillMdChanged) console.log("skill.md hash changed.");

  const body = formatIssueBody(
    changes,
    skillMdChanged,
    snapshot.skillMdHash,
    skillMdHash
  );
  console.log("\n--- Issue body ---");
  console.log(body);

  await createOrCommentIssue(body);
}

main().catch((err) => {
  console.error("Monitor failed:", err);
  process.exit(1);
});
