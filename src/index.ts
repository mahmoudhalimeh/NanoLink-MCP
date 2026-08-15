#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { LinkondaClient, LinkondaError } from "./api.js";

const apiKey = process.env.LINKONDA_API_KEY?.trim() || undefined;
const client = new LinkondaClient(apiKey, process.env.LINKONDA_API_BASE_URL);

// Read the version rather than hardcoding it: a literal here silently goes stale on every
// release, so clients get told a version that no longer matches the package they installed.
// `../package.json` resolves the same from src/ under tsx and from dist/ once built.
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const server = new McpServer({ name: "linkonda", version });

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Turns a failure into something the model can act on rather than retry blindly — the API's
 * stable `code` plus, where we have one, the concrete next step.
 */
function fail(error: unknown): ToolResult {
  if (error instanceof LinkondaError) {
    const parts = [error.message];
    if (error.code) parts.push(`(code: ${error.code})`);
    if (error.hint) parts.push(`\n${error.hint}`);
    return { content: [{ type: "text", text: parts.join(" ") }], isError: true };
  }
  return { content: [{ type: "text", text: `Unexpected error: ${String(error)}` }], isError: true };
}

const ANON_NOTE =
  "\n\nNote: this link was created anonymously — it expires automatically and is not saved to an account. " +
  "Set LINKONDA_API_KEY to keep links permanently and manage them.";

server.registerTool(
  "shorten_link",
  {
    title: "Shorten a URL",
    description:
      "Create a short link for a URL. Works without an API key (anonymous links expire and are " +
      "not saved to an account). Linkonda records only a total redirect count per link — no IP " +
      "addresses, geolocation, device data, or referrers. Use when the user wants a short or " +
      "shareable URL, or a link for a QR code.",
    inputSchema: {
      url: z.string().url().describe("The destination URL to shorten. Must be absolute, e.g. https://example.com/page"),
      expiresInDays: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Optional. Delete the link automatically after this many days. Requires a Pro or " +
            "Enterprise plan — omit it on other plans, where the plan's own lifetime applies.",
        ),
      slug: z
        .string()
        .optional()
        .describe("Optional custom short code. Requires a paid plan; omit it to get a generated one."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ url, expiresInDays, slug }) => {
    try {
      const link = await client.createLink({ url, expiresInDays, slug });
      // The API does not echo the destination back, so report the URL we sent.
      const lines = [`Short URL: ${link.shortUrl}`, `Destination: ${url}`];
      if (link.expiresAt) lines.push(`Expires: ${link.expiresAt}`);
      else if (link.lifetimeUnlimited) lines.push("Expires: never");
      return ok(lines.join("\n") + (link.savedToAccount ? "" : ANON_NOTE));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "shorten_links_bulk",
  {
    title: "Shorten many URLs at once",
    description:
      "Create up to 100 short links in a single request. Requires an API key. Use this instead of " +
      "calling shorten_link repeatedly when shortening several URLs.",
    inputSchema: {
      links: z
        .array(
          z.object({
            url: z.string().url().describe("Destination URL"),
            expiresInDays: z.number().int().positive().optional(),
          }),
        )
        .min(1)
        .max(100)
        .describe("Up to 100 links to create."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async ({ links }) => {
    try {
      const result = await client.createLinks(links);
      // Partial success is normal here: a quota or validation failure on one entry does not
      // fail the request. Reporting only `created` would silently lose the rest.
      //
      // `created` entries carry no index and the array is compacted, so position N of `created`
      // is not input N once anything fails. The API processes entries in order, so rebuild the
      // mapping from the input indices that are absent from `failed`.
      const failedIndices = new Set(result.failed.map((f) => f.index));
      const createdInputIndices = links
        .map((_, index) => index)
        .filter((index) => !failedIndices.has(index));

      const sections = [
        `Created ${result.created.length} of ${links.length} link(s):`,
        ...result.created.map((link, position) => {
          const inputIndex = createdInputIndices[position];
          const url = inputIndex === undefined ? undefined : links[inputIndex]?.url;
          return `  ${link.shortUrl} -> ${url ?? "(destination unknown)"}`;
        }),
      ];
      if (result.failed.length > 0) {
        sections.push(
          "",
          `${result.failed.length} failed:`,
          ...result.failed.map(
            (f) => `  [${f.index}] ${f.url}: ${f.error}${f.code ? ` (${f.code})` : ""}`,
          ),
        );
      }
      return ok(sections.join("\n"));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "list_links",
  {
    title: "List my short links",
    description:
      "List the short links on the authenticated account, with their destinations and total " +
      "redirect counts. Requires an API key.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      const { links } = await client.listLinks();
      if (!links || links.length === 0) return ok("No links on this account yet.");
      return ok(
        links
          .map((l) => {
            const bits = [`${l.shortUrl} -> ${l.targetUrl}`, `${l.clickCount} clicks`];
            if (l.pausedAt) bits.push("paused");
            if (l.expiresAt) bits.push(`expires ${l.expiresAt}`);
            return bits.join("  |  ");
          })
          .join("\n"),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "update_link",
  {
    title: "Update or pause a short link",
    description:
      "Change a short link's destination, or pause/resume it. A paused link stops redirecting but " +
      "is not deleted. Requires an API key. Changing the destination requires a paid plan.",
    inputSchema: {
      slug: z.string().describe("The link's short code (the part after the domain)."),
      url: z.string().url().optional().describe("New destination URL."),
      paused: z.boolean().optional().describe("true to stop the link redirecting, false to resume it."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  async ({ slug, url, paused }) => {
    if (url === undefined && paused === undefined) {
      return { content: [{ type: "text", text: "Provide `url`, `paused`, or both." }], isError: true };
    }
    try {
      await client.updateLink(slug, { url, paused });
      return ok(`Updated ${slug}.`);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "delete_link",
  {
    title: "Delete a short link",
    description:
      "Permanently delete a short link. The short URL stops working immediately and anyone who " +
      "already has it will get a 404 — prefer update_link with paused:true if it might be needed " +
      "again. Requires an API key.",
    inputSchema: {
      slug: z.string().describe("The link's short code (the part after the domain)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  async ({ slug }) => {
    try {
      await client.deleteLink(slug);
      return ok(`Deleted ${slug}.`);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "get_link_stats",
  {
    title: "Get a short link's click count",
    description:
      "Return the total number of times a short link has been followed. This is the only click " +
      "data that exists — Linkonda stores no per-visitor information, so there is no geographic, " +
      "device, or referrer breakdown to report. No API key needed.",
    inputSchema: {
      slug: z.string().describe("The link's short code (the part after the domain)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ slug }) => {
    try {
      const stats = await client.getStats(slug);
      return ok(`${slug} has been followed ${stats.clickCount} time(s).`);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "check_quota",
  {
    title: "Check remaining link allowance",
    description:
      "Report how many links are live and how many the current plan allows. Without an API key " +
      "this reports the anonymous allowance. Use it before a bulk create to check for room.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      const quota = await client.getQuota();
      const cap = quota.unlimited ? "unlimited" : String(quota.maxActive ?? "unknown");
      const lines = [`Plan: ${quota.tier}`, `Links live: ${quota.active} of ${cap}`];
      // Trust the API's tier rather than whether a key was configured — same authoritative
      // signal `shorten_link` takes from `savedToAccount`.
      if (quota.tier === "anonymous") {
        lines.push(
          "Running anonymously — links expire after " +
            `${quota.anonLinkTtlDays} days. Set LINKONDA_API_KEY for permanent links.`,
        );
      }
      return ok(lines.join("\n"));
    } catch (error) {
      return fail(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
