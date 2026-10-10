import { test, expect } from "@playwright/test";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { fixture } from "../helpers/api.mjs";
import { availablePort } from "../helpers/postgres.mjs";
const require = createRequire(import.meta.url);
let f, child, base, password, admin, order;
test.beforeAll(async () => {
  f = await fixture(); password = randomBytes(20).toString("hex");
  admin = await f.login();
  await f.cluster.owner.query("UPDATE users SET password_hash=$1", [await require("../../src/auth").hashPassword(password)]);
  await admin.api("/settings", "PATCH", { version: 0, data: { name: "Export Test Company", address: "Synthetic exporter address" } });
  const partner = (await admin.api("/partners", "POST", { name: "Synthetic buyer", address: "Synthetic buyer address", kind: "customer" })).body;
  const product = (await admin.api("/products", "POST", { name: "Verified bag", code: "BROWSER-DOC", unit: "pcs", price: "2", currency: "USD" })).body;
  const warehouse = (await admin.api("/warehouses", "POST", { name: "Warehouse", code: "BROWSER-DOC", kind: "domestic" })).body;
  await admin.api("/inventory/opening", "POST", { warehouse_id: warehouse.id, product_id: product.id, quantity: "10" }, randomUUID());
  order = (await admin.api("/orders", "POST", { partner_id: partner.id, warehouse_id: warehouse.id, currency: "USD",
    terms: "FCA Test City", lines: [{ product_id: product.id, quantity: "10", price: "2" }] }, randomUUID())).body;
  for (const action of ["submit", "approve"]) order = (await admin.api(`/orders/${order.id}/actions`, "POST", { version: order.version, action }, randomUUID())).body;
  order = (await admin.api(`/orders/${order.id}/ship`, "POST", { version: order.version,
    lines: [{ line_id: order.lines[0].id, quantity: "3" }] }, randomUUID())).body;
  const port = await availablePort(); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.js"], { cwd: new URL("../..", import.meta.url),
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "test", DATABASE_URL: f.cluster.runtimeUrl,
      DB_SSL: "false", BUILD_ID: "documents-browser-test" }, stdio: ["ignore", "pipe", "pipe"] });
  await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error("Server exited"); })]);
  expect(await fetch(base + "/api/health").then(r => r.json())).toMatchObject({ service: "trade-erp", build: "documents-browser-test", schemaVersion: 40 });
});
test.afterAll(async () => {
  if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
  if (f) await f.stop();
});
test.beforeEach(async ({ page, context }) => {
  await context.route("**/*", route => new URL(route.request().url()).origin === base || route.request().url().startsWith("blob:") ? route.continue() : route.abort());
  await page.goto(base);
  await page.getByLabel("企业标识").fill("alpha");
  await page.getByLabel("邮箱", { exact: true }).fill("admin@test.invalid");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator("#workspace")).toBeVisible();
  await page.locator('[data-nav="orders"]').click();
  await page.getByRole("button", { name: order.number, exact: true }).click();
});
test("employee issues a batch invoice, previews and downloads the exact stored artifact", async ({ page }) => {
  await page.getByRole("button", { name: "生成单证", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("模板", { exact: true }).selectOption("invoice");
  await dialog.getByLabel("单证语言", { exact: true }).selectOption("en");
  await dialog.getByLabel("资料确认", { exact: true }).selectOption("yes");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const issued = (await admin.api(`/documents?document_id=${order.id}`)).body.items[0];
  const iframe = page.frameLocator('iframe[title="单证预览"]');
  await expect(iframe.getByRole("heading", { name: "COMMERCIAL INVOICE" })).toBeVisible();
  await expect(iframe.locator("body")).toContainText("6.00 USD");
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 HTML", exact: true }).click();
  const download = await downloadEvent;
  const bytes = await readFile(await download.path());
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(issued.sha256);
  const printPage = await page.context().newPage();
  try {
    await printPage.setContent(bytes.toString("utf8"));
    await expect(printPage.getByRole("heading", { name: "COMMERCIAL INVOICE" })).toBeVisible();
    const pdf = await printPage.pdf({ path: "/tmp/dongda-document-invoice.pdf", format: "A4", printBackground: true });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    await printPage.screenshot({ path: "/tmp/dongda-document-invoice.png", fullPage: true });
  } finally { await printPage.close(); }
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  await page.getByRole("button", { name: "打印 / PDF", exact: true }).click();
  expect(errors).toEqual([]);
  await page.setViewportSize({ width: 390, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(page.locator("#login-screen")).toBeVisible();
  await expect(page.locator('iframe[title="单证预览"]')).toHaveCount(0);
});
test("packing errors preserve input and stale documents require explicit historical export", async ({ page }) => {
  await page.getByRole("button", { name: "生成单证", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("模板", { exact: true }).selectOption("packing_list");
  await dialog.getByLabel("件数", { exact: true }).fill("2");
  await dialog.getByLabel("毛重 kg", { exact: true }).fill("1");
  await dialog.getByLabel("净重 kg", { exact: true }).fill("3");
  await dialog.getByLabel("唛头", { exact: true }).fill("N/M");
  await dialog.getByLabel("资料确认", { exact: true }).selectOption("yes");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("gross weight");
  await expect(dialog.getByLabel("净重 kg", { exact: true })).toHaveValue("3");
  await dialog.getByLabel("毛重 kg", { exact: true }).fill("4");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  order = (await admin.api(`/orders/${order.id}`, "PATCH", { version: order.version, terms: "DAP Changed City" }, randomUUID())).body;
  await page.getByRole("button", { name: "单证档案", exact: true }).click();
  await expect(page.locator("#issued-documents")).toContainText("已过期 / 待重审");
  await page.locator("#issued-documents").getByRole("button", { name: /^PKL-/ }).click();
  await expect(page.locator("#issued-documents")).toContainText("仅可导出历史版本");
  await expect(page.locator('iframe[title="单证预览"]')).toHaveCount(0);
  await page.getByRole("button", { name: "明确查看历史快照", exact: true }).click();
  await expect(page.frameLocator('iframe[title="单证预览"]').locator("body")).toContainText("FCA Test City");
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载历史 HTML", exact: true }).click();
  expect((await downloadEvent).suggestedFilename()).toContain("-HISTORICAL.html");
});
