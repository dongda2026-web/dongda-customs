import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./helpers/api.mjs";
let f, admin, beta, sales, warehouse, supplier, customer, product, store;
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
before(async () => {
  f = await fixture(); admin = await f.login(); beta = await f.login("admin", "beta");
  sales = await f.login("sales"); warehouse = await f.login("warehouse");
  supplier = ok(await admin.api("/partners", "POST", { name: "Supplier", kind: "supplier" }), 201);
  customer = ok(await admin.api("/partners", "POST", { name: "Customer", kind: "customer" }), 201);
  product = ok(await admin.api("/products", "POST", { code: "BAG", name: "Bag", unit: "pcs", price: "0.125", currency: "USD" }), 201);
  store = ok(await admin.api("/warehouses", "POST", { code: "MAIN", name: "Main", kind: "domestic" }), 201);
});
after(async () => { if (f) await f.stop(); });
const lines = (quantity, price = "0.125") => [{ product_id: product.id, quantity, price }];
const draft = (quantity = "10") => ({ partner_id: customer.id, warehouse_id: store.id, currency: "USD", due_date: "2026-12-10", lines: lines(quantity) });
async function action(type, row, name, extra = {}, client = admin, key = randomUUID()) {
  return client.api(`/${type}/${row.id}/actions`, "POST", { action: name, version: row.version, ...extra }, key);
}
async function confirmedOrder(quantity) {
  let order = ok(await admin.api("/orders", "POST", draft(quantity), randomUUID()), 201);
  order = ok(await action("orders", order, "submit"));
  return ok(await action("orders", order, "approve"));
}
test("quote totals use decimal rounding, version snapshots and idempotent acceptance", async () => {
  const q = ok(await admin.api("/quotes", "POST", {
    ...draft("3"), valid_until: "2026-12-31", lead_id: null,
  }, randomUUID()), 201);
  assert.equal(q.total, "0.38");
  assert.equal(q.lines[0].unit, "pcs");
  let quote = ok(await action("quotes", q, "send"));
  const key = randomUUID();
  const accepted = ok(await action("quotes", quote, "accept", {}, admin, key));
  assert.ok(accepted.order_id);
  const replay = ok(await action("quotes", quote, "accept", {}, admin, key));
  assert.equal(replay.order_id, accepted.order_id);
  const order = ok(await admin.api(`/orders/${accepted.order_id}`));
  assert.equal(order.source_id, quote.id);
  assert.equal(order.total, "0.38");
  assert.equal((await beta.api(`/orders/${order.id}`)).status, 404);
});
test("orders require controlled approval and role checks", async () => {
  let o = ok(await sales.api("/orders", "POST", draft("2"), randomUUID()), 201);
  assert.equal((await action("orders", o, "complete")).status, 409);
  o = ok(await action("orders", o, "submit", {}, sales));
  assert.equal((await action("orders", o, "approve", {}, sales)).status, 403);
  o = ok(await action("orders", o, "approve"));
  assert.equal(o.state, "confirmed");
  assert.equal((await sales.api("/orders", "POST", { ...draft(), lines: lines("-1") }, randomUUID())).status, 422);
  assert.equal((await sales.api("/orders", "POST", { ...draft(), currency: "BAD" }, randomUUID())).status, 422);
  assert.equal((await action("orders", o, "cancel")).status, 200);
});
test("stock 4, order 10, purchase 6, split receipts and shipments reconcile exactly", async () => {
  ok(await warehouse.api("/inventory/opening", "POST", { warehouse_id: store.id, product_id: product.id, quantity: "4" }, randomUUID()), 201);
  let order = await confirmedOrder("10");
  assert.equal(order.lines[0].reserved, "4.000000");
  assert.equal(order.lines[0].shortage, "6.000000");
  let purchase = ok(await admin.api(`/orders/${order.id}/procure`, "POST", {
    version: order.version, supplier_id: supplier.id, currency: "CNY",
    prices: [{ order_line_id: order.lines[0].id, price: "0.5" }],
  }, randomUUID()), 201);
  assert.equal(purchase.lines[0].quantity, "6.000000");
  const duplicate = await admin.api(`/orders/${order.id}/procure`, "POST", { version: order.version, supplier_id: supplier.id }, randomUUID());
  assert.equal(duplicate.status, 409);
  purchase = ok(await action("purchases", purchase, "submit"));
  purchase = ok(await action("purchases", purchase, "approve"));
  const key = randomUUID(), receive2 = { version: purchase.version, lines: [{ line_id: purchase.lines[0].id, quantity: "2" }] };
  purchase = ok(await admin.api(`/purchases/${purchase.id}/receive`, "POST", receive2, key));
  assert.equal(purchase.state, "partial");
  const replay = ok(await admin.api(`/purchases/${purchase.id}/receive`, "POST", receive2, key));
  assert.equal(replay.lines[0].received, "2.000000");
  purchase = ok(await admin.api(`/purchases/${purchase.id}/receive`, "POST", {
    version: purchase.version, lines: [{ line_id: purchase.lines[0].id, quantity: "4" }],
  }, randomUUID()));
  assert.equal(purchase.state, "fulfilled");
  order = ok(await admin.api(`/orders/${order.id}`));
  assert.equal(order.lines[0].reserved, "10.000000");
  order = ok(await warehouse.api(`/orders/${order.id}/ship`, "POST", {
    version: order.version, lines: [{ line_id: order.lines[0].id, quantity: "3" }],
  }, randomUUID()));
  assert.equal(order.state, "partial");
  assert.equal((await warehouse.api(`/orders/${order.id}/ship`, "POST", {
    version: order.version, lines: [{ line_id: order.lines[0].id, quantity: "8" }],
  }, randomUUID())).status, 409);
  order = ok(await warehouse.api(`/orders/${order.id}/ship`, "POST", {
    version: order.version, lines: [{ line_id: order.lines[0].id, quantity: "7" }],
  }, randomUUID()));
  assert.equal(order.state, "fulfilled");
  const balances = ok(await admin.api("/inventory/balances"));
  const balance = balances.items.find(b => b.product_id === product.id && b.warehouse_id === store.id);
  assert.equal(balance.on_hand, "0.000000");
  assert.equal(balance.reserved, "0.000000");
  assert.equal(balance.available, "0.000000");
  const check = ok(await admin.api("/inventory/reconcile"));
  assert.equal(check.consistent, true);
  assert.equal(check.differences.length, 0);
  assert.equal((await beta.api("/inventory/balances")).body.items.length, 0);
});
test("concurrent approvals do not over-reserve stock and cancellation releases it", async () => {
  const p = ok(await admin.api("/products", "POST", { code: "RACE", name: "Race", unit: "pcs", price: "1", currency: "USD" }), 201);
  ok(await warehouse.api("/inventory/opening", "POST", { warehouse_id: store.id, product_id: p.id, quantity: "5" }, randomUUID()), 201);
  const make = async () => {
    const o = ok(await admin.api("/orders", "POST", { ...draft("5"), lines: [{ product_id: p.id, quantity: "5", price: "1" }] }, randomUUID()), 201);
    return ok(await action("orders", o, "submit"));
  };
  const [a, b] = await Promise.all([make(), make()]);
  const results = await Promise.all([action("orders", a, "approve"), action("orders", b, "approve")]);
  const approved = results.map(r => ok(r));
  assert.equal(approved.reduce((sum, o) => sum + Number(o.lines[0].reserved), 0), 5);
  const held = approved.find(o => Number(o.lines[0].reserved) > 0);
  ok(await action("orders", held, "cancel"));
  const balance = ok(await admin.api("/inventory/balances")).items.find(x => x.product_id === p.id);
  assert.equal(balance.available, "5.000000");
});
test("stock moves and audit are immutable to the application role", async () => {
  await assert.rejects(f.pool.query("DELETE FROM stock_movements"), /permission denied/);
  await assert.rejects(f.pool.query("UPDATE stock_movements SET delta_on_hand=0"), /permission denied/);
});
test("procurement requires explicit supplier prices and currency, never copies sales prices", async () => {
  const order = await confirmedOrder("10");
  const base = { version: order.version, supplier_id: supplier.id };
  const path = `/orders/${order.id}/procure`;
  const totalBefore = ok(await admin.api("/purchases")).total;
  assert.equal((await admin.api(path, "POST", base, randomUUID())).status, 422);
  assert.equal((await admin.api(path, "POST", { ...base, currency: "CNY", prices: [] }, randomUUID())).status, 422);
  assert.equal((await admin.api(path, "POST", { ...base, currency: "CNY", prices: [{ order_line_id: randomUUID(), price: "1" }] }, randomUUID())).status, 422);
  assert.equal((await admin.api(path, "POST", { ...base, currency: "CNY", prices: [{ order_line_id: order.lines[0].id, price: "-1" }] }, randomUUID())).status, 422);
  assert.equal(ok(await admin.api("/purchases")).total, totalBefore);
  const purchase = ok(await admin.api(path, "POST", { ...base, currency: "CNY", prices: [{ order_line_id: order.lines[0].id, price: "0.08" }] }, randomUUID()), 201);
  assert.equal(purchase.currency, "CNY");
  assert.equal(purchase.total, "0.80");
  assert.equal(purchase.lines[0].price, "0.080000");
  assert.equal(ok(await admin.api(`/orders/${order.id}`)).total, "1.25");
});

test("lead-linked quotes require an explicit matching customer and preserve that identity on revision", async () => {
  let lead = ok(await admin.api("/leads", "POST", { name: "Unbound website lead" }), 201);
  const body = { ...draft("2"), lead_id: lead.id, valid_until: "2026-12-31" };
  assert.equal((await sales.api("/quotes", "POST", body, randomUUID())).status, 409);
  lead = ok(await admin.api(`/leads/${lead.id}`, "PATCH", { version: lead.version, partner_id: customer.id }));
  const other = ok(await admin.api("/partners", "POST", { name: "Other customer", kind: "customer" }), 201);
  assert.equal((await sales.api("/quotes", "POST", { ...body, partner_id: other.id }, randomUUID())).status, 409);
  const quote = ok(await sales.api("/quotes", "POST", body, randomUUID()), 201);
  assert.equal((await sales.api(`/quotes/${quote.id}`, "PATCH", { version: quote.version, partner_id: other.id }, randomUUID())).status, 409);
  assert.equal(ok(await admin.api(`/quotes/${quote.id}`)).partner_id, customer.id);
});
