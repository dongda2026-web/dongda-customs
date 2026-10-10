"use strict";
const { randomUUID } = require("node:crypto");
const { AppError, text } = require("./http");
const r = require("./records");
const trade = require("./trade");
const inventory = require("./inventory");

async function revise(c, actor, doc, body) {
  trade.state(doc, doc.kind === "quote" ? ["draft", "sent"] : ["draft", "review", "confirmed", "partial"]);
  const merged = { ...doc, ...body };
  const currency = r.currency(merged.currency);
  const warehouse = r.uuid(merged.warehouse_id, "warehouse_id", doc.kind === "quote");
  const partner = await r.ref(c, actor, "partners", r.uuid(merged.partner_id), "partner_id");
  if (![doc.kind === "purchase" ? "supplier" : "customer", "both"].includes(partner.kind)) throw new AppError(422, "PARTNER_ROLE", "Invalid partner role");
  if ((doc.lead_id || doc.source_id) && partner.id !== doc.partner_id) {
    throw new AppError(409, "LEAD_PARTNER_MISMATCH", "A source-linked document must retain its original customer");
  }
  await r.ref(c, actor, "warehouses", warehouse, "warehouse_id");
  const supplied = (await c.query(`SELECT count(*) FROM procurement_allocations WHERE tenant_id=$1
    AND (purchase_line_id=ANY($2::uuid[]) OR order_line_id=ANY($2::uuid[]))`, [actor.tenantId, doc.lines.map(l => l.id)])).rows[0].count !== "0";
  const hasHistory = doc.lines.some(l => new r.Decimal(l.shipped).gt(0) || new r.Decimal(l.received).gt(0));
  if ((hasHistory || supplied) && (warehouse !== doc.warehouse_id || currency !== doc.currency || partner.id !== doc.partner_id)) {
    throw new AppError(409, "COMMITTED_DOCUMENT", "Cannot change parties, currency or warehouse after fulfilment commitments");
  }
  if (!Array.isArray(merged.lines) || merged.lines.length < 1 || merged.lines.length > 100) throw new AppError(422, "VALIDATION", "Provide 1 to 100 lines");
  const lines = [], seen = new Set();
  for (let i = 0; i < merged.lines.length; i++) {
    const raw = merged.lines[i];
    const prior = raw.id ? doc.lines.find(l => l.id === raw.id) : null;
    if ((raw.id && !prior) || (raw.id && seen.has(raw.id))) throw new AppError(422, "INVALID_LINE", "Invalid or repeated document line");
    if (prior) seen.add(prior.id);
    const product = await r.ref(c, actor, "products", r.uuid(raw.product_id), "product_id");
    const quantity = r.decimal(raw.quantity, "quantity", { zero: false }), price = r.decimal(raw.price, "price");
    if (prior) {
      const allocations = (await c.query(`SELECT COALESCE(sum(quantity),0) AS quantity FROM procurement_allocations
        WHERE tenant_id=$1 AND purchase_line_id=$2`, [actor.tenantId, prior.id])).rows[0].quantity;
      const min = r.Decimal.max(new r.Decimal(prior.shipped).plus(prior.cancelled).plus(prior.incoming), new r.Decimal(prior.received).plus(prior.cancelled), allocations);
      if (new r.Decimal(quantity).lt(min)) throw new AppError(409, "BELOW_COMMITTED_QUANTITY", "Quantity cannot be below fulfilled or committed quantity");
      if (product.id !== prior.product_id && (min.gt(0) || new r.Decimal(prior.reserved).gt(0))) {
        throw new AppError(409, "COMMITTED_LINE", "Cannot replace a committed product");
      }
    }
    lines.push({ id: prior?.id || randomUUID(), prior, position: i + 1, product_id: product.id, quantity, price,
      name: prior?.product_id === product.id ? prior.name : product.name,
      unit: prior?.product_id === product.id ? prior.unit : product.unit,
      amount: trade.money(new r.Decimal(quantity).times(price), currency) });
  }
  const removed = doc.lines.filter(l => !seen.has(l.id));
  for (const line of removed) {
    const referenced = (await c.query(`SELECT 1 FROM procurement_allocations WHERE tenant_id=$1
      AND (purchase_line_id=$2 OR order_line_id=$2) LIMIT 1`, [actor.tenantId, line.id])).rowCount;
    if (referenced || new r.Decimal(line.shipped).gt(0) || new r.Decimal(line.received).gt(0) || new r.Decimal(line.reserved).gt(0)) {
      throw new AppError(409, "COMMITTED_LINE", "Cannot remove a committed line; cancel remaining demand explicitly");
    }
  }
  if (doc.kind === "order") {
    for (const line of [...doc.lines].sort((a, b) => a.product_id.localeCompare(b.product_id) || a.id.localeCompare(b.id))) {
      if (new r.Decimal(line.reserved).gt(0)) await inventory.move(c, actor, { warehouse: doc.warehouse_id, product: line.product_id,
        reserved: new r.Decimal(line.reserved).negated().toFixed(6), kind: "revision_release", sourceType: "order_line", sourceId: line.id });
    }
  }
  await c.query("UPDATE trade_lines SET position=-position,reserved=0 WHERE tenant_id=$1 AND document_id=$2", [actor.tenantId, doc.id]);
  if (removed.length) await c.query("DELETE FROM trade_lines WHERE tenant_id=$1 AND id=ANY($2::uuid[])", [actor.tenantId, removed.map(l => l.id)]);
  for (const l of lines) {
    if (l.prior) {
      await c.query(`UPDATE trade_lines SET product_id=$3,position=$4,name=$5,unit=$6,quantity=$7,price=$8,amount=$9
        WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, l.id, l.product_id, l.position, l.name, l.unit, l.quantity, l.price, l.amount]);
    } else await c.query(`INSERT INTO trade_lines(tenant_id,id,document_id,product_id,position,name,unit,quantity,price,amount)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [actor.tenantId, l.id, doc.id, l.product_id, l.position, l.name, l.unit, l.quantity, l.price, l.amount]);
  }
  const total = trade.money(lines.reduce((sum, l) => sum.plus(l.amount), new r.Decimal(0)), currency);
  await c.query(`UPDATE trade_documents SET partner_id=$3,warehouse_id=$4,currency=$5,total=$6,due_date=$7,valid_until=$8,terms=$9,note=$10
    WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, doc.id, partner.id, warehouse, currency, total,
    trade.date(merged.due_date, "due_date", true), trade.date(merged.valid_until, "valid_until", doc.kind !== "quote"),
    text(merged.terms || "", "terms", 2000, false), text(merged.note || "", "note", 5000, false)]);
  return trade.bump(c, actor, doc.kind, doc.id, doc.kind === "quote" || doc.state === "draft" ? "draft" : "review", `${doc.kind}.revise`);
}
module.exports = { revise };
