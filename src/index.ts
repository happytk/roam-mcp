import OAuthProvider, { type OAuthHelpers } from "@cloudflare/workers-oauth-provider";

interface Env {
  ROAM_API_TOKEN?: string;
  ROAM_GRAPH_NAME?: string;
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
}

interface EffectiveEnv {
  ROAM_API_TOKEN: string;
  ROAM_GRAPH_NAME: string;
  aiTag: boolean;
  dryRun: boolean;
  mutate: boolean;
}

// Props persisted in each OAuth grant. The OAuthProvider injects these into
// `ctx.props` on every authenticated /mcp request so the API handler can act
// on the user's specific graph + token without re-prompting.
interface RoamProps {
  graph: string;
  token: string;
}

const ROAM_API_BASE = "https://api.roamresearch.com/api/graph";

function requireConfig(env: EffectiveEnv): void {
  if (!env.ROAM_GRAPH_NAME) {
    throw new Error("ROAM_GRAPH_NAME is not set. Pass X-Roam-Graph header.");
  }
  if (!env.ROAM_API_TOKEN) {
    throw new Error("ROAM_API_TOKEN is not set. Pass X-Roam-Token header (or Authorization: Bearer ...).");
  }
}

// --- Roam API helpers ---

async function roamQuery(env: EffectiveEnv, query: string): Promise<any> {
  requireConfig(env);
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

async function roamWrite(env: EffectiveEnv, action: object): Promise<any> {
  if (env.dryRun) {
    return { dryRun: true, action };
  }
  requireConfig(env);
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

async function findPageUid(env: EffectiveEnv, title: string): Promise<string | null> {
  const query =
    `[:find ?uid :where [?p :node/title "${esc(title)}"] [?p :block/uid ?uid]]`;
  const result = await roamQuery(env, query);
  return result.result?.[0]?.[0] ?? null;
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

// Recursively create a subtree of blocks under a given parent uid. Each node
// is { content: string, children?: Node[] }. Children are NOT tagged with #ai
// — the caller's root block already carries the tag, which is enough to mark
// the whole subtree as AI-generated without cluttering every descendant.
async function createChildrenTree(
  env: EffectiveEnv,
  parentUid: string,
  nodes: any[],
  createdUids: string[]
): Promise<void> {
  for (const node of nodes) {
    if (!node || typeof node.content !== "string") continue;
    const childUid = uid();
    await roamWrite(env, {
      action: "create-block",
      location: { "parent-uid": parentUid, order: "last" },
      block: { string: node.content, uid: childUid },
    });
    createdUids.push(childUid);
    if (Array.isArray(node.children) && node.children.length > 0) {
      await createChildrenTree(env, childUid, node.children, createdUids);
    }
  }
}

// --- Server-level instructions (sent in MCP initialize response) ---

function roamInstructions(env: EffectiveEnv): string {
  const tagSection = env.aiTag
    ? `The top-level block of every write (and new pages) is automatically tagged with #ai
so the user can distinguish AI-generated content from their own notes. Nested
children created via the \`children\` argument are NOT tagged individually —
the root's tag already marks the whole subtree.`
    : `The #ai auto-tagging is DISABLED for this session (X-Roam-Ai-Tag: false).
Blocks created by these tools will not carry a #ai marker.`;
  const sections = [tagSection];
  if (env.mutate) {
    sections.push(
      `Mutation tools are ENABLED for this session (X-Roam-Mutate: true).
roam_update_block, roam_delete_block, and roam_move_block are available.
Be conservative: prefer roam_update_block over delete; verify uids before
calling delete; consider X-Roam-Dry-Run for a no-op preview when uncertain.`
    );
  }
  if (env.dryRun) {
    sections.push(
      `Dry-run mode is ENABLED for this session (X-Roam-Dry-Run: true).
ALL writes are no-ops — no block, page, or edit will be persisted to the
graph. Tool responses include "dry_run": true so you can detect this.
Returned uids are synthesized and do NOT correspond to real blocks.`
    );
  }
  return ROAM_INSTRUCTIONS_BODY + "\n\n" + sections.join("\n\n");
}

const ROAM_INSTRUCTIONS_BODY = `This server writes to a Roam Research graph.

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

5. OUTLINER STRUCTURE — Roam is an outliner, not a document editor. Multi-item or
   hierarchical content MUST be written as a tree of short blocks, not as one long
   block with line breaks or bullets inside it, and not as a flat run of sibling
   blocks when the items logically nest.

   Rules of thumb:
   - One idea per block. If a block contains a list, multiple sentences on different
     topics, or markdown bullets/numbering inside a single string, split it.
   - Use parent/child nesting to express structure (topic → sub-points → details,
     task → sub-tasks, question → answer points). Do NOT fake hierarchy with "-" or
     indentation inside a single block.
   - Use the \`children\` argument on \`roam_create_block\` to create a whole subtree
     in one call. For adding under an existing block, pass its uid as \`parent_uid\`.
     Both \`roam_create_block\` and \`roam_add_todo\` return the created block's \`uid\`
     so you can chain follow-up calls.
   - Keep nesting consistent: don't mix "everything in one block" and "deep tree"
     in the same write. Pick the right depth for the content and apply it uniformly.`;

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
      "Add a TODO block. Defaults to today's daily note when `page` is omitted — this is the correct way to add to today. Do NOT pass today's date as `page`; omit it instead. Returns the created block's `uid` so you can nest sub-tasks under it using `parent_uid`.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Task description (one idea per block — split multi-step tasks into parent + children instead of cramming into one string)" },
        page: {
          type: "string",
          description:
            "Target page title. Omit to use today's daily note (preferred for 'today'). If specifying a daily note explicitly, use ordinal format like 'April 16th, 2026'. Ignored when `parent_uid` is provided.",
        },
        parent_uid: {
          type: "string",
          description:
            "If set, nest this TODO under an existing block instead of appending to a page. Use this to build hierarchy (e.g. sub-tasks under a parent task).",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "roam_create_block",
    description:
      "Append a text block to a page, or nest it under an existing block. Defaults to today's daily note when both `page` and `parent_uid` are omitted. IMPORTANT: Roam is an outliner — for multi-item or hierarchical content, pass a `children` tree (one idea per block, nested by structure) rather than stuffing bullets/newlines into a single `content` string. Returns the created block's `uid`, plus `created_uids` when `children` is used.\n\nExample for a list with sub-points:\n  { content: \"Release notes\", children: [\n    { content: \"Backend\", children: [\n      { content: \"fix race condition in queue\" },\n      { content: \"bump node to 20\" }\n    ]},\n    { content: \"Frontend\", children: [\n      { content: \"dark mode toggle\" }\n    ]}\n  ]}",
    inputSchema: {
      type: "object",
      properties: {
        page: {
          type: "string",
          description:
            "Target page title. Omit to use today's daily note. If specifying a daily note explicitly, use ordinal format like 'April 16th, 2026'. Ignored when `parent_uid` is provided.",
        },
        parent_uid: {
          type: "string",
          description:
            "If set, create this block as a child of an existing block (by uid) instead of appending to a page. Use this to build hierarchy across multiple calls.",
        },
        content: {
          type: "string",
          description:
            "Root block text (supports Roam markdown). Keep it to one idea — if you have multiple items, put them in `children` instead of concatenating with newlines/bullets.",
        },
        children: {
          type: "array",
          description:
            "Nested subtree created in one call. Each node has the shape { content: string, children?: Node[] } and can nest arbitrarily deep. Prefer this over multiple flat calls for any content with natural hierarchy (lists, outlines, topic+details, task+sub-tasks).",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "Block text" },
              children: {
                type: "array",
                description: "Further nested children (same { content, children? } shape; recurses).",
                items: {
                  type: "object",
                  properties: {
                    content: { type: "string" },
                    children: {
                      type: "array",
                      items: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
                    },
                  },
                  required: ["content"],
                },
              },
            },
            required: ["content"],
          },
        },
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

// Mutation tools — destructive or modify-existing-content. Hidden from
// tools/list and refused at tools/call unless the request opts in via
// `X-Roam-Mutate: true`. Default OFF so an LLM that hasn't been granted
// edit permission can't even discover them.
const MUTATE_TOOLS = [
  {
    name: "roam_update_block",
    description:
      "Replace the text of an existing block by uid. Does NOT auto-append #ai — pass the exact final content you want. Use this to edit a block you previously created (uid is returned by roam_add_todo / roam_create_block) or to fix a block found via search.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "uid of the block to update" },
        content: {
          type: "string",
          description:
            "New block string (Roam markdown). Replaces the entire block content — include any markers like {{[[TODO]]}} or #ai yourself if you want them preserved.",
        },
      },
      required: ["uid", "content"],
    },
  },
  {
    name: "roam_delete_block",
    description:
      "Delete a block by uid. The block AND all of its descendants are removed permanently — there is no undo from the API. Be conservative: prefer roam_update_block when you only need to change content.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "uid of the block to delete" },
      },
      required: ["uid"],
    },
  },
  {
    name: "roam_move_block",
    description:
      "Move a block under a new parent or onto a page. Provide either `parent_uid` (nest under another block) OR `page` (move to top of a page) — exactly one is required.",
    inputSchema: {
      type: "object",
      properties: {
        uid: { type: "string", description: "uid of the block to move" },
        parent_uid: {
          type: "string",
          description:
            "uid of the new parent block. Mutually exclusive with `page`.",
        },
        page: {
          type: "string",
          description:
            "Target page title (move to top level of a page). For daily notes use ordinal format like 'April 16th, 2026'. Mutually exclusive with `parent_uid`.",
        },
        order: {
          description:
            "Position under the new parent: a number (0-based index), 'first', or 'last'. Defaults to 'last'.",
          default: "last",
        },
      },
      required: ["uid"],
    },
  },
  {
    name: "roam_rename_page",
    description:
      "Rename a page. Identify it by `title` (current title) or `uid`; pass `new_title` for the new name. Daily notes use ordinal format like 'April 16th, 2026' for both old and new titles.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "Current page title. Mutually exclusive with `uid` (one is required).",
        },
        uid: {
          type: "string",
          description:
            "Page uid (skip the title→uid lookup). Mutually exclusive with `title`.",
        },
        new_title: { type: "string", description: "New page title." },
      },
      required: ["new_title"],
    },
  },
  {
    name: "roam_delete_page",
    description:
      "Delete a page and ALL its blocks permanently. Be VERY conservative — this is much higher blast radius than roam_delete_block. Identify by `title` or `uid`. Daily notes are deletable too, so double-check the title.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "Page title to delete. Mutually exclusive with `uid` (one is required). For daily notes use ordinal format.",
        },
        uid: {
          type: "string",
          description:
            "Page uid (skip the title→uid lookup). Mutually exclusive with `title`.",
        },
      },
    },
  },
];

const MUTATE_TOOL_NAMES = new Set(MUTATE_TOOLS.map((t) => t.name));

// --- Tool handlers ---

async function callTool(
  env: EffectiveEnv,
  name: string,
  args: Record<string, any>
): Promise<string> {
  if (MUTATE_TOOL_NAMES.has(name) && !env.mutate) {
    throw new Error(
      `Tool "${name}" is disabled. Mutation tools (update/delete/move) are off by default — set X-Roam-Mutate: true on the request to enable.`
    );
  }
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
      if (env.aiTag) {
        await roamWrite(env, {
          action: "create-block",
          location: { "page-title": title, order: 0 },
          block: { string: "#ai", uid: uid() },
        });
      }
      return JSON.stringify({
        success: true,
        message: `Page "${title}" created`,
        ...(env.dryRun ? { dry_run: true } : {}),
      });
    }

    case "roam_add_todo": {
      const { task, parent_uid } = args;
      const blockUid = uid();
      const tagSuffix = env.aiTag ? " #ai" : "";
      if (parent_uid) {
        await roamWrite(env, {
          action: "create-block",
          location: { "parent-uid": parent_uid, order: "last" },
          block: { string: `{{[[TODO]]}} ${task}${tagSuffix}`, uid: blockUid },
        });
        return JSON.stringify({
          success: true,
          uid: blockUid,
          parent_uid,
          ...(env.dryRun ? { dry_run: true } : {}),
        });
      }
      const pageTitle = args.page ? normalizePageTitle(args.page) : todayPageTitle();
      await roamWrite(env, {
        action: "create-block",
        location: { "page-title": pageTitle, order: "last" },
        block: { string: `{{[[TODO]]}} ${task}${tagSuffix}`, uid: blockUid },
      });
      return JSON.stringify({
        success: true,
        uid: blockUid,
        page: pageTitle,
        ...(env.dryRun ? { dry_run: true } : {}),
      });
    }

    case "roam_create_block": {
      const { content, parent_uid, children } = args;
      const rootUid = uid();
      const location = parent_uid
        ? { "parent-uid": parent_uid, order: "last" }
        : { "page-title": args.page ? normalizePageTitle(args.page) : todayPageTitle(), order: "last" };
      const tagSuffix = env.aiTag ? " #ai" : "";
      await roamWrite(env, {
        action: "create-block",
        location,
        block: { string: `${content}${tagSuffix}`, uid: rootUid },
      });
      const createdUids: string[] = [rootUid];
      if (Array.isArray(children) && children.length > 0) {
        await createChildrenTree(env, rootUid, children, createdUids);
      }
      return JSON.stringify({
        success: true,
        uid: rootUid,
        ...(parent_uid ? { parent_uid } : { page: (location as any)["page-title"] }),
        ...(createdUids.length > 1 ? { created_uids: createdUids } : {}),
        ...(env.dryRun ? { dry_run: true } : {}),
      });
    }

    case "roam_update_block": {
      const { uid: blockUid, content } = args;
      await roamWrite(env, {
        action: "update-block",
        block: { uid: blockUid, string: content },
      });
      return JSON.stringify({
        success: true,
        uid: blockUid,
        ...(env.dryRun ? { dry_run: true } : {}),
      });
    }

    case "roam_delete_block": {
      const { uid: blockUid } = args;
      await roamWrite(env, {
        action: "delete-block",
        block: { uid: blockUid },
      });
      return JSON.stringify({
        success: true,
        uid: blockUid,
        deleted: true,
        ...(env.dryRun ? { dry_run: true } : {}),
      });
    }

    case "roam_move_block": {
      const { uid: blockUid, parent_uid, page, order = "last" } = args;
      if (parent_uid && page) {
        throw new Error("Pass either parent_uid or page, not both.");
      }
      if (!parent_uid && !page) {
        throw new Error("Must pass parent_uid or page to specify the destination.");
      }
      const normalizedPage = page ? normalizePageTitle(page) : undefined;
      const location = parent_uid
        ? { "parent-uid": parent_uid, order }
        : { "page-title": normalizedPage!, order };
      await roamWrite(env, {
        action: "move-block",
        location,
        block: { uid: blockUid },
      });
      return JSON.stringify({
        success: true,
        uid: blockUid,
        ...(parent_uid ? { parent_uid } : { page: normalizedPage }),
        order,
        ...(env.dryRun ? { dry_run: true } : {}),
      });
    }

    case "roam_rename_page": {
      const { title, uid: argUid, new_title } = args;
      if (title && argUid) {
        throw new Error("Pass either title or uid, not both.");
      }
      if (!title && !argUid) {
        throw new Error("Must pass title or uid to identify the page.");
      }
      if (!new_title) {
        throw new Error("new_title is required.");
      }
      const fromTitle = title ? normalizePageTitle(title) : undefined;
      const toTitle = normalizePageTitle(new_title);
      let pageUid = argUid;
      if (!pageUid) {
        pageUid = await findPageUid(env, fromTitle!);
        if (!pageUid) {
          throw new Error(`Page "${fromTitle}" not found`);
        }
      }
      await roamWrite(env, {
        action: "update-page",
        page: { uid: pageUid, title: toTitle },
      });
      return JSON.stringify({
        success: true,
        uid: pageUid,
        ...(fromTitle ? { from: fromTitle } : {}),
        to: toTitle,
        ...(env.dryRun ? { dry_run: true } : {}),
      });
    }

    case "roam_delete_page": {
      const { title, uid: argUid } = args;
      if (title && argUid) {
        throw new Error("Pass either title or uid, not both.");
      }
      if (!title && !argUid) {
        throw new Error("Must pass title or uid to identify the page.");
      }
      const normalizedTitle = title ? normalizePageTitle(title) : undefined;
      let pageUid = argUid;
      if (!pageUid) {
        pageUid = await findPageUid(env, normalizedTitle!);
        if (!pageUid) {
          throw new Error(`Page "${normalizedTitle}" not found`);
        }
      }
      await roamWrite(env, {
        action: "delete-page",
        page: { uid: pageUid },
      });
      return JSON.stringify({
        success: true,
        uid: pageUid,
        ...(normalizedTitle ? { title: normalizedTitle } : {}),
        deleted: true,
        ...(env.dryRun ? { dry_run: true } : {}),
      });
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

function parseBoolHeader(value: string | null, defaultVal: boolean): boolean {
  if (value === null) return defaultVal;
  const v = value.trim().toLowerCase();
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  return defaultVal;
}

// Extract `/g/<graph>` prefix from the URL. Returns the graph name (if any)
// and the remaining sub-path so the rest of the router treats e.g.
// "/g/personal/mcp" exactly like "/mcp".
function parsePath(pathname: string): { graphFromPath: string | null; subPath: string } {
  const match = pathname.match(/^\/g\/([^/]+)(?:\/(.*))?$/);
  if (!match) return { graphFromPath: null, subPath: pathname };
  return { graphFromPath: decodeURIComponent(match[1]), subPath: "/" + (match[2] ?? "") };
}

// Priority for each setting: OAuth props > header > query > path (graph only) > env.
// Token is intentionally NOT read from query strings — query params end up in
// access logs, browser history, and referrers. When an OAuth grant is in play
// (`props` set), it wins over every other source so a stolen header can't
// override the user's authorized graph/token.
function resolveEnv(
  request: Request,
  env: Env,
  graphFromPath: string | null = null,
  props: RoamProps | null = null,
): EffectiveEnv {
  const q = new URL(request.url).searchParams;
  const graph = props?.graph
    ?? request.headers.get("X-Roam-Graph")
    ?? q.get("graph")
    ?? graphFromPath
    ?? env.ROAM_GRAPH_NAME
    ?? "";
  const token = props?.token
    ?? request.headers.get("X-Roam-Token")
    ?? request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "")
    ?? env.ROAM_API_TOKEN
    ?? "";
  const aiTag = parseBoolHeader(
    request.headers.get("X-Roam-Ai-Tag") ?? q.get("aiTag") ?? q.get("ai_tag"),
    true,
  );
  const dryRun = parseBoolHeader(
    request.headers.get("X-Roam-Dry-Run") ?? q.get("dryRun") ?? q.get("dry_run"),
    false,
  );
  const mutate = parseBoolHeader(
    request.headers.get("X-Roam-Mutate") ?? q.get("mutate"),
    false,
  );
  return {
    ROAM_GRAPH_NAME: graph,
    ROAM_API_TOKEN: token,
    aiTag,
    dryRun,
    mutate,
  };
}

async function handleMCP(
  request: Request,
  env: Env,
  graphFromPath: string | null,
  props: RoamProps | null = null,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const effectiveEnv = resolveEnv(request, env, graphFromPath, props);

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
          instructions: roamInstructions(effectiveEnv),
        },
      });
    }

    if (method === "ping") {
      return Response.json({ jsonrpc: "2.0", id, result: {} });
    }

    if (method === "tools/list") {
      const tools = effectiveEnv.mutate ? [...TOOLS, ...MUTATE_TOOLS] : TOOLS;
      return Response.json({ jsonrpc: "2.0", id, result: { tools } });
    }

    if (method === "tools/call") {
      const { name, arguments: args = {} } = params;
      const text = await callTool(effectiveEnv, name, args);
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
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Roam-Graph, X-Roam-Token, X-Roam-Ai-Tag, X-Roam-Mutate, X-Roam-Dry-Run",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  Object.entries(CORS).forEach(([k, v]) => headers.set(k, v));
  return new Response(res.body, { status: res.status, headers });
}

// --- API handler (OAuth-protected: /mcp, /g/<graph>/mcp, /g/<graph>/check) ---

const apiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { graphFromPath, subPath } = parsePath(url.pathname);
    const props = ((ctx as unknown) as { props?: RoamProps }).props ?? null;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method === "GET" && subPath === "/mcp") {
      return withCors(new Response("SSE not supported; use POST for stateless mode", {
        status: 405,
        headers: { Allow: "POST" },
      }));
    }

    // OAuth-bound /check verifies the token actually granted to this caller.
    // Useful for "did my Claude.ai connector authorize correctly?" debugging.
    if (request.method === "GET" && subPath === "/check") {
      return runCheck(request, env, graphFromPath, props);
    }

    if (request.method === "POST" && (subPath === "/mcp" || subPath === "/")) {
      return withCors(await handleMCP(request, env, graphFromPath, props));
    }

    return withCors(new Response("Not Found", { status: 404 }));
  },
};

// --- Default handler (unprotected: /, /check, /authorize, OAuth pages) ---

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/authorize") {
      return handleAuthorize(request, env);
    }

    if (request.method === "GET") {
      // Setup diagnostics: GET /check actually hits the Roam API to verify
      // that the token + graph name are configured correctly. This variant
      // uses env-based token (CI smoke test path).
      if (url.pathname === "/check") {
        return runCheck(request, env, null, null);
      }

      // Root: status + integration hints. The "graph" field reflects the
      // env-bound default graph (used by /check and curl-style fallback);
      // OAuth-mediated requests carry their own graph in the grant.
      return withCors(
        Response.json({
          status: "ok",
          server: "roam-research-mcp",
          graph: env.ROAM_GRAPH_NAME ?? null,
          tokenConfigured: !!env.ROAM_API_TOKEN,
          oauth: {
            authorize: "/authorize",
            token: "/token",
            register: "/register",
            metadata: "/.well-known/oauth-authorization-server",
            note: "Claude.ai uses dynamic client registration — paste the connector URL and follow the OAuth consent prompt.",
          },
          path: {
            "/g/<graph>/mcp": "Per-graph MCP endpoint. Each graph gets its own OAuth grant.",
            "/g/<graph>/check": "OAuth-bound diagnostic for the granted token.",
          },
          headers: {
            "X-Roam-Graph": "graph override (curl/CI only — ignored when an OAuth grant is present)",
            "X-Roam-Token": "token override (curl/CI only)",
            "X-Roam-Ai-Tag": "false to disable #ai auto-tag (default: on)",
            "X-Roam-Mutate": "true to expose update/delete/move tools (default: off)",
            "X-Roam-Dry-Run": "true to make every write a no-op (default: off)",
          },
          query: {
            graph: "graph name (alternative to path; curl/CI only)",
            aiTag: "false to disable #ai auto-tag",
            mutate: "true to expose update/delete/move tools",
            dryRun: "true to make every write a no-op",
          },
        })
      );
    }

    return withCors(new Response("Not Found", { status: 404 }));
  },
};

// --- Shared diagnostic ---

async function runCheck(
  request: Request,
  env: Env,
  graphFromPath: string | null,
  props: RoamProps | null,
): Promise<Response> {
  const checkEnv = resolveEnv(request, env, graphFromPath, props);
  const hasGraph = !!checkEnv.ROAM_GRAPH_NAME;
  const hasToken = !!checkEnv.ROAM_API_TOKEN;
  const tokenPrefix = checkEnv.ROAM_API_TOKEN?.slice(0, 17) ?? "";
  const tokenLooksValid = tokenPrefix.startsWith("roam-graph-token-");
  if (!hasGraph) {
    return withCors(Response.json({
      ok: false,
      stage: "graph",
      error: "ROAM_GRAPH_NAME is not set. Authorize via /authorize, set the env secret, or pass X-Roam-Graph.",
    }, { status: 500 }));
  }
  if (!hasToken) {
    return withCors(Response.json({
      ok: false,
      stage: "token",
      error: "ROAM_API_TOKEN is not set. Authorize via /authorize, set the env secret, or pass X-Roam-Token.",
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
    const result = await roamQuery(
      checkEnv,
      "[:find ?title :where [?p :node/title ?title] :limit 1]"
    );
    return withCors(Response.json({
      ok: true,
      graph: checkEnv.ROAM_GRAPH_NAME,
      source: props ? "oauth-grant" : "env",
      message: "Token and graph name are valid. Roam API responded successfully.",
      sampleCount: result.result?.length ?? 0,
    }));
  } catch (err) {
    return withCors(Response.json({
      ok: false,
      stage: "roam-api",
      graph: checkEnv.ROAM_GRAPH_NAME,
      error: String(err),
      hint: "Check that the graph name matches your token.",
    }, { status: 500 }));
  }
}

// --- OAuth /authorize consent flow ---

// GET shows a small HTML form prompting for the roam token (and graph if not
// inferable from the connector URL). POST validates the token against the Roam
// API, then asks the OAuthProvider to issue an authorization code bound to
// `{graph, token}` props that the API handler will later read from ctx.props.
async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const provider = env.OAUTH_PROVIDER;

  if (request.method === "GET") {
    let oauthReqInfo;
    try {
      oauthReqInfo = await provider.parseAuthRequest(request);
    } catch (err) {
      return new Response(`Invalid OAuth request: ${err}`, { status: 400 });
    }
    const clientInfo = await provider.lookupClient(oauthReqInfo.clientId);
    const graphHint = inferGraphFromAuthRequest(request, oauthReqInfo);
    return new Response(renderAuthorizePage({
      oauthReqInfo,
      clientName: clientInfo?.clientName ?? clientInfo?.clientUri ?? "an MCP client",
      graphHint,
      error: null,
    }), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  if (request.method === "POST") {
    const form = await request.formData();
    const graph = String(form.get("graph") ?? "").trim();
    const token = String(form.get("token") ?? "").trim();
    const oauthReqJson = String(form.get("oauthReqInfo") ?? "");
    let oauthReqInfo: any;
    try {
      oauthReqInfo = JSON.parse(oauthReqJson);
    } catch {
      return new Response("Missing OAuth request context. Restart the authorization from your client.", { status: 400 });
    }
    const clientInfo = await provider.lookupClient(oauthReqInfo.clientId);
    const renderError = (msg: string, status = 400) =>
      new Response(renderAuthorizePage({
        oauthReqInfo,
        clientName: clientInfo?.clientName ?? clientInfo?.clientUri ?? "an MCP client",
        graphHint: graph,
        error: msg,
      }), { status, headers: { "Content-Type": "text/html; charset=utf-8" } });

    if (!graph) return renderError("Graph name is required.");
    if (!token) return renderError("Roam API token is required.");
    if (!token.startsWith("roam-graph-token-")) {
      return renderError(`Token must start with "roam-graph-token-". Local tokens ("roam-graph-local-token-") cannot be used with the API.`);
    }
    try {
      await roamQuery(
        { ROAM_GRAPH_NAME: graph, ROAM_API_TOKEN: token, aiTag: false, dryRun: false, mutate: false },
        "[:find ?title :where [?p :node/title ?title] :limit 1]",
      );
    } catch (err) {
      return renderError(`Roam API rejected the token for graph "${graph}": ${err}`);
    }
    const { redirectTo } = await provider.completeAuthorization({
      request: oauthReqInfo,
      userId: graph,
      metadata: { graph },
      scope: oauthReqInfo.scope ?? [],
      props: { graph, token } satisfies RoamProps,
    });
    return Response.redirect(redirectTo, 302);
  }

  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST" } });
}

// Pull a graph hint from the OAuth `resource` parameter (RFC 8707) — Claude
// passes the connector URL there, so /g/<graph>/mcp lets us pre-fill the form.
// Falls back to the request's own URL path or query.
function inferGraphFromAuthRequest(request: Request, oauthReqInfo: { resource?: string | string[] }): string {
  const resources = Array.isArray(oauthReqInfo.resource)
    ? oauthReqInfo.resource
    : oauthReqInfo.resource ? [oauthReqInfo.resource] : [];
  for (const r of resources) {
    try {
      const { graphFromPath } = parsePath(new URL(r).pathname);
      if (graphFromPath) return graphFromPath;
    } catch {
      // not a valid URL — ignore
    }
  }
  const url = new URL(request.url);
  const { graphFromPath } = parsePath(url.pathname);
  return graphFromPath ?? url.searchParams.get("graph") ?? "";
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" :
    c === "<" ? "&lt;" :
    c === ">" ? "&gt;" :
    c === '"' ? "&quot;" :
    "&#39;");
}

function renderAuthorizePage(opts: {
  oauthReqInfo: unknown;
  clientName: string;
  graphHint: string;
  error: string | null;
}): string {
  const { oauthReqInfo, clientName, graphHint, error } = opts;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize Roam access</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 2em auto; padding: 0 1em; line-height: 1.5; color: #1f2328; }
  h1 { font-size: 1.4em; }
  .client { background: #f6f8fa; border: 1px solid #d0d7de; padding: .75em 1em; border-radius: 6px; margin-bottom: 1em; }
  .error { background: #ffebe9; border: 1px solid #ff8182; color: #82071e; padding: .5em .75em; border-radius: 6px; margin-bottom: 1em; }
  label { display: block; margin-top: 1em; font-weight: 600; }
  input[type=text], input[type=password] { width: 100%; padding: .5em; margin-top: .25em; box-sizing: border-box; font-size: 1em; border: 1px solid #d0d7de; border-radius: 6px; }
  small { color: #57606a; display: block; margin-top: .25em; }
  button { margin-top: 1.5em; padding: .65em 1.25em; font-size: 1em; background: #1f883d; color: white; border: 0; border-radius: 6px; cursor: pointer; }
  button:hover { background: #1a7f37; }
  code { background: #eaeef2; padding: 0 .25em; border-radius: 3px; }
</style>
</head><body>
<h1>Authorize Roam graph access</h1>
<div class="client"><b>${htmlEscape(clientName)}</b> is requesting access to a Roam graph through your roam-mcp Worker.</div>
${error ? `<div class="error">${htmlEscape(error)}</div>` : ""}
<form method="POST">
  <input type="hidden" name="oauthReqInfo" value="${htmlEscape(JSON.stringify(oauthReqInfo))}">
  <label>Graph name
    <input type="text" name="graph" value="${htmlEscape(graphHint)}" required autocomplete="off" spellcheck="false">
  </label>
  <small>The name in your Roam URL: <code>roamresearch.com/#/app/<b>graph-name</b></code>.</small>
  <label>Roam API token
    <input type="password" name="token" placeholder="roam-graph-token-..." required autocomplete="off" spellcheck="false">
  </label>
  <small>Generate one in Roam → Settings → API tokens. Must start with <code>roam-graph-token-</code> (local tokens won't work).</small>
  <button type="submit">Authorize</button>
</form>
</body></html>`;
}

// --- Worker entry point ---
//
// `OAuthProvider` intercepts /.well-known/oauth-authorization-server, /token,
// and /register; routes /authorize and other paths to `defaultHandler`; and
// only forwards requests under `apiRoute` to `apiHandler` once the bearer
// token validates (either OAuth-issued or, via `resolveExternalToken` below,
// a raw `roam-graph-token-...` for curl/CI compatibility).
export default new OAuthProvider({
  apiRoute: ["/mcp", "/g/"],
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  // Treat a bearer token shaped like `roam-graph-token-...` as a self-bearing
  // credential — bypass OAuth lookup and synthesize props from the request's
  // graph hint (path/header/env). Lets `curl /mcp -H 'Authorization: Bearer
  // roam-graph-token-...'` keep working alongside Claude.ai's OAuth flow.
  resolveExternalToken: async ({ token, request, env }) => {
    if (!token.startsWith("roam-graph-token-")) return null;
    const e = env as Env;
    const url = new URL(request.url);
    const { graphFromPath } = parsePath(url.pathname);
    const graph = request.headers.get("X-Roam-Graph")
      ?? url.searchParams.get("graph")
      ?? graphFromPath
      ?? e.ROAM_GRAPH_NAME
      ?? null;
    if (!graph) return null;
    return { props: { graph, token } satisfies RoamProps };
  },
});
