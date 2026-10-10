"use strict";
const { randomUUID } = require("node:crypto");
const { AppError } = require("./http");
const { requireRole } = require("./auth");
const r = require("./records");
const trade = require("./trade");
const inventory = require("./inventory");

function quantities(doc, body) {
  if (!Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > doc.lines.length) {
    throw new AppError(422, "VALIDATION", "Select valid document lines");
  }
  const seen = new Set();
  return body.lines.map(raw => {
    const line = doc.lines.find(l => l.id === raw.line_id);
    if (!line || seen.has(raw.line_id)) throw new AppError(422, "INVALID_LINE", "Invalid or repeated line");
    seen.add(raw.line_id);
    return { line, quantity: r.decimal(raw.quantity, "quantity", { zero: false }) };
  }).sort((a, b) => a.line.product_id.localeCompare(b.line.product_id) || a.line.id.localeCompare(b.line.id));
}

async function procure(c, actor, order, body) {
  requireRole(actor, "purchasing");
  trade.state(order, ["confirmed", "partial"]);
  const shortage = order.lines.filter(l => new r.Decimal(l.shortage).gt(0));
  if (!shortage.length) throw new AppError(409, "NO_SHORTAGE", "No unplanned shortage remains");
  const supplierId = r.uuid(body.supplier_id, "supplier_id");
  const currency = r.currency(body.currency);
  if (!Array.isArray(body.prices) || body.prices.length !== shortage.length) {
    throw new AppError(422, "SUPPLIER_PRICES_REQUIRED", "Provide a supplier price for every shortage line");
  }
  const prices = new Map();
  for (const entry of body.prices) {
    const id = r.uuid(entry?.order_line_id, "order_line_id");
    if (!shortage.some(l => l.id === id) || prices.has(id)) throw new AppError(422, "INVALID_LINE", "Invalid or repeated supplier price line");
    prices.set(id, r.decimal(entry.price, "supplier_price"));
  }
  const p = await trade.create(c, actor, "purchase", {
    partner_id: supplierId, warehouse_id: order.warehouse_id, currency,
    due_date: order.due_date, note: `Demand: ${order.number}`,
    lines: shortage.map(l => ({ product_id: l.product_id, quantity: l.shortage, price: prices.get(l.id) })),
  }, { sourceId: order.id, lineSnapshots: shortage });
  for (let i = 0; i < shortage.length; i++) {
    await c.query(`INSERT INTO procurement_allocations(tenant_id,purchase_line_id,order_line_id,quantity)
      VALUES ($1,$2,$3,$4)`, [actor.tenantId, p.lines[i].id, shortage[i].id, shortage[i].shortage]);
  }
  return p;
}

async function receive(c, actor, purchase, body) {
  requireRole(actor, "purchasing", "warehouse");
  trade.state(purchase, ["confirmed", "partial"]);
  const entries = quantities(purchase, body);
  const allocations = (await c.query(`SELECT a.*,l.document_id FROM procurement_allocations a
    JOIN trade_lines l ON l.tenant_id=a.tenant_id AND l.id=a.order_line_id
    WHERE a.tenant_id=$1 AND a.purchase_line_id=ANY($2::uuid[]) ORDER BY l.document_id,a.order_line_id`,
  [actor.tenantId, entries.map(e => e.line.id)])).rows;
  const orderIds = [...new Set(allocations.map(a => a.document_id))].sort();
  const orders = new Map();
  // Always lock the affected sales documents before taking any stock locks.
  for (const id of orderIds) orders.set(id, await trade.load(c, actor, "order", id, true));
  const fulfilmentId = randomUUID();
  await c.query("INSERT INTO fulfilments(tenant_id,id,document_id,kind,created_by) VALUES ($1,$2,$3,'receive',$4)",
    [actor.tenantId, fulfilmentId, purchase.id, actor.userId]);
  for (const { line, quantity } of entries) {
    if (new r.Decimal(line.received).plus(line.cancelled).plus(quantity).gt(line.quantity)) {
      throw new AppError(409, "OVER_RECEIPT", "Receipt exceeds remaining quantity");
    }
    const eventLine = randomUUID();
    await c.query("INSERT INTO fulfilment_lines(tenant_id,id,fulfilment_id,line_id,quantity) VALUES ($1,$2,$3,$4,$5)",
      [actor.tenantId, eventLine, fulfilmentId, line.id, quantity]);
    await inventory.move(c, actor, { warehouse: purchase.warehouse_id, product: line.product_id,
      onHand: quantity, kind: "receive", sourceType: "fulfilment_line", sourceId: eventLine });
    await c.query("UPDATE trade_lines SET received=received+$3 WHERE tenant_id=$1 AND id=$2", [actor.tenantId, line.id, quantity]);
    let remaining = new r.Decimal(quantity);
    for (const allocation of allocations.filter(a => a.purchase_line_id === line.id)) {
      const received = r.Decimal.min(remaining, new r.Decimal(allocation.quantity).minus(allocation.received));
      if (received.lte(0)) continue;
      const order = orders.get(allocation.document_id);
      const orderLine = (await c.query("SELECT * FROM trade_lines WHERE tenant_id=$1 AND id=$2",
        [actor.tenantId, allocation.order_line_id])).rows[0];
      const need = new r.Decimal(orderLine.quantity).minus(orderLine.shipped).minus(orderLine.cancelled).minus(orderLine.reserved);
      const reserved = ["confirmed", "partial"].includes(order.state) ? r.Decimal.min(received, need) : new r.Decimal(0);
      if (reserved.gt(0)) {
        await inventory.move(c, actor, { warehouse: purchase.warehouse_id, product: line.product_id, reserved: reserved.toFixed(6),
          kind: "reserve_receipt", sourceType: "order_line", sourceId: orderLine.id });
        await c.query("UPDATE trade_lines SET reserved=reserved+$3 WHERE tenant_id=$1 AND id=$2", [actor.tenantId, orderLine.id, reserved.toFixed(6)]);
      }
      await c.query(`UPDATE procurement_allocations SET received=received+$4
        WHERE tenant_id=$1 AND purchase_line_id=$2 AND order_line_id=$3`,
      [actor.tenantId, line.id, orderLine.id, received.toFixed(6)]);
      remaining = remaining.minus(received);
    }
  }
  for (const id of orderIds) await trade.bump(c, actor, "order", id, orders.get(id).state, "order.receipt_allocation");
  const latest = await trade.load(c, actor, "purchase", purchase.id);
  const done = latest.lines.every(l => new r.Decimal(l.received).plus(l.cancelled).eq(l.quantity));
  return { ...await trade.bump(c, actor, "purchase", purchase.id, done ? "fulfilled" : "partial", "purchase.receive"), fulfilment_id: fulfilmentId };
}

async function ship(c, actor, order, body) {
  requireRole(actor, "warehouse");
  trade.state(order, ["confirmed", "partial"]);
  const entries = quantities(order, body);
  const fulfilmentId = randomUUID();
  await c.query("INSERT INTO fulfilments(tenant_id,id,document_id,kind,created_by) VALUES ($1,$2,$3,'ship',$4)",
    [actor.tenantId, fulfilmentId, order.id, actor.userId]);
  for (const { line, quantity } of entries) {
    if (new r.Decimal(quantity).gt(line.reserved) || new r.Decimal(line.shipped).plus(line.cancelled).plus(quantity).gt(line.quantity)) {
      throw new AppError(409, "OVER_SHIPMENT", "Shipment exceeds reserved or unfulfilled quantity");
    }
    const eventLine = randomUUID(), negative = new r.Decimal(quantity).negated().toFixed(6);
    await c.query("INSERT INTO fulfilment_lines(tenant_id,id,fulfilment_id,line_id,quantity) VALUES ($1,$2,$3,$4,$5)",
      [actor.tenantId, eventLine, fulfilmentId, line.id, quantity]);
    await inventory.move(c, actor, { warehouse: order.warehouse_id, product: line.product_id, onHand: negative, reserved: negative,
      kind: "ship", sourceType: "fulfilment_line", sourceId: eventLine });
    await c.query("UPDATE trade_lines SET shipped=shipped+$3,reserved=reserved-$3 WHERE tenant_id=$1 AND id=$2", [actor.tenantId, line.id, quantity]);
  }
  const latest = await trade.load(c, actor, "order", order.id);
  const done = latest.lines.every(l => new r.Decimal(l.shipped).plus(l.cancelled).eq(l.quantity));
  const shipped = await trade.bump(c, actor, "order", order.id, done ? "fulfilled" : "partial", "order.ship");
  await require("./documents").captureShipment(c, actor, shipped, fulfilmentId, entries);
  return { ...shipped, fulfilment_id: fulfilmentId };
}
module.exports = { procure, receive, ship, quantities };
