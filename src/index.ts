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
  const suffix =
    day === 1 || day === 21 || day === 31 ? "st" :
    day === 2 || day === 22 ? "nd" :
    day === 3 || day === 23 ? "rd" : "th";
  return `${months[d.getMonth()]} ${day}${suffix}, ${d.getFullYear()}`;
}

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
        title: { type: "string", description: "Exact page title" },
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
    description: "Create a new page in Roam Research",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "New page title" },
      },
      required: ["title"],
    },
  },
  {
    name: "roam_add_todo",
    description: "Add a TODO block to a page (defaults to today's daily note)",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task description" },
        page: {
          type: "string",
          description: "Target page title. Omit to use today's daily note.",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "roam_create_block",
    description: "Append a text block to a page",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "string", description: "Target page title" },
        content: { type: "string", description: "Block content (supports Roam markdown)" },
      },
      required: ["page", "content"],
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
      const { title } = args;
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
      const { title } = args;
      await roamWrite(env, {
        action: "create-page",
        page: { title, uid: uid() },
      });
      return JSON.stringify({ success: true, message: `Page "${title}" created` });
    }

    case "roam_add_todo": {
      const { task, page } = args;
      const pageTitle = page ?? todayPageTitle();
      await roamWrite(env, {
        action: "create-block",
        location: { "page-title": pageTitle, order: "last" },
        block: { string: `{{[[TODO]]}} ${task} #ai`, uid: uid() },
      });
      return JSON.stringify({ success: true, page: pageTitle });
    }

    case "roam_create_block": {
      const { page, content } = args;
      await roamWrite(env, {
        action: "create-block",
        location: { "page-title": page, order: "last" },
        block: { string: `#ai ${content}`, uid: uid() },
      });
      return JSON.stringify({ success: true, page });
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
      return withCors(
        Response.json({
          status: "ok",
          server: "roam-research-mcp",
          graph: env.ROAM_GRAPH_NAME,
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
