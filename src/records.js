"use strict";
const { randomUUID, createHash } = require("node:crypto");
const { AppError, text } = require("./http");
const { audit } = require("./db");
const Decimal = require("decimal.js");
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const tables = new Set(["partners", "products", "warehouses", "social_accounts", "contents", "leads"]);
function tableName(table) {
  if (!tables.has(table)) throw new Error("Unregistered record table");
  return table;
}
function uuid(value, field = "id", optional = false) {
  if (optional && (value === undefined || value === null || value === "")) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value || "")) {
    throw new AppError(422, "VALIDATION", `Invalid ${field}`, { field });
  }
  return value;
}
function choice(value, field, choices) {
  if (!choices.includes(value)) throw new AppError(422, "VALIDATION", `Invalid ${field}`, { field });
  return value;
}
function decimal(value, field, { zero = true } = {}) {
  if (typeof value !== "string" || !/^\d{1,12}(?:\.\d{1,6})?$/.test(value)) {
    throw new AppError(422, "VALIDATION", `Invalid decimal ${field}`, { field });
  }
  const d = new Decimal(value);
  if (zero ? d.lt(0) : d.lte(0)) throw new AppError(422, "VALIDATION", `Invalid ${field}`, { field });
  return d.toFixed(6);
}
function currency(value) {
  return choice(value, "currency", ["USD", "EUR", "CNY", "KZT", "UZS", "RUB", "GBP", "AED", "JPY", "KWD"]);
}
function dateTime(value, field, optional = false) {
  if (optional && !value) return null;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value) || !/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new AppError(422, "VALIDATION", `Invalid ${field}`, { field });
  }
  return new Date(value).toISOString();
}
async function get(c, actor, table, id, lock = false) {
  uuid(id);
  const row = (await c.query(`SELECT * FROM ${tableName(table)} WHERE tenant_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`, [actor.tenantId, id])).rows[0];
  if (!row) throw new AppError(404, "NOT_FOUND", "Record not found");
  return row;
}
async function ref(c, actor, table, id, field) {
  if (!id) return null;
  uuid(id, field);
  const row = (await c.query(`SELECT * FROM ${tableName(table)} WHERE tenant_id=$1 AND id=$2`, [actor.tenantId, id])).rows[0];
  if (!row || row.active === false) throw new AppError(422, "INVALID_REFERENCE", `Invalid ${field}`, { field });
  return row;
}
function version(row, expected) {
  if (!Number.isInteger(expected) || expected < 1) throw new AppError(422, "VERSION_REQUIRED", "A current version is required");
  if (row.version !== expected) throw new AppError(409, "VERSION_CONFLICT", "Record changed; reload before saving");
}
async function insert(c, actor, table, values) {
  const fields = ["tenant_id", "id", ...Object.keys(values)];
  const params = [actor.tenantId, randomUUID(), ...Object.values(values)];
  const row = (await c.query(`INSERT INTO ${tableName(table)}(${fields.join(",")}) VALUES (${params.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`, params)).rows[0];
  await audit(c, actor, `${table}.create`, table, row.id, { version: row.version });
  return row;
}
async function update(c, actor, table, row, values) {
  const fields = Object.keys(values);
  const params = [actor.tenantId, row.id, ...Object.values(values)];
  const updated = (await c.query(`UPDATE ${tableName(table)} SET ${fields.map((f, i) => `${f}=$${i + 3}`).join(",")},
    version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`, params)).rows[0];
  await audit(c, actor, `${table}.update`, table, row.id, { version: updated.version });
  return updated;
}
async function list(c, actor, table, query, searchColumn = "name") {
  if (!["name", "title"].includes(searchColumn)) throw new Error("Unregistered search column");
  const page = Number(query.get("page") || 1), size = Number(query.get("pageSize") || 30);
  if (!Number.isInteger(page) || page < 1 || page > 100000 || !Number.isInteger(size) || size < 1 || size > 100) {
    throw new AppError(422, "VALIDATION", "Invalid pagination");
  }
  const search = String(query.get("search") || "").slice(0, 200);
  const count = await c.query(`SELECT count(*) FROM ${tableName(table)} WHERE tenant_id=$1 AND ${searchColumn} ILIKE $2`, [actor.tenantId, `%${search}%`]);
  const result = await c.query(`SELECT * FROM ${tableName(table)} WHERE tenant_id=$1 AND ${searchColumn} ILIKE $2 ORDER BY created_at DESC,id LIMIT $3 OFFSET $4`,
    [actor.tenantId, `%${search}%`, size, (page - 1) * size]);
  return { items: result.rows, total: Number(count.rows[0].count), page, pageSize: size };
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
async function command(c, actor, key, request, fn) {
  if (!key) return fn();
  text(key, "idempotency-key", 100);
  const hash = createHash("sha256").update(JSON.stringify(stable({ user: actor.userId, role: actor.role, request }))).digest("hex");
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${actor.tenantId}:${key}`]);
  const existing = (await c.query("SELECT * FROM command_receipts WHERE tenant_id=$1 AND key=$2", [actor.tenantId, key])).rows[0];
  if (existing) {
    if (existing.request_hash !== hash) throw new AppError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was used for another request");
    return { status: existing.status, body: existing.response };
  }
  const result = await fn();
  await c.query("INSERT INTO command_receipts(tenant_id,key,request_hash,status,response) VALUES ($1,$2,$3,$4,$5)",
    [actor.tenantId, key, hash, result.status, result.body]);
  return result;
}

module.exports = { uuid, choice, decimal, currency, dateTime, get, ref, version, insert, update, list, command, Decimal };
