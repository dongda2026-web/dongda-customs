import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./helpers/api.mjs";
let f, admin, worker, beta, item, from, to;
const ok = (r, s = 200) => { assert.equal(r.status, s, JSON.stringify(r.body)); return r.body; };
before(async () => {
  f = await fixture(); admin = await f.login(); worker = await f.login("warehouse"); beta = await f.login("admin", "beta");
  item = ok(await admin.api("/products", "POST", { code: "MOVE", name: "Movable stock", unit: "pcs", price: "1", currency: "USD" }), 201);
  from = ok(await admin.api("/warehouses", "POST", { code: "FROM", name: "Source", kind: "domestic" }), 201);
  to = ok(await admin.api("/warehouses", "POST", { code: "TO", name: "Destination", kind: "overseas" }), 201);
  ok(await worker.api("/inventory/opening", "POST", { warehouse_id: from.id, product_id: item.id, quantity: "10" }, randomUUID()), 201);
});
after(async () => { if (f) await f.stop(); });
test("transfer separates shipment, in-transit balance and partial receipts", async () => {
  let transfer = ok(await worker.api("/transfers", "POST", {
    source_warehouse_id: from.id, target_warehouse_id: to.id, product_id: item.id, quantity: "6",
  }, randomUUID()), 201);
  assert.equal((await beta.api(`/transfers/${transfer.id}`)).status, 404);
  transfer = ok(await worker.api(`/transfers/${transfer.id}/actions`, "POST", { action: "ship", version: transfer.version }, randomUUID()));
  assert.equal(transfer.in_transit, "6.000000");
  let balances = ok(await worker.api("/inventory/balances")).items;
  assert.equal(balances.find(b => b.warehouse_id === from.id).on_hand, "4.000000");
  assert.ok(!balances.find(b => b.warehouse_id === to.id) || balances.find(b => b.warehouse_id === to.id).on_hand === "0.000000");
  transfer = ok(await worker.api(`/transfers/${transfer.id}/actions`, "POST", { action: "receive", version: transfer.version, quantity: "2" }, randomUUID()));
  assert.equal(transfer.in_transit, "4.000000");
  assert.equal(transfer.state, "partial");
  const bad = await worker.api(`/transfers/${transfer.id}/actions`, "POST", { action: "receive", version: transfer.version, quantity: "5" }, randomUUID());
  assert.equal(bad.status, 409);
  transfer = ok(await worker.api(`/transfers/${transfer.id}/actions`, "POST", { action: "receive", version: transfer.version, quantity: "4" }, randomUUID()));
  assert.equal(transfer.state, "completed");
  assert.equal(transfer.in_transit, "0.000000");
  balances = ok(await worker.api("/inventory/balances")).items;
  assert.equal(balances.find(b => b.warehouse_id === to.id).on_hand, "6.000000");
  assert.equal(ok(await admin.api("/inventory/reconcile")).consistent, true);
});
test("stocktake requires review and fails when a newer movement invalidates its baseline", async () => {
  let count = ok(await worker.api("/stocktakes", "POST", {
    warehouse_id: from.id, reason: "Physical count", lines: [{ product_id: item.id, counted: "3" }],
  }, randomUUID()), 201);
  count = ok(await worker.api(`/stocktakes/${count.id}/actions`, "POST", { action: "submit", version: count.version }, randomUUID()));
  assert.equal((await worker.api(`/stocktakes/${count.id}/actions`, "POST", { action: "approve", version: count.version }, randomUUID())).status, 403);
  let transfer = ok(await worker.api("/transfers", "POST", {
    source_warehouse_id: from.id, target_warehouse_id: to.id, product_id: item.id, quantity: "1",
  }, randomUUID()), 201);
  ok(await worker.api(`/transfers/${transfer.id}/actions`, "POST", { action: "ship", version: transfer.version }, randomUUID()));
  const stale = await admin.api(`/stocktakes/${count.id}/actions`, "POST", { action: "approve", version: count.version }, randomUUID());
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "STOCK_BASELINE_CHANGED");
  let fresh = ok(await worker.api("/stocktakes", "POST", {
    warehouse_id: from.id, reason: "Recount after shipment", lines: [{ product_id: item.id, counted: "2" }],
  }, randomUUID()), 201);
  fresh = ok(await worker.api(`/stocktakes/${fresh.id}/actions`, "POST", { action: "submit", version: fresh.version }, randomUUID()));
  fresh = ok(await admin.api(`/stocktakes/${fresh.id}/actions`, "POST", { action: "approve", version: fresh.version }, randomUUID()));
  assert.equal(fresh.state, "posted");
  assert.equal(ok(await admin.api("/inventory/reconcile")).consistent, true);
});
