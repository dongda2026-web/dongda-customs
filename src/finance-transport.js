"use strict";
const { randomUUID, createHash } = require("node:crypto");
const { withTenant } = require("./db");
const { AppError, text } = require("./http");
const r = require("./records");

function validateBinding(binding) {
  r.uuid(binding.tenantId, "tenant binding");
  text(binding.accountSet, "accountSet", 100);
  if (typeof binding.token !== "string" || binding.token.length < 32) throw new Error("A scoped finance service token is required");
  const url = new URL(binding.endpoint);
  const local = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(binding.allowLocalHttp === true && local && url.protocol === "http:"))) {
    throw new Error("Finance endpoint must use HTTPS or explicit loopback test mode");
  }
  return url;
}
async function deliverTenant(pool, binding) {
  validateBinding(binding);
  const lease = randomUUID();
  const event = await withTenant(pool, binding.tenantId, async c => {
    const row = (await c.query(`SELECT e.* FROM finance_outbox e WHERE e.tenant_id=$1
      AND ((e.state IN ('pending','failed') AND e.retry_at<=now()) OR (e.state='sending' AND e.lease_until<now()))
      AND e.attempts<10
      AND NOT EXISTS(SELECT 1 FROM finance_outbox prior WHERE prior.tenant_id=e.tenant_id AND prior.document_id=e.document_id
        AND prior.document_version<e.document_version AND prior.state<>'accepted')
      ORDER BY e.created_at,e.id FOR UPDATE SKIP LOCKED LIMIT 1`, [binding.tenantId])).rows[0];
    if (!row) return null;
    await c.query(`UPDATE finance_outbox SET state='sending',attempts=attempts+1,lease_token=$3,lease_until=now()+interval '60 seconds'
      WHERE tenant_id=$1 AND id=$2`, [binding.tenantId, row.id, lease]);
    return { ...row, attempts: row.attempts + 1 };
  });
  if (!event) return null;
  let remoteId = null, code = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(binding.endpoint, {
      method: "POST", redirect: "error", signal: controller.signal,
      headers: { authorization: `Bearer ${binding.token}`, "content-type": "application/json", "idempotency-key": event.id },
      body: JSON.stringify({ ...event.payload, account_set: binding.accountSet }),
    });
    if (!response.ok) { code = response.status === 401 || response.status === 403 ? "AUTHORIZATION_FAILED" : "UPSTREAM_UNAVAILABLE"; }
    else {
      const chunks = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 16384) { controller.abort(); throw new Error("Receipt too large"); }
        chunks.push(chunk);
      }
      const receipt = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (receipt.service !== "dongda-finance" || receipt.tenant_id !== binding.tenantId ||
          receipt.event_id !== event.id || receipt.state !== "pending_review" ||
          typeof receipt.financial_record_id !== "string" || !receipt.financial_record_id || receipt.financial_record_id.length > 200) {
        code = "INVALID_RECEIPT";
      } else remoteId = receipt.financial_record_id;
    }
  } catch { code = controller.signal.aborted ? "DELIVERY_TIMEOUT" : "DELIVERY_FAILED"; }
  finally { clearTimeout(timer); }
  return withTenant(pool, binding.tenantId, async c => {
    const state = code ? "failed" : "accepted";
    return (await c.query(`UPDATE finance_outbox SET state=$4,remote_id=$5,error_code=$6,lease_token=NULL,lease_until=NULL,
      retry_at=now()+($7::integer*interval '1 second'),accepted_at=CASE WHEN $4='accepted' THEN now() ELSE accepted_at END
      WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 RETURNING *`,
    [binding.tenantId, event.id, lease, state, remoteId, code, Math.min(3600, 30 * 2 ** (event.attempts - 1))])).rows[0] || null;
  });
}

async function ingestResult(pool, binding, body) {
  r.uuid(binding.tenantId, "tenant binding");
  if (body.tenant_id !== binding.tenantId) throw new AppError(403, "BINDING_MISMATCH", "Tenant does not match binding");
  r.uuid(body.event_id); r.uuid(body.document_id);
  const recordId = text(body.financial_record_id, "financial_record_id");
  if (!Number.isInteger(body.source_version) || body.source_version < 1 || !Number.isInteger(body.result_version) || body.result_version < 1) {
    throw new AppError(422, "INVALID_VERSION", "Invalid finance result version");
  }
  const status = r.choice(body.status, "status", ["pending_review", "approved", "rejected", "partially_settled", "settled", "reversed"]);
  const amount = r.decimal(body.settled_amount, "settled_amount");
  const hash = createHash("sha256").update(JSON.stringify([body.event_id, body.document_id, body.source_version, recordId, body.result_version, status, body.currency, amount])).digest("hex");
  return withTenant(pool, binding.tenantId, async c => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`finance-result:${binding.tenantId}:${recordId}`]);
    const event = (await c.query("SELECT * FROM finance_outbox WHERE tenant_id=$1 AND id=$2", [binding.tenantId, body.event_id])).rows[0];
    if (!event || event.document_id !== body.document_id || event.document_version !== body.source_version ||
        event.state !== "accepted" || event.remote_id !== recordId) {
      throw new AppError(422, "INVALID_FINANCE_SOURCE", "Finance source receipt is not recognized");
    }
    if (body.currency !== event.payload.document.currency) throw new AppError(422, "CURRENCY_MISMATCH", "Finance currency mismatch");
    const total = new r.Decimal(event.payload.document.total);
    if (new r.Decimal(amount).gt(total) ||
      (["pending_review", "approved", "rejected", "reversed"].includes(status) && !new r.Decimal(amount).isZero()) ||
      (status === "settled" && !new r.Decimal(amount).eq(total)) ||
      (status === "partially_settled" && (new r.Decimal(amount).lte(0) || new r.Decimal(amount).gte(total)))) {
      throw new AppError(422, "AMOUNT_MISMATCH", "Invalid settled amount for status");
    }
    const prior = (await c.query("SELECT * FROM finance_results WHERE tenant_id=$1 AND financial_record_id=$2 ORDER BY result_version DESC LIMIT 1",
      [binding.tenantId, recordId])).rows[0];
    const same = (await c.query("SELECT * FROM finance_results WHERE tenant_id=$1 AND financial_record_id=$2 AND result_version=$3",
      [binding.tenantId, recordId, body.result_version])).rows[0];
    if (same) {
      if (same.payload_hash !== hash) throw new AppError(409, "RESULT_CONFLICT", "Result version reused with different content");
      return same;
    }
    if (prior && body.result_version !== prior.result_version + 1) throw new AppError(409, "RESULT_OUT_OF_ORDER", "Finance result version out of order");
    if (!prior && body.result_version !== 1) throw new AppError(409, "RESULT_OUT_OF_ORDER", "First finance result must be version 1");
    return (await c.query(`INSERT INTO finance_results(tenant_id,id,event_id,document_id,source_version,result_version,financial_record_id,status,currency,settled_amount,payload_hash)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [binding.tenantId, randomUUID(), body.event_id, body.document_id, body.source_version, body.result_version, recordId, status, body.currency, amount, hash])).rows[0];
  });
}
module.exports = { validateBinding, deliverTenant, ingestResult };
