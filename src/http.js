"use strict";
const crypto = require("node:crypto");

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function fail(res, error, requestId) {
  const known = error instanceof AppError;
  json(res, known ? error.status : 503, {
    error: {
      code: known ? error.code : "SERVICE_UNAVAILABLE",
      message: known ? error.message : "Service temporarily unavailable",
      ...(known && error.details ? { details: error.details } : {}),
    },
    requestId,
  });
}

function requestId() { return crypto.randomUUID(); }

async function readJson(req, limit = 512 * 1024) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) {
    throw new AppError(415, "JSON_REQUIRED", "Use application/json");
  }
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw new AppError(413, "BODY_TOO_LARGE", "Request body exceeds limit");
    parts.push(part);
  }
  try {
    const value = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error();
    return value;
  } catch { throw new AppError(400, "INVALID_JSON", "Expected a JSON object"); }
}

function checkOrigin(req, publicOrigin) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  if (req.headers["x-erp-request"] !== "1") {
    throw new AppError(403, "REQUEST_HEADER_REQUIRED", "ERP request header is required");
  }
  const origin = req.headers.origin;
  const expected = publicOrigin || `${req.socket.encrypted ? "https" : "http"}://${req.headers.host}`;
  if ((origin && origin !== expected) || req.headers["sec-fetch-site"] === "cross-site") {
    throw new AppError(403, "ORIGIN_REJECTED", "Cross-origin mutation rejected");
  }
}

function text(value, field, max = 200, required = true) {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) {
    throw new AppError(422, "VALIDATION", `Invalid ${field}`, { field });
  }
  return value.trim();
}

module.exports = { AppError, json, fail, requestId, readJson, checkOrigin, text };
