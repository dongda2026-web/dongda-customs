"use strict";
const { AppError, text } = require("./http");
const { requireRole } = require("./auth");
const r = require("./records");
const trade = require("./trade");
const inventory = require("./inventory");
const fulfilment = require("./fulfilment");

async function handle(c, actor, type, id, operation, method, body, query) {
  const kind = trade.kinds[type];
  if (!kind) return null;
  if (method === "GET") {
    if (operation === "versions") {
      await trade.load(c, actor, kind, id);
      return { status: 200, body: { items: (await c.query("SELECT version,snapshot,created_at FROM trade_versions WHERE tenant_id=$1 AND document_id=$2 ORDER BY version DESC",
        [actor.tenantId, id])).rows } };
    }
    if (operation === "fulfilments") {
      await trade.load(c, actor, kind, id);
      return { status: 200, body: { items: (await c.query(`SELECT f.id,f.kind,f.created_at,l.id AS event_line_id,l.line_id,l.quantity,l.source_line_id
        FROM fulfilments f JOIN fulfilment_lines l ON l.tenant_id=f.tenant_id AND l.fulfilment_id=f.id
        WHERE f.tenant_id=$1 AND f.document_id=$2 ORDER BY f.created_at DESC,l.id`, [actor.tenantId, id])).rows } };
    }
    return { status: 200, body: id ? await trade.load(c, actor, kind, id) : await trade.list(c, actor, kind, query) };
  }
  if (method === "POST" && !id) {
    requireRole(actor, ...(kind === "purchase" ? ["purchasing"] : ["sales"]));
    return { status: 201, body: await trade.create(c, actor, kind, body) };
  }
  const doc = await trade.load(c, actor, kind, id, true);
  r.version(doc, body.version);
  if (method === "POST" && kind === "order" && operation === "procure") {
    return { status: 201, body: await fulfilment.procure(c, actor, doc, body) };
  }
  if (method === "POST" && kind === "purchase" && operation === "receive") {
    return { status: 200, body: await fulfilment.receive(c, actor, doc, body) };
  }
  if (method === "POST" && kind === "order" && operation === "ship") {
    return { status: 200, body: await fulfilment.ship(c, actor, doc, body) };
  }
  if (method === "POST" && ["order", "purchase"].includes(kind) && operation === "return") {
    return { status: 200, body: await require("./returns").execute(c, actor, doc, body) };
  }
  if (method === "POST" && kind === "order" && operation === "release-return") {
    return { status: 200, body: await require("./returns").execute(c, actor, doc, body, true) };
  }
  requireRole(actor, ...(kind === "purchase" ? ["purchasing"] : ["sales"]));
  if (method === "PATCH" && !operation) {
    return { status: 200, body: await require("./revisions").revise(c, actor, doc, body) };
  }
  if (method !== "POST" || operation !== "actions") throw new AppError(405, "METHOD_NOT_ALLOWED", "Use a supported document action");
  const action = body.action;
  if (kind === "quote") {
    if (action === "send") {
      trade.state(doc, ["draft"]);
      return { status: 200, body: await trade.bump(c, actor, kind, id, "sent", "quote.send") };
    }
    if (action === "accept") {
      trade.state(doc, ["sent"]);
      if (doc.valid_until < new Date().toISOString().slice(0, 10)) throw new AppError(409, "QUOTE_EXPIRED", "Quote has expired");
      const order = await trade.create(c, actor, "order", { ...doc, warehouse_id: body.warehouse_id || doc.warehouse_id },
        { sourceId: doc.id, lineSnapshots: doc.lines });
      const accepted = await trade.bump(c, actor, kind, id, "accepted", "quote.accept");
      return { status: 200, body: { ...accepted, order_id: order.id } };
    }
    if (action === "cancel") {
      trade.state(doc, ["draft", "sent"]);
      return { status: 200, body: await trade.bump(c, actor, kind, id, "cancelled", "quote.cancel") };
    }
    throw new AppError(409, "INVALID_STATE", "Unsupported quote action");
  }
  let next;
  if (action === "submit") {
    trade.state(doc, ["draft"]);
    next = "review";
  } else if (action === "approve") {
    requireRole(actor);
    trade.state(doc, ["review"]);
    if (kind === "order") await inventory.reserveOrder(c, actor, doc);
    next = "confirmed";
  } else if (action === "reject") {
    requireRole(actor);
    trade.state(doc, ["review"]);
    text(body.reason, "reason", 1000);
    next = "draft";
  } else if (action === "cancel") {
    trade.state(doc, ["draft", "review", "confirmed", "partial"]);
    if (kind === "order") await inventory.releaseOrder(c, actor, doc);
    else await c.query("UPDATE trade_lines SET cancelled=quantity-received WHERE tenant_id=$1 AND document_id=$2", [actor.tenantId, id]);
    next = "cancelled";
  } else if (action === "complete") {
    trade.state(doc, ["fulfilled"]);
    next = "completed";
  } else throw new AppError(422, "UNKNOWN_ACTION", "Unknown document action");
  return { status: 200, body: await trade.bump(c, actor, kind, id, next, `${kind}.${action}`) };
}
module.exports = { handle };
