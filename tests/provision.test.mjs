import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { startPostgres } from "./helpers/postgres.mjs";
const require = createRequire(import.meta.url);

function run(env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["scripts/provision.mjs"], {
      cwd: new URL("..", import.meta.url),
      env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; });
    child.stderr.on("data", c => { stderr += c; });
    child.once("exit", code => resolve({ code, stdout, stderr }));
  });
}

test("provisioning creates one tenant and administrator, and is idempotent", async () => {
  const cluster = await startPostgres();
  try {
    const env = {
      DATABASE_URL: cluster.ownerUrl, DB_SSL: "false",
      ERP_TENANT_SLUG: "dongda-demo", ERP_TENANT_NAME: "Dong Da Demo",
      ERP_ADMIN_EMAIL: "owner@example.invalid", ERP_ADMIN_PASSWORD: "Synthetic-Provision-Password-2026",
    };
    const first = await run(env);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stdout.includes("Synthetic-Provision-Password-2026"), false, "must never print the password");

    const tenants = await cluster.owner.query("SELECT id,slug,name,active FROM tenants WHERE slug='dongda-demo'");
    assert.equal(tenants.rowCount, 1);
    const users = await cluster.owner.query("SELECT id,email,active FROM users WHERE email='owner@example.invalid'");
    assert.equal(users.rowCount, 1);
    const membership = await cluster.owner.query(
      "SELECT role,active FROM memberships WHERE tenant_id=$1 AND user_id=$2", [tenants.rows[0].id, users.rows[0].id]);
    assert.equal(membership.rowCount, 1);
    assert.equal(membership.rows[0].role, "admin");
    assert.equal(membership.rows[0].active, true);

    const second = await run(env);
    assert.equal(second.code, 0, second.stderr);
    assert.equal((await cluster.owner.query("SELECT count(*) FROM tenants WHERE slug='dongda-demo'")).rows[0].count, "1");
    assert.equal((await cluster.owner.query("SELECT count(*) FROM users WHERE email='owner@example.invalid'")).rows[0].count, "1");
    assert.equal((await cluster.owner.query("SELECT count(*) FROM memberships")).rows[0].count, "1");

    const { hashPassword, verifyPassword } = require("../src/auth");
    const hash = (await cluster.owner.query("SELECT password_hash FROM users WHERE email='owner@example.invalid'")).rows[0].password_hash;
    assert.equal(await verifyPassword("Synthetic-Provision-Password-2026", hash), true);
    assert.equal(await verifyPassword("Wrong-Password", hash), false);
    assert.equal(typeof hashPassword, "function");
  } finally {
    await cluster.stop();
  }
});

test("provisioning refuses to run without an explicit database and required identity", async () => {
  const missing = await run({ ERP_TENANT_SLUG: "x", ERP_TENANT_NAME: "X", ERP_ADMIN_EMAIL: "a@b.invalid", ERP_ADMIN_PASSWORD: "pw-1234567890" });
  assert.notEqual(missing.code, 0, "must fail without DATABASE_URL");
});
