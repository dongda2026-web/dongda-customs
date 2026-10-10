import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./helpers/api.mjs";

let f, admin, beta, social, warehouse;
before(async () => {
  f = await fixture();
  admin = await f.login(); beta = await f.login("admin", "beta");
  social = await f.login("social"); warehouse = await f.login("warehouse");
});
after(async () => { if (f) await f.stop(); });
async function create(client, path, body) {
  const r = await client.api(path, "POST", body, randomUUID());
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
}

test("partner CRUD is versioned and tenant scoped", async () => {
  const a = await create(admin, "/partners", { name: "Same customer", kind: "both", email: "a@test.invalid" });
  const b = await create(beta, "/partners", { name: "Same customer", kind: "customer" });
  assert.notEqual(a.id, b.id);
  assert.equal((await admin.api(`/partners/${b.id}`)).status, 404);
  const list = await admin.api("/partners?search=Same&page=1");
  assert.equal(list.body.items.length, 1);
  const change = await admin.api(`/partners/${a.id}`, "PATCH", { version: 1, name: "Customer revised", kind: "both" });
  assert.equal(change.status, 200);
  assert.equal(change.body.version, 2);
  assert.equal((await admin.api(`/partners/${a.id}`, "PATCH", { version: 1, name: "Stale", kind: "both" })).status, 409);
  assert.equal((await warehouse.api("/partners", "POST", { name: "Forbidden", kind: "customer" })).status, 403);
});
test("SKU codes are unique within a tenant, with validated base units and prices", async () => {
  const body = { code: "BAG-01", name: "Packing bag", unit: "pcs", price: "0.125", currency: "USD" };
  const a = await create(admin, "/products", body);
  await create(beta, "/products", body);
  assert.equal(a.price, "0.125000");
  assert.equal((await admin.api("/products", "POST", body)).status, 409);
  assert.equal((await admin.api("/products", "POST", { ...body, code: "BAD", price: "-1" })).status, 422);
  assert.equal((await admin.api("/products", "POST", { ...body, code: "BAD", unit: "" })).status, 422);
});
test("warehouse setup validates type and does not allow cross-tenant mutation", async () => {
  const a = await create(admin, "/warehouses", { code: "MAIN", name: "Main warehouse", kind: "domestic" });
  assert.equal((await beta.api(`/warehouses/${a.id}`, "PATCH", { version: 1, code: "MAIN", name: "Bad", kind: "domestic" })).status, 404);
  assert.equal((await admin.api("/warehouses", "POST", { code: "X", name: "Bad", kind: "unknown" })).status, 422);
});
test("social content requires approval and distinguishes manual publication from unconnected automation", async () => {
  const account = await create(social, "/social-accounts", { name: "Brand page", platform: "facebook", handle: "brand" });
  assert.equal(account.connection_state, "not_connected");
  let content = await create(social, "/contents", { account_id: account.id, title: "Packaging introduction", body: "Custom packing products", language: "en" });
  const act = async (action, extra = {}) => {
    const r = await social.api(`/contents/${content.id}/actions`, "POST", { action, version: content.version, ...extra }, randomUUID());
    if (r.status === 200) content = r.body;
    return r;
  };
  assert.equal((await act("publish_manual", { url: "https://example.com/post/1" })).status, 409);
  assert.equal((await act("submit")).status, 200);
  assert.equal((await act("approve")).status, 403, "social operator must not self-approve");
  let r = await admin.api(`/contents/${content.id}/actions`, "POST", { action: "approve", version: content.version }, randomUUID());
  assert.equal(r.status, 200); content = r.body;
  assert.equal((await act("schedule", { scheduled_at: new Date(Date.now() + 86400000).toISOString() })).status, 200);
  assert.equal((await act("publish_api")).status, 409);
  assert.equal((await act("publish_manual", { url: "javascript:alert(1)" })).status, 422);
  assert.equal((await act("publish_manual", { url: "https://example.com/post/1" })).status, 200);
  assert.equal(content.state, "published");
  assert.equal(content.publication_source, "manual");
  assert.equal((await beta.api(`/contents/${content.id}`)).status, 404);
});
test("content revision invalidates prior approval and preserves the version guard", async () => {
  const account = await create(social, "/social-accounts", { name: "News", platform: "linkedin", handle: "news" });
  let c = await create(social, "/contents", { account_id: account.id, title: "News", body: "Original", language: "en" });
  c = (await social.api(`/contents/${c.id}/actions`, "POST", { action: "submit", version: c.version }, randomUUID())).body;
  c = (await admin.api(`/contents/${c.id}/actions`, "POST", { action: "approve", version: c.version }, randomUUID())).body;
  const r = await social.api(`/contents/${c.id}`, "PATCH", { version: c.version, account_id: account.id, title: "New", body: "Changed", language: "en" });
  assert.equal(r.status, 200);
  assert.equal(r.body.state, "draft");
  assert.equal((await social.api(`/contents/${c.id}/actions`, "POST", { action: "schedule", version: c.version }, randomUUID())).status, 409);
});
test("lead followups retain source links, owner and due date; foreign references are rejected", async () => {
  const foreign = await create(beta, "/social-accounts", { name: "Foreign", platform: "whatsapp", handle: "foreign" });
  assert.equal((await social.api("/leads", "POST", { name: "Lead", account_id: foreign.id, need: "100 bags" })).status, 422);
  const account = await create(social, "/social-accounts", { name: "Sales", platform: "whatsapp", handle: "sales" });
  const lead = await create(social, "/leads", { name: "Alex", account_id: account.id, need: "100 bags", contact: "+000123" });
  const r = await social.api(`/leads/${lead.id}/followups`, "POST", {
    note: "Confirmed quantity", due_at: "2026-12-01T09:00:00.000Z", version: lead.version,
  }, randomUUID());
  assert.equal(r.status, 201);
  const detail = await social.api(`/leads/${lead.id}`);
  assert.equal(detail.body.account_id, account.id);
  assert.equal(detail.body.followups.length, 1);
  assert.equal(detail.body.followups[0].note, "Confirmed quantity");
});
test("same idempotency key replays the response and rejects changed content", async () => {
  const key = randomUUID();
  const body = { name: "Idempotent partner", kind: "supplier" };
  const a = await admin.api("/partners", "POST", body, key);
  const b = await admin.api("/partners", "POST", body, key);
  assert.equal(a.status, 201);
  assert.equal(b.body.id, a.body.id);
  assert.equal((await admin.api("/partners", "POST", { ...body, name: "Changed" }, key)).status, 409);
});
