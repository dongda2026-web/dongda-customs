import { test, expect } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fixture } from "../helpers/api.mjs";
import { availablePort } from "../helpers/postgres.mjs";
const require = createRequire(import.meta.url);
let f, child, base, password, admin, ids;
test.beforeEach(async () => {
  f = await fixture(); admin = await f.login();
  ids = Object.fromEntries((await f.cluster.owner.query("SELECT id,name FROM users")).rows.map(r => [r.name, r.id]));
  password = randomBytes(20).toString("hex");
  await f.cluster.owner.query("UPDATE users SET password_hash=$1", [await require("../../src/auth").hashPassword(password)]);
  const port = await availablePort(); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.js"], { cwd: new URL("../..", import.meta.url),
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", PORT: String(port), NODE_ENV: "test",
      DATABASE_URL: f.cluster.runtimeUrl, DB_SSL: "false", BUILD_ID: "members-browser-test" },
    stdio: ["ignore", "pipe", "pipe"] });
  await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw new Error("Server exited"); })]);
  expect(await fetch(base + "/api/health").then(r => r.json())).toMatchObject({
    service: "trade-erp", build: "members-browser-test", schemaVersion: 40, database: "ready",
  });
});
test.afterEach(async () => {
  if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
  if (f) await f.stop();
  child = null; f = null;
});
async function login(page, role = "admin", tenant = "alpha") {
  await page.context().route("**/*", route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  await page.goto(base);
  await page.getByLabel("企业标识").fill(tenant);
  await page.getByLabel("邮箱", { exact: true }).fill(`${role}@test.invalid`);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByLabel("密码", { exact: true }).press("Enter");
  await expect(page.locator("#workspace")).toBeVisible();
}
async function select(page, name) {
  await expect(page.getByRole("button", { name: "企业成员", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "企业成员", exact: true }).click();
  await page.locator("#table-region").getByRole("button", { name, exact: true }).click();
}
async function change(page, { role, active, reason = "Synthetic membership change" } = {}) {
  await page.getByRole("button", { name: "调整成员权限", exact: true }).click();
  const dialog = page.getByRole("dialog");
  if (role) await dialog.getByLabel("本企业角色", { exact: true }).selectOption(role);
  if (active !== undefined) await dialog.getByLabel("本企业状态", { exact: true }).selectOption(String(active));
  await dialog.getByLabel("操作原因", { exact: true }).fill(reason);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  return dialog;
}
test("administrator changes role and old session clears on next request, while another enterprise stays signed in", async ({ page, browser }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  try {
    const sales = await a.newPage(), beta = await b.newPage();
    await login(sales, "sales"); await login(beta, "sales", "beta"); await login(page);
    await expect(sales.getByRole("button", { name: "企业成员", exact: true })).toHaveCount(0);
    await sales.locator('[data-nav="partners"]').click();
    await select(page, "sales");
    await expect(await change(page, { role: "auditor" })).not.toBeVisible();
    await expect(page.locator("#detail")).toContainText("审计");
    await sales.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(sales.locator("#login-screen")).toBeVisible();
    await expect(sales.locator("#table-region")).toBeEmpty();
    await beta.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(beta.locator("#workspace")).toBeVisible();
    expect((await b.request.get(base + "/api/v1/auth/me")).status()).toBe(200);
    await login(sales, "sales");
    await expect(sales.locator("#user-name")).toContainText("审计");
  } finally { await a.close(); await b.close(); }
});
test("disable then restore never revives the previous session and mobile member view stays usable", async ({ page, browser }) => {
  const context = await browser.newContext();
  try {
    const employee = await context.newPage(); await login(employee, "social"); await login(page);
    await select(page, "social");
    await expect(await change(page, { active: false })).not.toBeVisible();
    await expect(page.locator("#detail")).toContainText("停用");
    await expect(await change(page, { active: true })).not.toBeVisible();
    expect((await context.request.get(base + "/api/v1/bootstrap")).status()).toBe(401);
    await employee.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(employee.locator("#login-screen")).toBeVisible();
    await login(employee, "social");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    await page.screenshot({ path: "/tmp/dongda-members-390.png", fullPage: true });
  } finally { await context.close(); }
});
test("last administrator and concurrent version conflict preserve reason and do not overwrite changes", async ({ page }) => {
  await login(page); await select(page, "admin");
  let dialog = await change(page, { role: "sales", reason: "Keep this handover reason" });
  await expect(dialog.getByRole("alert")).toContainText("管理员");
  await expect(dialog.getByLabel("操作原因", { exact: true })).toHaveValue("Keep this handover reason");
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await select(page, "warehouse");
  await page.getByRole("button", { name: "调整成员权限", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("操作原因", { exact: true }).fill("Retain unsaved reason");
  const current = (await admin.api(`/members/${ids.warehouse}`)).body;
  expect((await admin.api(`/members/${ids.warehouse}/revoke-sessions`, "POST",
    { version: current.version, reason: "Concurrent revocation" }, randomUUID())).status).toBe(200);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("刷新");
  await expect(dialog.getByLabel("操作原因", { exact: true })).toHaveValue("Retain unsaved reason");
  await expect(dialog.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
});
test("explicit revocation of own sessions clears the workspace immediately after acknowledgement", async ({ page }) => {
  await login(page); await select(page, "admin");
  await page.getByRole("button", { name: "撤销本企业会话", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("操作原因", { exact: true }).fill("Lost device");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator("#login-screen")).toBeVisible();
  await expect(page.locator("#editor-fields")).toBeEmpty();
  await expect(page.locator("#detail")).toBeEmpty();
  expect((await page.request.get(base + "/api/v1/bootstrap")).status()).toBe(401);
});
test("self demotion with a backup administrator signs out and the next login has only the new role", async ({ page }) => {
  const row = (await admin.api(`/members/${ids.purchasing}`)).body;
  expect((await admin.api(`/members/${ids.purchasing}`, "PATCH",
    { version: row.version, role: "admin", reason: "Backup admin" }, randomUUID())).status).toBe(200);
  await login(page); await select(page, "admin");
  await change(page, { role: "sales" });
  await expect(page.locator("#login-screen")).toBeVisible();
  await login(page);
  await expect(page.locator("#user-name")).toContainText("销售");
  await expect(page.getByRole("button", { name: "企业成员", exact: true })).toHaveCount(0);
});
test("a lost member-change acknowledgement retries the same command without another version or audit event", async ({ page }) => {
  await login(page); await select(page, "sales");
  const keys = []; let first = true;
  await page.route(`**/api/v1/members/${ids.sales}`, async route => {
    if (route.request().method() !== "PATCH") return route.continue();
    keys.push(route.request().headers()["idempotency-key"]);
    if (first) {
      first = false;
      expect((await route.fetch()).ok()).toBe(true);
      await route.abort("failed");
    } else await route.continue();
  });
  const dialog = await change(page, { role: "auditor", reason: "Lost receipt proof" });
  await expect(dialog.getByRole("alert")).not.toBeEmpty();
  await expect(dialog.getByLabel("操作原因", { exact: true })).toHaveValue("Lost receipt proof");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(keys.length).toBe(2); expect(keys[0]).toBeTruthy(); expect(keys[1]).toBe(keys[0]);
  expect((await admin.api(`/members/${ids.sales}`)).body.version).toBe(2);
  expect((await admin.api("/audit")).body.items.filter(e => e.action === "member.update" && e.resource_id === ids.sales)).toHaveLength(1);
});
