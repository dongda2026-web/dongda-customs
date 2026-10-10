import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fixture } from "./helpers/api.mjs";
import { startPostgres } from "./helpers/postgres.mjs";
const require = createRequire(import.meta.url);
const { migrate } = require("../src/db");
function cli(script, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL(`../scripts/${script}.mjs`, import.meta.url).pathname, ...args], {
      env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; }); child.stderr.on("data", c => { stderr += c; });
    child.on("error", reject); child.on("close", code => resolve({ code, stdout, stderr }));
  });
}
test("recovery CLI requires explicit credentials, private keys, and named empty target; never overwrites files or exposes secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "erp-recovery-cli-"));
  const key = join(dir, "recovery.key"), file = join(dir, "snapshot.erp");
  let f, target;
  try {
    let result = await cli("backup", ["--generate-key", key]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await readFile(key)).length, 32);
    assert.equal((await stat(key)).mode & 0o777, 0o600);
    assert.notEqual((await cli("backup", ["--generate-key", key])).code, 0);
    result = await cli("backup", ["--output", file], { DATABASE_URL: "postgresql://do-not-use:secret@example.invalid/prod" });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /ERP_RECOVERY_DATABASE_URL/);
    assert.doesNotMatch(result.stderr, /secret|example.invalid/);
    f = await fixture();
    target = await startPostgres(); await migrate(target.owner);
    const env = { ERP_RECOVERY_DATABASE_URL: f.cluster.ownerUrl, ERP_RECOVERY_KEY_FILE: key };
    result = await cli("backup", ["--output", file], env);
    assert.notEqual(result.code, 0, "loopback plaintext still needs explicit permission");
    result = await cli("backup", ["--output", file, "--allow-local"], env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const original = await readFile(file);
    assert.notEqual((await cli("backup", ["--output", file, "--allow-local"], env)).code, 0);
    assert.deepEqual(await readFile(file), original);
    const targetEnv = { ...env, ERP_RECOVERY_DATABASE_URL: target.ownerUrl };
    result = await cli("restore", ["--input", file, "--allow-local"], targetEnv);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /confirm-empty-database/);
    result = await cli("restore", ["--input", file, "--allow-local", "--confirm-empty-database", "wrong_database"], targetEnv);
    assert.notEqual(result.code, 0);
    assert.equal((await target.owner.query("SELECT count(*) FROM tenants")).rows[0].count, "0");
    result = await cli("restore", ["--input", file, "--allow-local", "--confirm-empty-database", "erp_test"], targetEnv);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).sessions_restored, false);
    assert.equal((await target.owner.query("SELECT count(*) FROM tenants")).rows[0].count, "2");
    result = await cli("restore", ["--input", file, "--allow-local", "--confirm-empty-database", "erp_test"], targetEnv);
    assert.notEqual(result.code, 0, "a second restore must never overwrite existing rows");
    assert.doesNotMatch(result.stdout + result.stderr, /postgresql:|password_hash|scrypt\$/);
  } finally {
    if (target) await target.stop();
    if (f) await f.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
