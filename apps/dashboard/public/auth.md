# auth.md

You are an agent registering with **PulseWatch by OrangeCloud**. This service uses workspace accounts and opaque session tokens. It does not issue OpenID Connect ID tokens, ID-JAGs, or JWT access tokens.

The protected resource is `https://reputation.orangecloud.vn/api`. Humans use the same account at `https://reputation.orangecloud.vn/app/`.

## Discover

1. `GET https://reputation.orangecloud.vn/.well-known/oauth-protected-resource`
2. `GET https://reputation.orangecloud.vn/.well-known/oauth-authorization-server`
3. `GET https://reputation.orangecloud.vn/openapi.json`
4. Human reference: `https://reputation.orangecloud.vn/docs/`

Protected API responses that require a session use:

```http
WWW-Authenticate: Bearer realm="PulseWatch", resource_metadata="https://reputation.orangecloud.vn/.well-known/oauth-protected-resource"
```

## Register

`POST https://reputation.orangecloud.vn/api/v1/auth/signup`

```json
{
  "email": "agent@example.com",
  "password": "choose-a-long-passphrase",
  "workspaceName": "Listening workspace"
}
```

Password length is at least 10 characters. The response is HTTP 201 and includes `session.token`, `access_token`, `token_type` (`Bearer`), and `expires_in`. A `Set-Cookie` header sets `reputa_session` to the same token.

This is the `register_uri` advertised on the authorization server. The supported identity type is `verified_email`: the account email plus password is the credential. There is no anonymous registration and no ID-JAG exchange.

## Sign in

`POST https://reputation.orangecloud.vn/api/v1/auth/login`

JSON:

```json
{"email":"agent@example.com","password":"choose-a-long-passphrase"}
```

OAuth resource-owner password grant (same account check):

```http
POST /api/v1/auth/login
Content-Type: application/x-www-form-urlencoded

grant_type=password&username=agent%40example.com&password=choose-a-long-passphrase
```

Use `access_token` or `session.token` as the bearer token. `/.well-known/jwks.json` is intentionally an empty key set because these tokens are opaque session secrets, not signed JWTs.

## Call the API

```http
GET /api/v1/me
Authorization: Bearer <access_token>
```

The cookie `reputa_session` is equivalent when the client sends cookies. Scopes map to workspace capabilities such as `workspace.read`, `monitor.read`, and `query.read`.

A human can sign in at the claim URL `https://reputation.orangecloud.vn/app/` with the same email and password.

## Revoke

`POST https://reputation.orangecloud.vn/api/v1/auth/logout` with the bearer token or session cookie. There is no separate revocation-event stream.

## Public reads

`GET /api/health` and `POST /api/v1/queries/validate` do not need a session. Source availability from `GET /api/v1/source-health` is authoritative; do not treat a source as live when it is `disabled`, `degraded`, or `contract-required`.
