import { createRequire } from "node:module";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import pg from "pg";
import { startPostgres } from "./postgres.mjs";
const require = createRequire(import.meta.url);
const { createApp } = require("../../src/app");
const { migrate } = require("../../src/db");
const { hashPassword } = require("../../src/auth");

export async function fixture() {
  const cluster = await startPostgres();
  let pool, server;
  try {
    await migrate(cluster.owner);
    const password = randomBytes(20).toString("hex");
    const hash = await hashPassword(password);
    const tenants = { alpha: randomUUID(), beta: randomUUID() };
    await cluster.owner.query("INSERT INTO tenants(id,slug,name) VALUES ($1,'alpha','Alpha'),($2,'beta','Beta')", [tenants.alpha, tenants.beta]);
    for (const role of ["admin", "sales", "social", "purchasing", "warehouse", "auditor"]) {
      const id = randomUUID();
      await cluster.owner.query("INSERT INTO users(id,email,name,password_hash) VALUES ($1,$2,$3,$4)", [id, `${role}@test.invalid`, role, hash]);
      for (const tenant of Object.values(tenants)) {
        await cluster.owner.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES ($1,$2,$3)", [tenant, id, role]);
      }
    }
    pool = new pg.Pool({ connectionString: cluster.runtimeUrl });
    server = createServer(createApp({ pool, buildId: "integration-test", environment: "test" }));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const client = cookie => ({
      async api(path, method = "GET", body, key) {
        const res = await fetch(`${base}/api/v1${path}`, {
          method, headers: { "content-type": "application/json", "x-erp-request": "1",
            ...(cookie ? { cookie } : {}), ...(key ? { "idempotency-key": key } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: res.status, body: await res.json(), cookie: res.headers.get("set-cookie") };
      },
    });
    return {
      cluster, pool, tenants, base,
      async login(role = "admin", tenant = "alpha") {
        const r = await client().api("/auth/login", "POST", { tenant, email: `${role}@test.invalid`, password });
        if (r.status !== 200) throw new Error(JSON.stringify(r.body));
        return client(r.cookie.split(";")[0]);
      },
      async stop() {
        await new Promise(resolve => server.close(resolve));
        await pool.end();
        await cluster.stop();
      },
    };
  } catch (error) {
    if (server) await new Promise(resolve => server.close(resolve));
    if (pool) await pool.end();
    await cluster.stop();
    throw error;
  }
}
