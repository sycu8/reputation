const controller = new AbortController();
const page = typeof window !== "undefined" ? window : globalThis;
if (typeof page.addEventListener === "function") {
  page.addEventListener("pagehide", () => controller.abort());
}

function modelContext() {
  const doc = typeof document !== "undefined" ? document : undefined;
  if (doc && doc.modelContext && typeof doc.modelContext.registerTool === "function") return doc.modelContext;
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  if (nav && nav.modelContext && typeof nav.modelContext.registerTool === "function") return nav.modelContext;
  return null;
}

function apiBase() {
  const loc = typeof location !== "undefined" ? location : { hostname: "", origin: "", protocol: "https:", port: "" };
  const host = loc.hostname || "";
  if (loc.port === "8788" || host === "localhost" || host === "127.0.0.1") {
    return `${loc.origin.replace(":8788", ":8787")}`;
  }
  if (host.endsWith(".workers.dev")) return "https://reputa-api-production.sycu-lee.workers.dev";
  return `${loc.origin}/api`;
}

function register(context, tool) {
  const pending = context.registerTool(tool, { signal: controller.signal });
  if (pending && typeof pending.then === "function") pending.catch(() => {});
}

const context = modelContext();
if (context) {
  register(context, {
    name: "pulsewatch_product_summary",
    description: "Summarize PulseWatch by OrangeCloud and where to read the public product and API docs.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return {
        content: [{
          type: "text",
          text: "PulseWatch by OrangeCloud monitors public web, news, and RSS mentions, classifies sentiment, and alerts on important negative mentions. Docs: /docs/. App: /app/."
        }]
      };
    }
  });

  register(context, {
    name: "open_pulsewatch_app",
    description: "Open the PulseWatch app where a person can create an account or sign in.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      if (typeof location !== "undefined") location.assign("/app/#signup");
      return { content: [{ type: "text", text: "Opened /app/#signup" }] };
    }
  });

  register(context, {
    name: "validate_listening_query",
    description: "Check whether a PulseWatch Boolean listening query is valid. Supports AND, OR, NOT, parentheses, and quoted phrases.",
    inputSchema: {
      type: "object",
      properties: {
        rawQuery: { type: "string", description: "Boolean query using AND, OR, NOT, and quotes for phrases." }
      },
      required: ["rawQuery"],
      additionalProperties: false
    },
    async execute(input) {
      const rawQuery = input && typeof input.rawQuery === "string" ? input.rawQuery : "";
      const response = await fetch(`${apiBase()}/v1/queries/validate`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ rawQuery })
      });
      const text = await response.text();
      return { content: [{ type: "text", text }] };
    }
  });
}
