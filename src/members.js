"use strict";
const { AppError, text } = require("./http");
const { requireRole } = require("./auth");
const { audit } = require("./db");
const { uuid, version, choice } = require("./records");
const roles = ["admin", "social", "sales", "purchasing", "warehouse", "auditor"];
const projection = `m.user_id AS id,m.user_id,m.role,m.active,m.version,u.name,u.email,u.active AS account_active`;
async function authorize(c, actor) {
  requireRole(actor);
  // Serialize administrative changes per tenant, then re-read authority after any wait.
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`members:${actor.tenantId}`]);
  const row = (await c.query(`SELECT m.role,m.version FROM memberships m JOIN users u ON u.id=m.user_id
    JOIN tenants t ON t.id=m.tenant_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.active AND u.active AND t.active`,
  [actor.tenantId, actor.userId])).rows[0];
  if (!row || row.role !== "admin" || (actor.membershipVersion != null && actor.membershipVersion !== row.version)) {
    throw new AppError(403, "AUTHORITY_REVOKED", "Administrative permission was revoked");
  }
  if (actor.sessionHash && !(await c.query(`SELECT 1 FROM sessions WHERE token_hash=$1 AND tenant_id=$2 AND user_id=$3
    AND membership_version=$4 AND expires_at>now()`, [actor.sessionHash, actor.tenantId, actor.userId, row.version])).rowCount) {
    throw new AppError(401, "UNAUTHENTICATED", "Session was revoked");
  }
}
async function get(c, actor, id) {
  const row = (await c.query(`SELECT ${projection} FROM memberships m JOIN users u ON u.id=m.user_id
    WHERE m.tenant_id=$1 AND m.user_id=$2`, [actor.tenantId, uuid(id)])).rows[0];
  if (!row) throw new AppError(404, "NOT_FOUND", "Member not found in this enterprise");
  return row;
}
async function handle(c, actor, id, action, method, body, query) {
  await authorize(c, actor);
  if (method === "GET" && !action) {
    if (id) return { status: 200, body: await get(c, actor, id) };
    const page = Number(query.get("page") || 1), size = Number(query.get("pageSize") || 30);
    if (!Number.isInteger(page) || page < 1 || page > 100000 || !Number.isInteger(size) || size < 1 || size > 100) {
      throw new AppError(422, "VALIDATION", "Invalid pagination");
    }
    const search = `%${String(query.get("search") || "").slice(0, 200)}%`;
    const clause = "FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.tenant_id=$1 AND (u.name ILIKE $2 OR u.email ILIKE $2)";
    const count = (await c.query(`SELECT count(*) ${clause}`, [actor.tenantId, search])).rows[0].count;
    const result = await c.query(`SELECT ${projection} ${clause} ORDER BY u.name,m.user_id LIMIT $3 OFFSET $4`, [actor.tenantId, search, size, (page - 1) * size]);
    return { status: 200, body: { items: result.rows, total: Number(count), page, pageSize: size } };
  }
  const revoke = method === "POST" && action === "revoke-sessions";
  if (!id || (!revoke && !(method === "PATCH" && !action))) throw new AppError(405, "METHOD_NOT_ALLOWED", "Use member update or session revocation");
  const allowed = revoke ? ["version", "reason"] : ["version", "reason", "role", "active"];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new AppError(422, "VALIDATION", "Unsupported member field");
  const row = await get(c, actor, id);
  version(row, body.version);
  const reason = text(body.reason, "reason", 500);
  const role = body.role === undefined ? row.role : choice(body.role, "role", roles);
  const active = body.active === undefined ? row.active : body.active;
  if (typeof active !== "boolean") throw new AppError(422, "VALIDATION", "Invalid active flag");
  if (!revoke && body.role === undefined && body.active === undefined) throw new AppError(422, "VALIDATION", "Specify role or active");
  if (active && !row.account_active) throw new AppError(409, "ACCOUNT_DISABLED", "The global account is disabled; tenant administrators cannot enable it");
  if (row.active && row.role === "admin" && (!active || role !== "admin")) {
    const others = (await c.query(`SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id
      WHERE m.tenant_id=$1 AND m.user_id<>$2 AND m.role='admin' AND m.active AND u.active LIMIT 1`, [actor.tenantId, id])).rowCount;
    if (!others) throw new AppError(409, "LAST_ADMIN", "At least one active administrator must remain");
  }
  if (!revoke && active === row.active && role === row.role) return { status: 200, body: row };
  await c.query("UPDATE memberships SET role=$3,active=$4,version=version+1 WHERE tenant_id=$1 AND user_id=$2",
    [actor.tenantId, id, role, active]);
  const revoked = await c.query("DELETE FROM sessions WHERE tenant_id=$1 AND user_id=$2", [actor.tenantId, id]);
  await audit(c, actor, revoke ? "member.revoke_sessions" : "member.update", "member", id,
    { from: { role: row.role, active: row.active, version: row.version }, to: { role, active, version: row.version + 1 }, reason, sessions_revoked: revoked.rowCount });
  return { status: 200, body: await get(c, actor, id) };
}
module.exports = { handle, authorize };
