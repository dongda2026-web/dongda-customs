import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { startPostgres } from "../tests/helpers/postgres.mjs";
const require = createRequire(import.meta.url);
const { migrate } = require("../src/db");
const { hashPassword } = require("../src/auth");

const cluster = await startPostgres();
let child, stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (child && child.exitCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  await cluster.stop();
}
process.on("SIGINT", () => stop().then(() => process.exit(0)));
process.on("SIGTERM", () => stop().then(() => process.exit(0)));
try {
  await migrate(cluster.owner);
  const password = randomBytes(18).toString("base64url");
  const hash = await hashPassword(password);
  const tenantId = randomUUID(), secondId = randomUUID();
  await cluster.owner.query("INSERT INTO tenants(id,slug,name) VALUES ($1,'dongda-demo','东大 · 合成验收'),($2,'second-demo','第二企业 · 隔离验收')", [tenantId, secondId]);
  for (const role of ["admin", "sales", "social", "purchasing", "warehouse", "auditor"]) {
    const userId = randomUUID();
    await cluster.owner.query("INSERT INTO users(id,email,name,password_hash) VALUES ($1,$2,$3,$4)",
      [userId, `${role}@local.test`, role, hash]);
    for (const tid of [tenantId, secondId]) await cluster.owner.query("INSERT INTO memberships(tenant_id,user_id,role) VALUES ($1,$2,$3)", [tid, userId, role]);
  }
  const port = process.env.PORT || "3189";
  child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: port, NODE_ENV: "development",
      DATABASE_URL: cluster.runtimeUrl, DB_SSL: "false", BUILD_ID: "four-modules-local-dev", ANTHROPIC_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", chunk => process.stderr.write(chunk));
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(([code]) => { throw new Error(`Application startup failed: ${code}`); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Startup timeout")), 15000); timer.unref(); }),
  ]);
  const base = `http://127.0.0.1:${port}`;
  const health = await fetch(`${base}/api/health`).then(r => r.json());
  if (health.service !== "trade-erp" || health.database !== "ready") throw new Error("Local identity check failed");
  const stateFile = process.env.LOCAL_STATE_FILE || "/tmp/dongda-erp-local-session.json";
  await writeFile(stateFile, JSON.stringify({ base, tenant: "dongda-demo", email: "admin@local.test", password, databaseDir: cluster.dir }, null, 2), { mode: 0o600 });
  await chmod(stateFile, 0o600);
  console.log(`Local ERP: ${base}/erp.html\nSynthetic credentials: ${stateFile}\nTemporary isolated data; this is not production.`);
  child.stdout.on("data", chunk => process.stdout.write(chunk));
  child.once("exit", () => { if (!stopping) stop().then(() => process.exit(1)); });
} catch (error) {
  await stop();
  throw error;
}
