import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./helpers/api.mjs";
let f, a, item, warehouse, customer;
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
before(async () => {
  f = await fixture(); a = await f.login();
  item = ok(await a.api("/products", "POST", { code: "EDIT", name: "Edit item", unit: "pcs", price: "2", currency: "USD" }), 201);
  warehouse = ok(await a.api("/warehouses", "POST", { code: "EDIT", name: "Edit warehouse", kind: "domestic" }), 201);
  customer = ok(await a.api("/partners", "POST", { name: "Revision customer", kind: "customer" }), 201);
  ok(await a.api("/inventory/opening", "POST", { product_id: item.id, warehouse_id: warehouse.id, quantity: "10" }, randomUUID()), 201);
});
after(async () => { if (f) await f.stop(); });
async function action(doc, action) { return ok(await a.api(`/orders/${doc.id}/actions`, "POST", { version: doc.version, action }, randomUUID())); }
test("editing a confirmed order releases stock, requires reapproval and preserves prior versions", async () => {
  let d = ok(await a.api("/orders", "POST", { partner_id: customer.id, warehouse_id: warehouse.id, currency: "USD",
    lines: [{ product_id: item.id, quantity: "6", price: "2" }] }, randomUUID()), 201);
  d = await action(await action(d, "submit"), "approve");
  const originalVersion = d.version;
  d = ok(await a.api(`/orders/${d.id}`, "PATCH", {
    version: d.version, lines: [{ id: d.lines[0].id, product_id: item.id, quantity: "5", price: "3" }],
  }, randomUUID()));
  assert.equal(d.state, "review");
  assert.equal(d.total, "15.00");
  assert.equal(d.lines[0].reserved, "0.000000");
  const versions = ok(await a.api(`/orders/${d.id}/versions`)).items;
  assert.equal(versions.find(x => x.version === originalVersion).snapshot.total, "12.00");
  assert.equal((await a.api(`/orders/${d.id}`, "PATCH", { version: originalVersion, note: "stale" }, randomUUID())).status, 409);
  d = await action(d, "approve");
  assert.equal(d.lines[0].reserved, "5.000000");
  d = ok(await a.api(`/orders/${d.id}/ship`, "POST", { version: d.version, lines: [{ line_id: d.lines[0].id, quantity: "3" }] }, randomUUID()));
  assert.equal((await a.api(`/orders/${d.id}`, "PATCH", {
    version: d.version, lines: [{ id: d.lines[0].id, product_id: item.id, quantity: "2", price: "3" }],
  }, randomUUID())).status, 409);
  assert.equal(ok(await a.api("/inventory/reconcile")).consistent, true);
});

test("draft documents can add and remove uncommitted lines without rewriting old snapshots", async () => {
  let d = ok(await a.api("/orders", "POST", { partner_id: customer.id, warehouse_id: warehouse.id, currency: "USD",
    lines: [{ product_id: item.id, quantity: "1", price: "2" }] }, randomUUID()), 201);
  const originalId = d.lines[0].id;
  d = ok(await a.api(`/orders/${d.id}`, "PATCH", { version: d.version, lines: [
    { id: originalId, product_id: item.id, quantity: "2", price: "2" },
    { product_id: item.id, quantity: "3", price: "1" },
  ] }, randomUUID()));
  assert.equal(d.lines.length, 2);
  assert.equal(d.total, "7.00");
  d = ok(await a.api(`/orders/${d.id}`, "PATCH", { version: d.version, lines: [d.lines[1]] }, randomUUID()));
  assert.equal(d.lines.length, 1);
  const versions = ok(await a.api(`/orders/${d.id}/versions`)).items;
  assert.equal(versions.find(v => v.version === 1).snapshot.lines[0].id, originalId);
});
