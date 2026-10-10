import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fixture } from "./helpers/api.mjs";
import { startPostgres } from "./helpers/postgres.mjs";
const require = createRequire(import.meta.url);
test("encrypted consistent backup restores to an empty isolated database and refuses overwrite", async () => {
  assert.ok(existsSync(new URL("../src/recovery.js", import.meta.url)), "recovery module must exist");
  const { backup, restore } = require("../src/recovery");
  const { migrate } = require("../src/db");
  const f = await fixture(); let target;
  try {
    const a = await f.login();
    const p = (await a.api("/partners", "POST", { name: "Private synthetic partner", kind: "customer" })).body;
    const sku = (await a.api("/products", "POST", { name: "Bag", code: "RECOVERY", unit: "pcs", price: "1", currency: "USD" })).body;
    const wh = (await a.api("/warehouses", "POST", { name: "Warehouse", code: "RECOVERY", kind: "domestic" })).body;
    await a.api("/inventory/opening", "POST", { product_id: sku.id, warehouse_id: wh.id, quantity: "4" }, randomUUID());
    let order = (await a.api("/orders", "POST", { partner_id: p.id, warehouse_id: wh.id, currency: "USD", lines: [{ product_id: sku.id, quantity: "4", price: "1" }] }, randomUUID())).body;
    for (const action of ["submit", "approve"]) order = (await a.api(`/orders/${order.id}/actions`, "POST", { action, version: order.version }, randomUUID())).body;
    await f.cluster.owner.query("UPDATE products SET price=12345678901234.123456 WHERE id=$1", [sku.id]);
    await f.cluster.owner.query(`INSERT INTO tenant_settings(tenant_id,data) VALUES ($1,
      '{"exactNumeric":9007199254740993.123456,"nested":{"id":9007199254740993}}')`, [f.tenants.alpha]);
    await f.cluster.owner.query("INSERT INTO document_counters(tenant_id,kind,value) VALUES ($1,'recovery-test',9007199254740993)", [f.tenants.alpha]);
    const member = (await a.api("/members?search=sales")).body.items[0];
    assert.equal((await a.api(`/members/${member.id}`, "PATCH",
      { version: member.version, role: "auditor", active: false, reason: "Recovery access state" }, randomUUID())).status, 200);
    const membershipRows = "SELECT tenant_id,user_id,role,active,version FROM memberships ORDER BY tenant_id,user_id";
    const originalMembers = (await f.cluster.owner.query(membershipRows)).rows;
    const key = randomBytes(32);
    const encrypted = await backup(f.cluster.owner, key);
    assert.equal(encrypted.includes(Buffer.from(p.name)), false);
    target = await startPostgres();
    await migrate(target.owner);
    await assert.rejects(restore(target.owner, encrypted, randomBytes(32)), /authentication|authenticate|decrypt/i);
    const restored = await restore(target.owner, encrypted, key);
    assert.ok(restored.tables >= 20);
    assert.ok(restored.rows > 20);
    const row = (await target.owner.query("SELECT * FROM trade_documents WHERE id=$1", [order.id])).rows[0];
    assert.equal(row.state, "confirmed");
    assert.equal((await target.owner.query("SELECT price FROM products WHERE id=$1", [sku.id])).rows[0].price, "12345678901234.123456");
    assert.equal((await target.owner.query("SELECT data::text AS data FROM tenant_settings WHERE tenant_id=$1", [f.tenants.alpha])).rows[0].data,
      (await f.cluster.owner.query("SELECT data::text AS data FROM tenant_settings WHERE tenant_id=$1", [f.tenants.alpha])).rows[0].data);
    assert.equal((await target.owner.query("SELECT value FROM document_counters WHERE kind='recovery-test'")).rows[0].value, "9007199254740993");
    const stock = (await target.owner.query("SELECT on_hand,reserved FROM stock_balances WHERE product_id=$1", [sku.id])).rows[0];
    assert.equal(stock.on_hand, "4.000000");
    assert.equal(stock.reserved, "4.000000");
    assert.equal((await target.owner.query("SELECT count(*) FROM sessions")).rows[0].count, "0", "restored backups must not resurrect sessions");
    assert.deepEqual((await target.owner.query(membershipRows)).rows, originalMembers);
    const restoredMember = originalMembers.find(m => m.tenant_id === f.tenants.alpha && m.user_id === member.id);
    assert.equal(restoredMember.version, member.version + 1);
    await target.owner.query("UPDATE memberships SET active=true WHERE tenant_id=$1 AND user_id=$2", [f.tenants.alpha, member.id]);
    assert.equal((await target.owner.query("SELECT version FROM memberships WHERE tenant_id=$1 AND user_id=$2",
      [f.tenants.alpha, member.id])).rows[0].version, restoredMember.version + 1, "restored membership trigger must remain active");
    await assert.rejects(restore(target.owner, encrypted, key), /empty/);
    const first = await f.cluster.owner.query("SELECT count(*) FROM audit_log");
    const second = await target.owner.query("SELECT count(*) FROM audit_log");
    assert.equal(first.rows[0].count, second.rows[0].count);
    assert.equal((await target.owner.query("SELECT count(*) FROM finance_outbox")).rows[0].count, "1");
  } finally {
    if (target) await target.stop();
    await f.stop();
  }
});

test("backup refuses RLS-filtered runtime credentials rather than silently omitting tenant records", async () => {
  const { backup } = require("../src/recovery");
  const f = await fixture();
  try {
    await assert.rejects(backup(f.pool, randomBytes(32)), /row.level security|permission|privilege/i);
  } finally { await f.stop(); }
});
