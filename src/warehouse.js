"use strict";
const { randomUUID } = require("node:crypto");
const { AppError, text } = require("./http");
const { requireRole } = require("./auth");
const { audit } = require("./db");
const r = require("./records");
const { state } = require("./trade");
const inventory = require("./inventory");

async function load(c, actor, type, id, lock = false) {
  r.uuid(id);
  const row = (await c.query(`SELECT * FROM ${type} WHERE tenant_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`, [actor.tenantId, id])).rows[0];
  if (!row) throw new AppError(404, "NOT_FOUND", "Warehouse document not found");
  if (type === "transfers") row.in_transit = new r.Decimal(row.shipped).minus(row.received).toFixed(6);
  else row.lines = (await c.query("SELECT * FROM stocktake_lines WHERE tenant_id=$1 AND stocktake_id=$2 ORDER BY product_id", [actor.tenantId, id])).rows;
  return row;
}
async function create(c, actor, type, body) {
  const id = randomUUID();
  if (type === "transfers") {
    const from = r.uuid(body.source_warehouse_id), to = r.uuid(body.target_warehouse_id), product = r.uuid(body.product_id);
    if (from === to) throw new AppError(422, "VALIDATION", "Transfer warehouses must differ");
    for (const warehouse of [from, to]) await r.ref(c, actor, "warehouses", warehouse, "warehouse_id");
    await r.ref(c, actor, "products", product, "product_id");
    const quantity = r.decimal(body.quantity, "quantity", { zero: false });
    await c.query(`INSERT INTO transfers(tenant_id,id,source_warehouse_id,target_warehouse_id,product_id,quantity,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`, [actor.tenantId, id, from, to, product, quantity, actor.userId]);
  } else {
    const warehouse = r.uuid(body.warehouse_id), reason = text(body.reason, "reason", 1000);
    await r.ref(c, actor, "warehouses", warehouse, "warehouse_id");
    if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 100) throw new AppError(422, "VALIDATION", "Select 1 to 100 products");
    const seen = new Set();
    const lines = body.lines.map(l => {
      const product = r.uuid(l.product_id);
      if (seen.has(product)) throw new AppError(422, "VALIDATION", "Repeated product");
      seen.add(product);
      return { product, counted: r.decimal(l.counted, "counted") };
    }).sort((a, b) => a.product.localeCompare(b.product));
    await c.query("INSERT INTO stocktakes(tenant_id,id,warehouse_id,reason,created_by) VALUES ($1,$2,$3,$4,$5)",
      [actor.tenantId, id, warehouse, reason, actor.userId]);
    for (const line of lines) {
      await r.ref(c, actor, "products", line.product, "product_id");
      const baseline = await inventory.lock(c, actor, warehouse, line.product);
      await c.query(`INSERT INTO stocktake_lines(tenant_id,stocktake_id,product_id,baseline_version,baseline_quantity,counted)
        VALUES ($1,$2,$3,$4,$5,$6)`, [actor.tenantId, id, line.product, baseline.version, baseline.on_hand, line.counted]);
    }
  }
  await audit(c, actor, `${type}.create`, type, id);
  return load(c, actor, type, id);
}
async function transferAction(c, actor, row, body) {
  let next, received = row.received, shipped = row.shipped;
  if (body.action === "ship") {
    state(row, ["draft"]);
    await inventory.move(c, actor, { warehouse: row.source_warehouse_id, product: row.product_id,
      onHand: new r.Decimal(row.quantity).negated().toFixed(6), kind: "transfer_out", sourceType: "transfer", sourceId: row.id });
    shipped = row.quantity; next = "in_transit";
  } else if (body.action === "receive") {
    state(row, ["in_transit", "partial"]);
    const qty = r.decimal(body.quantity, "quantity", { zero: false });
    const sum = new r.Decimal(received).plus(qty);
    if (sum.gt(shipped)) throw new AppError(409, "EXCESS_TRANSFER_RECEIPT", "Receipt exceeds in-transit stock");
    await inventory.move(c, actor, { warehouse: row.target_warehouse_id, product: row.product_id,
      onHand: qty, kind: "transfer_in", sourceType: "transfer", sourceId: row.id });
    received = sum.toFixed(6); next = sum.eq(shipped) ? "completed" : "partial";
  } else if (body.action === "cancel") { state(row, ["draft"]); next = "cancelled"; }
  else throw new AppError(422, "UNKNOWN_ACTION", "Unknown transfer action");
  await c.query("UPDATE transfers SET state=$3,shipped=$4,received=$5,version=version+1 WHERE tenant_id=$1 AND id=$2",
    [actor.tenantId, row.id, next, shipped, received]);
}
async function stocktakeAction(c, actor, row, body) {
  let next;
  if (body.action === "submit") { state(row, ["draft"]); next = "review"; }
  else if (body.action === "approve") {
    requireRole(actor);
    state(row, ["review"]);
    for (const line of row.lines) {
      const current = await inventory.lock(c, actor, row.warehouse_id, line.product_id);
      if (current.version !== line.baseline_version) throw new AppError(409, "STOCK_BASELINE_CHANGED", "Stock changed after counting; recount required");
      const delta = new r.Decimal(line.counted).minus(current.on_hand);
      if (!delta.isZero()) await inventory.move(c, actor, { warehouse: row.warehouse_id, product: line.product_id, onHand: delta.toFixed(6),
        kind: "stocktake", sourceType: "stocktake", sourceId: row.id });
    }
    next = "posted";
  } else if (body.action === "cancel") { state(row, ["draft", "review"]); next = "cancelled"; }
  else throw new AppError(422, "UNKNOWN_ACTION", "Unknown stocktake action");
  await c.query("UPDATE stocktakes SET state=$3,version=version+1 WHERE tenant_id=$1 AND id=$2", [actor.tenantId, row.id, next]);
}
async function handle(c, actor, type, id, operation, method, body) {
  if (!["transfers", "stocktakes"].includes(type)) return null;
  if (method === "GET") return { status: 200, body: id ? await load(c, actor, type, id) : {
    items: (await c.query(`SELECT *${type === "transfers" ? ",shipped-received AS in_transit" : ""} FROM ${type} WHERE tenant_id=$1 ORDER BY created_at DESC,id LIMIT 100`, [actor.tenantId])).rows,
  } };
  requireRole(actor, "warehouse");
  if (method === "POST" && !id) return { status: 201, body: await create(c, actor, type, body) };
  if (method !== "POST" || operation !== "actions") throw new AppError(405, "METHOD_NOT_ALLOWED", "Use an explicit action");
  const row = await load(c, actor, type, id, true);
  r.version(row, body.version);
  if (type === "transfers") await transferAction(c, actor, row, body);
  else await stocktakeAction(c, actor, row, body);
  await audit(c, actor, `${type}.${body.action}`, type, id, { version: row.version + 1 });
  return { status: 200, body: await load(c, actor, type, id) };
}
module.exports = { handle };
