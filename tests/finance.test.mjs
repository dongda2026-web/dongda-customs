import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./helpers/api.mjs";
let f, a, beta, sales, order;
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
before(async () => {
  f = await fixture(); a = await f.login(); beta = await f.login("admin", "beta"); sales = await f.login("sales");
  const partner = ok(await a.api("/partners", "POST", { name: "Finance customer", kind: "customer" }), 201);
  const product = ok(await a.api("/products", "POST", { code: "FIN", name: "Finance product", unit: "pcs", price: "12.345", currency: "USD" }), 201);
  const wh = ok(await a.api("/warehouses", "POST", { code: "FIN", name: "Warehouse", kind: "domestic" }), 201);
  order = ok(await a.api("/orders", "POST", { partner_id: partner.id, warehouse_id: wh.id, currency: "USD",
    lines: [{ product_id: product.id, quantity: "2", price: "12.345" }] }, randomUUID()), 201);
});
after(async () => { if (f) await f.stop(); });
test("finance status is explicit, unconfigured integrations cannot claim delivery", async () => {
  const result = ok(await a.api("/finance/status"));
  assert.equal(result.connected, false);
  assert.equal(result.provider, "dongda-finance");
  assert.equal(ok(await a.api("/finance/events")).items.length, 0);
});
test("drafts do not emit financial events; approval and later changes write transactional outbox snapshots", async () => {
  assert.equal(ok(await a.api("/finance/events")).items.length, 0);
  for (const action of ["submit", "approve"]) order = ok(await a.api(`/orders/${order.id}/actions`, "POST", { action, version: order.version }, randomUUID()));
  let events = ok(await a.api("/finance/events")).items;
  assert.equal(events.length, 1);
  assert.equal(events[0].state, "pending");
  assert.equal(events[0].event_type, "order.approve");
  assert.equal(events[0].payload.document.total, "24.69");
  assert.equal(events[0].payload.document.id, order.id);
  assert.equal(events[0].payload.tenant_id, f.tenants.alpha);
  const first = events[0];
  order = ok(await a.api(`/orders/${order.id}`, "PATCH", { version: order.version, note: "Terms amended" }, randomUUID()));
  events = ok(await a.api("/finance/events")).items;
  assert.equal(events.length, 2);
  assert.equal(events.find(e => e.id === first.id).payload.document.version, first.payload.document.version);
  assert.equal(events.find(e => e.event_type === "order.revise").payload.document.state, "review");
  assert.equal(ok(await beta.api("/finance/events")).items.length, 0);
});
test("document activity and its finance event roll back together", async () => {
  const before = ok(await a.api("/finance/events")).items.length;
  const result = await a.api(`/orders/${order.id}/ship`, "POST", {
    version: order.version, lines: [{ line_id: order.lines[0].id, quantity: "999" }],
  }, randomUUID());
  assert.equal(result.status, 409);
  assert.equal(ok(await a.api("/finance/events")).items.length, before);
});
test("sales cannot requeue finance events, cross-tenant event ids are invisible", async () => {
  const event = ok(await a.api("/finance/events")).items[0];
  assert.equal((await sales.api(`/finance/${event.id}/retry`, "POST", {}, randomUUID())).status, 403);
  assert.equal((await beta.api(`/finance/${event.id}/retry`, "POST", {}, randomUUID())).status, 404);
});
test("finance results require the same audit permission as financial event snapshots", async () => {
  for (const role of ["sales", "social", "purchasing", "warehouse"]) {
    const user = await f.login(role);
    assert.equal((await user.api("/finance/results")).status, 403, role);
  }
  const auditor = await f.login("auditor");
  assert.equal((await auditor.api("/finance/results")).status, 200);
});
test("explicit admin retry renews exhausted delivery budget and records previous attempts", async () => {
  const event = ok(await a.api("/finance/events")).items[0];
  await f.cluster.owner.query("UPDATE finance_outbox SET state='failed',attempts=10,error_code='DELIVERY_TIMEOUT' WHERE id=$1", [event.id]);
  ok(await a.api(`/finance/${event.id}/retry`, "POST", {}, randomUUID()));
  const row = (await f.cluster.owner.query("SELECT * FROM finance_outbox WHERE id=$1", [event.id])).rows[0];
  assert.equal(row.state, "pending");
  assert.equal(row.attempts, 0, "manual retry must actually become eligible for delivery");
  const log = (await f.cluster.owner.query("SELECT summary FROM audit_log WHERE action='finance.retry' AND resource_id=$1 ORDER BY id DESC LIMIT 1", [event.id])).rows[0];
  assert.equal(log.summary.previous_attempts, 10);
});
