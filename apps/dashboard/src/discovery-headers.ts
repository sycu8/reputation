export const DISCOVERY_LINK =
  '</.well-known/api-catalog>; rel="api-catalog", </openapi.json>; rel="service-desc"; type="application/openapi+json", </docs/>; rel="service-doc", </.well-known/ai-catalog.json>; rel="describedby"';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  "/.well-known/api-catalog": "application/linkset+json",
  "/.well-known/oauth-authorization-server": "application/json; charset=utf-8",
  "/.well-known/oauth-protected-resource": "application/json; charset=utf-8",
  "/.well-known/openid-configuration": "application/json; charset=utf-8",
  "/.well-known/jwks.json": "application/json; charset=utf-8",
  "/.well-known/mcp/server-card.json": "application/json; charset=utf-8",
  "/.well-known/agent-skills/index.json": "application/json; charset=utf-8",
  "/.well-known/ai-catalog.json": "application/json; charset=utf-8",
  "/openapi.json": "application/json; charset=utf-8",
  "/robots.txt": "text/plain; charset=utf-8",
  "/sitemap.xml": "application/xml; charset=utf-8",
  "/auth.md": "text/markdown; charset=utf-8"
};

export function applyDiscoveryHeaders(pathname: string, response: Response): Response {
  const headers = new Headers(response.headers);
  const contentType = CONTENT_TYPES[pathname];
  if (contentType) headers.set("content-type", contentType);
  if (pathname === "/" || pathname === "/index.html") headers.set("link", DISCOVERY_LINK);
  if (pathname === "/.well-known/ai-catalog.json" || pathname === "/.well-known/api-catalog") {
    headers.set("access-control-allow-origin", "*");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
