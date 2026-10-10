"use strict";
const { readdir, readFile } = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { Pool } = require("pg");
const { AppError } = require("./http");

function createPool(env = process.env) {
  if (!env.DATABASE_URL) return null;
  return new Pool({
    connectionString: env.DATABASE_URL,
    max: 12,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    ssl: env.DB_SSL === "false" ? false : {
      rejectUnauthorized: true,
      ...(env.DB_CA_CERT ? { ca: env.DB_CA_CERT } : {}),
    },
  });
}

async function withTenant(pool, tenantId, fn) {
  if (!pool) throw new AppError(503, "DATABASE_UNAVAILABLE", "Database is not configured");
  if (!/^[0-9a-f-]{36}$/i.test(tenantId || "")) {
    throw new AppError(401, "INVALID_TENANT", "Verified tenant is required");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function migrate(ownerPool, runtimeRole = "erp_runtime") {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole)) throw new Error("Invalid runtime role");
  const c = await ownerPool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(78123011)");
    await c.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now())`);
    const files = (await readdir(path.join(__dirname, "migrations"))).filter(f => /^\d+-.+\.sql$/.test(f)).sort();
    for (const file of files) {
      const sql = await readFile(path.join(__dirname, "migrations", file), "utf8");
      const version = Number(file.split("-")[0]);
      const checksum = crypto.createHash("sha256").update(sql).digest("hex");
      const prior = (await c.query("SELECT checksum FROM schema_migrations WHERE version=$1", [version])).rows[0];
      if (prior) {
        if (prior.checksum !== checksum) throw new Error(`Applied migration changed: ${file}`);
        continue;
      }
      await c.query(sql);
      await c.query("INSERT INTO schema_migrations(version,name,checksum) VALUES ($1,$2,$3)", [version, file, checksum]);
    }
    await c.query(`GRANT USAGE ON SCHEMA public TO "${runtimeRole}"`);
    await c.query(`GRANT SELECT ON schema_migrations,tenants,users,memberships TO "${runtimeRole}"`);
    await c.query(`GRANT UPDATE(role,active,version) ON memberships TO "${runtimeRole}"`);
    await c.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON sessions,login_attempts,tenant_settings TO "${runtimeRole}"`);
    await c.query(`GRANT SELECT,INSERT ON audit_log TO "${runtimeRole}"`);
    await c.query(`GRANT SELECT,INSERT,UPDATE ON partners,products,warehouses,social_accounts,contents,leads TO "${runtimeRole}"`);
    await c.query(`GRANT SELECT,INSERT ON lead_followups,content_insights,command_receipts TO "${runtimeRole}"`);
    await c.query(`GRANT SELECT,INSERT,UPDATE ON document_counters,trade_documents,trade_lines,procurement_allocations,stock_balances TO "${runtimeRole}"`);
    await c.query(`GRANT DELETE ON trade_lines TO "${runtimeRole}"`);
    await c.query(`GRANT SELECT,INSERT ON trade_versions,stock_movements,fulfilments,fulfilment_lines TO "${runtimeRole}"`);
    await c.query(`GRANT SELECT,INSERT,UPDATE ON transfers,stocktakes TO "${runtimeRole}"`);
    await c.query(`GRANT SELECT,INSERT ON stocktake_lines TO "${runtimeRole}"`);
    await c.query(`GRANT SELECT,INSERT ON website_inquiries TO "${runtimeRole}"`);
    await c.query(`GRANT SELECT,INSERT,UPDATE ON website_intake_windows TO "${runtimeRole}"`);
    await c.query(`GRANT SELECT,INSERT,UPDATE ON finance_outbox TO "${runtimeRole}"`);
    await c.query(`GRANT SELECT,INSERT ON finance_results TO "${runtimeRole}"`);
    await c.query(`GRANT SELECT,INSERT ON shipment_document_sources,issued_documents TO "${runtimeRole}"`);
    await c.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "${runtimeRole}"`);
    const version = (await c.query("SELECT COALESCE(max(version),0) AS version FROM schema_migrations")).rows[0].version;
    await c.query("COMMIT");
    return version;
  } catch (error) {
    await c.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { c.release(); }
}

async function audit(client, actor, action, resourceType, resourceId, summary = {}) {
  await client.query(`INSERT INTO audit_log(tenant_id,user_id,action,resource_type,resource_id,request_id,summary)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,
  [actor.tenantId, actor.userId, action, resourceType, resourceId, actor.requestId, summary]);
}

// Highest migration shipped with this build; used to tell "already migrated" from "needs DDL".
async function requiredVersion() {
  const files = (await readdir(path.join(__dirname, "migrations"))).filter(f => /^\d+-.+\.sql$/.test(f));
  return files.reduce((max, file) => Math.max(max, Number(file.split("-")[0])), 0);
}

module.exports = { createPool, withTenant, migrate, requiredVersion, audit };
