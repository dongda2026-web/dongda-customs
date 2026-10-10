import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { availablePort } from "./helpers/postgres.mjs";

let child;
let base;
before(async () => {
  const port = await availablePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.js"], {
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: String(port),
      NODE_ENV: "test", DATABASE_URL: "", ANTHROPIC_API_KEY: "", BUILD_ID: "foundation-test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(([code]) => { throw new Error(`Server exited: ${code}`); }),
    new Promise((_, reject) => { const t = setTimeout(() => reject(new Error("Startup timeout")), 10000); t.unref(); }),
  ]);
});
after(async () => {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
});

test("health exposes build identity without tenant data", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 503, "unconfigured database must report not ready");
  const body = await res.json();
  assert.equal(body.service, "trade-erp");
  assert.equal(body.build, "foundation-test");
  assert.equal(body.database, "unconfigured");
  assert.equal(body.customers, undefined);
});

for (const path of ["/api/v1/bootstrap", "/api/config", "/api/tickets/list", "/api/archive/list"]) {
  test(`anonymous business request is rejected: ${path}`, async () => {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, "UNAUTHENTICATED");
  });
}

test("unknown API routes are not served as HTML", async () => {
  const res = await fetch(`${base}/api/not-real`);
  assert.match(res.headers.get("content-type"), /application\/json/);
  assert.equal(res.status, 401);
});

test("root opens the authenticated workspace, without the legacy auto-sync entry", async () => {
  const res = await fetch(base);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /id="login-form"/);
  assert.match(res.headers.get("content-security-policy"), /connect-src 'self'/);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("malformed static URLs return a controlled error without crashing the server", async () => {
  const res = await fetch(`${base}/%E0%A4%A`);
  assert.equal(res.status, 400);
  assert.equal((await fetch(`${base}/api/health`)).status, 503);
});
