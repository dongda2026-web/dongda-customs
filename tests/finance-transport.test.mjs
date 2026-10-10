import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fixture } from "./helpers/api.mjs";
const require = createRequire(import.meta.url);
test("finance delivery verifies receipts, rejects redirects, persists retries, and separates tenants", async () => {
  assert.ok(existsSync(new URL("../src/finance-transport.js", import.meta.url)), "finance transport must exist");
  const { deliverTenant, ingestResult } = require("../src/finance-transport");
  const f = await fixture(); let server;
  try {
    const admin = await f.login();
    const tenant = f.tenants.alpha, document = randomUUID(), event = randomUUID(), partner = randomUUID();
    await f.cluster.owner.query("INSERT INTO partners(tenant_id,id,name,kind) VALUES ($1,$2,'Synthetic','customer')", [tenant, partner]);
    const user = (await f.cluster.owner.query("SELECT user_id FROM memberships WHERE tenant_id=$1 AND role='admin'", [tenant])).rows[0].user_id;
    await f.cluster.owner.query(`INSERT INTO trade_documents(tenant_id,id,kind,number,partner_id,currency,state,total,version,created_by)
      VALUES($1,$2,'order','SO-transport',$3,'USD','confirmed',100,3,$4)`, [tenant, document, partner, user]);
    const payload = { schema_version: 1, tenant_id: tenant, event_id: event, document: { id: document, version: 3, currency: "USD", total: "100.00" } };
    await f.cluster.owner.query(`INSERT INTO finance_outbox(tenant_id,id,document_id,document_version,event_type,payload)
      VALUES($1,$2,$3,3,'order.approve',$4)`, [tenant, event, document, payload]);
    let mode = "failure", requests = 0;
    server = createServer(async (req, res) => {
      requests++; const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks));
      assert.equal(req.headers.authorization, "Bearer synthetic-service-token-long-enough");
      assert.equal(input.tenant_id, tenant);
      if (mode === "failure") { res.writeHead(503); return res.end("synthetic failure"); }
      if (mode === "redirect") { res.writeHead(302, { location: "https://example.invalid" }); return res.end(); }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ service: "dongda-finance", tenant_id: tenant, event_id: event,
        financial_record_id: "finance-inbox-1", state: mode === "invalid" ? "posted" : "pending_review" }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const binding = { tenantId: tenant, accountSet: "synthetic-book", endpoint: `http://127.0.0.1:${server.address().port}/api/integrations/erp/events`,
      token: "synthetic-service-token-long-enough", allowLocalHttp: true };
    assert.equal(await deliverTenant(f.pool, { ...binding, tenantId: f.tenants.beta }), null);
    assert.equal(requests, 0);
    let result = await deliverTenant(f.pool, binding);
    assert.equal(result.state, "failed");
    assert.equal(result.error_code, "UPSTREAM_UNAVAILABLE");
    assert.equal(await deliverTenant(f.pool, binding), null, "backoff must prevent immediate retry");
    for (const nextMode of ["redirect", "invalid", "success"]) {
      mode = nextMode;
      await f.cluster.owner.query("UPDATE finance_outbox SET retry_at=now(),state='pending' WHERE id=$1", [event]);
      result = await deliverTenant(f.pool, binding);
      assert.equal(result.state, nextMode === "success" ? "accepted" : "failed");
    }
    assert.equal(result.remote_id, "finance-inbox-1");
    assert.equal(requests, 4);
    assert.equal((await admin.api("/finance/events")).body.items[0].state, "accepted");
    const callback = { event_id: event, tenant_id: tenant, document_id: document, source_version: 3,
      financial_record_id: "finance-inbox-1", result_version: 1, status: "partially_settled", currency: "USD", settled_amount: "25.00" };
    const first = await ingestResult(f.pool, binding, callback);
    const replay = await ingestResult(f.pool, binding, callback);
    assert.equal(first.id, replay.id);
    await assert.rejects(ingestResult(f.pool, binding, { ...callback, settled_amount: "50" }), /reused/);
    await assert.rejects(ingestResult(f.pool, binding, { ...callback, tenant_id: f.tenants.beta }), /binding/);
    await assert.rejects(ingestResult(f.pool, binding, { ...callback, result_version: 2, currency: "EUR" }), /currency/);
    await assert.rejects(ingestResult(f.pool, binding, { ...callback, result_version: 2, settled_amount: "101" }), /amount/);
    const settled = await ingestResult(f.pool, binding, { ...callback, result_version: 2, status: "settled", settled_amount: "100" });
    assert.equal(settled.status, "settled");
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await f.stop();
  }
});
