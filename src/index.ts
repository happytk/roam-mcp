interface Env {
  ROAM_API_TOKEN: string;
  ROAM_GRAPH_NAME: string;
}

const ROAM_API_BASE = "https://api.roamresearch.com/api/graph";

// --- Roam API helpers ---

async function roamQuery(env: Env, query: string): Promise<any> {
  const res = await fetch(`${ROAM_API_BASE}/${env.ROAM_GRAPH_NAME}/q`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Authorization": `Bearer ${env.ROAM_API_TOKEN}`,
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Roam query failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function roamWrite(env: Env, action: object): Promise<any> {
  const res = await fetch(`${ROAM_API_BASE}/${env.ROAM_GRAPH_NAME}/write`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Authorization": `Bearer ${env.ROAM_API_TOKEN}`,
    },
    body: JSON.stringify(action),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Roam write failed (${res.status}): ${text}`);
  }
  try {
    return text ? JSON.parse(text) : { ok: true };
  } catch {
    return { ok: true, raw: text };
  }
}

function uid(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 9 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join("");
}

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function todayPageTitle(): string {
  const d = new Date();
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const day = d.getDate();
  const suffix = ordinalSuffix(day);
  return `${months[d.getMonth()]} ${day}${suffix}, ${d.getFullYear()}`;
}

function ordinalSuffix(day: number): string {
  return day === 1 || day === 21 || day === 31 ? "st" :
         day === 2 || day === 22 ? "nd" :
         day === 3 || day === 23 ? "rd" : "th";
}

// Roam daily note titles MUST use ordinal suffixes, e.g. "April 16th, 2026".
// LLMs frequently produce "April 16, 2026" which Roam treats as a completely
// separate page. Detect that shape and normalize it so the correct daily note
// is used regardless of how the caller spelled it.
const DAILY_NOTE_NO_SUFFIX =
  /^(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})$/;

function normalizePageTitle(title: string): string {
  const match = title.match(DAILY_NOTE_NO_SUFFIX);
  if (!match) return title;
  const [, month, dayStr, year] = match;
  const day = parseInt(dayStr, 10);
  if (day < 1 || day > 31) return title;
  return `${month} ${day}${ordinalSuffix(day)}, ${year}`;
}

// --- Server-level instructions (sent in MCP initialize response) ---

const ROAM_INSTRUCTIONS = `This server writes to a Roam Research graph.

Roam conventions you MUST follow:

1. Daily note titles use ordinal suffixes: "April 16th, 2026", NOT "April 16, 2026".
   Roam treats "April 16, 2026" as a completely separate page, so using the wrong
   format silently creates the wrong page.

2. When the user says "today", "오늘", or refers to today's daily note, DO NOT pass
   today's date as the \`page\` argument. Instead, OMIT the \`page\` argument entirely
   — roam_add_todo and roam_create_block both default to today's daily note when
   \`page\` is omitted, and the server computes the correct title.

3. Do NOT call roam_create_page for today's daily note. Daily notes are auto-created
   when roam_add_todo or roam_create_block writes to them. Use roam_create_page only
   for genuinely new non-date pages.

4. When referencing a specific past/future daily note, always use the ordinal format
   (e.g. "March 3rd, 2026", "January 1st, 2026"). The server normalizes common
   mistakes like "March 3, 2026" as a safety net, but explicit correct formatting
   is preferred.

All blocks and new pages created via this server are automatically tagged with #ai
so the user can distinguish AI-generated content from their own notes.`;

// --- Tool definitions ---

const TOOLS = [
  {
    name: "roam_find_pages_modified_today",
    description: "Find pages modified today",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "roam_fetch_page_by_title",
    description: "Fetch a page and its block contents by title",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "Exact page title. For daily notes use ordinal format like 'April 16th, 2026' (NOT 'April 16, 2026').",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "roam_search_by_text",
    description: "Search for blocks containing specific text",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to search for" },
        limit: { type: "number", description: "Max results (default 20)", default: 20 },
      },
      required: ["text"],
    },
  },
  {
    name: "roam_search_for_tag",
    description: "Find all blocks that reference a specific tag or page",
    inputSchema: {
      type: "object",
      properties: {
        tag: { type: "string", description: "Tag name (without # or [[]])" },
        limit: { type: "number", description: "Max results (default 20)", default: 20 },
      },
      required: ["tag"],
    },
  },
  {
    name: "roam_search_by_status",
    description: "Find blocks with a specific status: TODO, DONE, or LATER",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["TODO", "DONE", "LATER"],
          description: "Block status to filter by",
        },
        limit: { type: "number", description: "Max results (default 20)", default: 20 },
      },
      required: ["status"],
    },
  },
  {
    name: "roam_create_page",
    description:
      "Create a new page in Roam Research. Do NOT use this to create today's daily note — daily notes are auto-created when roam_add_todo or roam_create_block writes to them.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "New page title. For daily notes use ordinal format like 'April 16th, 2026' (NOT 'April 16, 2026').",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "roam_add_todo",
    description:
      "Add a TODO block to a page. Defaults to today's daily note when `page` is omitted — this is the correct way to add to today. Do NOT pass today's date as `page`; omit it instead.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task description" },
        page: {
          type: "string",
          description:
            "Target page title. Omit to use today's daily note (preferred for 'today'). If specifying a daily note explicitly, use ordinal format like 'April 16th, 2026'.",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "roam_create_block",
    description:
      "Append a text block to a page. Defaults to today's daily note when `page` is omitted. Do NOT pass today's date as `page`; omit it instead.",
    inputSchema: {
      type: "object",
      properties: {
        page: {
          type: "string",
          description:
            "Target page title. Omit to use today's daily note (preferred for 'today'). If specifying a daily note explicitly, use ordinal format like 'April 16th, 2026'.",
        },
        content: { type: "string", description: "Block content (supports Roam markdown)" },
      },
      required: ["content"],
    },
  },
  {
    name: "roam_datomic_query",
    description: "Run a raw Datalog query against the Roam graph",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Datalog query string" },
      },
      required: ["query"],
    },
  },
];

// --- Tool handlers ---

async function callTool(
  env: Env,
  name: string,
  args: Record<string, any>
): Promise<string> {
  switch (name) {
    case "roam_find_pages_modified_today": {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      const query = `[:find (pull ?p [:node/title :edit/time]) :where [?p :node/title] [?p :edit/time ?t] [(> ?t ${midnight.getTime()})]]`;
      const result = await roamQuery(env, query);
      const pages = (result.result ?? [])
        .map((r: any) => r[0]?.["node/title"])
        .filter(Boolean);
      return JSON.stringify({ pages, count: pages.length }, null, 2);
    }

    case "roam_fetch_page_by_title": {
      const title = normalizePageTitle(args.title);
      const query =
        `[:find (pull ?p [:node/title :block/uid ` +
        `{:block/children [:block/string :block/uid :block/order ` +
        `{:block/children [:block/string :block/uid :block/order ` +
        `{:block/children [:block/string :block/uid :block/order]}]}]}]) ` +
        `:where [?p :node/title "${esc(title)}"]]`;
      const result = await roamQuery(env, query);
      if (!result.result?.length) {
        return JSON.stringify({ error: `Page "${title}" not found` });
      }
      return JSON.stringify(result.result[0][0], null, 2);
    }

    case "roam_search_by_text": {
      const { text, limit = 20 } = args;
      const query =
        `[:find (pull ?b [:block/string :block/uid {:block/page [:node/title]}]) ` +
        `:where [?b :block/string ?s] [(clojure.string/includes? ?s "${esc(text)}")]]`;
      const result = await roamQuery(env, query);
      const blocks = (result.result ?? []).slice(0, limit).map((r: any) => r[0]);
      return JSON.stringify({ blocks, count: blocks.length }, null, 2);
    }

    case "roam_search_for_tag": {
      const { tag, limit = 20 } = args;
      const query =
        `[:find (pull ?b [:block/string :block/uid {:block/page [:node/title]}]) ` +
        `:where [?tag :node/title "${esc(tag)}"] [?b :block/refs ?tag]]`;
      const result = await roamQuery(env, query);
      const blocks = (result.result ?? []).slice(0, limit).map((r: any) => r[0]);
      return JSON.stringify({ blocks, count: blocks.length }, null, 2);
    }

    case "roam_search_by_status": {
      const { status = "TODO", limit = 20 } = args;
      const marker =
        status === "TODO" ? "{{[[TODO]]}}" :
        status === "DONE" ? "{{[[DONE]]}}" :
        "{{[[LATER]]}}";
      const query =
        `[:find (pull ?b [:block/string :block/uid {:block/page [:node/title]}]) ` +
        `:where [?b :block/string ?s] [(clojure.string/includes? ?s "${esc(marker)}")]]`;
      const result = await roamQuery(env, query);
      const blocks = (result.result ?? []).slice(0, limit).map((r: any) => r[0]);
      return JSON.stringify({ blocks, count: blocks.length }, null, 2);
    }

    case "roam_create_page": {
      const title = normalizePageTitle(args.title);
      await roamWrite(env, {
        action: "create-page",
        page: { title, uid: uid() },
      });
      await roamWrite(env, {
        action: "create-block",
        location: { "page-title": title, order: 0 },
        block: { string: "#ai", uid: uid() },
      });
      return JSON.stringify({ success: true, message: `Page "${title}" created` });
    }

    case "roam_add_todo": {
      const { task } = args;
      const pageTitle = args.page ? normalizePageTitle(args.page) : todayPageTitle();
      await roamWrite(env, {
        action: "create-block",
        location: { "page-title": pageTitle, order: "last" },
        block: { string: `{{[[TODO]]}} ${task} #ai`, uid: uid() },
      });
      return JSON.stringify({ success: true, page: pageTitle });
    }

    case "roam_create_block": {
      const { content } = args;
      const pageTitle = args.page ? normalizePageTitle(args.page) : todayPageTitle();
      await roamWrite(env, {
        action: "create-block",
        location: { "page-title": pageTitle, order: "last" },
        block: { string: `${content} #ai`, uid: uid() },
      });
      return JSON.stringify({ success: true, page: pageTitle });
    }

    case "roam_datomic_query": {
      const result = await roamQuery(env, args.query);
      return JSON.stringify(result.result, null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --- MCP JSON-RPC handler ---

async function handleMCP(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  }

  const { id, method, params } = body;

  // Notifications have no id — respond with 204
  if (id === undefined) {
    return new Response(null, { status: 204 });
  }

  try {
    if (method === "initialize") {
      const SUPPORTED_VERSIONS = ["2025-03-26", "2024-11-05"];
      const requestedVersion = params?.protocolVersion ?? "2024-11-05";
      const protocolVersion = SUPPORTED_VERSIONS.includes(requestedVersion)
        ? requestedVersion
        : "2025-03-26";
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          serverInfo: { name: "roam-research", version: "1.0.0" },
          capabilities: { tools: { listChanged: false } },
          instructions: ROAM_INSTRUCTIONS,
        },
      });
    }

    if (method === "ping") {
      return Response.json({ jsonrpc: "2.0", id, result: {} });
    }

    if (method === "tools/list") {
      return Response.json({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    }

    if (method === "tools/call") {
      const { name, arguments: args = {} } = params;
      const text = await callTool(env, name, args);
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text }] },
      });
    }

    return Response.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  } catch (err) {
    return Response.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: String(err) },
    });
  }
}

// --- CORS headers ---

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  Object.entries(CORS).forEach(([k, v]) => headers.set(k, v));
  return new Response(res.body, { status: res.status, headers });
}

// --- Worker entry point ---

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method === "GET") {
      // Claude.ai may try GET /mcp for SSE — return 405 to signal stateless mode
      if (url.pathname === "/mcp") {
        return withCors(new Response("SSE not supported; use POST for stateless mode", {
          status: 405,
          headers: { Allow: "POST" },
        }));
      }

      // Setup diagnostics: GET /check actually hits the Roam API to verify
      // that the token + graph name are configured correctly.
      if (url.pathname === "/check") {
        const hasToken = !!env.ROAM_API_TOKEN;
        const tokenPrefix = env.ROAM_API_TOKEN?.slice(0, 17) ?? "";
        const tokenLooksValid = tokenPrefix.startsWith("roam-graph-token-");
        if (!hasToken) {
          return withCors(Response.json({
            ok: false,
            stage: "token",
            error: "ROAM_API_TOKEN secret is not set. Run: npx wrangler secret put ROAM_API_TOKEN",
          }, { status: 500 }));
        }
        if (!tokenLooksValid) {
          return withCors(Response.json({
            ok: false,
            stage: "token",
            error: `Token does not start with "roam-graph-token-" (got prefix: "${tokenPrefix}"). Local tokens ("roam-graph-local-token-") cannot be used with the API.`,
          }, { status: 500 }));
        }
        try {
          // Minimal query: just fetch one page title to confirm auth works.
          const result = await roamQuery(
            env,
            "[:find ?title :where [?p :node/title ?title] :limit 1]"
          );
          return withCors(Response.json({
            ok: true,
            graph: env.ROAM_GRAPH_NAME,
            message: "Token and graph name are valid. Roam API responded successfully.",
            sampleCount: result.result?.length ?? 0,
          }));
        } catch (err) {
          return withCors(Response.json({
            ok: false,
            stage: "roam-api",
            graph: env.ROAM_GRAPH_NAME,
            error: String(err),
            hint: "Check that ROAM_GRAPH_NAME in wrangler.toml matches your graph exactly, and that the token belongs to that graph.",
          }, { status: 500 }));
        }
      }

      return withCors(
        Response.json({
          status: "ok",
          server: "roam-research-mcp",
          graph: env.ROAM_GRAPH_NAME,
          tokenConfigured: !!env.ROAM_API_TOKEN,
        })
      );
    }

    // Accept POST at both "/" and "/mcp" — Claude.ai posts to the registered URL directly
    if (request.method === "POST") {
      return withCors(await handleMCP(request, env));
    }

    return withCors(new Response("Not Found", { status: 404 }));
  },
};
