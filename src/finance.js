"use strict";
const { randomUUID } = require("node:crypto");
const { AppError } = require("./http");
const { requireRole } = require("./auth");
const { audit } = require("./db");
const r = require("./records");

async function enqueue(c, actor, doc, eventType) {
  if (!["order", "purchase"].includes(doc.kind)) return;
  const previouslyApproved = (await c.query(`SELECT 1 FROM trade_versions WHERE tenant_id=$1 AND document_id=$2
    AND snapshot->>'state' IN ('confirmed','partial','fulfilled','completed') LIMIT 1`, [actor.tenantId, doc.id])).rowCount;
  if (!previouslyApproved) return;
  const eventId = randomUUID();
  const movements = (await c.query(`SELECT f.id,f.kind,f.created_at,l.id AS line_event_id,l.line_id,l.quantity,l.source_line_id
    FROM fulfilments f JOIN fulfilment_lines l ON l.tenant_id=f.tenant_id AND l.fulfilment_id=f.id
    WHERE f.tenant_id=$1 AND f.document_id=$2 ORDER BY f.created_at,f.id,l.id`, [actor.tenantId, doc.id])).rows;
  const partner = (await c.query("SELECT id,name,kind FROM partners WHERE tenant_id=$1 AND id=$2", [actor.tenantId, doc.partner_id])).rows[0];
  const payload = {
    schema_version: 1, event_id: eventId, tenant_id: actor.tenantId,
    event_type: eventType, occurred_at: new Date().toISOString(),
    document: { ...doc }, partner, movements,
  };
  await c.query(`INSERT INTO finance_outbox(tenant_id,id,document_id,document_version,event_type,payload)
    VALUES ($1,$2,$3,$4,$5,$6)`, [actor.tenantId, eventId, doc.id, doc.version, eventType, payload]);
}
async function handle(c, actor, id, operation, method) {
  if (method === "GET" && id === "status") {
    return { status: 200, body: { provider: "dongda-finance", connected: false,
      mode: "pending_review", message: "Transport configuration and finance-side verification are required" } };
  }
  if (method === "GET" && id === "events") {
    requireRole(actor, "auditor");
    return { status: 200, body: { items: (await c.query(
      "SELECT * FROM finance_outbox WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 200", [actor.tenantId])).rows } };
  }
  if (method === "GET" && id === "results") {
    requireRole(actor, "auditor");
    return { status: 200, body: { items: (await c.query(
      "SELECT * FROM finance_results WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC LIMIT 200", [actor.tenantId])).rows } };
  }
  if (method === "POST" && operation === "retry") {
    requireRole(actor);
    r.uuid(id);
    const event = (await c.query("SELECT * FROM finance_outbox WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [actor.tenantId, id])).rows[0];
    if (!event) throw new AppError(404, "NOT_FOUND", "Finance event not found");
    if (!["failed", "rejected"].includes(event.state)) throw new AppError(409, "INVALID_STATE", "Only failed events can be retried");
    await c.query("UPDATE finance_outbox SET state='pending',attempts=0,retry_at=now(),error_code=NULL WHERE tenant_id=$1 AND id=$2", [actor.tenantId, id]);
    await audit(c, actor, "finance.retry", "finance_event", id, { previous_attempts: event.attempts, previous_error: event.error_code });
    return { status: 200, body: { id, state: "pending" } };
  }
  throw new AppError(404, "NOT_FOUND", "Finance operation not found");
}
module.exports = { enqueue, handle };
