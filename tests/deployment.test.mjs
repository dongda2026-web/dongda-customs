import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { availablePort, startPostgres } from "./helpers/postgres.mjs";

async function startServer(env) {
  const port = await availablePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url),
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "production", BUILD_ID: "deployment-test", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://127.0.0.1:${port}`;
  await Promise.race([
    once(child.stdout, "data"),
    once(child, "exit").then(([code]) => { throw new Error(`Server exited before ready: ${code}`); }),
  ]);
  return { child, base, async stop() {
    if (child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
  } };
}

test("production server migrates an empty database before reporting healthy", async () => {
  const cluster = await startPostgres();
  let server;
  try {
    server = await startServer({ DATABASE_URL: cluster.ownerUrl, DB_SSL: "false" });
    const health = await fetch(`${server.base}/api/health`).then(r => r.json());
    assert.equal(health.service, "trade-erp");
    assert.equal(health.database, "ready");
    assert.equal(health.schemaVersion, 40);
    assert.equal((await cluster.owner.query("SELECT max(version) AS version FROM schema_migrations")).rows[0].version, 40);
  } finally {
    if (server) await server.stop();
    await cluster.stop();
  }
});

test("legacy anonymous APIs stay closed while the ERP API is mounted", async () => {
  let server;
  try {
    server = await startServer({});
    for (const path of ["/api/config", "/api/tickets/list", "/api/archive/list", "/api/recognize"]) {
      const write = path === "/api/recognize";
      const response = await fetch(`${server.base}${path}`, {
        method: write ? "POST" : "GET",
        headers: { "content-type": "application/json", "x-erp-request": "1" },
        ...(write ? { body: JSON.stringify({ files: [] }) } : {}),
      });
      assert.equal(response.headers.get("content-type")?.includes("application/json"), true, `${path} must answer JSON`);
      assert.equal(response.status, 401, `${path} must reject anonymous calls`);
      assert.equal((await response.json()).error.code, "UNAUTHENTICATED");
    }
  } finally {
    if (server) await server.stop();
  }
});
