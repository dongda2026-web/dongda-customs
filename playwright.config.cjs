const { defineConfig } = require("@playwright/test");
module.exports = defineConfig({
  testDir: "./tests/browser",
  timeout: 60000,
  workers: 1,
  outputDir: "/tmp/dongda-erp-browser-results",
  reporter: "list",
  use: {
    headless: true,
    viewport: { width: 1440, height: 960 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
