import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { fixture } from "./helpers/api.mjs";
const require = createRequire(import.meta.url);
const auth = require("../src/auth"), { dispatch } = require("../src/business");
function request(body) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    url: "/api/v1/partners", method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
  });
}
test("a request authenticated before demotion cannot execute later with stale sales permission", async () => {
  const f = await fixture();
  try {
    const a = await f.login(), sales = await f.login("sales");
    const id = (await sales.api("/auth/me")).body.user.id;
    const session = (await f.cluster.owner.query("SELECT token_hash,membership_version FROM sessions WHERE tenant_id=$1 AND user_id=$2", [f.tenants.alpha, id])).rows[0];
    const actor = { tenantId: f.tenants.alpha, userId: id, role: "sales", membershipVersion: session.membership_version,
      sessionHash: session.token_hash, requestId: randomUUID() };
    const row = (await a.api(`/members/${id}`)).body;
    assert.equal((await a.api(`/members/${id}`, "PATCH", { version: row.version, role: "auditor", reason: "Remove sales authority" }, randomUUID())).status, 200);
    await assert.rejects(dispatch(f.pool, actor, request({ name: "Must not be saved", kind: "customer" })), /revoked|expired|changed/i);
    assert.equal((await f.cluster.owner.query("SELECT count(*) FROM partners WHERE name='Must not be saved'")).rows[0].count, "0");
  } finally { await f.stop(); }
});
test("direct membership disable and re-enable invalidates old sessions even if rows were not deleted", async () => {
  const f = await fixture();
  try {
    const user = await f.login("sales"), id = (await user.api("/auth/me")).body.user.id;
    await f.cluster.owner.query("UPDATE memberships SET active=false WHERE tenant_id=$1 AND user_id=$2", [f.tenants.alpha, id]);
    await f.cluster.owner.query("UPDATE memberships SET active=true WHERE tenant_id=$1 AND user_id=$2", [f.tenants.alpha, id]);
    assert.equal((await user.api("/bootstrap")).status, 401);
    assert.equal((await (await f.login("sales")).api("/bootstrap")).status, 200);
  } finally { await f.stop(); }
});
test("website source reads recheck membership after entry authentication", async () => {
  const f = await fixture();
  try {
    const a = await f.login(), sales = await f.login("sales");
    const id = (await sales.api("/auth/me")).body.user.id;
    const lead = (await sales.api("/leads", "POST", { name: "Private source" }, randomUUID())).body;
    await f.cluster.owner.query(`INSERT INTO website_inquiries
      (tenant_id,site_id,source_inquiry_id,lead_id,schema_version,digest,received_at,payload)
      VALUES ($1,'race-test','DD-RACE-PRIVATE',$2,'test',$3,now(),$4)`,
    [f.tenants.alpha, lead.id, "a".repeat(64), { notes: "Private original inquiry" }]);
    const session = (await f.cluster.owner.query("SELECT token_hash,membership_version FROM sessions WHERE tenant_id=$1 AND user_id=$2",
      [f.tenants.alpha, id])).rows[0];
    const actor = { tenantId: f.tenants.alpha, userId: id, role: "sales", membershipVersion: session.membership_version,
      sessionHash: session.token_hash, requestId: randomUUID() };
    const row = (await a.api(`/members/${id}`)).body;
    assert.equal((await a.api(`/members/${id}`, "PATCH",
      { version: row.version, active: false, reason: "Suspend source access" }, randomUUID())).status, 200);
    await assert.rejects(require("../src/website-intake").readSource(f.pool, actor, lead.id),
      error => error.status === 401 && error.code === "UNAUTHENTICATED");
  } finally { await f.stop(); }
});
test("login whose credential read predates membership change cannot recreate an old session", async () => {
  const f = await fixture();
  try {
    const user = await f.login("sales"), id = (await user.api("/auth/me")).body.user.id;
    let checked = false;
    const proxy = {
      query: async (sql, args) => {
        const result = await f.pool.query(sql, args);
        if (sql.includes("u.password_hash") && !checked) {
          checked = true;
          await f.cluster.owner.query("UPDATE memberships SET role='auditor' WHERE tenant_id=$1 AND user_id=$2", [f.tenants.alpha, id]);
        }
        return result;
      },
      connect: () => f.pool.connect(),
    };
    // The injected boundary changes real PG state after the credential lookup.
    // Use a known synthetic password for this isolated login.
    const password = "Membership-race-synthetic-2026";
    await f.cluster.owner.query("UPDATE users SET password_hash=$1 WHERE id=$2", [await auth.hashPassword(password), id]);
    await assert.rejects(auth.login(proxy, { tenant: "alpha", email: "sales@test.invalid", password },
      { ip: "127.0.0.1", requestId: randomUUID() }), /changed/i);
    assert.equal(checked, true);
    assert.equal((await user.api("/auth/me")).status, 401);
  } finally { await f.stop(); }
});
