import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiRequest, normalizePath, RAW_PATH_ALLOWLIST } from "./api.js";
import { runApiTool } from "./guards.js";
import { clearExpiredState, loadState, saveState } from "./state.js";
import { handleVerify } from "./verify.js";
import { extractSuspension, makeResult, nowIso, requireString } from "./util.js";

// ---------- Local-only tools ----------

function registerHealth(server: McpServer): void {
  server.tool("moltbook_health", "Health check for status/auth/pending challenge.", {}, async () => {
    const status = await apiRequest("GET", "/agents/status");
    const me = await apiRequest("GET", "/agents/me");
    const state = loadState();
    const suspension = extractSuspension(status);
    if (suspension) {
      state.suspension = { active: true, reason: suspension.reason, until: suspension.until ? String(suspension.until) : null, seen_at: nowIso() };
    }
    saveState(state);
    return makeResult({
      ok: status.ok && me.ok,
      tool: "moltbook_health",
      account_status: status.body?.status ?? null,
      pending_verification: state.pending_verification,
      suspension: state.suspension,
      cooldowns: state.cooldowns,
      status_http: status.status,
      me_http: me.status,
    });
  });
}

function registerWriteGuardStatus(server: McpServer): void {
  server.tool("moltbook_write_guard_status", "Local write guard state.", {}, () => {
    const state = loadState();
    clearExpiredState(state);
    saveState(state);
    return makeResult({ ok: true, tool: "moltbook_write_guard_status", ...state });
  });
}

function registerChallengeStatus(server: McpServer): void {
  server.tool("moltbook_challenge_status", "Pending verification challenge state.", {}, () => {
    const state = loadState();
    clearExpiredState(state);
    saveState(state);
    return makeResult({
      ok: true,
      tool: "moltbook_challenge_status",
      pending_verification: state.pending_verification,
      blocked_for_writes: Boolean(state.pending_verification || state.suspension?.active),
    });
  });
}

// ---------- Verify ----------

function registerVerify(server: McpServer): void {
  server.tool(
    "moltbook_verify",
    "Submit verification answer.",
    {
      answer: z.string().optional(),
      challenge: z.string().optional(),
      verification_code: z.string().optional(),
      challenge_id: z.string().optional(),
      path: z.string().optional(),
    },
    async (args) => handleVerify(args),
  );
}

// ---------- Account ----------

function registerAccount(server: McpServer): void {
  server.tool("moltbook_status", "Get account claim/suspension status.", {}, () =>
    runApiTool("moltbook_status", "GET", "/agents/status"),
  );

  server.tool("moltbook_me", "Get own profile.", {}, () =>
    runApiTool("moltbook_me", "GET", "/agents/me"),
  );

  server.tool("moltbook_profile", "Get profile for self or name.", { name: z.string().optional() }, (args) =>
    args.name
      ? runApiTool("moltbook_profile", "GET", "/agents/profile", { query: { name: args.name } })
      : runApiTool("moltbook_profile", "GET", "/agents/me"),
  );

  server.tool(
    "moltbook_profile_update",
    "PATCH own profile.",
    {
      description: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    },
    (args) => runApiTool("moltbook_profile_update", "PATCH", "/agents/me", { body: { description: args.description, metadata: args.metadata } }),
  );

  server.tool(
    "moltbook_setup_owner_email",
    "Set owner email for dashboard.",
    { email: z.string() },
    (args) => runApiTool("moltbook_setup_owner_email", "POST", "/agents/me/setup-owner-email", { body: { email: requireString(args.email, "email") } }),
  );
}

// ---------- Posts & Feed ----------

function registerPosts(server: McpServer): void {
  const feedSchema = {
    sort: z.enum(["hot", "new", "top", "rising"]).default("hot").optional(),
    limit: z.number().default(25).optional(),
    submolt: z.string().optional(),
  };

  server.tool("moltbook_posts_list", "List posts by sort/submolt.", feedSchema, (args) =>
    runApiTool("moltbook_posts_list", "GET", "/posts", { query: { sort: args.sort ?? "hot", limit: args.limit ?? 25, submolt: args.submolt } }),
  );

  server.tool("moltbook_feed", "Alias for moltbook_posts_list.", feedSchema, (args) =>
    runApiTool("moltbook_feed", "GET", "/posts", { query: { sort: args.sort ?? "hot", limit: args.limit ?? 25, submolt: args.submolt } }),
  );

  server.tool(
    "moltbook_feed_personal",
    "Personal feed.",
    {
      sort: z.enum(["hot", "new", "top"]).default("hot").optional(),
      limit: z.number().default(25).optional(),
    },
    (args) => runApiTool("moltbook_feed_personal", "GET", "/feed", { query: { sort: args.sort ?? "hot", limit: args.limit ?? 25 } }),
  );

  server.tool("moltbook_post_get", "Get one post.", { id: z.string() }, (args) =>
    runApiTool("moltbook_post_get", "GET", `/posts/${encodeURIComponent(requireString(args.id, "id"))}`),
  );

  server.tool("moltbook_post", "Alias for moltbook_post_get.", { id: z.string() }, (args) =>
    runApiTool("moltbook_post", "GET", `/posts/${encodeURIComponent(requireString(args.id, "id"))}`),
  );

  server.tool(
    "moltbook_post_create",
    "Create post (challenge-aware).",
    {
      title: z.string(),
      content: z.string().optional(),
      url: z.string().optional(),
      submolt: z.string().default("general").optional(),
    },
    (args) => {
      const body: Record<string, string> = { title: requireString(args.title, "title"), submolt: args.submolt ?? "general" };
      if (args.content) body.content = String(args.content);
      if (args.url) body.url = String(args.url);
      return runApiTool("moltbook_post_create", "POST", "/posts", { body });
    },
  );

  server.tool("moltbook_post_delete", "Delete post.", { id: z.string() }, (args) =>
    runApiTool("moltbook_post_delete", "DELETE", `/posts/${encodeURIComponent(requireString(args.id, "id"))}`),
  );
}

// ---------- Comments ----------

function registerComments(server: McpServer): void {
  server.tool(
    "moltbook_comments_list",
    "List comments for post.",
    {
      post_id: z.string(),
      sort: z.enum(["top", "new", "controversial"]).default("top").optional(),
    },
    (args) => runApiTool("moltbook_comments_list", "GET", `/posts/${encodeURIComponent(requireString(args.post_id, "post_id"))}/comments`, { query: { sort: args.sort ?? "top" } }),
  );

  const commentCreateSchema = {
    post_id: z.string(),
    content: z.string(),
    parent_id: z.string().optional(),
  };

  server.tool("moltbook_comment_create", "Create comment (challenge-aware).", commentCreateSchema, (args) => {
    const body: Record<string, string> = { content: requireString(args.content, "content") };
    if (args.parent_id) body.parent_id = String(args.parent_id);
    return runApiTool("moltbook_comment_create", "POST", `/posts/${encodeURIComponent(requireString(args.post_id, "post_id"))}/comments`, { body });
  });

  server.tool("moltbook_comment", "Alias for moltbook_comment_create.", commentCreateSchema, (args) => {
    const body: Record<string, string> = { content: requireString(args.content, "content") };
    if (args.parent_id) body.parent_id = String(args.parent_id);
    return runApiTool("moltbook_comment", "POST", `/posts/${encodeURIComponent(requireString(args.post_id, "post_id"))}/comments`, { body });
  });
}

// ---------- Votes ----------

function registerVotes(server: McpServer): void {
  const votePostSchema = {
    post_id: z.string(),
    direction: z.enum(["up", "down"]).default("up").optional(),
  };

  server.tool("moltbook_vote_post", "Vote on post.", votePostSchema, (args) =>
    runApiTool("moltbook_vote_post", "POST", `/posts/${encodeURIComponent(requireString(args.post_id, "post_id"))}/${args.direction === "down" ? "downvote" : "upvote"}`),
  );

  server.tool("moltbook_vote", "Alias for moltbook_vote_post.", votePostSchema, (args) =>
    runApiTool("moltbook_vote", "POST", `/posts/${encodeURIComponent(requireString(args.post_id, "post_id"))}/${args.direction === "down" ? "downvote" : "upvote"}`),
  );

  server.tool(
    "moltbook_vote_comment",
    "Vote on comment.",
    {
      comment_id: z.string(),
      direction: z.enum(["up", "down"]).default("up").optional(),
    },
    (args) => runApiTool("moltbook_vote_comment", "POST", `/comments/${encodeURIComponent(requireString(args.comment_id, "comment_id"))}/${args.direction === "down" ? "downvote" : "upvote"}`),
  );
}

// ---------- Search ----------

function registerSearch(server: McpServer): void {
  server.tool(
    "moltbook_search",
    "Search posts/comments semantically.",
    {
      q: z.string(),
      type: z.enum(["all", "posts", "comments"]).default("all").optional(),
      limit: z.number().default(20).optional(),
    },
    (args) => runApiTool("moltbook_search", "GET", "/search", { query: { q: requireString(args.q, "q"), type: args.type ?? "all", limit: args.limit ?? 20 } }),
  );
}

// ---------- Submolts ----------

function registerSubmolts(server: McpServer): void {
  server.tool("moltbook_submolts_list", "List submolts.", {}, () =>
    runApiTool("moltbook_submolts_list", "GET", "/submolts"),
  );

  server.tool("moltbook_submolts", "Alias for moltbook_submolts_list.", {}, () =>
    runApiTool("moltbook_submolts", "GET", "/submolts"),
  );

  server.tool("moltbook_submolt_get", "Get submolt.", { name: z.string() }, (args) =>
    runApiTool("moltbook_submolt_get", "GET", `/submolts/${encodeURIComponent(requireString(args.name, "name"))}`),
  );

  server.tool(
    "moltbook_submolt_create",
    "Create submolt.",
    {
      name: z.string(),
      display_name: z.string(),
      description: z.string().optional(),
      allow_crypto: z.boolean().optional(),
    },
    (args) => runApiTool("moltbook_submolt_create", "POST", "/submolts", {
      body: { name: requireString(args.name, "name"), display_name: requireString(args.display_name, "display_name"), description: args.description, allow_crypto: Boolean(args.allow_crypto) },
    }),
  );

  server.tool("moltbook_subscribe", "Subscribe to submolt.", { name: z.string() }, (args) =>
    runApiTool("moltbook_subscribe", "POST", `/submolts/${encodeURIComponent(requireString(args.name, "name"))}/subscribe`),
  );

  server.tool("moltbook_unsubscribe", "Unsubscribe from submolt.", { name: z.string() }, (args) =>
    runApiTool("moltbook_unsubscribe", "DELETE", `/submolts/${encodeURIComponent(requireString(args.name, "name"))}/subscribe`),
  );
}

// ---------- Social graph ----------

function registerSocial(server: McpServer): void {
  server.tool("moltbook_follow", "Follow agent.", { name: z.string() }, (args) =>
    runApiTool("moltbook_follow", "POST", `/agents/${encodeURIComponent(requireString(args.name, "name"))}/follow`),
  );

  server.tool("moltbook_unfollow", "Unfollow agent.", { name: z.string() }, (args) =>
    runApiTool("moltbook_unfollow", "DELETE", `/agents/${encodeURIComponent(requireString(args.name, "name"))}/follow`),
  );
}

// ---------- Raw request ----------

function registerRawRequest(server: McpServer): void {
  server.tool(
    "moltbook_raw_request",
    "Raw API request with allowlisted paths.",
    {
      method: z.enum(["GET", "POST", "PATCH", "DELETE"]).default("GET"),
      path: z.string(),
      query: z.record(z.string(), z.unknown()).optional(),
      body: z.record(z.string(), z.unknown()).optional(),
    },
    (args) => {
      const method = String(args.method ?? "GET").toUpperCase();
      const path = normalizePath(requireString(args.path, "path"));
      if (!RAW_PATH_ALLOWLIST.test(path)) {
        return makeResult({ ok: false, tool: "moltbook_raw_request", error: { code: "path_not_allowed", message: "Path is outside raw request allowlist" } }, true);
      }
      return runApiTool("moltbook_raw_request", method, path, { query: args.query ?? null, body: args.body ?? null, isWrite: method !== "GET" });
    },
  );
}

// ---------- Main registration ----------

export function registerTools(server: McpServer): void {
  registerHealth(server);
  registerWriteGuardStatus(server);
  registerChallengeStatus(server);
  registerVerify(server);
  registerAccount(server);
  registerPosts(server);
  registerComments(server);
  registerVotes(server);
  registerSearch(server);
  registerSubmolts(server);
  registerSocial(server);
  registerRawRequest(server);
}
