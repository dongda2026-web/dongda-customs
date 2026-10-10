import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { startPostgres } from "./helpers/postgres.mjs";

const require = createRequire(import.meta.url);
test("versioned migrations and runtime RLS isolate tenants in a real database", async () => {
  assert.equal(existsSync(new URL("../src/db.js", import.meta.url)), true, "database module must exist");
  const { migrate, withTenant } = require("../src/db");
  const cluster = await startPostgres();
  const runtime = new pg.Pool({ connectionString: cluster.runtimeUrl });
  try {
    const first = await migrate(cluster.owner, "erp_runtime");
    assert.ok(first >= 1);
    assert.equal(await migrate(cluster.owner, "erp_runtime"), first);
    const a = randomUUID(), b = randomUUID();
    await cluster.owner.query("INSERT INTO tenants(id,slug,name) VALUES ($1,'alpha','Alpha'),($2,'beta','Beta')", [a, b]);
    await cluster.owner.query("INSERT INTO tenant_settings(tenant_id,data) VALUES ($1,$2),($3,$4)", [a, { marker: "alpha" }, b, { marker: "beta" }]);
    assert.deepEqual((await runtime.query("SELECT * FROM tenant_settings")).rows, []);
    const alpha = await withTenant(runtime, a, c => c.query("SELECT * FROM tenant_settings"));
    assert.equal(alpha.rows.length, 1);
    assert.equal(alpha.rows[0].data.marker, "alpha");
    await assert.rejects(withTenant(runtime, a, c =>
      c.query("INSERT INTO tenant_settings(tenant_id,data) VALUES ($1,'{}')", [b])), /row-level security/);
    const leaked = await withTenant(runtime, a, c =>
      c.query("UPDATE tenant_settings SET data='{}' WHERE tenant_id=$1 RETURNING *", [b]));
    assert.equal(leaked.rowCount, 0);
    assert.equal((await runtime.query("SELECT * FROM tenant_settings")).rowCount, 0, "transaction scope must not leak through pool");
    await assert.rejects(withTenant(runtime, a, async c => {
      await c.query("UPDATE tenant_settings SET data='{\"marker\":\"bad\"}'");
      throw new Error("rollback proof");
    }), /rollback proof/);
    const current = await withTenant(runtime, a, c => c.query("SELECT data FROM tenant_settings"));
    assert.equal(current.rows[0].data.marker, "alpha");
    const role = (await runtime.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
    assert.equal(role.rolsuper, false);
    assert.equal(role.rolbypassrls, false);
    await assert.rejects(runtime.query("DELETE FROM audit_log"), /permission denied/);
  } finally {
    await runtime.end();
    await cluster.stop();
  }
});
