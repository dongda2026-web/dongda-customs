"use strict";
const { parseArgs } = require("node:util");
const { open, readFile, unlink } = require("node:fs/promises");
const { constants } = require("node:fs");
const { randomBytes } = require("node:crypto");
const { Pool } = require("pg");
const { backup, restore } = require("./recovery");

class UsageError extends Error {}
async function privateFile(path, expectedLength) {
  if (!path) throw new UsageError("ERP_RECOVERY_KEY_FILE is required");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid()) || (expectedLength && info.size !== expectedLength)) {
      throw new UsageError("Recovery files must be owned by this user, private (0600), and have the expected size");
    }
    if (info.size > 256 * 1024 * 1024) throw new UsageError("Backup exceeds the 256 MiB CLI limit; use a reviewed large-database recovery procedure");
    return await handle.readFile();
  } finally { await handle.close(); }
}
function poolConfig(env, local) {
  if (!env.ERP_RECOVERY_DATABASE_URL) throw new UsageError("ERP_RECOVERY_DATABASE_URL is required; application DATABASE_URL is never used");
  let url;
  try { url = new URL(env.ERP_RECOVERY_DATABASE_URL); } catch { throw new UsageError("Invalid recovery database configuration"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.search || url.hash || !url.hostname || !url.username || url.pathname.length < 2) {
    throw new UsageError("Recovery database URL must identify a database and contain no query parameters");
  }
  if (local && !["127.0.0.1", "[::1]"].includes(url.hostname)) throw new UsageError("--allow-local only permits literal loopback addresses");
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.slice(1)), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
    ssl: local ? false : { rejectUnauthorized: true },
    max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000,
    statement_timeout: 120000, lock_timeout: 5000, application_name: "trade-erp-offline-recovery",
  };
}
async function exclusiveFile(path, produce) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(await produce());
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(path).catch(() => {});
    throw error;
  }
  await handle.close();
}
async function run(mode, argv = process.argv.slice(2), env = process.env) {
  let pool, key;
  try {
    const { values } = parseArgs({ args: argv, options: {
      help: { type: "boolean" }, "allow-local": { type: "boolean" },
      "generate-key": { type: "string" }, output: { type: "string" },
      input: { type: "string" }, "confirm-empty-database": { type: "string" },
    }, strict: true, allowPositionals: false });
    if (values.help) {
      console.log(mode === "backup"
        ? "backup --generate-key PATH | --output PATH [--allow-local]"
        : "restore --input PATH --confirm-empty-database NAME [--allow-local]");
      console.log("Set ERP_RECOVERY_DATABASE_URL and ERP_RECOVERY_KEY_FILE. TLS verification is required except explicit loopback mode.");
      return;
    }
    if (mode === "backup" && values["generate-key"]) {
      if (values.output || values.input) throw new UsageError("Generate a key separately from database operations");
      await exclusiveFile(values["generate-key"], async () => randomBytes(32));
      console.log(JSON.stringify({ key_created: true }));
      return;
    }
    if (mode === "backup" ? !values.output || values.input : !values.input || values.output || values["generate-key"]) {
      throw new UsageError(mode === "backup" ? "--output is required" : "--input is required");
    }
    if (mode === "restore" && !values["confirm-empty-database"]) throw new UsageError("--confirm-empty-database NAME is required");
    const config = poolConfig(env, values["allow-local"]);
    if (mode === "restore" && config.database !== values["confirm-empty-database"]) throw new UsageError("Recovery target does not match confirmed database");
    if (env.ERP_RECOVERY_TLS_CA_FILE && config.ssl) config.ssl.ca = await readFile(env.ERP_RECOVERY_TLS_CA_FILE, "utf8");
    key = await privateFile(env.ERP_RECOVERY_KEY_FILE, 32);
    pool = new Pool(config);
    const identity = (await pool.query("SELECT current_database() AS name,pg_is_in_recovery() AS replica")).rows[0];
    if (identity.name !== config.database || (mode === "restore" && identity.replica)) throw new UsageError("Recovery database identity check failed");
    if (mode === "backup") {
      await exclusiveFile(values.output, () => backup(pool, key));
      console.log(JSON.stringify({ backup_created: true, format: 2, sessions_included: false }));
    } else {
      console.log(JSON.stringify(await restore(pool, await privateFile(values.input), key)));
    }
  } catch (error) {
    // Database errors can contain values, connection details, or the offending row.
    console.error(error instanceof UsageError ? error.message
      : error.code === "EEXIST" ? "Output already exists; refusing overwrite"
      : "Recovery operation failed; verify permissions, matching schema, key, and an empty target. No database error details are emitted.");
    process.exitCode = 1;
  } finally {
    if (key) key.fill(0);
    if (pool) await pool.end();
  }
}
module.exports = { run };
