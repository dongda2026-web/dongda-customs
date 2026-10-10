"use strict";
const { json, fail, AppError, requestId, readJson, checkOrigin } = require("./http");
const { audit } = require("./db");
const auth = require("./auth");
const website = require("./website-intake");

function createApp({ pool = null, buildId = "development", environment = "development", publicOrigin, websiteIntake = [] } = {}) {
  const websiteConfig = website.configuration(websiteIntake);
  return async function handle(req, res) {
    const id = requestId();
    res.setHeader("X-Request-Id", id);
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (req.method === "GET" && ["/api/health", "/healthz"].includes(path)) {
        let database = "unconfigured";
        let schemaVersion = null;
        if (pool) {
          try {
            schemaVersion = (await pool.query("SELECT max(version) AS version FROM schema_migrations")).rows[0].version;
            database = schemaVersion ? "ready" : "migration_required";
          }
          catch { database = "unavailable"; }
        }
        return json(res, database === "ready" ? 200 : 503, {
          service: "trade-erp", environment, build: buildId, database, schemaVersion,
        });
      }
      if (path === website.PATH) {
        const result = await website.receive(pool, websiteConfig, req, id);
        return json(res, result.status, result.body);
      }
      checkOrigin(req, publicOrigin);
      if (req.method === "POST" && path === "/api/v1/auth/login") {
        const result = await auth.login(pool, await readJson(req, 4096), {
          ip: req.socket.remoteAddress, requestId: id,
        });
        return json(res, 200, { user: result.actor.user, tenant: result.actor.tenant, role: result.actor.role }, {
          "Set-Cookie": auth.cookie(result.token, environment === "production"),
        });
      }
      const actor = await auth.authenticate(pool, req, id);
      const source = /^\/api\/v1\/leads\/([a-f0-9-]{36})\/website-source$/.exec(path);
      if (source) {
        if (req.method !== "GET") throw new AppError(405, "METHOD_NOT_ALLOWED", "Website source is read-only");
        return json(res, 200, await website.readSource(pool, actor, source[1]));
      }
      if (req.method === "GET" && path === "/api/v1/auth/me") {
        return json(res, 200, { user: actor.user, tenant: actor.tenant, role: actor.role });
      }
      if (req.method === "POST" && path === "/api/v1/auth/logout") {
        await auth.withActor(pool, actor, async c => {
          await c.query("DELETE FROM sessions WHERE token_hash=$1", [auth.digest(auth.sessionToken(req))]);
          await audit(c, actor, "session.logout", "user", actor.userId);
        });
        return json(res, 200, { ok: true }, { "Set-Cookie": auth.cookie("", environment === "production", true) });
      }
      if (req.method === "GET" && ["/api/v1/bootstrap", "/api/v1/settings"].includes(path)) {
        const settings = await auth.withActor(pool, actor, async c =>
          (await c.query("SELECT data,version FROM tenant_settings WHERE tenant_id=$1", [actor.tenantId])).rows[0] || { data: {}, version: 0 });
        return json(res, 200, path.endsWith("/bootstrap")
          ? { user: actor.user, tenant: actor.tenant, role: actor.role, settings } : settings);
      }
      if (req.method === "PATCH" && path === "/api/v1/settings") {
        auth.requireRole(actor);
        const body = await readJson(req);
        if (!Number.isInteger(body.version) || !body.data || Array.isArray(body.data) || typeof body.data !== "object") {
          throw new AppError(422, "VALIDATION", "Expected version and settings object");
        }
        const result = await auth.withActor(pool, actor, async c => {
          let row;
          if (body.version === 0) {
            row = (await c.query(`INSERT INTO tenant_settings(tenant_id,data) VALUES ($1,$2)
              ON CONFLICT DO NOTHING RETURNING data,version`, [actor.tenantId, body.data])).rows[0];
          } else {
            row = (await c.query(`UPDATE tenant_settings SET data=$1,version=version+1,updated_at=now()
              WHERE tenant_id=$2 AND version=$3 RETURNING data,version`, [body.data, actor.tenantId, body.version])).rows[0];
          }
          if (!row) throw new AppError(409, "VERSION_CONFLICT", "Settings changed; reload before saving");
          await audit(c, actor, "settings.update", "settings", actor.tenantId, { version: row.version });
          return row;
        });
        return json(res, 200, result);
      }
      if (req.method === "GET" && path === "/api/v1/audit") {
        auth.requireRole(actor, "auditor");
        const result = await auth.withActor(pool, actor, c => c.query(
          "SELECT * FROM audit_log WHERE tenant_id=$1 ORDER BY id DESC LIMIT 100", [actor.tenantId]));
        return json(res, 200, { items: result.rows });
      }
      const result = await require("./business").dispatch(pool, actor, req);
      if (result) return json(res, result.status, result.body);
      throw new AppError(404, "NOT_FOUND", "API route not found");
    } catch (error) {
      if (error.code === "WEBSITE_RATE_LIMIT") res.setHeader("Retry-After", "60");
      fail(res, error, id);
    }
  };
}

module.exports = { createApp };
