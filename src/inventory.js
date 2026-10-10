"use strict";
const { randomUUID } = require("node:crypto");
const { AppError } = require("./http");
const { requireRole } = require("./auth");
const { audit } = require("./db");
const r = require("./records");

async function lock(c, actor, warehouse, product) {
  await c.query(`INSERT INTO stock_balances(tenant_id,warehouse_id,product_id) VALUES ($1,$2,$3)
    ON CONFLICT DO NOTHING`, [actor.tenantId, warehouse, product]);
  return (await c.query(`SELECT *,on_hand-reserved-frozen AS available FROM stock_balances
    WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3 FOR UPDATE`, [actor.tenantId, warehouse, product])).rows[0];
}
async function move(c, actor, { warehouse, product, onHand = "0", reserved = "0", frozen = "0", kind, sourceType, sourceId }) {
  const prior = await lock(c, actor, warehouse, product);
  const next = {
    onHand: new r.Decimal(prior.on_hand).plus(onHand),
    reserved: new r.Decimal(prior.reserved).plus(reserved),
    frozen: new r.Decimal(prior.frozen).plus(frozen),
  };
  if (next.onHand.lt(0) || next.reserved.lt(0) || next.frozen.lt(0) || next.onHand.lt(next.reserved.plus(next.frozen))) {
    throw new AppError(409, "INSUFFICIENT_STOCK", "Not enough available stock");
  }
  await c.query(`UPDATE stock_balances SET on_hand=$4,reserved=$5,frozen=$6,version=version+1
    WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3`,
  [actor.tenantId, warehouse, product, next.onHand.toFixed(6), next.reserved.toFixed(6), next.frozen.toFixed(6)]);
  const id = randomUUID();
  await c.query(`INSERT INTO stock_movements(tenant_id,id,warehouse_id,product_id,kind,delta_on_hand,delta_reserved,delta_frozen,source_type,source_id,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [actor.tenantId, id, warehouse, product, kind, onHand, reserved, frozen, sourceType, sourceId, actor.userId]);
  return id;
}
async function reserveOrder(c, actor, order) {
  for (const line of [...order.lines].sort((a, b) => a.product_id.localeCompare(b.product_id) || a.id.localeCompare(b.id))) {
    const stock = await lock(c, actor, order.warehouse_id, line.product_id);
    const remaining = new r.Decimal(line.quantity).minus(line.shipped).minus(line.cancelled).minus(line.reserved);
    const quantity = r.Decimal.min(stock.available, remaining);
    if (quantity.gt(0)) {
      await move(c, actor, { warehouse: order.warehouse_id, product: line.product_id, reserved: quantity.toFixed(6),
        kind: "reserve", sourceType: "order_line", sourceId: line.id });
      await c.query("UPDATE trade_lines SET reserved=reserved+$3 WHERE tenant_id=$1 AND id=$2", [actor.tenantId, line.id, quantity.toFixed(6)]);
    }
  }
}
async function releaseOrder(c, actor, order) {
  for (const line of [...order.lines].sort((a, b) => a.product_id.localeCompare(b.product_id) || a.id.localeCompare(b.id))) {
    if (new r.Decimal(line.reserved).gt(0)) {
      await move(c, actor, { warehouse: order.warehouse_id, product: line.product_id, reserved: new r.Decimal(line.reserved).negated().toFixed(6),
        kind: "release", sourceType: "order_line", sourceId: line.id });
    }
    await c.query("UPDATE trade_lines SET reserved=0,cancelled=quantity-shipped WHERE tenant_id=$1 AND id=$2", [actor.tenantId, line.id]);
  }
}
async function handle(c, actor, operation, method, body) {
  if (method === "GET") {
    if (operation === "balances") return { status: 200, body: { items: (await c.query(`SELECT b.*,b.on_hand-b.reserved-b.frozen AS available,
      p.name AS product_name,p.code AS product_code,p.unit,w.name AS warehouse_name FROM stock_balances b
      JOIN products p ON p.tenant_id=b.tenant_id AND p.id=b.product_id
      JOIN warehouses w ON w.tenant_id=b.tenant_id AND w.id=b.warehouse_id
      WHERE b.tenant_id=$1 ORDER BY w.code,p.code LIMIT 1000`, [actor.tenantId])).rows } };
    if (operation === "movements") return { status: 200, body: { items: (await c.query(`SELECT m.*,p.name AS product_name,w.name AS warehouse_name
      FROM stock_movements m JOIN products p ON p.tenant_id=m.tenant_id AND p.id=m.product_id
      JOIN warehouses w ON w.tenant_id=m.tenant_id AND w.id=m.warehouse_id
      WHERE m.tenant_id=$1 ORDER BY m.created_at DESC,m.id DESC LIMIT 200`, [actor.tenantId])).rows } };
    if (operation === "reconcile") {
      requireRole(actor, "auditor", "warehouse");
      const differences = (await c.query(`WITH totals AS (
        SELECT tenant_id,warehouse_id,product_id,sum(delta_on_hand) AS on_hand,sum(delta_reserved) AS reserved,sum(delta_frozen) AS frozen
        FROM stock_movements WHERE tenant_id=$1 GROUP BY tenant_id,warehouse_id,product_id)
        SELECT b.warehouse_id,b.product_id,b.on_hand,b.reserved,b.frozen,t.on_hand AS rebuilt_on_hand,t.reserved AS rebuilt_reserved,t.frozen AS rebuilt_frozen
        FROM stock_balances b LEFT JOIN totals t USING(tenant_id,warehouse_id,product_id) WHERE b.tenant_id=$1
        AND (b.on_hand<>COALESCE(t.on_hand,0) OR b.reserved<>COALESCE(t.reserved,0) OR b.frozen<>COALESCE(t.frozen,0))`, [actor.tenantId])).rows;
      return { status: 200, body: { consistent: differences.length === 0, differences } };
    }
  }
  if (method === "POST" && operation === "opening") {
    requireRole(actor, "warehouse");
    const warehouse = r.uuid(body.warehouse_id, "warehouse_id"), product = r.uuid(body.product_id, "product_id");
    await r.ref(c, actor, "warehouses", warehouse, "warehouse_id");
    await r.ref(c, actor, "products", product, "product_id");
    const quantity = r.decimal(body.quantity, "quantity", { zero: false });
    await lock(c, actor, warehouse, product);
    const used = (await c.query("SELECT 1 FROM stock_movements WHERE tenant_id=$1 AND warehouse_id=$2 AND product_id=$3 LIMIT 1",
      [actor.tenantId, warehouse, product])).rowCount;
    if (used) throw new AppError(409, "OPENING_ALREADY_POSTED", "Use a stocktake adjustment after activity has started");
    const sourceId = randomUUID();
    await move(c, actor, { warehouse, product, onHand: quantity, kind: "opening", sourceType: "opening", sourceId });
    await audit(c, actor, "inventory.opening", "opening", sourceId, { warehouse, product, quantity });
    return { status: 201, body: await lock(c, actor, warehouse, product) };
  }
  throw new AppError(404, "NOT_FOUND", "Inventory operation not found");
}
module.exports = { lock, move, reserveOrder, releaseOrder, handle };
