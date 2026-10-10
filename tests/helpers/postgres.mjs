import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";

export async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

export async function startPostgres() {
  const dir = await mkdtemp(join(tmpdir(), "erp-pg-"));
  const port = await availablePort();
  const password = randomBytes(24).toString("hex");
  const database = new EmbeddedPostgres({
    databaseDir: join(dir, "data"), port, user: "erp_test_owner",
    password, authMethod: "scram-sha-256", persistent: true,
    postgresFlags: ["-h", "127.0.0.1", "-k", dir],
    onLog() {}, onError() {},
  });
  let owner;
  try {
    await database.initialise();
    await database.start();
    await database.createDatabase("erp_test");
    const ownerUrl = `postgresql://erp_test_owner:${password}@127.0.0.1:${port}/erp_test`;
    owner = new pg.Pool({ connectionString: ownerUrl });
    await owner.query(`CREATE ROLE erp_runtime LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
    await owner.query("GRANT CONNECT ON DATABASE erp_test TO erp_runtime");
    return {
      dir, database, owner, ownerUrl,
      runtimeUrl: `postgresql://erp_runtime:${password}@127.0.0.1:${port}/erp_test`,
      async stop() {
        await owner.end();
        await database.stop();
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (owner) await owner.end();
    await database.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
