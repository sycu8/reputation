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
    const { pathname } = new URL(request.url);
    if (pathname === "/mcp") return handleMcp(request);
    const asset = await env.ASSETS.fetch(request);
    return applyDiscoveryHeaders(pathname, asset);
  }
};
