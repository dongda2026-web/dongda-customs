import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fixture } from "./helpers/api.mjs";
const require = createRequire(import.meta.url);
let f, a, beta, ids;
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
before(async () => {
  f = await fixture(); a = await f.login(); beta = await f.login("admin", "beta");
  ids = Object.fromEntries((await f.cluster.owner.query("SELECT id,name FROM users")).rows.map(r => [r.name, r.id]));
});
after(async () => { if (f) await f.stop(); });
async function member(name) { return ok(await a.api(`/members/${ids[name]}`)); }
test("only tenant administrators list or manage members and never receive credentials or platform flags", async () => {
  const result = ok(await a.api("/members?pageSize=2"));
  assert.equal(result.items.length, 2); assert.equal(result.total, 6);
  assert.equal(ok(await a.api("/members?search=sales")).items[0].user_id, ids.sales);
  assert.doesNotMatch(JSON.stringify(result), /password_hash|scrypt|token_hash|platform_admin/);
  assert.equal((await a.api("/members?pageSize=1000")).status, 422);
  for (const role of ["sales", "social", "purchasing", "warehouse", "auditor"]) {
    const user = await f.login(role);
    assert.equal((await user.api("/members")).status, 403);
    assert.equal((await user.api(`/members/${ids.sales}`, "PATCH", { version: 1, active: false, reason: "No permission" }, randomUUID())).status, 403);
  }
});
test("role change revokes tenant sessions, leaves other tenant intact and supports versioned idempotent retry", async () => {
  const user = await f.login("sales"), otherTenant = await f.login("sales", "beta");
  const row = await member("sales"), key = randomUUID();
  const body = { version: row.version, role: "auditor", reason: "Move to audit team" };
  const changed = ok(await a.api(`/members/${ids.sales}`, "PATCH", body, key));
  assert.equal(changed.role, "auditor"); assert.equal(changed.version, row.version + 1);
  assert.deepEqual(ok(await a.api(`/members/${ids.sales}`, "PATCH", body, key)), changed);
  assert.equal((await user.api("/bootstrap")).status, 401);
  assert.equal(ok(await otherTenant.api("/auth/me")).role, "sales");
  assert.equal(ok(await beta.api(`/members/${ids.sales}`)).role, "sales");
  assert.equal(ok(await (await f.login("sales")).api("/auth/me")).role, "auditor");
  assert.equal((await a.api(`/members/${ids.sales}`, "PATCH", { ...body, role: "sales" }, randomUUID())).status, 409);
  const event = ok(await a.api("/audit")).items.find(e => e.action === "member.update" && e.resource_id === ids.sales);
  assert.equal(event.summary.reason, body.reason);
});
test("disable and restore never resurrect old sessions, nor modify the global user", async () => {
  const user = await f.login("social"), row = await member("social");
  const changed = ok(await a.api(`/members/${ids.social}`, "PATCH", { version: row.version, active: false, reason: "Access suspended" }, randomUUID()));
  assert.equal((await user.api("/bootstrap")).status, 401);
  await assert.rejects(f.login("social"), /INVALID_CREDENTIALS/);
  ok(await a.api(`/members/${ids.social}`, "PATCH", { version: changed.version, active: true, reason: "Reinstated" }, randomUUID()));
  assert.equal((await user.api("/bootstrap")).status, 401);
  assert.equal((await (await f.login("social")).api("/bootstrap")).status, 200);
  assert.equal((await f.cluster.owner.query("SELECT active FROM users WHERE id=$1", [ids.social])).rows[0].active, true);
});
test("last effective administrator cannot be disabled or demoted even when another admin user is globally inactive", async () => {
  let row = await member("admin");
  for (const change of [{ active: false }, { role: "sales" }]) {
    const result = await a.api(`/members/${ids.admin}`, "PATCH", { version: row.version, ...change, reason: "Last admin" }, randomUUID());
    assert.equal(result.status, 409); assert.equal(result.body.error.code, "LAST_ADMIN");
  }
  const p = await member("purchasing");
  ok(await a.api(`/members/${ids.purchasing}`, "PATCH", { version: p.version, role: "admin", reason: "Backup admin" }, randomUUID()));
  await f.cluster.owner.query("UPDATE users SET active=false WHERE id=$1", [ids.purchasing]);
  try {
    assert.equal((await a.api(`/members/${ids.admin}`, "PATCH", { version: row.version, active: false, reason: "Inactive backup" }, randomUUID())).status, 409);
  } finally { await f.cluster.owner.query("UPDATE users SET active=true WHERE id=$1", [ids.purchasing]); }
  const current = await member("purchasing");
  ok(await a.api(`/members/${ids.purchasing}`, "PATCH", { version: current.version, role: "purchasing", reason: "Restore role" }, randomUUID()));
});
test("unknown tenant references and prohibited fields fail closed", async () => {
  const id = randomUUID();
  await f.cluster.owner.query(`INSERT INTO users(id,email,name,password_hash)
    SELECT $1,'beta-only@test.invalid','Beta only',password_hash FROM users LIMIT 1`, [id]);
  await f.cluster.owner.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES($1,$2,'sales')", [f.tenants.beta, id]);
  assert.equal((await a.api(`/members/${id}`)).status, 404);
  assert.equal((await a.api(`/members/${id}`, "PATCH", { version: 1, role: "admin", reason: "Foreign member" }, randomUUID())).status, 404);
  const row = await member("warehouse");
  for (const extra of [{ role: "platform_admin" }, { active: "false" }, { password: "Do-not-reset" }, { tenant_id: f.tenants.beta }, { email: "changed@test.invalid" }]) {
    assert.equal((await a.api(`/members/${ids.warehouse}`, "PATCH", { version: row.version, reason: "Invalid field", ...extra }, randomUUID())).status, 422);
  }
  assert.equal((await a.api(`/members/${ids.warehouse}`, "PATCH", { version: row.version, active: false, reason: "" }, randomUUID())).status, 422);
  await assert.rejects(f.pool.query("UPDATE users SET active=false"), /permission denied/);
  const client = await f.pool.connect();
  try {
    await client.query("BEGIN"); await client.query("SELECT set_config('app.tenant_id',$1,true)", [f.tenants.alpha]);
    assert.equal((await client.query("UPDATE memberships SET active=false WHERE tenant_id=$1", [f.tenants.beta])).rowCount, 0);
    await client.query("ROLLBACK");
  } finally { client.release(); }
});
test("explicit session revocation advances membership version and remains tenant scoped", async () => {
  const user = await f.login("warehouse"), other = await f.login("warehouse", "beta"), row = await member("warehouse");
  const changed = ok(await a.api(`/members/${ids.warehouse}/revoke-sessions`, "POST", { version: row.version, reason: "Lost device" }, randomUUID()));
  assert.equal(changed.version, row.version + 1);
  assert.equal(changed.role, "warehouse"); assert.equal(changed.active, true);
  assert.equal((await user.api("/auth/me")).status, 401);
  assert.equal((await other.api("/auth/me")).status, 200);
});
test("two administrators concurrently demoting themselves leave exactly one administrator", async () => {
  let p = await member("purchasing");
  p = ok(await a.api(`/members/${ids.purchasing}`, "PATCH", { version: p.version, role: "admin", reason: "Second admin" }, randomUUID()));
  const second = await f.login("purchasing"), first = await member("admin");
  const results = await Promise.all([
    a.api(`/members/${ids.admin}`, "PATCH", { version: first.version, role: "sales", reason: "Hand over" }, randomUUID()),
    second.api(`/members/${ids.purchasing}`, "PATCH", { version: p.version, role: "purchasing", reason: "Hand over" }, randomUUID()),
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const rows = (await f.cluster.owner.query("SELECT user_id FROM memberships WHERE tenant_id=$1 AND active AND role='admin'", [f.tenants.alpha])).rows;
  assert.equal(rows.length, 1);
});
test("a previously authenticated actor cannot perform member changes after being demoted", async () => {
  const { withTenant } = require("../src/db"), members = require("../src/members");
  const survivor = (await f.cluster.owner.query("SELECT user_id FROM memberships WHERE tenant_id=$1 AND active AND role='admin'", [f.tenants.alpha])).rows[0];
  const staleId = survivor.user_id === ids.admin ? ids.purchasing : ids.admin;
  await assert.rejects(withTenant(f.pool, f.tenants.alpha, c => members.handle(c,
    { tenantId: f.tenants.alpha, userId: staleId, role: "admin", requestId: randomUUID() },
    ids.warehouse, null, "PATCH", { version: 1, active: false, reason: "Stale authority" }, new URLSearchParams())), /permission|revoked/i);
});
