import { applyDiscoveryHeaders } from "./discovery-headers.ts";
import { handleMcp } from "./mcp.ts";

interface AssetBinding {
  fetch(input: Request): Promise<Response>;
}

interface Env {
  ASSETS: AssetBinding;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const response = url.pathname === "/mcp"
      ? await handleMcp(request)
      : await env.ASSETS.fetch(request);
    return applyDiscoveryHeaders(url.pathname, response, url.hostname);
  }
};
