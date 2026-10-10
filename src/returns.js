"use strict";
const { randomUUID } = require("node:crypto");
const { AppError, text } = require("./http");
const { requireRole } = require("./auth");
const { audit } = require("./db");
const r = require("./records");
const trade = require("./trade");
const inventory = require("./inventory");

async function execute(c, actor, doc, body, release = false) {
  requireRole(actor, "warehouse");
  const reason = text(body.reason, "reason", 1000);
  if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 100) {
    throw new AppError(422, "VALIDATION", "Select the original movement lines");
  }
  const expected = release ? "sales_return" : doc.kind === "order" ? "ship" : "receive";
  const kind = release ? "inspection_release" : doc.kind === "order" ? "sales_return" : "purchase_return";
  const seen = new Set(), entries = [];
  for (const raw of body.lines) {
    const sourceId = r.uuid(raw.source_line_id, "source_line_id");
    if (seen.has(sourceId)) throw new AppError(422, "INVALID_LINE", "Repeated source line");
    seen.add(sourceId);
    const source = (await c.query(`SELECT l.*,d.product_id FROM fulfilment_lines l
      JOIN fulfilments f ON f.tenant_id=l.tenant_id AND f.id=l.fulfilment_id
      JOIN trade_lines d ON d.tenant_id=l.tenant_id AND d.id=l.line_id
      WHERE l.tenant_id=$1 AND l.id=$2 AND f.document_id=$3 AND f.kind=$4`,
    [actor.tenantId, sourceId, doc.id, expected])).rows[0];
    if (!source) throw new AppError(422, "INVALID_REFERENCE", "Movement does not belong to this document");
    const used = (await c.query(`SELECT COALESCE(sum(l.quantity),0) AS quantity FROM fulfilment_lines l
      JOIN fulfilments f ON f.tenant_id=l.tenant_id AND f.id=l.fulfilment_id
      WHERE l.tenant_id=$1 AND l.source_line_id=$2 AND f.kind=$3`, [actor.tenantId, sourceId, kind])).rows[0].quantity;
    const quantity = r.decimal(raw.quantity, "quantity", { zero: false });
    if (new r.Decimal(used).plus(quantity).gt(source.quantity)) throw new AppError(409, "EXCESS_RETURN", "Quantity exceeds the remaining original movement");
    entries.push({ source, quantity });
  }
  entries.sort((a, b) => a.source.product_id.localeCompare(b.source.product_id) || a.source.id.localeCompare(b.source.id));
  const fulfilmentId = randomUUID();
  await c.query("INSERT INTO fulfilments(tenant_id,id,document_id,kind,created_by) VALUES ($1,$2,$3,$4,$5)",
    [actor.tenantId, fulfilmentId, doc.id, kind, actor.userId]);
  for (const { source, quantity } of entries) {
    const eventId = randomUUID(), negative = new r.Decimal(quantity).negated().toFixed(6);
    await c.query(`INSERT INTO fulfilment_lines(tenant_id,id,fulfilment_id,line_id,quantity,source_line_id)
      VALUES ($1,$2,$3,$4,$5,$6)`, [actor.tenantId, eventId, fulfilmentId, source.line_id, quantity, source.id]);
    await inventory.move(c, actor, {
      warehouse: doc.warehouse_id, product: source.product_id, kind, sourceType: "fulfilment_line", sourceId: eventId,
      onHand: release ? "0" : doc.kind === "order" ? quantity : negative,
      frozen: release ? negative : doc.kind === "order" ? quantity : "0",
    });
  }
  await audit(c, actor, kind, doc.kind, doc.id, { reason, fulfilmentId });
  return { ...await trade.bump(c, actor, doc.kind, doc.id, doc.state, `${doc.kind}.${kind}`), fulfilment_id: fulfilmentId };
}
module.exports = { execute };
