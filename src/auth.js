"use strict";
const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { AppError, text } = require("./http");
const { withTenant, audit } = require("./db");
const scrypt = promisify(crypto.scrypt);
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const dummyHash = `scrypt$${"0".repeat(32)}$${"0".repeat(128)}`;

async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 128) {
    throw new AppError(422, "PASSWORD_POLICY", "Password must contain 12 to 128 characters");
  }
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${hash.toString("hex")}`;
}

async function verifyPassword(password, encoded = dummyHash) {
  if (typeof password !== "string" || password.length > 128) return false;
  const [algorithm, salt, hash] = encoded.split("$");
  if (algorithm !== "scrypt" || !/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{128}$/.test(hash)) return false;
  const actual = await scrypt(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, "hex"));
}

async function attempt(pool, key, limit) {
  const row = (await pool.query(`INSERT INTO login_attempts(key,attempts) VALUES ($1,1)
    ON CONFLICT (key) DO UPDATE SET
    attempts=CASE WHEN login_attempts.window_start < now()-interval '15 minutes' THEN 1 ELSE login_attempts.attempts+1 END,
    window_start=CASE WHEN login_attempts.window_start < now()-interval '15 minutes' THEN now() ELSE login_attempts.window_start END
    RETURNING attempts`, [key])).rows[0];
  if (row.attempts > limit) throw new AppError(429, "LOGIN_RATE_LIMITED", "Too many attempts; retry later");
}

async function login(pool, body, { ip, requestId }) {
  if (!pool) throw new AppError(503, "DATABASE_UNAVAILABLE", "Database is not configured");
  const email = text(body.email, "email", 254).toLowerCase();
  const tenant = text(body.tenant, "tenant", 63).toLowerCase();
  const password = typeof body.password === "string" && body.password.length <= 128 ? body.password : "";
  const key = digest(`account:${tenant}:${email}`);
  await attempt(pool, digest(`ip:${ip}`), 100);
  await attempt(pool, key, 5);
  const row = (await pool.query(`SELECT u.id AS user_id,u.email,u.name,u.password_hash,
    t.id AS tenant_id,t.name AS tenant_name,t.slug,m.role,m.version AS membership_version
    FROM users u JOIN memberships m ON m.user_id=u.id JOIN tenants t ON t.id=m.tenant_id
    WHERE u.email=$1 AND t.slug=$2 AND u.active AND m.active AND t.active`, [email, tenant])).rows[0];
  const valid = await verifyPassword(password, row ? row.password_hash : dummyHash);
  if (!row || !valid) throw new AppError(401, "INVALID_CREDENTIALS", "Invalid credentials");
  const token = crypto.randomBytes(32).toString("hex");
  const actor = actorFromRow(row, requestId);
  await withTenant(pool, actor.tenantId, async client => {
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [`members:${actor.tenantId}`]);
    const current = (await client.query(`SELECT m.version FROM memberships m JOIN users u ON u.id=m.user_id
      JOIN tenants t ON t.id=m.tenant_id WHERE m.tenant_id=$1 AND m.user_id=$2 AND m.active AND u.active AND t.active`,
    [actor.tenantId, actor.userId])).rows[0];
    if (!current || current.version !== row.membership_version) throw new AppError(401, "UNAUTHENTICATED", "Membership changed; sign in again");
    await client.query("DELETE FROM login_attempts WHERE key=$1", [key]);
    await client.query(`INSERT INTO sessions(token_hash,tenant_id,user_id,expires_at,membership_version)
      VALUES ($1,$2,$3,now()+interval '8 hours',$4)`, [digest(token), row.tenant_id, row.user_id, row.membership_version]);
    await audit(client, actor, "session.login", "user", row.user_id);
  });
  return { token, actor };
}

function actorFromRow(row, requestId) {
  return {
    tenantId: row.tenant_id, userId: row.user_id, role: row.role, membershipVersion: row.membership_version, requestId,
    user: { id: row.user_id, email: row.email, name: row.name },
    tenant: { id: row.tenant_id, name: row.tenant_name, slug: row.slug },
  };
}

function sessionToken(req) {
  const cookie = (req.headers.cookie || "").split(";").map(x => x.trim()).find(x => x.startsWith("erp_session="));
  const token = cookie ? cookie.slice("erp_session=".length) : "";
  return /^[0-9a-f]{64}$/.test(token) ? token : null;
}

async function authenticate(pool, req, requestId) {
  const token = sessionToken(req);
  if (!token) throw new AppError(401, "UNAUTHENTICATED", "Sign in required");
  if (!pool) throw new AppError(503, "DATABASE_UNAVAILABLE", "Database is not configured");
  const row = (await pool.query(`SELECT u.id AS user_id,u.email,u.name,t.id AS tenant_id,
    t.name AS tenant_name,t.slug,m.role,m.version AS membership_version FROM sessions s
    JOIN users u ON u.id=s.user_id JOIN tenants t ON t.id=s.tenant_id
    JOIN memberships m ON m.user_id=s.user_id AND m.tenant_id=s.tenant_id
    WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active AND t.active AND m.active
      AND s.membership_version=m.version`, [digest(token)])).rows[0];
  if (!row) throw new AppError(401, "UNAUTHENTICATED", "Session expired or revoked");
  return { ...actorFromRow(row, requestId), sessionHash: digest(token) };
}

function requireRole(actor, ...roles) {
  if (actor.role !== "admin" && !roles.includes(actor.role)) {
    throw new AppError(403, "FORBIDDEN", "Insufficient permissions");
  }
}

async function authorizeTransaction(client, actor) {
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [`members:${actor.tenantId}`]);
  const row = (await client.query(`SELECT m.role,m.version FROM memberships m JOIN users u ON u.id=m.user_id
    JOIN tenants t ON t.id=m.tenant_id JOIN sessions s ON s.tenant_id=m.tenant_id AND s.user_id=m.user_id
    WHERE m.tenant_id=$1 AND m.user_id=$2 AND s.token_hash=$3 AND s.expires_at>now()
    AND m.active AND u.active AND t.active AND s.membership_version=m.version`,
  [actor.tenantId, actor.userId, actor.sessionHash])).rows[0];
  if (!row || row.role !== actor.role || row.version !== actor.membershipVersion) {
    throw new AppError(401, "UNAUTHENTICATED", "Session expired, revoked or membership changed");
  }
}

async function withActor(pool, actor, fn) {
  return withTenant(pool, actor.tenantId, async client => {
    await authorizeTransaction(client, actor);
    return fn(client);
  });
}

function cookie(token, secure, clear = false) {
  return `erp_session=${clear ? "" : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 28800}${secure ? "; Secure" : ""}`;
}

module.exports = { hashPassword, verifyPassword, login, authenticate, requireRole, cookie, sessionToken, digest, authorizeTransaction, withActor };
