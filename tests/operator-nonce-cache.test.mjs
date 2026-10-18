import test from "node:test";
import assert from "node:assert/strict";
import api from "../apps/api-worker/src/index.ts";
import { signOperatorRequest } from "../scripts/operator-signature.mjs";
import { makeLocalEnv } from "./helpers/local-env.mjs";

const OPERATOR_SECRET = "operator-test-secret";
const IP = "198.51.100.80";

function call(env, nonce, secret = OPERATOR_SECRET) {
  const path = "/v1/admin/accounts";
  const signed = signOperatorRequest({
    secret,
    method: "GET",
    path,
    body: "",
    nonce
  });
  return api.fetch(new Request(`https://api.local${path}`, {
    method: "GET",
    headers: {
      ...signed.headers,
      origin: "http://127.0.0.1:8788",
      "cf-connecting-ip": IP
    }
  }), env);
}

test("nonce cache keeps in-window entries and fails closed when full", { timeout: 120_000 }, async () => {
  const env = makeLocalEnv({ OPERATOR_ACCOUNT_SECRET: OPERATOR_SECRET });
  const anchor = "nonce-anchor-000001";
  const first = await call(env, anchor);
  assert.equal(first.status, 200);
  let filled = 1;
  let blocked = null;
  for (let i = 0; i < 2200 && !blocked; i += 1) {
    const response = await call(env, `nonce-fill-${String(i).padStart(8, "0")}`);
    if (response.status === 429) {
      blocked = response;
      break;
    }
    assert.equal(response.status, 200, `fill ${i}`);
    filled += 1;
  }
  assert.ok(blocked);
  assert.equal(filled, 2048);
  assert.equal((await blocked.json()).error, "rate_limited");
  const retryAfter = Number(blocked.headers.get("retry-after"));
  assert.equal(Number.isInteger(retryAfter), true);
  assert.ok(retryAfter >= 1 && retryAfter <= 60);

  const replay = await call(env, anchor);
  assert.equal(replay.status, 401);
  assert.equal((await replay.json()).error, "invalid_operator_secret");

  for (let i = 0; i < 7; i += 1) {
    const extra = await call(env, `nonce-extra-${String(i).padStart(8, "0")}`);
    assert.equal(extra.status, 429);
    extra.body?.cancel();
  }
  const wrong = await call(env, "nonce-wrong-signature1", "wrong-operator-secret-value");
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error, "invalid_operator_secret");
});
