import { test, expect } from "@playwright/test";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { fixture } from "../helpers/api.mjs";
import { availablePort } from "../helpers/postgres.mjs";
const require = createRequire(import.meta.url);
const { hashPassword } = require("../../src/auth");
const stable = v => Array.isArray(v) ? "[" + v.map(stable).join(",") + "]" : v && typeof v === "object"
  ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}" : JSON.stringify(v);
let f, child, base, password, token, ownerId, admin, customer, product, warehouse;
const sources = [];
test.beforeAll(async () => {
  f = await fixture(); password = randomBytes(20).toString("hex"); token = randomBytes(32).toString("hex");
  await f.cluster.owner.query("UPDATE users SET password_hash=$1", [await hashPassword(password)]);
  ownerId = (await f.cluster.owner.query("SELECT id FROM users WHERE email='sales@test.invalid'")).rows[0].id;
  const port = await availablePort();
  child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("../..", import.meta.url),
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "test",
      DATABASE_URL: f.cluster.runtimeUrl, DB_SSL: "false", BUILD_ID: "source-browser-test",
      ERP_WEBSITE_INTAKE_CONFIG: JSON.stringify([{ siteId: "source-test", tenantId: f.tenants.alpha, ownerId,
        tokenHash: createHash("sha256").update(token).digest("hex") }]) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error("Test server exited"); })]);
  base = `http://127.0.0.1:${port}`;
  expect(await fetch(base + "/api/health").then(r => r.json())).toMatchObject({ service: "trade-erp", build: "source-browser-test", database: "ready" });
  const login = await fetch(base + "/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json", "x-erp-request": "1" },
    body: JSON.stringify({ tenant: "alpha", email: "admin@test.invalid", password }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  admin = async (path, method = "GET", body) => {
    const res = await fetch(base + "/api/v1" + path, { method,
      headers: { cookie, "content-type": "application/json", "x-erp-request": "1", "idempotency-key": randomUUID() },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json() };
  };
  customer = (await admin("/partners", "POST", { name: "明确绑定客户", kind: "customer" })).body;
  product = (await admin("/products", "POST", { name: "内部确认商品", code: "SOURCE", unit: "pcs", price: "2", currency: "USD" })).body;
  warehouse = (await admin("/warehouses", "POST", { name: "来源验收仓", code: "SOURCE", kind: "domestic" })).body;
  for (const language of ["zh", "en", "ru"]) {
    for (const type of ["inquiry", "ai-customer-service", "multi-product-rfq", "quote-calculator", "sample-request"]) {
      sources.push(await receive(type, language));
    }
  }
});
test.afterAll(async () => {
  if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
  if (f) await f.stop();
});
async function receive(type = "inquiry", language = "en") {
  const company = `${type}-${language}-${randomUUID().slice(0, 8)}`;
  const custom = { dimensionUnit: "cm", length: "120", width: "80", height: "90", material: "PP", bagColor: "white",
    printing: "single-color", printColors: "1", loadKg: "1000", contents: "Сырьё / Resin", notes: "定制要求", technicalAdvice: true };
  const payload = { type, company, contact: "客户 Contact Клиент", email: "synthetic@example.invalid", phone: "+000",
    product: "官网商品 / Website product", productId: "not-an-erp-sku", quantity: "1000", quantityUnit: "pcs",
    specifications: "客户原始规格", notes: "<img src=x onerror=alert(1)> 原始需求", language, page: "https://example.invalid/inquiry" };
  let schemaVersion = "2026.10.08-v1";
  if (type === "multi-product-rfq") {
    Object.assign(payload, { productId: "", quantity: "", quantityUnit: "", specifications: "", destination: "Алматы", deliveryWindow: "2027-01",
      items: [1, 2].map(i => ({ lineId: "line-" + randomUUID(), productId: `web-${i}`, product: `独立产品 ${i}`,
        quantity: String(i * 100), quantityUnit: "pcs", specifications: { qty: String(i * 100), size: `${i}00 mm` },
        ...(i === 2 ? { customization: custom } : {}) })) });
    schemaVersion = "2026.10.08-v4";
  } else if (type === "quote-calculator") {
    Object.assign(payload, { specifications: { qty: "1000" }, customization: custom }); schemaVersion = "2026.10.08-v4";
  } else if (type === "sample-request") {
    Object.assign(payload, { quantity: "", quantityUnit: "", specifications: "", sampleRequest: {
      purpose: "打样 / Evaluate / Образец", quantity: "3", expectedPurchaseQuantity: "5000", requirements: "保留原文",
      recipientName: "Sample Contact", recipientPhone: "+000", country: "KZ", city: "Алматы", address: "Synthetic street",
      postalCode: "000000", costTermsAcknowledged: true } }); schemaVersion = "2026.10.08-v3";
  }
  const packet = { schemaVersion, siteId: "source-test", sourceInquiryId: "DD-" + randomUUID().toUpperCase(),
    receivedAt: new Date().toISOString(), payload };
  packet.digest = createHash("sha256").update(stable(packet)).digest("hex");
  const response = await fetch(base + "/api/v1/integrations/website-inquiries", { method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json", "idempotency-key": packet.sourceInquiryId }, body: JSON.stringify(packet) });
  expect(response.status).toBe(201);
  return { ...packet, id: (await response.json()).leadId };
}
async function login(page, role = "sales", tenant = "alpha") {
  await page.goto(base + "/erp.html");
  await page.getByLabel("企业标识").fill(tenant);
  await page.getByLabel("邮箱", { exact: true }).fill(`${role}@test.invalid`);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator("#workspace")).toBeVisible();
}
async function openLead(page, source) {
  await page.locator('[data-nav="leads"]').click();
  await page.getByRole("button", { name: source.payload.company, exact: true }).click();
  await expect(page.locator("#detail h2")).toHaveText(source.payload.company);
}
async function openSource(page) {
  const b = page.getByRole("button", { name: "查看官网来源", exact: true });
  await b.focus(); await page.keyboard.press("Enter");
  return page.locator("#website-source");
}
test.beforeEach(async ({ context }) => {
  await context.route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
});

test("source view preserves all request variants, multilingual text and independent quantities at desktop and narrow widths", async ({ page }) => {
  await login(page);
  for (const source of sources) {
    for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await openLead(page, source);
    const area = await openSource(page);
    await expect(area).toContainText(source.sourceInquiryId);
    await expect(area).toContainText("source-test");
    await expect(area).toContainText(source.payload.notes);
    await expect(area.locator("img")).toHaveCount(0);
    if (source.payload.sampleRequest) {
      await expect(area.locator('[data-source-field="sampleRequest.quantity"]')).toContainText("3");
      await expect(area.locator('[data-source-field="sampleRequest.expectedPurchaseQuantity"]')).toContainText("5000");
    }
    if (source.payload.items) {
      await expect(area.locator('[data-source-field="items.0.quantity"]')).toContainText("100");
      await expect(area.locator('[data-source-field="items.1.quantity"]')).toContainText("200");
      await expect(area).toContainText("cm"); await expect(area).toContainText("100 mm");
    }
    if (source.payload.customization) await expect(area).toContainText("cm");
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    if (source.payload.type === "sample-request" && source.payload.language === "ru") {
      await area.screenshot({ path: `/tmp/dongda-erp-source-${width}.png` });
    }
    }
  }
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test("missing source, forbidden access and failed reads are explicit and never retain old source data", async ({ page }) => {
  await login(page); await openLead(page, sources[0]);
  let area = await openSource(page); await expect(area).toContainText(sources[0].sourceInquiryId);
  for (const [status, text] of [[404, "无官网来源或无权查看"], [403, "没有查看官网来源的权限"], [503, "读取失败"]]) {
    await page.route("**/website-source", route => route.fulfill({ status, contentType: "application/json", body: '{"error":{"message":"synthetic"}}' }));
    area = await openSource(page);
    await expect(area).toContainText(text);
    await expect(area).not.toContainText(sources[0].sourceInquiryId);
    await page.unroute("**/website-source");
  }
  await page.route("**/website-source", route => route.abort("failed"));
  area = await openSource(page);
  await expect(area).toContainText("读取失败");
  await expect(area).not.toContainText(sources[0].sourceInquiryId);
});

test("late lead detail cannot replace the most recently selected lead", async ({ page }) => {
  await login(page); await page.locator('[data-nav="leads"]').click();
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/v1/leads/${sources[0].id}`, async route => { const r = await route.fetch(); started(); await gate; await route.fulfill({ response: r }); });
  await page.getByRole("button", { name: sources[0].payload.company, exact: true }).click();
  await ready;
  await page.getByRole("button", { name: sources[1].payload.company, exact: true }).click();
  await expect(page.locator("#detail h2")).toHaveText(sources[1].payload.company);
  release();
  await page.unrouteAll({ behavior: "wait" });
  await expect(page.locator("#detail h2")).toHaveText(sources[1].payload.company);
});

test("source response arriving after logout and a tenant switch never reaches the new workspace", async ({ page }) => {
  await login(page); await openLead(page, sources[0]);
  let release, started;
  const ready = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  await page.route("**/website-source", async route => { const response = await route.fetch(); started(); await gate; await route.fulfill({ response }); });
  await page.getByRole("button", { name: "查看官网来源", exact: true }).click();
  await ready;
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await page.getByLabel("企业标识").fill("beta");
  await page.getByLabel("邮箱", { exact: true }).fill("sales@test.invalid");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator("#tenant-name")).toHaveText("Beta");
  release(); await page.unrouteAll({ behavior: "wait" });
  await expect(page.locator("#workspace")).not.toContainText(sources[0].sourceInquiryId);
  await expect(page.locator("#workspace")).not.toContainText(sources[0].payload.company);
});

test("current ownership and role are rechecked when reopening or refocusing a source", async ({ page }) => {
  const source = await receive();
  await login(page); await openLead(page, source); const area = await openSource(page);
  await expect(area).toContainText(source.sourceInquiryId);
  const adminId = (await f.cluster.owner.query("SELECT id FROM users WHERE email='admin@test.invalid'")).rows[0].id;
  const lead = (await admin(`/leads/${source.id}`)).body;
  expect((await admin(`/leads/${source.id}`, "PATCH", { version: lead.version, owner_id: adminId })).status).toBe(200);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(area).not.toContainText(source.sourceInquiryId);
  await expect(area).toContainText("无官网来源或无权查看");
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await login(page, "warehouse"); await openLead(page, source); await openSource(page);
  await expect(page.locator("#website-source")).toContainText("没有查看官网来源的权限");
});

test("employee binds customer, creates quote and confirms exactly one order with source trace", async ({ page }) => {
  const source = await receive("sample-request", "ru");
  await login(page); await openLead(page, source); await openSource(page);
  await page.getByRole("button", { name: "创建报价", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("先明确绑定业务客户");
  await page.getByRole("button", { name: "编辑询盘", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("业务客户", { exact: true }).selectOption(customer.id);
  await dialog.getByRole("button", { name: "保存", exact: true }).click(); await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "创建报价", exact: true }).click(); dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("客户", { exact: true })).toHaveValue(customer.id);
  await expect(dialog.getByLabel("商品", { exact: true })).toHaveValue("");
  await expect(dialog.getByLabel("数量", { exact: true })).toHaveValue("");
  await dialog.getByLabel("商品", { exact: true }).selectOption(product.id);
  await dialog.getByLabel("仓库", { exact: true }).selectOption(warehouse.id);
  await dialog.getByLabel("数量", { exact: true }).fill("100");
  await dialog.getByRole("button", { name: "保存", exact: true }).click(); await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "发送报价", exact: true }).click();
  let first = true; const keys = [];
  await page.route("**/api/v1/quotes/*/actions", async route => {
    if (route.request().postDataJSON().action !== "accept") return route.continue();
    keys.push(route.request().headers()["idempotency-key"]);
    if (first) { first = false; expect((await route.fetch()).ok()).toBe(true); await route.abort("failed"); }
    else await route.continue();
  });
  await page.getByRole("button", { name: "接受并转订单", exact: true }).click();
  await expect(page.locator("#notice")).not.toBeEmpty();
  await page.getByRole("button", { name: "接受并转订单", exact: true }).click();
  await expect(page.locator("#workspace")).toHaveAttribute("data-view", "orders");
  expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]);
  const orders = (await admin("/orders")).body.items.filter(o => o.lead_id === source.id);
  expect(orders).toHaveLength(1); expect(orders[0].total).toBe("200.00");
  await page.getByRole("button", { name: "查看来源报价", exact: true }).click();
  await expect(page.locator("#workspace")).toHaveAttribute("data-view", "quotes");
  await page.getByRole("button", { name: "查看来源询盘", exact: true }).click();
  await expect(page.locator("#detail h2")).toHaveText(source.payload.company);
  await openSource(page); await expect(page.locator("#website-source")).toContainText(source.sourceInquiryId);
});

test("refresh clears visible source before loading a new server list", async ({ page }) => {
  await login(page); await openLead(page, sources[0]); await openSource(page);
  await expect(page.locator("#website-source")).toContainText(sources[0].sourceInquiryId);
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.locator("#detail")).toBeHidden();
  await expect(page.locator("#workspace")).not.toContainText(sources[0].sourceInquiryId);
});

test("customer binding conflict preserves the employee draft and never overwrites a newer lead", async ({ page }) => {
  const source = await receive();
  await login(page); await openLead(page, source);
  await page.getByRole("button", { name: "编辑询盘", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("业务客户", { exact: true }).selectOption(customer.id);
  await dialog.getByLabel("需求", { exact: true }).fill("员工尚未提交的编辑");
  const lead = (await admin(`/leads/${source.id}`)).body;
  expect((await admin(`/leads/${source.id}`, "PATCH", { version: lead.version, need: "另一员工已保存" })).status).toBe(200);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByRole("alert")).not.toBeEmpty();
  await expect(dialog.getByLabel("需求", { exact: true })).toHaveValue("员工尚未提交的编辑");
  const current = (await admin(`/leads/${source.id}`)).body;
  expect(current.need).toBe("另一员工已保存"); expect(current.partner_id).toBeNull();
});

test("unknown source keys stay plain text and tenant-denied reads cannot reveal the payload", async ({ page }) => {
  await login(page); await openLead(page, sources[0]);
  await page.route("**/website-source", async route => {
    const response = await route.fetch(), data = await response.json();
    data.payload["<svg onload=alert(1)>"] = "<script>not executable</script>";
    await route.fulfill({ response, json: data });
  });
  await openSource(page);
  await expect(page.locator("#website-source")).toContainText("<svg onload=alert(1)>");
  await expect(page.locator("#website-source svg, #website-source script")).toHaveCount(0);
  await page.unroute("**/website-source");
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(page.locator("#login-screen")).toBeVisible();
  const anonymous = await page.request.get(base + `/api/v1/leads/${sources[0].id}/website-source`);
  expect(anonymous.status()).toBe(401);
  await login(page, "sales", "beta");
  const denied = await page.request.get(base + `/api/v1/leads/${sources[0].id}/website-source`);
  expect(denied.status()).toBe(404);
  expect(await denied.text()).not.toContain(sources[0].sourceInquiryId);
});

test("real website forms flow through SQLite delivery into employee source, followup, quote and order", async ({ page, context }) => {
  const root = process.env.DONGDA_WEBSITE_TEST_ROOT;
  test.skip(!root, "Set DONGDA_WEBSITE_TEST_ROOT to an explicit local website checkout for cross-application verification");
  expect(isAbsolute(root)).toBe(true);
  const { InquiryStore, createInquiryServer } = await import(pathToFileURL(join(root, "server/inquiry-service.mjs")));
  const { deliverCrmInquiry } = await import(pathToFileURL(join(root, "server/crm-delivery.mjs")));
  const { staticPreview } = await import(pathToFileURL(join(root, "server/static-preview.mjs")));
  const dir = await mkdtemp(join(tmpdir(), "erp-source-website-"));
  const store = new InquiryStore(join(dir, "inquiries.sqlite"));
  const config = { crmProtocol: "four-modules-v1", crmUrl: base + "/api/v1/integrations/website-inquiries",
    crmSiteId: "source-test", crmToken: token, crmAllowLoopback: true };
  const serve = staticPreview(join(root, "dist/client"), html => html.replace("</head>",
    '<script>window.DONGDA_INQUIRY_ENDPOINT="/api/inquiries";</script></head>'));
  let api;
  const web = createServer((req, res) => req.url.startsWith("/api/") ? api.emit("request", req, res) : void serve(req, res));
  await new Promise(resolve => web.listen(0, "127.0.0.1", resolve));
  const webBase = "http://127.0.0.1:" + web.address().port;
  api = createInquiryServer(store, { ...config, adminToken: randomBytes(32).toString("hex"),
    rateSalt: randomBytes(32).toString("hex"), allowedOrigins: [webBase], localPreview: true });
  try {
    expect((await fetch(webBase + "/api/health")).status).toBe(200);
    await context.unroute("**/*");
    const errors = [], blocked = [];
    page.on("pageerror", e => errors.push(e.message));
    await context.route("**/*", route => {
      const url = new URL(route.request().url());
      if ([base, webBase].includes(url.origin) || ["data:", "blob:"].includes(url.protocol)) return route.continue();
      blocked.push(url.origin); return route.abort();
    });
    for (const [variant, language] of [["inquiry", "zh"], ["rfq", "en"], ["sample", "ru"], ["custom", "en"]]) {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(webBase + "/");
      await page.locator(`#top-bar button[onclick*="'${language}'"]`).click();
      await expect(page.locator("html")).toHaveAttribute("lang", language);
      await page.goto(webBase + (variant === "inquiry" ? "/#inquiry" : variant === "sample" ? "/#sample/fibc-bulk-bags" : "/#quote/fibc-bulk-bags"));
      const company = `真实表单合成客户-${variant}-${randomUUID().slice(0, 6)}`;
      const fill = async values => { for (const [id, value] of Object.entries(values)) await page.locator("#" + id).fill(value); };
      let submit, receiptSelector;
      if (variant === "inquiry") {
        await fill({ fi1: company, fi2: "Synthetic buyer", fi3: "endtoend@example.test", fi6: "1000" });
        await page.locator("#fi5").selectOption(await page.locator('#fi5 option[data-product-id="fibc-bulk-bags"]').getAttribute("value"));
        submit = "#inq-submit-btn"; receiptSelector = "#fok";
      } else if (variant === "sample") {
        await fill({ "sample-company": company, "sample-contact": "Synthetic buyer", "sample-email": "endtoend@example.test",
          "sample-purpose": "Сравнение образцов", "sample-quantity": "2", "sample-expectedPurchaseQuantity": "9000",
          "sample-recipientName": "Synthetic recipient", "sample-recipientPhone": "+000", "sample-country": "KZ",
          "sample-city": "Алматы", "sample-address": "Synthetic street" });
        await page.locator("#sample-costTermsAcknowledged").check(); submit = "#sample-submit"; receiptSelector = "#sample-reference";
      } else {
        if (await page.locator("#qn1").isVisible()) await page.locator("#qn1").click();
        for (const [key, value] of Object.entries({ capacity: "1000", sling: "4loop", liner: "pe", discharge: "bot" })) {
          await page.locator("#q-spec-" + key).selectOption(value);
        }
        await page.locator("#q-spec-qty").fill("1000");
        if (variant === "custom") {
          await page.locator('[data-custom-prefix="q-custom"] summary').click();
          await page.locator("#q-custom-dimensionUnit").selectOption("cm");
          await fill({ "q-custom-length": "90", "q-custom-width": "80", "q-custom-height": "110" });
          await page.locator("#qn2").click();
          await fill({ "q-company": company, "q-contact": "Synthetic buyer", "q-email": "endtoend@example.test" });
          submit = "#quote-submit-btn"; receiptSelector = "#quote-success-title";
        } else {
          await page.locator("#q-list-add").click();
          await fill({ "rfq-company": company, "rfq-contact": "Synthetic buyer", "rfq-email": "endtoend@example.test", "rfq-destination": "Almaty" });
          submit = "#rfq-list-submit"; receiptSelector = "#rfq-list-reference";
        }
      }
      const waiting = page.waitForResponse(r => r.url() === webBase + "/api/inquiries" && r.request().method() === "POST");
      await page.locator(submit).click(); const response = await waiting;
      expect(response.status()).toBe(201); const receipt = await response.json();
      await expect(page.locator(receiptSelector)).toContainText(receipt.leadId);
      const delivery = await deliverCrmInquiry(store, config);
      expect(delivery.ok).toBe(true); expect(delivery.id).toBe(receipt.leadId);
      expect(store.get(receipt.leadId).notification.status).toBe("pending");
      await login(page);
      await openLead(page, { payload: { company } });
      await openSource(page); await expect(page.locator("#website-source")).toContainText(receipt.leadId);
      if (variant === "sample") {
        await expect(page.locator('[data-source-field="sampleRequest.quantity"]')).toContainText("2");
        await expect(page.locator('[data-source-field="sampleRequest.expectedPurchaseQuantity"]')).toContainText("9000");
      }
      await page.getByRole("button", { name: "新增跟进", exact: true }).click();
      let dialog = page.getByRole("dialog");
      await dialog.getByLabel("跟进内容", { exact: true }).fill("已人工核实来源需求，正式订购100件");
      await dialog.getByRole("button", { name: "保存", exact: true }).click(); await expect(dialog).not.toBeVisible();
      await page.getByRole("button", { name: "编辑询盘", exact: true }).click(); dialog = page.getByRole("dialog");
      await dialog.getByLabel("业务客户", { exact: true }).selectOption(customer.id);
      await dialog.getByRole("button", { name: "保存", exact: true }).click(); await expect(dialog).not.toBeVisible();
      await page.getByRole("button", { name: "创建报价", exact: true }).click(); dialog = page.getByRole("dialog");
      await dialog.getByLabel("商品", { exact: true }).selectOption(product.id);
      await dialog.getByLabel("仓库", { exact: true }).selectOption(warehouse.id);
      await dialog.getByLabel("数量", { exact: true }).fill("100");
      await dialog.getByRole("button", { name: "保存", exact: true }).click(); await expect(dialog).not.toBeVisible();
      await page.getByRole("button", { name: "发送报价", exact: true }).click();
      await page.getByRole("button", { name: "接受并转订单", exact: true }).click();
      await expect(page.locator("#workspace")).toHaveAttribute("data-view", "orders");
      const orders = (await admin("/orders")).body.items.filter(o => o.lead_id === delivery.mainLeadId);
      expect(orders).toHaveLength(1); expect(orders[0].total).toBe("200.00");
      await page.getByRole("button", { name: "查看来源询盘", exact: true }).click();
      await openSource(page); await expect(page.locator("#website-source")).toContainText(receipt.leadId);
      expect((await admin(`/leads/${delivery.mainLeadId}/website-source`)).body.payload).toEqual(store.get(receipt.leadId).lead);
      expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
      await page.getByRole("button", { name: "退出", exact: true }).click();
      await expect(page.locator("#login-screen")).toBeVisible();
    }
    expect(errors).toEqual([]); expect(blocked).toEqual([]);
  } finally {
    await new Promise(resolve => web.close(resolve)); store.close(); await rm(dir, { recursive: true, force: true });
  }
});
