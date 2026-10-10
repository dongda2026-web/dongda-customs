"use strict";
const { randomUUID } = require("node:crypto");
const { AppError, text } = require("./http");
const { audit } = require("./db");
const r = require("./records");
const kinds = { quotes: "quote", orders: "order", purchases: "purchase" };
const money = (n, currency) => new r.Decimal(n).toFixed(currency === "JPY" ? 0 : currency === "KWD" ? 3 : 2);
function date(value, field, optional = false) {
  if (optional && !value) return null;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d$/.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new AppError(422, "VALIDATION", `Invalid ${field}`);
  }
  return value;
}
function state(row, allowed) {
  if (!allowed.includes(row.state)) throw new AppError(409, "INVALID_STATE", "Action not allowed in current state");
}
async function load(c, actor, kind, id, lock = false) {
  r.uuid(id);
  const d = (await c.query(`SELECT * FROM trade_documents WHERE tenant_id=$1 AND id=$2 AND kind=$3${lock ? " FOR UPDATE" : ""}`,
    [actor.tenantId, id, kind])).rows[0];
  if (!d) throw new AppError(404, "NOT_FOUND", "Document not found");
  d.total = money(d.total, d.currency);
  d.due_date = d.due_date ? new Date(d.due_date).toISOString().slice(0, 10) : null;
  d.valid_until = d.valid_until ? new Date(d.valid_until).toISOString().slice(0, 10) : null;
  d.lines = (await c.query(`SELECT l.*,
    (SELECT COALESCE(sum(a.quantity-a.received),0) FROM procurement_allocations a
      JOIN trade_lines pl ON pl.tenant_id=a.tenant_id AND pl.id=a.purchase_line_id
      JOIN trade_documents pd ON pd.tenant_id=pl.tenant_id AND pd.id=pl.document_id
      WHERE a.tenant_id=l.tenant_id AND a.order_line_id=l.id AND pd.state<>'cancelled') AS incoming
    FROM trade_lines l WHERE l.tenant_id=$1 AND l.document_id=$2 ORDER BY l.position`,
  [actor.tenantId, id])).rows.map(l => ({
    ...l, amount: money(l.amount, d.currency),
    shortage: r.Decimal.max(0, new r.Decimal(l.quantity).minus(l.shipped).minus(l.cancelled).minus(l.reserved).minus(l.incoming)).toFixed(6),
  }));
  return d;
}
async function snapshot(c, actor, doc) {
  await c.query("INSERT INTO trade_versions(tenant_id,document_id,version,snapshot) VALUES ($1,$2,$3,$4)",
    [actor.tenantId, doc.id, doc.version, doc]);
}
async function bump(c, actor, kind, id, nextState, action) {
  await c.query("UPDATE trade_documents SET state=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2", [actor.tenantId, id, nextState]);
  const doc = await load(c, actor, kind, id);
  await snapshot(c, actor, doc);
  await audit(c, actor, action, kind, id, { state: nextState, version: doc.version });
  await require("./finance").enqueue(c, actor, doc, action);
  return doc;
}
async function create(c, actor, kind, body, { sourceId = null, lineSnapshots } = {}) {
  const partnerId = r.uuid(body.partner_id, "partner_id");
  const partner = await r.ref(c, actor, "partners", partnerId, "partner_id");
  if (![kind === "purchase" ? "supplier" : "customer", "both"].includes(partner.kind)) {
    throw new AppError(422, "PARTNER_ROLE", "Partner does not have the required business role");
  }
  const warehouseId = r.uuid(body.warehouse_id, "warehouse_id", kind === "quote");
  await r.ref(c, actor, "warehouses", warehouseId, "warehouse_id");
  const currency = r.currency(body.currency);
  const dueDate = date(body.due_date, "due_date", true);
  const validUntil = date(body.valid_until, "valid_until", kind !== "quote");
  const leadId = r.uuid(body.lead_id, "lead_id", true);
  if (leadId) {
    const lead = await r.get(c, actor, "leads", leadId, true);
    if (kind === "purchase" || lead.partner_id !== partnerId) {
      throw new AppError(409, "LEAD_PARTNER_MISMATCH", "Bind the lead to this customer before creating a sales document");
    }
  }
  if (!Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > 100) {
    throw new AppError(422, "VALIDATION", "Provide 1 to 100 document lines");
  }
  const lines = [];
  for (let i = 0; i < body.lines.length; i++) {
    const raw = body.lines[i];
    const product = await r.ref(c, actor, "products", r.uuid(raw.product_id, "product_id"), "product_id");
    const quantity = r.decimal(raw.quantity, "quantity", { zero: false });
    const price = r.decimal(raw.price, "price");
    lines.push({ id: randomUUID(), position: i + 1, product_id: product.id, name: lineSnapshots?.[i]?.name || product.name,
      unit: lineSnapshots?.[i]?.unit || product.unit, quantity, price, amount: money(new r.Decimal(quantity).times(price), currency) });
  }
  const total = money(lines.reduce((sum, l) => sum.plus(l.amount), new r.Decimal(0)), currency);
  const counter = (await c.query(`INSERT INTO document_counters(tenant_id,kind,value) VALUES ($1,$2,1)
    ON CONFLICT(tenant_id,kind) DO UPDATE SET value=document_counters.value+1 RETURNING value`, [actor.tenantId, kind])).rows[0].value;
  const id = randomUUID(), number = `${{ quote: "QT", order: "SO", purchase: "PO" }[kind]}-${String(counter).padStart(6, "0")}`;
  await c.query(`INSERT INTO trade_documents(tenant_id,id,kind,number,partner_id,warehouse_id,currency,due_date,valid_until,terms,note,source_id,lead_id,total,created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
  [actor.tenantId, id, kind, number, partnerId, warehouseId, currency, dueDate, validUntil,
    text(body.terms || "", "terms", 2000, false), text(body.note || "", "note", 5000, false), sourceId, leadId, total, actor.userId]);
  for (const l of lines) {
    await c.query(`INSERT INTO trade_lines(tenant_id,id,document_id,product_id,position,name,unit,quantity,price,amount)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [actor.tenantId, l.id, id, l.product_id, l.position, l.name, l.unit, l.quantity, l.price, l.amount]);
  }
  const doc = await load(c, actor, kind, id);
  await snapshot(c, actor, doc);
  await audit(c, actor, `${kind}.create`, kind, id, { number, version: 1 });
  return doc;
}
async function list(c, actor, kind, query) {
  const page = Number(query.get("page") || 1), pageSize = Number(query.get("pageSize") || 30);
  if (!Number.isInteger(page) || page < 1 || page > 100000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new AppError(422, "VALIDATION", "Invalid pagination");
  }
  const search = String(query.get("search") || "").slice(0, 200);
  const params = [actor.tenantId, kind, `%${search}%`, query.get("state") || null];
  const where = "d.tenant_id=$1 AND d.kind=$2 AND (d.number ILIKE $3 OR p.name ILIKE $3) AND ($4::text IS NULL OR d.state=$4)";
  const from = "trade_documents d JOIN partners p ON p.tenant_id=d.tenant_id AND p.id=d.partner_id";
  const total = Number((await c.query(`SELECT count(*) FROM ${from} WHERE ${where}`, params)).rows[0].count);
  const rows = (await c.query(`SELECT d.*,p.name AS partner_name FROM ${from} WHERE ${where}
    ORDER BY d.created_at DESC,d.id LIMIT $5 OFFSET $6`, [...params, pageSize, (page - 1) * pageSize])).rows;
  return { items: rows.map(d => ({ ...d, total: money(d.total, d.currency) })), total, page, pageSize };
}
module.exports = { kinds, money, date, state, load, create, bump, snapshot, list };
