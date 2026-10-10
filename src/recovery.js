"use strict";
const { randomBytes, createCipheriv, createDecipheriv } = require("node:crypto");
const quote = name => `"${String(name).replace(/"/g, '""')}"`;
const excluded = new Set(["sessions", "login_attempts", "website_intake_windows"]);
const MAGIC = Buffer.from("TRADE-ERP-BACKUP-2\n");
function requireKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("Backup requires a 32-byte encryption key");
}
async function tables(client) {
  return (await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(x => x.tablename);
}
async function backup(pool, key) {
  requireKey(key);
  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await c.query("SET LOCAL row_security = off");
    const names = await tables(c), data = {};
    for (const name of names) {
      if (!excluded.has(name)) {
        // Keep PostgreSQL's JSON text intact; JS numbers cannot represent all NUMERIC/BIGINT values.
        data[name] = (await c.query(`SELECT row_to_json(t)::text AS row FROM public.${quote(name)} t`)).rows.map(x => x.row);
      }
    }
    await c.query("COMMIT");
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(MAGIC);
    const payload = Buffer.from(JSON.stringify({ format: 2, created_at: new Date().toISOString(), tables: data }));
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]);
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}
async function restore(pool, encrypted, key) {
  requireKey(key);
  if (!Buffer.isBuffer(encrypted) || !encrypted.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Invalid backup format");
  const start = MAGIC.length;
  const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(start, start + 12));
  decipher.setAAD(MAGIC); decipher.setAuthTag(encrypted.subarray(start + 12, start + 28));
  const payload = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(start + 28)), decipher.final()]).toString("utf8"));
  if (payload.format !== 2 || !payload.tables || typeof payload.tables !== "object") throw new Error("Invalid backup payload");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL row_security = off");
    await c.query("SELECT pg_advisory_xact_lock(78123011)");
    const names = await tables(c);
    if (Object.keys(payload.tables).sort().join(",") !== names.filter(t => !excluded.has(t)).sort().join(",")) {
      throw new Error("Backup and target schemas differ; apply matching migrations first");
    }
    // Exclusive locks keep an accidentally started application from writing into the recovery target.
    for (const name of names) await c.query(`LOCK TABLE public.${quote(name)} IN ACCESS EXCLUSIVE MODE`);
    for (const name of names.filter(t => t !== "schema_migrations")) {
      if ((await c.query(`SELECT 1 FROM public.${quote(name)} LIMIT 1`)).rowCount) throw new Error("Recovery target must be empty");
    }
    const current = (await c.query("SELECT version,name,checksum FROM schema_migrations ORDER BY version")).rows;
    const expected = payload.tables.schema_migrations.map(row => {
      const { version, name, checksum } = JSON.parse(row);
      return { version, name, checksum };
    }).sort((a, b) => a.version - b.version);
    if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("Migration checksum mismatch");
    const constraints = (await c.query(`SELECT t.relname AS table_name,k.conname,k.condeferrable,k.condeferred
      FROM pg_constraint k JOIN pg_class t ON t.oid=k.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='public' AND k.contype='f' ORDER BY t.relname,k.conname`)).rows;
    for (const fk of constraints) await c.query(`ALTER TABLE public.${quote(fk.table_name)} ALTER CONSTRAINT ${quote(fk.conname)} DEFERRABLE INITIALLY DEFERRED`);
    await c.query("SET CONSTRAINTS ALL DEFERRED");
    let rows = 0;
    for (const name of names.filter(t => !excluded.has(t) && t !== "schema_migrations")) {
      const cols = (await c.query(`SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position`, [name])).rows.map(x => x.column_name);
      for (const row of payload.tables[name]) {
        if (typeof row !== "string" || Object.keys(JSON.parse(row)).some(k => !cols.includes(k))) throw new Error("Unexpected backup column");
        await c.query(`INSERT INTO public.${quote(name)} (${cols.map(quote).join(",")}) OVERRIDING SYSTEM VALUE
          SELECT ${cols.map(quote).join(",")} FROM json_populate_record(NULL::public.${quote(name)},$1::json)`, [row]);
        rows++;
      }
    }
    await c.query("SET CONSTRAINTS ALL IMMEDIATE");
    for (const fk of constraints) await c.query(`ALTER TABLE public.${quote(fk.table_name)} ALTER CONSTRAINT ${quote(fk.conname)}
      ${fk.condeferrable ? `DEFERRABLE INITIALLY ${fk.condeferred ? "DEFERRED" : "IMMEDIATE"}` : "NOT DEFERRABLE"}`);
    const sequences = (await c.query(`SELECT table_name,column_name,pg_get_serial_sequence(format('%I.%I',table_schema,table_name),column_name) AS sequence
      FROM information_schema.columns WHERE table_schema='public' AND (is_identity='YES' OR column_default LIKE 'nextval%')`)).rows;
    for (const seq of sequences.filter(s => s.sequence)) {
      const value = (await c.query(`SELECT max(${quote(seq.column_name)}) AS value FROM public.${quote(seq.table_name)}`)).rows[0].value;
      await c.query("SELECT setval($1::regclass,$2,$3)", [seq.sequence, value || 1, value !== null]);
    }
    await c.query("COMMIT");
    return { tables: names.length, rows, restored_at: new Date().toISOString(), sessions_restored: false };
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
  finally { c.release(); }
}
module.exports = { backup, restore };
