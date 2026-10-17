export interface McpFetch {
  (input: string, init?: RequestInit): Promise<Response>;
}

interface RpcMessage {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: unknown;
}

const SERVER_INFO = { name: "PulseWatch", version: "0.1.0" };

const PRODUCT_SUMMARY = [
  "PulseWatch by OrangeCloud monitors the public web, news, and RSS for people, brands, products, and companies.",
  "It classifies sentiment toward the monitored entity and alerts on important negative mentions.",
  "Facebook, TikTok, LinkedIn, YouTube, and X are not full live coverage unless a workspace has a supported integration configured.",
  "API reference: https://reputation.orangecloud.vn/docs/",
  "Health: https://reputation.orangecloud.vn/api/health"
].join(" ");

const TOOLS = [
  {
    name: "pulsewatch_product_summary",
    description: "Summarize PulseWatch by OrangeCloud, including what it monitors and where the public API docs live.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "pulsewatch_validate_query",
    description: "Validate a PulseWatch Boolean listening query (AND, OR, NOT, parentheses, quoted phrases) without saving it.",
    inputSchema: {
      type: "object",
      properties: {
        rawQuery: {
          type: "string",
          description: "Boolean query text to validate"
        }
      },
      required: ["rawQuery"],
      additionalProperties: false
    }
  }
];

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      ...extra
    }
  });
}

function rpc(id: unknown, result: unknown, status = 200): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, result }, status);
}

function rpcError(id: unknown, code: number, message: string, status = 200): Response {
  return json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, status);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function apiBaseForHost(hostname: string, origin: string): string {
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    return origin.includes(":8788") ? origin.replace(":8788", ":8787") : origin;
  }
  if (hostname.endsWith(".workers.dev")) return "https://reputa-api-production.sycu-lee.workers.dev";
  return `${origin}/api`;
}

function textResult(text: string, isError = false): { content: Array<{ type: string; text: string }>; isError: boolean } {
  return { content: [{ type: "text", text }], isError };
}

export async function handleMcp(request: Request, fetchImpl: McpFetch = fetch): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type, accept",
        "access-control-max-age": "600"
      }
    });
  }
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405, { allow: "POST, OPTIONS" });
  }

  let message: RpcMessage;
  try {
    message = await request.json() as RpcMessage;
  } catch {
    return rpcError(null, -32700, "parse_error", 400);
  }

  const method = typeof message.method === "string" ? message.method : "";
  if (method.startsWith("notifications/")) return new Response(null, { status: 202 });

  const id = message.id ?? null;
  if (method === "initialize") {
    return rpc(id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO
    });
  }
  if (method === "ping") return rpc(id, {});
  if (method === "tools/list") return rpc(id, { tools: TOOLS });
  if (method !== "tools/call") return rpcError(id, -32601, "method_not_found");

  const params = asRecord(message.params);
  const name = params && typeof params.name === "string" ? params.name : "";
  if (name === "pulsewatch_product_summary") return rpc(id, textResult(PRODUCT_SUMMARY));
  if (name !== "pulsewatch_validate_query") return rpc(id, textResult(`Unknown tool: ${name}`, true));

  const args = params ? asRecord(params.arguments) : null;
  const rawQuery = args && typeof args.rawQuery === "string" ? args.rawQuery.trim() : "";
  if (!rawQuery) return rpc(id, textResult("rawQuery is required", true));

  const url = new URL(request.url);
  const endpoint = `${apiBaseForHost(url.hostname, url.origin)}/v1/queries/validate`;
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ rawQuery })
    });
    const body = await response.text();
    return rpc(id, textResult(body, !response.ok));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "validate_failed";
    return rpc(id, textResult(detail, true));
  }
}
