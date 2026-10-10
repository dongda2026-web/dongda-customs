"use strict";
const { randomUUID, createHash } = require("node:crypto");
const { AppError, text } = require("./http");
const { requireRole } = require("./auth");
const { audit } = require("./db");
const r = require("./records");
const trade = require("./trade");
const { render } = require("./document-renderer");
const hash = value => createHash("sha256").update(value).digest("hex");
const templateVersion = "TRADE-DOC-1";
const approvedStates = ["confirmed", "partial", "fulfilled", "completed"];
function fingerprint(doc) {
  return hash(JSON.stringify([doc.partner_id, doc.warehouse_id, doc.currency, doc.terms, doc.due_date,
    doc.lines.map(l => [l.id, l.product_id, l.name, l.unit, l.quantity, l.price])]));
}
function lineProjection(line, currency, quantity = line.quantity) {
  return { id: line.id, product_id: line.product_id, name: line.name, unit: line.unit, quantity,
    price: line.price, amount: trade.money(new r.Decimal(quantity).times(line.price), currency) };
}
async function captureShipment(c, actor, doc, fulfilmentId, entries) {
  const snapshot = { source: { document_id: doc.id, number: doc.number, version: doc.version, fulfilment_id: fulfilmentId },
    fingerprint: fingerprint(doc), currency: doc.currency, terms: doc.terms, partner_id: doc.partner_id,
    lines: doc.lines.filter(l => entries.some(e => e.line.id === l.id)).map(l =>
      lineProjection(l, doc.currency, entries.find(e => e.line.id === l.id).quantity)) };
  await c.query(`INSERT INTO shipment_document_sources(tenant_id,fulfilment_id,document_id,document_version,snapshot)
    VALUES($1,$2,$3,$4,$5)`, [actor.tenantId, fulfilmentId, doc.id, doc.version, snapshot]);
}
function permission(actor, kind, write = false) {
  requireRole(actor, ...(kind === "purchase_order" ? ["purchasing"] : ["sales"]), ...(write ? [] : ["auditor"]));
}
async function sourceDocument(c, actor, id) {
  const row = (await c.query("SELECT kind FROM trade_documents WHERE tenant_id=$1 AND id=$2", [actor.tenantId, r.uuid(id)])).rows[0];
  if (!row) throw new AppError(404, "NOT_FOUND", "Document not found");
  return trade.load(c, actor, row.kind, id, true);
}
async function hasShipmentReturns(c, actor, fulfilmentId) {
  if (!fulfilmentId) return false;
  return (await c.query(`SELECT 1 FROM fulfilment_lines returned
    JOIN fulfilment_lines original ON original.tenant_id=returned.tenant_id AND original.id=returned.source_line_id
    JOIN fulfilments f ON f.tenant_id=returned.tenant_id AND f.id=returned.fulfilment_id
    WHERE returned.tenant_id=$1 AND original.fulfilment_id=$2 AND f.kind='sales_return' LIMIT 1`,
  [actor.tenantId, fulfilmentId])).rowCount > 0;
}
async function create(c, actor, body) {
  const kind = r.choice(body.kind, "kind", ["invoice", "packing_list", "purchase_order"]);
  permission(actor, kind, true);
  const doc = await sourceDocument(c, actor, body.document_id);
  r.version(doc, body.version);
  if (!approvedStates.includes(doc.state)) throw new AppError(409, "SOURCE_NOT_APPROVED", "Approve the source before issuing a document");
  if (body.confirmed !== true) throw new AppError(422, "CONFIRM_REQUIRED", "Confirm document particulars before issuing");
  const issueDate = trade.date(body.issue_date, "issue_date");
  const language = r.choice(body.language, "language", ["zh", "en", "ru"]);
  let source;
  if (kind === "purchase_order") {
    if (doc.kind !== "purchase" || body.fulfilment_id) throw new AppError(422, "INVALID_SOURCE", "Purchase order requires a purchase without a shipment");
    source = { source: { document_id: doc.id, number: doc.number, version: doc.version, fulfilment_id: null },
      fingerprint: fingerprint(doc), lines: doc.lines.map(l => lineProjection(l, doc.currency)), currency: doc.currency, terms: doc.terms };
  } else {
    if (doc.kind !== "order") throw new AppError(422, "INVALID_SOURCE", "Shipment documents require a sales order");
    source = (await c.query(`SELECT snapshot FROM shipment_document_sources WHERE tenant_id=$1 AND fulfilment_id=$2 AND document_id=$3`,
      [actor.tenantId, r.uuid(body.fulfilment_id), doc.id])).rows[0]?.snapshot;
    if (!source) throw new AppError(404, "SHIPMENT_SNAPSHOT_MISSING", "No frozen source exists for this shipment; do not reconstruct it from current prices");
    if (await hasShipmentReturns(c, actor, body.fulfilment_id)) throw new AppError(409, "SHIPMENT_RETURNED", "This shipment has returns; reconcile before issuing replacement documents");
    if (source.fingerprint !== fingerprint(doc)) throw new AppError(409, "SOURCE_CHANGED", "Order particulars changed since shipment; review the historical batch");
  }
  const settings = (await c.query("SELECT data,version FROM tenant_settings WHERE tenant_id=$1 FOR SHARE", [actor.tenantId])).rows[0];
  const partner = await r.get(c, actor, "partners", doc.partner_id, true);
  const company = { name: text(settings?.data.name, "company_name"), address: text(settings?.data.address, "company_address", 1000) };
  const counterparty = { name: text(partner.name, "partner_name"), address: text(partner.address, "partner_address", 1000) };
  const terms = text(source.terms, "terms", 1000);
  let packing = null;
  if (kind === "packing_list") {
    const p = body.packing || {};
    packing = { packages: r.decimal(p.packages, "packages", { zero: false }),
      gross_kg: r.decimal(p.gross_kg, "gross_kg", { zero: false }), net_kg: r.decimal(p.net_kg, "net_kg", { zero: false }),
      marks: text(p.marks, "marks", 500) };
    if (!new r.Decimal(packing.packages).isInteger() || new r.Decimal(packing.net_kg).gt(packing.gross_kg)) {
      throw new AppError(422, "INVALID_PACKING", "Packages must be whole and gross weight must not be below net weight");
    }
  }
  const n = (await c.query(`INSERT INTO document_counters(tenant_id,kind,value) VALUES($1,'issued',1)
    ON CONFLICT(tenant_id,kind) DO UPDATE SET value=document_counters.value+1 RETURNING value`, [actor.tenantId])).rows[0].value;
  const number = `${kind === "invoice" ? "INV" : kind === "packing_list" ? "PKL" : "PO"}-${String(n).padStart(7, "0")}`;
  const snapshot = { ...source, kind, number, issue_date: issueDate, language, template_version: templateVersion,
    settings_version: settings.version, partner_version: partner.version, terms, packing,
    seller: kind === "purchase_order" ? counterparty : company, buyer: kind === "purchase_order" ? company : counterparty,
    total: trade.money(source.lines.reduce((sum, l) => sum.plus(l.amount), new r.Decimal(0)), source.currency) };
  const html = render(snapshot), id = randomUUID(), sha256 = hash(html);
  await c.query(`INSERT INTO issued_documents(tenant_id,id,number,document_id,document_version,fulfilment_id,kind,template_version,snapshot,html,sha256,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
  [actor.tenantId, id, number, doc.id, source.source.version, source.source.fulfilment_id, kind, templateVersion, snapshot, html, sha256, actor.userId]);
  await audit(c, actor, "document.issue", "issued_document", id, { kind, document_id: doc.id, version: source.source.version, sha256 });
  return { id, number, kind, document_id: doc.id, document_version: source.source.version,
    fulfilment_id: source.source.fulfilment_id, snapshot, sha256, stale: false };
}
async function inspect(c, actor, row) {
  const doc = await sourceDocument(c, actor, row.document_id);
  const settings = (await c.query("SELECT version FROM tenant_settings WHERE tenant_id=$1", [actor.tenantId])).rows[0];
  const partner = await r.get(c, actor, "partners", doc.partner_id);
  const stale = !approvedStates.includes(doc.state) || row.snapshot.fingerprint !== fingerprint(doc)
    || row.snapshot.settings_version !== settings?.version || row.snapshot.partner_version !== partner.version
    || await hasShipmentReturns(c, actor, row.fulfilment_id);
  const { html, ...metadata } = row;
  return { ...metadata, stale, current_source_version: doc.version };
}
async function handle(c, actor, id, action, method, body, query) {
  if (method === "POST" && !id) return { status: 201, body: await create(c, actor, body) };
  if (method !== "GET") throw new AppError(405, "IMMUTABLE_DOCUMENT", "Issued documents cannot be overwritten");
  if (!id) {
    const doc = await sourceDocument(c, actor, query.get("document_id"));
    permission(actor, doc.kind === "purchase" ? "purchase_order" : "invoice");
    const rows = (await c.query("SELECT * FROM issued_documents WHERE tenant_id=$1 AND document_id=$2 ORDER BY created_at DESC LIMIT 100",
      [actor.tenantId, doc.id])).rows;
    return { status: 200, body: { items: await Promise.all(rows.map(row => inspect(c, actor, row))) } };
  }
  const row = (await c.query("SELECT * FROM issued_documents WHERE tenant_id=$1 AND id=$2", [actor.tenantId, r.uuid(id)])).rows[0];
  if (!row) throw new AppError(404, "NOT_FOUND", "Document not found");
  permission(actor, row.kind);
  const metadata = await inspect(c, actor, row);
  if (!action) return { status: 200, body: metadata };
  if (action !== "export") throw new AppError(404, "NOT_FOUND", "Unknown document action");
  if (metadata.stale && query.get("history") !== "1") throw new AppError(409, "DOCUMENT_STALE", "Source changed; only explicit historical export is permitted");
  if (hash(row.html) !== row.sha256) throw new AppError(503, "DOCUMENT_INTEGRITY", "Document integrity check failed");
  await audit(c, actor, "document.export", "issued_document", row.id, { historical: metadata.stale, sha256: row.sha256 });
  return { status: 200, body: { html: row.html, sha256: row.sha256, historical: metadata.stale, number: row.number,
    filename: `${row.number}${metadata.stale ? "-HISTORICAL" : ""}.html` } };
}
module.exports = { captureShipment, handle };
