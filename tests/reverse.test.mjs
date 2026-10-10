import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./helpers/api.mjs";
let f, admin, buyer, seller, store, item;
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
before(async () => {
  f = await fixture(); admin = await f.login();
  buyer = ok(await admin.api("/partners", "POST", { name: "Buyer", kind: "customer" }), 201);
  seller = ok(await admin.api("/partners", "POST", { name: "Seller", kind: "supplier" }), 201);
  store = ok(await admin.api("/warehouses", "POST", { code: "RET", name: "Return warehouse", kind: "domestic" }), 201);
  item = ok(await admin.api("/products", "POST", { code: "RETURN", name: "Return item", unit: "pcs", price: "2", currency: "USD" }), 201);
});
after(async () => { if (f) await f.stop(); });
async function confirmed(type, partner, quantity) {
  let row = ok(await admin.api(`/${type}`, "POST", {
    partner_id: partner.id, warehouse_id: store.id, currency: "USD", lines: [{ product_id: item.id, quantity, price: "2" }],
  }, randomUUID()), 201);
  for (const action of ["submit", "approve"]) {
    row = ok(await admin.api(`/${type}/${row.id}/actions`, "POST", { action, version: row.version }, randomUUID()));
  }
  return row;
}
test("sales returns enter quarantine, release requires inspection, and no replacement demand is created", async () => {
  ok(await admin.api("/inventory/opening", "POST", { warehouse_id: store.id, product_id: item.id, quantity: "8" }, randomUUID()), 201);
  let order = await confirmed("orders", buyer, "5");
  order = ok(await admin.api(`/orders/${order.id}/ship`, "POST", { version: order.version, lines: [{ line_id: order.lines[0].id, quantity: "5" }] }, randomUUID()));
  const events = ok(await admin.api(`/orders/${order.id}/fulfilments`)).items;
  const shipment = events.find(e => e.kind === "ship");
  const returnRequest = { version: order.version, lines: [{ source_line_id: shipment.event_line_id, quantity: "2" }], reason: "Packaging damaged" };
  order = ok(await admin.api(`/orders/${order.id}/return`, "POST", returnRequest, randomUUID()));
  let balance = ok(await admin.api("/inventory/balances")).items.find(i => i.product_id === item.id);
  assert.equal(balance.on_hand, "5.000000");
  assert.equal(balance.frozen, "2.000000");
  assert.equal(balance.available, "3.000000");
  assert.equal(order.lines[0].shipped, "5.000000");
  assert.equal(order.lines[0].shortage, "0.000000");
  const overReturn = await admin.api(`/orders/${order.id}/return`, "POST", {
    version: order.version, lines: [{ source_line_id: shipment.event_line_id, quantity: "4" }], reason: "Too many",
  }, randomUUID());
  assert.equal(overReturn.status, 409);
  const returnLine = ok(await admin.api(`/orders/${order.id}/fulfilments`)).items.find(e => e.kind === "sales_return");
  const inspect = { version: order.version, lines: [{ source_line_id: returnLine.event_line_id, quantity: "2" }], reason: "Inspection passed" };
  order = ok(await admin.api(`/orders/${order.id}/release-return`, "POST", inspect, randomUUID()));
  balance = ok(await admin.api("/inventory/balances")).items.find(i => i.product_id === item.id);
  assert.equal(balance.frozen, "0.000000");
  assert.equal(balance.available, "5.000000");
  assert.equal((await admin.api(`/orders/${order.id}/release-return`, "POST", { ...inspect, version: order.version }, randomUUID())).status, 409);
  assert.equal(ok(await admin.api("/inventory/reconcile")).consistent, true);
});
test("purchase return links original receipt, cannot exceed receipt or consume reserved stock", async () => {
  let p = await confirmed("purchases", seller, "3");
  p = ok(await admin.api(`/purchases/${p.id}/receive`, "POST", { version: p.version, lines: [{ line_id: p.lines[0].id, quantity: "3" }] }, randomUUID()));
  const event = ok(await admin.api(`/purchases/${p.id}/fulfilments`)).items.find(e => e.kind === "receive");
  const order = await confirmed("orders", buyer, "8");
  const request = { version: p.version, lines: [{ source_line_id: event.event_line_id, quantity: "1" }], reason: "Supplier defect" };
  assert.equal((await admin.api(`/purchases/${p.id}/return`, "POST", request, randomUUID())).status, 409);
  ok(await admin.api(`/orders/${order.id}/actions`, "POST", { action: "cancel", version: order.version }, randomUUID()));
  p = ok(await admin.api(`/purchases/${p.id}/return`, "POST", request, randomUUID()));
  assert.equal(p.lines[0].received, "3.000000", "original received history stays unchanged");
  assert.equal((await admin.api(`/purchases/${p.id}/return`, "POST", {
    ...request, version: p.version, lines: [{ source_line_id: event.event_line_id, quantity: "3" }],
  }, randomUUID())).status, 409);
  assert.equal(ok(await admin.api("/inventory/reconcile")).consistent, true);
});
