import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const session = JSON.parse(readFileSync(process.env.LOCAL_STATE_FILE || "/tmp/dongda-erp-local-session.json", "utf8"));
const stamp = Date.now().toString(36);
test.beforeEach(async ({ page, context }) => {
  await context.route("**/*", route => new URL(route.request().url()).origin === session.base ? route.continue() : route.abort());
  await page.goto(`${session.base}/erp.html`);
  await page.getByLabel("企业标识").fill(session.tenant);
  await page.getByLabel("邮箱", { exact: true }).fill(session.email);
  await page.getByLabel("密码", { exact: true }).fill(session.password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.locator("#workspace")).toBeVisible();
});

async function nav(page, key) {
  await page.locator(`[data-nav="${key}"]`).click();
  await expect(page.locator("#workspace")).toHaveAttribute("data-view", key);
}
async function create(page, fields) {
  await page.getByRole("button", { name: "新建", exact: true }).click();
  const dialog = page.getByRole("dialog");
  for (const [name, value] of Object.entries(fields)) {
    const field = dialog.getByLabel(name, { exact: true });
    if (typeof value === "object") await field.selectOption(value);
    else await field.fill(value);
  }
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

test("four-module fulfilment flow works through the visible ERP interface", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await nav(page, "partners");
  await create(page, { "名称": `验收客户-${stamp}`, "业务身份": { label: "客户" } });
  await create(page, { "名称": `验收供应商-${stamp}`, "业务身份": { label: "供应商" } });
  await nav(page, "products");
  await create(page, { "SKU 编码": `BAG-${stamp}`, "名称": `验收商品-${stamp}`, "基础单位": "pcs", "参考单价": "2" });
  await nav(page, "warehouses");
  await create(page, { "仓库编码": `WH-${stamp}`, "名称": `验收仓-${stamp}` });
  await nav(page, "inventory");
  await page.getByRole("button", { name: "期初入库" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("仓库", { exact: true }).selectOption({ label: `验收仓-${stamp}` });
  await dialog.getByLabel("商品", { exact: true }).selectOption({ label: `验收商品-${stamp}` });
  await dialog.getByLabel("数量", { exact: true }).fill("4");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await nav(page, "orders");
  await page.getByRole("button", { name: "新建", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("客户", { exact: true }).selectOption({ label: `验收客户-${stamp}` });
  await dialog.getByLabel("仓库", { exact: true }).selectOption({ label: `验收仓-${stamp}` });
  await dialog.getByLabel("商品", { exact: true }).selectOption({ label: `验收商品-${stamp}` });
  await dialog.getByLabel("数量", { exact: true }).fill("10");
  await dialog.getByLabel("单价", { exact: true }).fill("2");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "提交审核", exact: true }).click();
  await page.getByRole("button", { name: "审核通过", exact: true }).click();
  await expect(page.locator("#detail")).toContainText("缺货");
  const orderNumber = await page.locator("#detail h2").textContent();
  await page.getByRole("button", { name: "生成采购", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByLabel("供应商", { exact: true }).selectOption({ label: `验收供应商-${stamp}` });
  await dialog.getByLabel("采购币种", { exact: true }).selectOption("CNY");
  await dialog.getByLabel("供应商单价", { exact: true }).fill("1.5");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("#detail")).toContainText("9.00 CNY");
  await page.getByRole("button", { name: "提交审核", exact: true }).click();
  await page.getByRole("button", { name: "审核通过", exact: true }).click();
  for (const quantity of ["2", "4"]) {
    await page.getByRole("button", { name: "收货入库", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("本次数量", { exact: true }).fill(quantity);
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
  await nav(page, "orders");
  await page.getByRole("button", { name: orderNumber, exact: true }).click();
  for (const quantity of ["3", "7"]) {
    await page.getByRole("button", { name: "出库发货", exact: true }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel("本次数量", { exact: true }).fill(quantity);
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).not.toBeVisible();
  }
  await expect(page.locator("#detail")).toContainText("已履约");
  await page.reload();
  await expect(page.locator("#workspace")).toBeVisible();
  await nav(page, "inventory");
  await page.getByRole("button", { name: "流水核对", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("一致");
  expect(errors).toEqual([]);
});

test("social content and inquiry are operable, while platform status remains honest", async ({ page }) => {
  await nav(page, "social-accounts");
  await create(page, { "名称": `社媒账号-${stamp}`, "平台": { label: "Facebook" }, "账号标识": "sample-page" });
  await expect(page.locator("#table-region")).toContainText("未接通");
  await nav(page, "contents");
  await create(page, { "标题": `内容-${stamp}`, "社媒账号": { label: `社媒账号-${stamp}` }, "正文": "产品介绍与询盘邀请" });
  await page.getByRole("button", { name: "提交审核", exact: true }).click();
  await page.getByRole("button", { name: "审核通过", exact: true }).click();
  await page.getByRole("button", { name: "登记人工发布", exact: true }).click();
  await page.getByRole("dialog").getByLabel("发布链接", { exact: true }).fill("https://example.com/synthetic-post");
  await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator("#detail")).toContainText("人工登记");
  await nav(page, "leads");
  await create(page, { "姓名或企业": `询盘-${stamp}`, "需求": "1000 个包装袋", "联系方式": "synthetic@example.invalid" });
  await page.getByRole("button", { name: "新增跟进", exact: true }).click();
  await page.getByRole("dialog").getByLabel("跟进内容", { exact: true }).fill("确认规格与交期");
  await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator("#detail")).toContainText("确认规格与交期");
});

test("narrow viewport supports keyboard login, navigation and logout", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await nav(page, "orders");
  await page.locator("#table-region button.link").first().click();
  await expect(page.locator("#detail")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(overflow).toBe(false);
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await expect(page.getByLabel("企业标识")).toBeVisible();
});

test("finance queue clearly shows pending integration and no false accounting success", async ({ page }) => {
  await nav(page, "finance");
  await expect(page.locator("#table-region")).toContainText("尚未完成财务端联调");
  await expect(page.locator("#table-region")).not.toContainText("已自动记账");
});

test("content rendered from users is plain text and dialog edits survive a failed save", async ({ page }) => {
  await nav(page, "partners");
  await page.getByRole("button", { name: "新建", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("名称", { exact: true }).fill(`<img src=x onerror=alert(1)>-${stamp}`);
  await page.route("**/api/v1/partners", route => route.request().method() === "POST"
    ? route.fulfill({ status: 503, contentType: "application/json", body: '{"error":{"message":"测试保存失败"}}' }) : route.continue());
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("测试保存失败");
  await expect(dialog.getByLabel("名称", { exact: true })).toHaveValue(`<img src=x onerror=alert(1)>-${stamp}`);
  await page.unroute("**/api/v1/partners");
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("#detail")).toContainText("<img src=x onerror=alert(1)>");
  await expect(page.locator("#detail img")).toHaveCount(0);
});

test("retry after a committed followup loses its response reuses the command and stores one followup", async ({ page }) => {
  await nav(page, "leads");
  await create(page, { "姓名或企业": `断网重试-${stamp}`, "需求": "验证已保存但回执丢失" });
  await page.getByRole("button", { name: "新增跟进", exact: true }).click();
  const dialog = page.getByRole("dialog"), keys = [];
  await dialog.getByLabel("跟进内容", { exact: true }).fill(`只保存一次-${stamp}`);
  let first = true;
  await page.route("**/api/v1/leads/*/followups", async route => {
    keys.push(route.request().headers()["idempotency-key"]);
    if (first) {
      first = false;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort("failed");
    } else await route.continue();
  });
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect(dialog.getByRole("alert")).not.toBeEmpty();
  await expect(dialog.getByLabel("跟进内容", { exact: true })).toHaveValue(`只保存一次-${stamp}`);
  await dialog.getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  await expect(dialog).not.toBeVisible();
  await expect(page.locator("#detail .event")).toHaveCount(1);
  await expect(page.locator("#detail .event")).toContainText(`只保存一次-${stamp}`);
});
