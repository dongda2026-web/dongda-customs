import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID, randomBytes, scryptSync } from "node:crypto";
import { createServer } from "node:http";
import pg from "pg";
import { startPostgres } from "./helpers/postgres.mjs";

const require = createRequire(import.meta.url);
const { createApp } = require("../src/app");
const { migrate } = require("../src/db");
let cluster, pool, server, base;
const ids = { alpha: randomUUID(), beta: randomUUID(), admin: randomUUID(), sales: randomUUID(), other: randomUUID() };
const password = randomBytes(20).toString("hex");
const salt = randomBytes(16).toString("hex");
const hash = `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
before(async () => {
  cluster = await startPostgres();
  await migrate(cluster.owner);
  await cluster.owner.query("INSERT INTO tenants(id,slug,name) VALUES ($1,'alpha','Alpha'),($2,'beta','Beta')", [ids.alpha, ids.beta]);
  for (const [name, id] of Object.entries(ids).filter(([k]) => ["admin", "sales", "other"].includes(k))) {
    await cluster.owner.query("INSERT INTO users(id,email,name,password_hash) VALUES ($1,$2,$3,$4)", [id, `${name}@test.invalid`, name, hash]);
  }
  await cluster.owner.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES ($1,$2,'admin'),($1,$3,'sales'),($4,$5,'admin')",
    [ids.alpha, ids.admin, ids.sales, ids.beta, ids.other]);
  await cluster.owner.query("INSERT INTO tenant_settings(tenant_id,data) VALUES ($1,$2),($3,$4)",
    [ids.alpha, { company: "Alpha" }, ids.beta, { company: "Beta" }]);
  pool = new pg.Pool({ connectionString: cluster.runtimeUrl });
  server = createServer(createApp({ pool, buildId: "auth-test", environment: "test" }));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (pool) await pool.end();
  if (cluster) await cluster.stop();
});
async function api(path, { method = "GET", body, cookie, headers = {} } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", "x-erp-request": "1", ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), cookie: res.headers.get("set-cookie"), headers: res.headers };
}
async function login(email = "admin@test.invalid", tenant = "alpha") {
  const result = await api("/auth/login", { method: "POST", body: { email, password, tenant } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.cookie.split(";")[0];
}

test("health includes the actual schema version", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.ok((await res.json()).schemaVersion >= 1);
});
test("login returns an HttpOnly session and no password hash", async () => {
  const result = await api("/auth/login", { method: "POST", body: { email: "admin@test.invalid", password, tenant: "alpha" } });
  assert.equal(result.status, 200);
  assert.match(result.cookie, /HttpOnly/);
  assert.match(result.cookie, /SameSite=Strict/);
  assert.equal(result.body.user.password_hash, undefined);
  const row = (await cluster.owner.query("SELECT token_hash FROM sessions LIMIT 1")).rows[0];
  assert.ok(row.token_hash.length === 64);
  assert.ok(!result.cookie.includes(row.token_hash), "stored token must be a digest");
});
test("wrong credentials and wrong tenant produce identical errors", async () => {
  const bad = await api("/auth/login", { method: "POST", body: { email: "other@test.invalid", password, tenant: "alpha" } });
  const missing = await api("/auth/login", { method: "POST", body: { email: "absent@test.invalid", password, tenant: "beta" } });
  assert.equal(bad.status, 401);
  assert.equal(missing.status, 401);
  assert.equal(bad.body.error.code, "INVALID_CREDENTIALS");
  assert.equal(missing.body.error.message, bad.body.error.message);
});
test("tenant from the signed-in membership cannot be changed by a header or request body", async () => {
  const cookie = await login();
  const bootstrap = await api("/bootstrap", { cookie, headers: { "x-tenant-id": ids.beta } });
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.body.tenant.id, ids.alpha);
  assert.equal(bootstrap.body.settings.data.company, "Alpha");
  const changed = await api("/settings", { method: "PATCH", cookie, body: { tenantId: ids.beta, version: 1, data: { company: "Alpha updated" } } });
  assert.equal(changed.status, 200);
  const beta = (await cluster.owner.query("SELECT data FROM tenant_settings WHERE tenant_id=$1", [ids.beta])).rows[0];
  assert.equal(beta.data.company, "Beta");
});
test("settings use optimistic concurrency and audit records", async () => {
  const cookie = await login();
  const settings = (await api("/settings", { cookie })).body;
  const changed = await api("/settings", { method: "PATCH", cookie, body: { version: settings.version, data: { company: "Alpha final" } } });
  assert.equal(changed.status, 200);
  const conflict = await api("/settings", { method: "PATCH", cookie, body: { version: settings.version, data: { company: "Lost update" } } });
  assert.equal(conflict.status, 409);
  const audit = await api("/audit", { cookie });
  assert.equal(audit.status, 200);
  assert.ok(audit.body.items.some(x => x.action === "settings.update"));
  assert.ok(audit.body.items.every(x => x.tenant_id === ids.alpha));
  assert.ok(!JSON.stringify(audit.body).includes(password));
});
test("sales users cannot modify tenant settings", async () => {
  const cookie = await login("sales@test.invalid");
  const res = await api("/settings", { method: "PATCH", cookie, body: { version: 1, data: {} } });
  assert.equal(res.status, 403);
});
test("cross-origin mutations are rejected", async () => {
  const cookie = await login();
  const res = await api("/settings", { method: "PATCH", cookie,
    headers: { origin: "https://untrusted.invalid" }, body: { version: 1, data: {} } });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, "ORIGIN_REJECTED");
});
test("logout revokes the server session", async () => {
  const cookie = await login();
  assert.equal((await api("/auth/me", { cookie })).status, 200);
  assert.equal((await api("/auth/logout", { method: "POST", cookie, body: {} })).status, 200);
  assert.equal((await api("/auth/me", { cookie })).status, 401);
});
test("disabling a membership immediately invalidates its active sessions", async () => {
  const cookie = await login("sales@test.invalid");
  await cluster.owner.query("UPDATE memberships SET active=false WHERE tenant_id=$1 AND user_id=$2", [ids.alpha, ids.sales]);
  assert.equal((await api("/bootstrap", { cookie })).status, 401);
});
test("persistent credential attempt limit is enforced", async () => {
  const body = { tenant: "alpha", email: "rate-limit@test.invalid", password: "incorrect-password" };
  for (let i = 0; i < 5; i++) {
    assert.equal((await api("/auth/login", { method: "POST", body })).status, 401);
  }
  assert.equal((await api("/auth/login", { method: "POST", body })).status, 429);
});
