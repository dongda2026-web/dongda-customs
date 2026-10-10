"use strict";
const { withTenant } = require("./db");
const { AppError, readJson } = require("./http");
const { command } = require("./records");
const master = require("./master");
const social = require("./social");
const orders = require("./orders");
const inventory = require("./inventory");

async function dispatch(pool, actor, req) {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "v1" || parts.length > 5) return null;
  const [, , type, id, action] = parts;
  if (!master.definitions[type] && !["contents", "leads", "quotes", "orders", "purchases", "inventory", "transfers", "stocktakes", "finance", "documents", "members"].includes(type)) return null;
  const body = ["POST", "PATCH"].includes(req.method) ? await readJson(req) : {};
  if (req.method !== "GET" && ["quotes", "orders", "purchases", "inventory", "transfers", "stocktakes", "documents", "members"].includes(type) && !req.headers["idempotency-key"]) {
    throw new AppError(422, "IDEMPOTENCY_REQUIRED", "An idempotency key is required");
  }
  try {
    return await withTenant(pool, actor.tenantId, async c => {
      if (type === "members") await require("./members").authorize(c, actor);
      else await require("./auth").authorizeTransaction(c, actor);
      const execute = () => {
        if (master.definitions[type]) return master.handle(c, actor, type, id, req.method, body, url.searchParams);
        if (type === "inventory") return inventory.handle(c, actor, id, req.method, body);
        if (type === "finance") return require("./finance").handle(c, actor, id, action, req.method, body);
        if (type === "documents") return require("./documents").handle(c, actor, id, action, req.method, body, url.searchParams);
        if (type === "members") return require("./members").handle(c, actor, id, action, req.method, body, url.searchParams);
        if (["transfers", "stocktakes"].includes(type)) return require("./warehouse").handle(c, actor, type, id, action, req.method, body);
        if (["quotes", "orders", "purchases"].includes(type)) return orders.handle(c, actor, type, id, action, req.method, body, url.searchParams);
        return social.handle(c, actor, type, id, action, req.method, body, url.searchParams);
      };
      return req.method === "GET" ? execute()
        : command(c, actor, req.headers["idempotency-key"], { path: url.pathname, method: req.method, body }, execute);
    });
  } catch (error) {
    if (error.code === "23505") throw new AppError(409, "DUPLICATE", "Record already exists");
    if (["23503", "23514", "22003", "22007", "22008"].includes(error.code)) {
      throw new AppError(422, "VALIDATION", "Invalid data or reference");
    }
    throw error;
  }
}
module.exports = { dispatch };
