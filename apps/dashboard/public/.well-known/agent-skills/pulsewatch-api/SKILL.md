---
name: pulsewatch-api
description: Call the PulseWatch by OrangeCloud HTTP API for health, account registration, and workspace listening data.
---

# PulseWatch API

Use this skill to talk to the PulseWatch API at `https://reputation.orangecloud.vn/api`.

## Discover

- API catalog: `https://reputation.orangecloud.vn/.well-known/api-catalog`
- OpenAPI: `https://reputation.orangecloud.vn/openapi.json`
- Human docs: `https://reputation.orangecloud.vn/docs/`
- Health: `GET https://reputation.orangecloud.vn/api/health`
- Registration instructions: `https://reputation.orangecloud.vn/auth.md`

## Register and sign in

Create a workspace with `POST /v1/auth/signup` and a JSON body of `email`, `password`, and `workspaceName`. Sign in with `POST /v1/auth/login`. The JSON body includes `session.token` and `access_token`. Send it as `Authorization: Bearer <token>`. A `reputa_session` cookie is equivalent.

## Read data

Authenticated calls are workspace scoped. Start with `GET /v1/me` and `GET /v1/workspaces`, then list monitors and mentions under `/v1/workspaces/{workspaceId}/monitors`.

Public source availability is `GET /v1/source-health`. Do not assume a source is live when its availability is `disabled`, `degraded`, or `contract-required`.

## Validate a query

`POST /v1/queries/validate` with `{"rawQuery":"\"acme\" AND outage"}` does not require a session.
