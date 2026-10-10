import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fixture } from "./helpers/api.mjs";
import { startPostgres } from "./helpers/postgres.mjs";
const require = createRequire(import.meta.url);
let f, a, sales, buyer, store, beta, partner, product, warehouse;
const ok = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.body)); return r.body; };
before(async () => {
  f = await fixture(); a = await f.login(); sales = await f.login("sales"); buyer = await f.login("purchasing");
  store = await f.login("warehouse"); beta = await f.login("admin", "beta");
  ok(await a.api("/settings", "PATCH", { version: 0, data: { name: "Tenant Alpha Exporter", address: "Synthetic exporter address" } }));
  partner = ok(await a.api("/partners", "POST", { name: "Customer <script>alert(1)</script>", kind: "both", address: "Synthetic buyer address" }), 201);
  product = ok(await a.api("/products", "POST", { name: "Bag <img src=x>", code: "DOC", unit: "pcs", currency: "KWD", price: "0.333333" }), 201);
  warehouse = ok(await a.api("/warehouses", "POST", { name: "Doc warehouse", code: "DOC", kind: "domestic" }), 201);
  ok(await a.api("/inventory/opening", "POST", { warehouse_id: warehouse.id, product_id: product.id, quantity: "1000" }, randomUUID()), 201);
});
after(async () => { if (f) await f.stop(); });
async function approved(kind = "orders") {
  let doc = ok(await a.api(`/${kind}`, "POST", { partner_id: partner.id, warehouse_id: warehouse.id, currency: "KWD",
    terms: "FCA Synthetic City", lines: [{ product_id: product.id, quantity: "10", price: "0.333333" }] }, randomUUID()), 201);
  for (const action of ["submit", "approve"]) doc = ok(await a.api(`/${kind}/${doc.id}/actions`, "POST", { action, version: doc.version }, randomUUID()));
  return doc;
}
async function shipped() {
  const order = await approved();
  return ok(await store.api(`/orders/${order.id}/ship`, "POST",
    { version: order.version, lines: [{ line_id: order.lines[0].id, quantity: "3" }] }, randomUUID()));
}
function request(order, kind = "invoice") {
  return { document_id: order.id, version: order.version, fulfilment_id: order.fulfilment_id, kind,
    issue_date: "2026-10-10", confirmed: true, language: "en" };
}
test("shipment documents use frozen batch quantities and currency precision, are idempotent and immutable", async () => {
  const order = await shipped(), body = request(order), key = randomUUID();
  const result = ok(await sales.api("/documents", "POST", body, key), 201);
  assert.equal(result.snapshot.lines[0].quantity, "3.000000");
  assert.equal(result.snapshot.lines[0].price, "0.333333");
  assert.equal(result.snapshot.total, "1.000");
  assert.equal(result.snapshot.source.version, order.version);
  assert.equal(result.snapshot.source.fulfilment_id, order.fulfilment_id);
  assert.equal(ok(await sales.api("/documents", "POST", body, key), 201).id, result.id);
  assert.equal(ok(await a.api(`/documents?document_id=${order.id}`)).items.length, 1);
  const exported = ok(await sales.api(`/documents/${result.id}/export`));
  assert.equal(exported.sha256, createHash("sha256").update(exported.html).digest("hex"));
  assert.match(exported.html, /COMMERCIAL INVOICE/);
  assert.ok(exported.html.includes("&lt;script&gt;"));
  assert.ok(!exported.html.includes("<script>"));
  assert.ok(!exported.html.includes("<img"));
  assert.ok(!exported.html.includes("dongda-seal"));
  await assert.rejects(f.pool.query("UPDATE issued_documents SET html='changed'"), /permission denied/);
  await assert.rejects(f.pool.query("DELETE FROM shipment_document_sources"), /permission denied/);
});
test("later order changes mark documents stale without rewriting history or replacing shipment prices", async () => {
  let order = await shipped();
  const doc = ok(await sales.api("/documents", "POST", request(order), randomUUID()), 201);
  const original = ok(await sales.api(`/documents/${doc.id}/export`)).html;
  order = ok(await sales.api(`/orders/${order.id}`, "PATCH", { version: order.version,
    lines: order.lines.map(l => ({ id: l.id, product_id: l.product_id, quantity: l.quantity, price: "2" })) }, randomUUID()));
  const stale = ok(await sales.api(`/documents/${doc.id}`));
  assert.equal(stale.stale, true);
  assert.equal((await sales.api(`/documents/${doc.id}/export`)).status, 409);
  const history = ok(await sales.api(`/documents/${doc.id}/export?history=1`));
  assert.equal(history.html, original);
  assert.equal(history.historical, true);
  const source = (await f.cluster.owner.query("SELECT snapshot FROM shipment_document_sources WHERE fulfilment_id=$1", [doc.fulfilment_id])).rows[0].snapshot;
  assert.equal(source.lines[0].price, "0.333333");
  assert.equal((await sales.api("/documents", "POST", { ...request(order), fulfilment_id: doc.fulfilment_id }, randomUUID())).status, 409);
});
test("document validation blocks incomplete packing data, wrong batch and unconfirmed output without leaving records", async () => {
  const order = await shipped(), body = request(order);
  for (const change of [{ confirmed: false }, { fulfilment_id: randomUUID() }, { issue_date: "2026-02-30" },
    { kind: "packing_list" }, { kind: "packing_list", packing: { packages: "1", gross_kg: "2", net_kg: "3", marks: "N/M" } }]) {
    assert.ok([404, 409, 422].includes((await sales.api("/documents", "POST", { ...body, ...change }, randomUUID())).status));
  }
  assert.equal(ok(await a.api(`/documents?document_id=${order.id}`)).items.length, 0);
  const packing = ok(await sales.api("/documents", "POST", { ...body, kind: "packing_list",
    packing: { packages: "2", gross_kg: "4.123456", net_kg: "3", marks: "<b>Marks</b>" } }, randomUUID()), 201);
  const output = ok(await sales.api(`/documents/${packing.id}/export`));
  assert.match(output.html, /PACKING LIST/);
  assert.match(output.html, /4.123456/);
  assert.ok(!output.html.includes("0.333333"), "packing list must not leak commercial prices");
});
test("document read and write roles, tenant references and anonymous paths are enforced", async () => {
  const order = await shipped(), body = request(order);
  const doc = ok(await sales.api("/documents", "POST", body, randomUUID()), 201);
  assert.equal((await beta.api(`/documents/${doc.id}`)).status, 404);
  assert.equal((await beta.api(`/documents/${doc.id}/export?history=1`)).status, 404);
  assert.equal((await beta.api("/documents", "POST", body, randomUUID())).status, 404);
  for (const role of ["social", "warehouse", "purchasing"]) {
    const user = await f.login(role);
    assert.equal((await user.api(`/documents/${doc.id}/export`)).status, 403, role);
  }
  const auditor = await f.login("auditor");
  assert.equal((await auditor.api("/documents", "POST", body, randomUUID())).status, 403);
  assert.equal((await auditor.api(`/documents/${doc.id}/export`)).status, 200);
  assert.equal((await fetch(f.base + `/api/v1/documents/${doc.id}/export`)).status, 401);
});
test("purchase order uses confirmed purchase snapshot, not sales prices or shipment references", async () => {
  const purchase = await approved("purchases");
  const body = { ...request(purchase, "purchase_order"), fulfilment_id: null };
  const doc = ok(await buyer.api("/documents", "POST", body, randomUUID()), 201);
  assert.equal(doc.snapshot.lines[0].quantity, "10.000000");
  assert.equal(doc.snapshot.total, "3.333");
  assert.match(ok(await buyer.api(`/documents/${doc.id}/export`)).html, /PURCHASE ORDER/);
  assert.equal((await sales.api(`/documents/${doc.id}/export`)).status, 403);
  assert.equal((await buyer.api("/documents", "POST", { ...body, fulfilment_id: randomUUID() }, randomUUID())).status, 422);
});

test("a different shipment does not invalidate a frozen batch, but its return blocks current export", async () => {
  let order = await shipped();
  const first = order.fulfilment_id;
  const doc = ok(await sales.api("/documents", "POST", request(order), randomUUID()), 201);
  order = ok(await store.api(`/orders/${order.id}/ship`, "POST",
    { version: order.version, lines: [{ line_id: order.lines[0].id, quantity: "2" }] }, randomUUID()));
  assert.equal(ok(await sales.api(`/documents/${doc.id}`)).stale, false);
  const moves = ok(await a.api(`/orders/${order.id}/fulfilments`)).items;
  order = ok(await store.api(`/orders/${order.id}/return`, "POST", { version: order.version, reason: "Damaged package",
    lines: [{ source_line_id: moves.find(l => l.id === first).event_line_id, quantity: "1" }] }, randomUUID()));
  assert.equal(ok(await sales.api(`/documents/${doc.id}`)).stale, true);
  assert.equal((await sales.api(`/documents/${doc.id}/export`)).status, 409);
  assert.equal((await sales.api("/documents", "POST", { ...request(order), fulfilment_id: first }, randomUUID())).status, 409);
});
test("failure to persist shipment snapshot rolls back stock, fulfilment and order revision together", async () => {
  const order = await approved();
  const before = (await f.cluster.owner.query("SELECT on_hand,reserved FROM stock_balances WHERE tenant_id=$1 AND product_id=$2", [f.tenants.alpha, product.id])).rows[0];
  await f.cluster.owner.query("REVOKE INSERT ON shipment_document_sources FROM erp_runtime");
  try {
    assert.equal((await store.api(`/orders/${order.id}/ship`, "POST",
      { version: order.version, lines: [{ line_id: order.lines[0].id, quantity: "1" }] }, randomUUID())).status, 503);
    assert.equal(ok(await a.api(`/orders/${order.id}`)).version, order.version);
    assert.equal(ok(await a.api(`/orders/${order.id}/fulfilments`)).items.length, 0);
    assert.deepEqual((await f.cluster.owner.query("SELECT on_hand,reserved FROM stock_balances WHERE tenant_id=$1 AND product_id=$2", [f.tenants.alpha, product.id])).rows[0], before);
  } finally { await f.cluster.owner.query("GRANT INSERT ON shipment_document_sources TO erp_runtime"); }
});
test("missing company particulars block issuance and later partner edits invalidate exports", async () => {
  const order = await shipped(), settings = ok(await a.api("/settings"));
  ok(await a.api("/settings", "PATCH", { version: settings.version, data: { name: "No address" } }));
  assert.equal((await sales.api("/documents", "POST", request(order), randomUUID())).status, 422);
  ok(await a.api("/settings", "PATCH", { version: settings.version + 1, data: settings.data }));
  const issued = ok(await sales.api("/documents", "POST", request(order), randomUUID()), 201);
  const current = ok(await a.api(`/partners/${partner.id}`));
  ok(await a.api(`/partners/${partner.id}`, "PATCH", { version: current.version, address: "Changed buyer address" }));
  assert.equal((await sales.api(`/documents/${issued.id}/export`)).status, 409);
  assert.ok(ok(await sales.api(`/documents/${issued.id}/export?history=1`)).html.includes("Synthetic buyer address"));
});
test("document bytes and source snapshots survive authenticated encrypted restore into another real database", async () => {
  const { backup, restore } = require("../src/recovery");
  const { migrate } = require("../src/db");
  const key = randomBytes(32), encrypted = await backup(f.cluster.owner, key);
  const target = await startPostgres();
  try {
    await migrate(target.owner); await restore(target.owner, encrypted, key);
    for (const table of ["issued_documents", "shipment_document_sources"]) {
      const source = (await f.cluster.owner.query(`SELECT row_to_json(t)::text AS row FROM ${table} t ORDER BY row_to_json(t)::text`)).rows;
      const restored = (await target.owner.query(`SELECT row_to_json(t)::text AS row FROM ${table} t ORDER BY row_to_json(t)::text`)).rows;
      assert.ok(source.length > 0); assert.deepEqual(restored, source);
    }
  } finally { await target.stop(); }
});
