/** Thin client over the Linkonda REST API. Mirrors docs/api-requests-reference.md. */

const DEFAULT_BASE_URL = "https://api.linkonda.com";

export type PlanTier = "anonymous" | "free" | "plus" | "pro" | "enterprise";

/**
 * Response of `POST /api/links` and each entry of a batch create.
 *
 * Note it does **not** echo the destination — callers that want to show it must keep the URL
 * they sent. `savedToAccount` is the authoritative anonymous/authenticated signal.
 */
export type CreatedLink = {
  id: string;
  slug: string;
  shortUrl: string;
  clickCount: number;
  savedToAccount: boolean;
  tier: PlanTier;
  expiresAt: string | null;
  lifetimeUnlimited: boolean;
};

/** Batch create is partial-success: some entries can fail while others are created. */
export type BatchCreateResult = {
  ok: number;
  created: CreatedLink[];
  failed: { index: number; url: string; error: string; code?: string }[];
};

/** Entry of `GET /api/links`. The destination is `targetUrl`, and paused state is a timestamp. */
export type AccountLink = {
  id: string;
  slug: string;
  shortUrl: string;
  targetUrl: string;
  clickCount: number;
  expiresAt: string | null;
  createdAt: string;
  pausedAt: string | null;
};

export type Quota = {
  tier: PlanTier;
  active: number;
  maxActive: number | null;
  unlimited: boolean;
  anonLinkTtlDays: number;
  freeLinkTtlDays: number;
  plusLinkTtlDays: number;
};

/**
 * An error the model should be able to act on.
 *
 * `code` is the API's stable machine-readable code (see the API error codes page); `hint` is
 * added here to turn the common failures into a next step rather than a dead end.
 */
export class LinkondaError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "LinkondaError";
  }
}

/** True for routes addressing one link by slug — `/api/links/{slug}`, but not `/api/links` itself. */
function isSlugRoute(path: string): boolean {
  return /^\/api\/links\/[^/]+/.test(path) && !path.startsWith("/api/links/batch");
}

function hintFor(
  status: number,
  code: string | undefined,
  hasKey: boolean,
  path: string,
): string | undefined {
  if (code === "API_KEY_REQUIRES_PAID") {
    return "This API key belongs to a free account. Bearer authentication requires the Plus, Pro, or Enterprise plan — see https://linkonda.com/pricing.";
  }
  if (status === 401) {
    return hasKey
      ? "The LINKONDA_API_KEY appears to be invalid or revoked. Create a new key in the Linkonda dashboard."
      : "This action needs an API key. Set LINKONDA_API_KEY in the MCP server config — create one at https://linkonda.com/api-keys (paid plans).";
  }
  if (status === 404) {
    // A 404 means two different things here. On a slug route the link is missing; anywhere else
    // the route itself is missing, which in practice means the base URL points somewhere wrong.
    return isSlugRoute(path)
      ? "No link with that short code. Check the slug (the part after the domain — not the full URL); it may also have been deleted or expired."
      : "That API endpoint does not exist. Check LINKONDA_API_BASE_URL — it should point at a Linkonda API host (default https://api.linkonda.com).";
  }
  if (status === 429) {
    return "Rate limited. Wait a moment before retrying.";
  }
  return undefined;
}

export class LinkondaClient {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey?: string,
    baseUrl: string = DEFAULT_BASE_URL,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  get authenticated(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * @param auth `required` rejects before the round trip when no key is set; `optional` sends the
   * key when present (the API then answers for that account rather than anonymously); `never`
   * deliberately omits it so the request is treated as anonymous.
   */
  private async request<T>(
    method: string,
    path: string,
    options: { body?: unknown; auth: "required" | "optional" | "never" } = { auth: "optional" },
  ): Promise<T> {
    if (options.auth === "required" && !this.apiKey) {
      throw new LinkondaError(
        "This tool requires a Linkonda API key.",
        401,
        "NO_API_KEY",
        hintFor(401, undefined, false, path),
      );
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    // When an Authorization header is present the API validates only the key and never falls
    // back to a session, so a bad key fails cleanly instead of acting as someone else.
    if (this.apiKey && options.auth !== "never") headers.Authorization = `Bearer ${this.apiKey}`;

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (cause) {
      throw new LinkondaError(
        `Could not reach the Linkonda API at ${this.baseUrl}: ${(cause as Error).message}`,
        0,
      );
    }

    const text = await response.text();
    const payload = text ? safeJson(text) : undefined;

    if (!response.ok) {
      const code = typeof payload?.code === "string" ? payload.code : undefined;
      const message =
        (typeof payload?.message === "string" && payload.message) ||
        (typeof payload?.error === "string" && payload.error) ||
        `Request failed with HTTP ${response.status}`;
      throw new LinkondaError(message, response.status, code, hintFor(response.status, code, this.authenticated, path));
    }

    return payload as T;
  }

  /** Anonymous when no key is set: 10 links per network, expiring after the anon TTL. */
  createLink(input: { url: string; expiresInDays?: number; slug?: string }) {
    return this.request<CreatedLink>("POST", "/api/links", { body: input, auth: "optional" });
  }

  /** Batch create is not available anonymously, and is partial-success — always read `failed`. */
  createLinks(links: { url: string; expiresInDays?: number }[]) {
    return this.request<BatchCreateResult>("POST", "/api/links/batch-create", {
      body: { links },
      auth: "required",
    });
  }

  listLinks() {
    return this.request<{ links: AccountLink[] }>("GET", "/api/links", { auth: "required" });
  }

  updateLink(slug: string, patch: { url?: string; paused?: boolean }) {
    return this.request<unknown>("PATCH", `/api/links/${encodeURIComponent(slug)}`, {
      body: patch,
      auth: "required",
    });
  }

  deleteLink(slug: string) {
    return this.request<unknown>("DELETE", `/api/links/${encodeURIComponent(slug)}`, {
      auth: "required",
    });
  }

  /** Public endpoint — returns the total redirect count and nothing about who followed the link. */
  getStats(slug: string) {
    return this.request<{ clickCount: number }>(
      "GET",
      `/api/links/${encodeURIComponent(slug)}/stats`,
      { auth: "optional" },
    );
  }

  getQuota() {
    return this.request<Quota>("GET", "/api/quota", { auth: "optional" });
  }
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
