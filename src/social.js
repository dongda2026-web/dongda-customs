"use strict";
const { randomUUID } = require("node:crypto");
const { AppError, text } = require("./http");
const { requireRole } = require("./auth");
const { audit } = require("./db");
const r = require("./records");

async function contentValues(c, actor, body) {
  const account = r.uuid(body.account_id, "account_id");
  await r.ref(c, actor, "social_accounts", account, "account_id");
  return { account_id: account, title: text(body.title, "title"),
    body: text(body.body, "body", 20000),
    language: r.choice(body.language || "en", "language", ["en", "zh", "ru", "kk", "uz", "other"]) };
}
async function leadValues(c, actor, body) {
  const account = r.uuid(body.account_id, "account_id", true);
  const content = r.uuid(body.content_id, "content_id", true);
  const partner = r.uuid(body.partner_id, "partner_id", true);
  await r.ref(c, actor, "social_accounts", account, "account_id");
  const linked = await r.ref(c, actor, "contents", content, "content_id");
  await r.ref(c, actor, "partners", partner, "partner_id");
  if (linked && linked.account_id !== account) throw new AppError(422, "SOURCE_MISMATCH", "Content does not belong to this account");
  const owner = r.uuid(body.owner_id || actor.userId, "owner_id");
  const member = (await c.query("SELECT 1 FROM memberships WHERE tenant_id=$1 AND user_id=$2 AND active", [actor.tenantId, owner])).rows[0];
  if (!member) throw new AppError(422, "INVALID_REFERENCE", "Invalid owner");
  return { name: text(body.name, "name"), contact: text(body.contact || "", "contact", 300, false),
    need: text(body.need || "", "need", 5000, false), account_id: account, content_id: content,
    partner_id: partner, owner_id: owner };
}
function state(row, allowed) {
  if (!allowed.includes(row.state)) throw new AppError(409, "INVALID_STATE", "Action is not allowed in the current state");
}
async function contentAction(c, actor, row, body) {
  r.version(row, body.version);
  const action = body.action;
  let values;
  if (action === "submit") { state(row, ["draft"]); values = { state: "review" }; }
  else if (action === "approve") {
    requireRole(actor); state(row, ["review"]); values = { state: "approved" };
  } else if (action === "reject") {
    requireRole(actor); state(row, ["review"]);
    text(body.reason, "reason", 1000);
    values = { state: "draft", scheduled_at: null };
  } else if (action === "schedule") {
    state(row, ["approved", "scheduled"]);
    const scheduled = r.dateTime(body.scheduled_at, "scheduled_at");
    if (Date.parse(scheduled) <= Date.now()) throw new AppError(422, "SCHEDULE_IN_PAST", "Schedule must be in the future");
    values = { state: "scheduled", scheduled_at: scheduled };
  } else if (action === "publish_manual") {
    state(row, ["approved", "scheduled"]);
    const raw = text(body.url, "url", 2000);
    let url;
    try { url = new URL(raw); } catch { throw new AppError(422, "INVALID_URL", "A valid publication URL is required"); }
    if (url.protocol !== "https:" || url.username || url.password) throw new AppError(422, "INVALID_URL", "Use a public HTTPS URL");
    values = { state: "published", publication_source: "manual", publication_url: url.href, published_at: new Date().toISOString() };
  } else if (action === "publish_api") {
    throw new AppError(409, "PLATFORM_NOT_CONNECTED", "Official platform authorization has not been configured");
  } else throw new AppError(422, "UNKNOWN_ACTION", "Unknown content action");
  const result = await r.update(c, actor, "contents", row, values);
  await audit(c, actor, `content.${action}`, "content", row.id, {
    previous: row.state, state: result.state, version: result.version,
    ...(action === "reject" ? { reason: body.reason.trim() } : {}),
  });
  return result;
}

async function handle(c, actor, type, id, action, method, body, query) {
  if (!["contents", "leads"].includes(type)) return null;
  if (method === "GET") {
    if (!id) return { status: 200, body: await r.list(c, actor, type, query, type === "contents" ? "title" : "name") };
    const row = await r.get(c, actor, type, id);
    if (type === "leads") {
      row.followups = (await c.query("SELECT * FROM lead_followups WHERE tenant_id=$1 AND lead_id=$2 ORDER BY created_at DESC,id",
        [actor.tenantId, id])).rows;
    } else {
      row.insights = (await c.query("SELECT * FROM content_insights WHERE tenant_id=$1 AND content_id=$2 ORDER BY period_end DESC,id",
        [actor.tenantId, id])).rows;
    }
    return { status: 200, body: row };
  }
  requireRole(actor, ...(type === "contents" ? ["social"] : ["social", "sales"]));
  if (method === "POST" && !id) {
    const values = type === "contents"
      ? { ...await contentValues(c, actor, body), created_by: actor.userId }
      : await leadValues(c, actor, body);
    return { status: 201, body: await r.insert(c, actor, type, values) };
  }
  const row = await r.get(c, actor, type, id, true);
  r.version(row, body.version);
  if (method === "PATCH" && !action) {
    if (type === "contents") {
      state(row, ["draft", "review", "approved", "scheduled"]);
      const values = await contentValues(c, actor, { ...row, ...body });
      return { status: 200, body: await r.update(c, actor, type, row, { ...values, state: "draft", scheduled_at: null }) };
    }
    return { status: 200, body: await r.update(c, actor, type, row, await leadValues(c, actor, { ...row, ...body })) };
  }
  if (method === "POST" && action === "actions" && type === "contents") {
    return { status: 200, body: await contentAction(c, actor, row, body) };
  }
  if (method === "POST" && action === "followups" && type === "leads") {
    const note = text(body.note, "note", 5000), due = r.dateTime(body.due_at, "due_at", true);
    const item = (await c.query(`INSERT INTO lead_followups(tenant_id,id,lead_id,note,due_at,created_by)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [actor.tenantId, randomUUID(), id, note, due, actor.userId])).rows[0];
    await r.update(c, actor, type, row, { next_followup_at: due });
    return { status: 201, body: item };
  }
  if (method === "POST" && action === "actions" && type === "leads") {
    const next = r.choice(body.action, "action", ["qualify", "lose", "reopen"]);
    const changes = { state: next === "qualify" ? "qualified" : next === "lose" ? "lost" : "new",
      reason: next === "lose" ? text(body.reason, "reason", 1000) : "" };
    state(row, next === "reopen" ? ["lost"] : ["new", "qualified"]);
    return { status: 200, body: await r.update(c, actor, type, row, changes) };
  }
  if (method === "POST" && action === "insights" && type === "contents") {
    state(row, ["published"]);
    const counts = ["impressions", "interactions", "clicks", "leads"].map(k => {
      const value = body[k] === undefined ? 0 : body[k];
      if (!Number.isSafeInteger(value) || value < 0) throw new AppError(422, "VALIDATION", `Invalid ${k}`);
      return value;
    });
    for (const k of ["period_start", "period_end"]) {
      if (!/^\d{4}-\d\d-\d\d$/.test(body[k] || "") || !Number.isFinite(Date.parse(body[k]))) {
        throw new AppError(422, "VALIDATION", `Invalid ${k}`);
      }
    }
    if (body.period_end < body.period_start) throw new AppError(422, "VALIDATION", "Invalid date range");
    const item = (await c.query(`INSERT INTO content_insights(tenant_id,id,content_id,period_start,period_end,impressions,interactions,clicks,leads,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [actor.tenantId, randomUUID(), id, body.period_start, body.period_end, ...counts, actor.userId])).rows[0];
    await audit(c, actor, "content.insights", "content", id, { insightId: item.id, source: "manual" });
    return { status: 201, body: item };
  }
  throw new AppError(405, "METHOD_NOT_ALLOWED", "Unsupported operation");
}
module.exports = { handle };
