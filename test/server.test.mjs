// @ts-check
/**
 * Integration tests for server.mjs.
 *
 * Strategy:
 *  - Set critical env vars BEFORE any dynamic import so config.mjs picks them up
 *    (dotenv does not override vars that are already in process.env).
 *  - PORT=0 → OS assigns a free port; we read it back via server.address().port.
 *  - TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN cleared → twilioClient stays null,
 *    so no real Twilio SDK calls can be made even in the async SMS path.
 *  - DISCORD_LOG_CHANNEL_ID cleared → discordLog() returns immediately (no-op).
 *  - ALLOW_FROM fixed to a known test number.
 *  - A fake `openclaw` stub is injected onto PATH so openclawReply() never
 *    reaches the real agent or Discord, preventing notifications during tests.
 *  - voice-state.mjs is imported statically (no config dependency) so we can
 *    pre-populate pending turns for /speech-wait tests; it shares the same module
 *    instance as the one server.mjs imported.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import http from "node:http";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPendingTurn,
  completeTurn,
  deleteTurn,
} from "../lib/voice-state.mjs";

// ── Fake openclaw stub ───────────────────────────────────────────────────────
// Prevent real openclaw (if on PATH) from spawning and touching Discord/agents.
const fakeBinDir = mkdtempSync(join(tmpdir(), "twilio-gw-test-"));
const fakeOpenclawPath = join(fakeBinDir, "openclaw");
writeFileSync(
  fakeOpenclawPath,
  '#!/bin/sh\necho \'{"result":{"payloads":[{"text":"[test stub]"}]}}\'\n',
  "utf8"
);
chmodSync(fakeOpenclawPath, 0o755);
process.env.PATH = `${fakeBinDir}:${process.env.PATH}`;

// ── Configure env before server / config loads ───────────────────────────────
process.env.PORT = "0"; // OS picks free port
process.env.ALLOW_FROM = "+15550001111";
process.env.TWILIO_ACCOUNT_SID = ""; // keeps twilioClient = null
process.env.TWILIO_AUTH_TOKEN = "";
process.env.DISCORD_LOG_CHANNEL_ID = ""; // discordLog() returns early (no-op)
// Short fast-path timeout so /sms tests complete quickly
process.env.SMS_FAST_TIMEOUT_MS = "200";
process.env.BROWSER_ENABLED = "true";
process.env.BROWSER_PATH = "/browser";
process.env.BROWSER_ACCESS_CODE = "let-me-in";
process.env.RATE_LIMIT_MAX = "200"; // High limit for test suite

// Dynamic import: config.mjs is evaluated HERE with the env vars above already set
const { server } = await import("../server.mjs");

// ── Tiny HTTP helpers ────────────────────────────────────────────────────────

function request(method, path, body, port, headers = {}) {
  return new Promise((resolve, reject) => {
    const contentType = headers["content-type"] || headers["Content-Type"] || "application/x-www-form-urlencoded";
    const encoded =
      body == null
        ? ""
        : typeof body === "string"
        ? body
        : contentType.includes("application/json")
        ? JSON.stringify(body)
        : new URLSearchParams(body).toString();

    const options = {
      hostname: "localhost",
      port,
      path,
      method,
      headers: {
        "content-type": contentType,
        "content-length": Buffer.byteLength(encoded),
        ...headers,
      },
    };

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: data })
      );
    });
    req.on("error", reject);
    if (encoded) req.write(encoded);
    req.end();
  });
}

const post = (path, body, port) => request("POST", path, body, port);
const get = (path, port) => request("GET", path, null, port);
const postJson = (path, body, port, headers = {}) =>
  request("POST", path, body, port, { "content-type": "application/json", ...headers });

// Browser routes require HTTPS.  Test connections come from loopback (trusted
// proxy), so we simulate HTTPS by sending x-forwarded-proto: https.
// Browser POST routes also require a same-origin Origin header.
const HTTPS_HEADER = { "x-forwarded-proto": "https" };
const getBrowser = (path, port) => request("GET", path, null, port, HTTPS_HEADER);
const postJsonBrowser = (path, body, port, headers = {}) =>
  request("POST", path, body, port, {
    "content-type": "application/json",
    origin: `https://localhost:${port}`,
    ...HTTPS_HEADER,
    ...headers,
  });

// ── Tests ────────────────────────────────────────────────────────────────────

describe("server integration", () => {
  let port;

  before(async () => {
    // server.listen() is async; wait for it to actually bind
    if (!server.listening) {
      await new Promise((r) => server.once("listening", r));
    }
    port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
  });

  after(async () => {
    // Give fire-and-forget background tasks (openclawReply IIFEs) a moment to
    // settle so their error-catch branches register in the coverage report.
    await new Promise((r) => setTimeout(r, 200));
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    rmSync(fakeBinDir, { recursive: true, force: true });
  });

  // ── Health ──────────────────────────────────────────────────────────────

  it("GET /health → ok with fields", async () => {
    const res = await get("/health", port);
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(typeof body.version, "string");
    assert.ok(body.version.length > 0);
    assert.strictEqual(typeof body.uptime, "number");
    assert.ok(body.uptime >= 0);
    assert.strictEqual(body.activeTurns, 0);
    assert.strictEqual(body.twilioConfigured, false); // test env: no Twilio creds
    assert.strictEqual(body.browserEnabled, true);
  });

  // ── 404 ─────────────────────────────────────────────────────────────────

  it("GET /unknown → 404", async () => {
    const res = await get("/unknown", port);
    assert.strictEqual(res.status, 404);
  });

  it("POST /unknown → 404", async () => {
    const res = await post("/unknown", {}, port);
    assert.strictEqual(res.status, 404);
  });

  // ── /browser ─────────────────────────────────────────────────────────────

  it("GET /browser → HTML shell", async () => {
    const res = await getBrowser("/browser", port);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers["content-type"], /text\/html/);
    assert.match(res.body, /HouseCarl Voice/);
  });

  it("POST /browser/login with wrong code → 401", async () => {
    const res = await postJsonBrowser("/browser/login", { code: "wrong" }, port);
    assert.strictEqual(res.status, 401);
    const body = JSON.parse(res.body);
    assert.match(body.error, /invalid access code/i);
  });

  it("POST /browser/login with correct code → session cookie", async () => {
    const res = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
    assert.match(String(res.headers["set-cookie"]), /clawphone_browser=/);
  });

  it("POST /browser/login with cross-origin Origin header → 403", async () => {
    const res = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port, {
      origin: "https://evil.example.com",
    });
    assert.strictEqual(res.status, 403, "cross-origin login must be rejected");
    const body = JSON.parse(res.body);
    assert.match(body.error, /forbidden/i);
  });

  it("POST /browser/login with same-origin Origin header → 200", async () => {
    const res = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port, {
      "x-forwarded-host": "browser.test",
      origin: "https://browser.test",
    });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
  });

  it("POST /browser/chat without cookie → 401", async () => {
    const res = await postJsonBrowser("/browser/chat", { text: "hello" }, port);
    assert.strictEqual(res.status, 401);
    const body = JSON.parse(res.body);
    assert.match(body.error, /unauthorized/i);
  });

  it("POST /browser/chat with cookie → JSON reply", async () => {
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");
    const res = await postJsonBrowser("/browser/chat", { text: "hello from browser" }, port, { cookie });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.reply, "[test stub]");
  });

  it("POST /browser/chat with empty text → 400", async () => {
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");
    const res = await postJsonBrowser("/browser/chat", { text: "   " }, port, { cookie });
    assert.strictEqual(res.status, 400);
    const body = JSON.parse(res.body);
    assert.match(body.error, /message text is required/i);
  });

  it("POST /browser/logout without session → 401 + clears stale cookie", async () => {
    // Send a bogus cookie — server should still clear it on 401
    const res = await postJsonBrowser("/browser/logout", {}, port, {
      cookie: "clawphone_browser=stale-bogus-session",
    });
    assert.strictEqual(res.status, 401, "logout without valid session must return 401");
    const body = JSON.parse(res.body);
    assert.match(body.error, /unauthorized/i);
    // Cookie must be cleared so the browser stops sending the dead value
    assert.match(String(res.headers["set-cookie"]), /Max-Age=0/, "stale cookie must be cleared on 401 logout");
  });

  it("POST /browser/logout with valid session → clears session cookie", async () => {
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");
    const res = await postJsonBrowser("/browser/logout", {}, port, { cookie });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
    // Cookie should be cleared (Max-Age=0)
    assert.match(String(res.headers["set-cookie"]), /Max-Age=0/);
  });

  it("POST /browser/logout with cross-origin Origin header → 403", async () => {
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");
    const res = await postJsonBrowser("/browser/logout", {}, port, {
      cookie,
      origin: "https://evil.example.com",
    });
    assert.strictEqual(res.status, 403, "cross-origin logout must be rejected");
    const body = JSON.parse(res.body);
    assert.match(body.error, /forbidden/i);
  });

  it("POST /browser/chat with same-origin Origin header → 200", async () => {
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");
    // Simulate a real browser fetch: Origin matches the forwarded proto+host.
    const res = await postJsonBrowser("/browser/chat", { text: "hello" }, port, {
      cookie,
      "x-forwarded-host": "browser.test",
      origin: "https://browser.test",
    });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
  });

  it("POST /browser/logout with same-origin Origin header → 200", async () => {
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");
    const res = await postJsonBrowser("/browser/logout", {}, port, {
      cookie,
      "x-forwarded-host": "browser.test",
      origin: "https://browser.test",
    });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
  });

  it("POST /browser/chat with cross-origin Origin header → 403", async () => {
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");
    const res = await postJsonBrowser("/browser/chat", { text: "hello" }, port, {
      cookie,
      origin: "https://evil.example.com",
    });
    assert.strictEqual(res.status, 403, "cross-origin chat must be rejected");
    const body = JSON.parse(res.body);
    assert.match(body.error, /forbidden/i);
  });

  it("POST /browser/chat with unknown session cookie → 401", async () => {
    // A random session ID that was never issued by the server
    const res = await postJsonBrowser("/browser/chat", { text: "hello" }, port, { cookie: "clawphone_browser=bogus-session-id" });
    assert.strictEqual(res.status, 401);
  });

  it("POST /browser/chat with malformed cookie → 401", async () => {
    const res = await postJsonBrowser("/browser/chat", { text: "hello" }, port, { cookie: "clawphone_browser=garbage" });
    assert.strictEqual(res.status, 401);
  });

  it("POST /browser/chat with invalid percent-encoded cookie → 401 (not crash)", async () => {
    const res = await postJsonBrowser("/browser/chat", { text: "hello" }, port, { cookie: "clawphone_browser=%E0%A4%A" });
    assert.strictEqual(res.status, 401);
  });

  it("POST /browser/logout revokes session — old cookie rejected", async () => {
    // Login to get a valid session cookie
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");

    // Verify the cookie works before logout
    const chatBefore = await postJsonBrowser("/browser/chat", { text: "hi" }, port, { cookie });
    assert.strictEqual(chatBefore.status, 200);

    // Logout (server-side revocation)
    await postJsonBrowser("/browser/logout", {}, port, { cookie });

    // Replay the old cookie → must be rejected
    const chatAfter = await postJsonBrowser("/browser/chat", { text: "hi" }, port, { cookie });
    assert.strictEqual(chatAfter.status, 401, "old cookie must be rejected after logout");
  });

  it("POST /browser/login re-login invalidates previous session", async () => {
    // First login
    const login1 = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    assert.strictEqual(login1.status, 200);
    const cookie1 = Array.isArray(login1.headers["set-cookie"])
      ? login1.headers["set-cookie"][0]
      : String(login1.headers["set-cookie"] || "");

    // Verify first session works
    const chat1 = await postJsonBrowser("/browser/chat", { text: "hi" }, port, { cookie: cookie1 });
    assert.strictEqual(chat1.status, 200);

    // Re-login with the same cookie present (simulates browser re-login)
    const login2 = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port, { cookie: cookie1 });
    assert.strictEqual(login2.status, 200);
    const cookie2 = Array.isArray(login2.headers["set-cookie"])
      ? login2.headers["set-cookie"][0]
      : String(login2.headers["set-cookie"] || "");

    // New session should work
    const chat2 = await postJsonBrowser("/browser/chat", { text: "hi" }, port, { cookie: cookie2 });
    assert.strictEqual(chat2.status, 200);

    // Old session must be revoked
    const chatOld = await postJsonBrowser("/browser/chat", { text: "hi" }, port, { cookie: cookie1 });
    assert.strictEqual(chatOld.status, 401, "previous session must be revoked after re-login");
  });

  it("POST /browser/login with wrong code does not revoke existing session", async () => {
    // Login successfully first
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    assert.strictEqual(login.status, 200);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");

    // Verify the session works
    const chatBefore = await postJsonBrowser("/browser/chat", { text: "hi" }, port, { cookie });
    assert.strictEqual(chatBefore.status, 200);

    // Attempt re-login with wrong code (sends the existing cookie along)
    const badLogin = await postJsonBrowser("/browser/login", { code: "wrong" }, port, { cookie });
    assert.strictEqual(badLogin.status, 401);

    // Original session must still be valid
    const chatAfter = await postJsonBrowser("/browser/chat", { text: "hi" }, port, { cookie });
    assert.strictEqual(chatAfter.status, 200, "existing session must survive a failed re-login attempt");
  });

  it("GET /browser/ (trailing slash) → same HTML shell as /browser", async () => {
    const res = await getBrowser("/browser/", port);
    assert.strictEqual(res.status, 200);
    assert.match(res.headers["content-type"], /text\/html/);
    assert.match(res.body, /HouseCarl Voice/);
  });

  it("POST /browser/login on forwarded HTTPS via trusted proxy → Secure cookie", async () => {
    // Connection from loopback (trusted proxy) with X-Forwarded-Proto: https
    // → server trusts the header and sets the Secure flag.
    const res = await postJsonBrowser(
      "/browser/login",
      { code: "let-me-in" },
      port
    );
    assert.strictEqual(res.status, 200);
    const cookie = String(res.headers["set-cookie"] || "");
    assert.match(cookie, /HttpOnly/, "cookie must be HttpOnly");
    assert.match(cookie, /SameSite=Lax/, "cookie must be SameSite=Lax");
    assert.match(cookie, /Path=\/browser/, "cookie must be scoped to /browser");
    assert.match(cookie, /Secure/, "cookie must include Secure on HTTPS via trusted proxy");
  });

  it("browser routes on plain HTTP (no x-forwarded-proto) → 426", async () => {
    // Without x-forwarded-proto: https, browser routes must reject with 426
    const getRes = await get("/browser", port);
    assert.strictEqual(getRes.status, 426, "GET /browser on plain HTTP must return 426");
    const postRes = await postJson("/browser/login", { code: "let-me-in" }, port);
    assert.strictEqual(postRes.status, 426, "POST /browser/login on plain HTTP must return 426");
  });

  it("POST /browser/chat after logout → 401 (session fully revoked)", async () => {
    // Full login→chat→logout→chat flow proving logout kills the server session
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    assert.strictEqual(login.status, 200);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");

    // Chat works before logout
    const chatOk = await postJsonBrowser("/browser/chat", { text: "hi" }, port, { cookie });
    assert.strictEqual(chatOk.status, 200);

    // Logout
    const logoutRes = await postJsonBrowser("/browser/logout", {}, port, { cookie });
    assert.strictEqual(logoutRes.status, 200);

    // Late chat with the same cookie must be rejected
    const chatAfter = await postJsonBrowser("/browser/chat", { text: "post-logout" }, port, { cookie });
    assert.strictEqual(chatAfter.status, 401, "chat after logout must be rejected");
  });

  it("GET /browser → security headers present", async () => {
    const res = await getBrowser("/browser", port);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers["x-frame-options"], "DENY");
    assert.strictEqual(res.headers["x-content-type-options"], "nosniff");
    assert.ok(res.headers["content-security-policy"], "CSP header should be present");
    assert.match(res.headers["content-security-policy"], /default-src 'none'/);
    assert.ok(res.headers["permissions-policy"], "Permissions-Policy header should be present");
  });

  it("POST /browser/login with oversized body → JSON error (not text/plain)", async () => {
    const oversized = '{"code":"' + "a".repeat(70_000) + '"}';
    const res = await request("POST", "/browser/login", oversized, port, {
      "content-type": "application/json",
      origin: `https://localhost:${port}`,
      ...HTTPS_HEADER,
    });
    // readBody rejects oversized payloads; response must still be JSON
    assert.strictEqual(res.status, 413);
    assert.match(res.headers["content-type"], /application\/json/, "browser body-read error must return JSON");
    const body = JSON.parse(res.body);
    assert.ok(body.error, "JSON error body must include an error field");
  });

  it("POST /browser/chat with oversized body → JSON error (not text/plain)", async () => {
    // Login first to get a valid session
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");
    const oversized = '{"text":"' + "a".repeat(70_000) + '"}';
    const res = await request("POST", "/browser/chat", oversized, port, {
      "content-type": "application/json",
      origin: `https://localhost:${port}`,
      ...HTTPS_HEADER,
      cookie,
    });
    assert.strictEqual(res.status, 413);
    assert.match(res.headers["content-type"], /application\/json/, "browser body-read error must return JSON");
    const body = JSON.parse(res.body);
    assert.ok(body.error, "JSON error body must include an error field");
  });

  it("POST /browser/login without X-Forwarded-For → rate-limits on socket address", async () => {
    // Without X-Forwarded-For, all loopback requests share the same rate-limit
    // bucket (socket.remoteAddress).  With header present from a trusted proxy
    // the forwarded IP is used instead; from non-loopback clients the header
    // is ignored entirely (isTrustedProxy gate in getClientIp).
    //
    // This test verifies the default (no forwarded header) path works and
    // returns 401 (wrong code) — NOT 429 — within the normal rate budget.
    const res = await postJsonBrowser(
      "/browser/login",
      { code: "wrong-code" },
      port
    );
    assert.strictEqual(res.status, 401);
    const body = JSON.parse(res.body);
    assert.match(body.error, /invalid access code/i);
  });

  // ── null / non-object JSON body rejection ─────────────────────────────

  it("POST /browser/login with null JSON body → 400", async () => {
    const res = await request("POST", "/browser/login", "null", port, {
      "content-type": "application/json",
      origin: `https://localhost:${port}`,
      ...HTTPS_HEADER,
    });
    assert.strictEqual(res.status, 400);
    const body = JSON.parse(res.body);
    assert.match(body.error, /invalid request body/i);
  });

  it("POST /browser/login with JSON array body → 400", async () => {
    const res = await request("POST", "/browser/login", '[1,2,3]', port, {
      "content-type": "application/json",
      origin: `https://localhost:${port}`,
      ...HTTPS_HEADER,
    });
    assert.strictEqual(res.status, 400);
    const body = JSON.parse(res.body);
    assert.match(body.error, /invalid request body/i);
  });

  it("POST /browser/login with JSON string body → 400", async () => {
    const res = await request("POST", "/browser/login", '"hello"', port, {
      "content-type": "application/json",
      origin: `https://localhost:${port}`,
      ...HTTPS_HEADER,
    });
    assert.strictEqual(res.status, 400);
    const body = JSON.parse(res.body);
    assert.match(body.error, /invalid request body/i);
  });

  it("POST /browser/chat with null JSON body → 401 (no session)", async () => {
    // Without a session the auth check fires first
    const res = await request("POST", "/browser/chat", "null", port, {
      "content-type": "application/json",
      origin: `https://localhost:${port}`,
      ...HTTPS_HEADER,
    });
    assert.strictEqual(res.status, 401);
  });

  it("POST /browser/chat with null JSON body + valid session → 400", async () => {
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");
    const res = await request("POST", "/browser/chat", "null", port, {
      "content-type": "application/json",
      origin: `https://localhost:${port}`,
      ...HTTPS_HEADER,
      cookie,
    });
    assert.strictEqual(res.status, 400);
    const body = JSON.parse(res.body);
    assert.match(body.error, /invalid request body/i);
  });

  // ── Non-string field type rejection ──────────────────────────────────────

  it("POST /browser/login with non-string code (array) → 400", async () => {
    const res = await postJsonBrowser("/browser/login", { code: ["let-me-in"] }, port);
    assert.strictEqual(res.status, 400, "array code must be rejected");
    const body = JSON.parse(res.body);
    assert.match(body.error, /access code must be a string/i);
  });

  it("POST /browser/login with non-string code (object) → 400", async () => {
    const res = await postJsonBrowser("/browser/login", { code: { value: "let-me-in" } }, port);
    assert.strictEqual(res.status, 400, "object code must be rejected");
    const body = JSON.parse(res.body);
    assert.match(body.error, /access code must be a string/i);
  });

  it("POST /browser/login with non-string code (number) → 400", async () => {
    const res = await postJsonBrowser("/browser/login", { code: 12345 }, port);
    assert.strictEqual(res.status, 400, "number code must be rejected");
    const body = JSON.parse(res.body);
    assert.match(body.error, /access code must be a string/i);
  });

  it("POST /browser/login with missing code field → 400", async () => {
    const res = await postJsonBrowser("/browser/login", {}, port);
    assert.strictEqual(res.status, 400, "missing code must be rejected");
    const body = JSON.parse(res.body);
    assert.match(body.error, /access code must be a string/i);
  });

  it("POST /browser/chat with non-string text (array) → 400", async () => {
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");
    const res = await postJsonBrowser("/browser/chat", { text: ["hello"] }, port, { cookie });
    assert.strictEqual(res.status, 400, "array text must be rejected");
    const body = JSON.parse(res.body);
    assert.match(body.error, /message text must be a string/i);
  });

  it("POST /browser/chat with non-string text (object) → 400", async () => {
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");
    const res = await postJsonBrowser("/browser/chat", { text: {} }, port, { cookie });
    assert.strictEqual(res.status, 400, "object text must be rejected");
    const body = JSON.parse(res.body);
    assert.match(body.error, /message text must be a string/i);
  });

  it("POST /browser/chat with non-string text (number) → 400", async () => {
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");
    const res = await postJsonBrowser("/browser/chat", { text: 42 }, port, { cookie });
    assert.strictEqual(res.status, 400, "number text must be rejected");
    const body = JSON.parse(res.body);
    assert.match(body.error, /message text must be a string/i);
  });

  it("POST /browser/chat with missing text field → 400", async () => {
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");
    const res = await postJsonBrowser("/browser/chat", {}, port, { cookie });
    assert.strictEqual(res.status, 400, "missing text must be rejected");
    const body = JSON.parse(res.body);
    assert.match(body.error, /message text must be a string/i);
  });

  // ── /browser/logout body validation ────────────────────────────────────

  it("POST /browser/logout with oversized body → 413 JSON error", async () => {
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");
    const oversized = '{"extra":"' + "a".repeat(70_000) + '"}';
    const res = await request("POST", "/browser/logout", oversized, port, {
      "content-type": "application/json",
      origin: `https://localhost:${port}`,
      ...HTTPS_HEADER,
      cookie,
    });
    assert.strictEqual(res.status, 413);
    assert.match(res.headers["content-type"], /application\/json/, "logout oversized error must return JSON");
    const body = JSON.parse(res.body);
    assert.ok(body.error, "JSON error body must include an error field");
  });

  it("POST /browser/logout with malformed JSON body → 400", async () => {
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");
    const res = await request("POST", "/browser/logout", "{bad json", port, {
      "content-type": "application/json",
      origin: `https://localhost:${port}`,
      ...HTTPS_HEADER,
      cookie,
    });
    assert.strictEqual(res.status, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error);
  });

  it("POST /browser/logout with JSON array body → 400", async () => {
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");
    const res = await request("POST", "/browser/logout", "[1,2]", port, {
      "content-type": "application/json",
      origin: `https://localhost:${port}`,
      ...HTTPS_HEADER,
      cookie,
    });
    assert.strictEqual(res.status, 400);
    const body = JSON.parse(res.body);
    assert.match(body.error, /invalid request body/i);
  });

  // ── Missing Origin → 403 ────────────────────────────────────────────────

  it("POST /browser/login without Origin header → 403", async () => {
    const res = await request("POST", "/browser/login", '{"code":"let-me-in"}', port, {
      "content-type": "application/json",
      ...HTTPS_HEADER,
      // no origin header
    });
    assert.strictEqual(res.status, 403, "missing Origin must be rejected");
    const body = JSON.parse(res.body);
    assert.match(body.error, /forbidden/i);
  });

  it("POST /browser/chat without Origin header → 403", async () => {
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");
    const res = await request("POST", "/browser/chat", '{"text":"hello"}', port, {
      "content-type": "application/json",
      ...HTTPS_HEADER,
      cookie,
      // no origin header
    });
    assert.strictEqual(res.status, 403, "missing Origin must be rejected");
    const body = JSON.parse(res.body);
    assert.match(body.error, /forbidden/i);
  });

  it("POST /browser/logout without Origin header → 403", async () => {
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");
    const res = await request("POST", "/browser/logout", '{}', port, {
      "content-type": "application/json",
      ...HTTPS_HEADER,
      cookie,
      // no origin header
    });
    assert.strictEqual(res.status, 403, "missing Origin must be rejected");
    const body = JSON.parse(res.body);
    assert.match(body.error, /forbidden/i);
  });

  // ── Non-JSON content type → 415 ──────────────────────────────────────

  it("POST /browser/login with form-urlencoded body → 415", async () => {
    const res = await request("POST", "/browser/login", "code=let-me-in", port, {
      "content-type": "application/x-www-form-urlencoded",
      origin: `https://localhost:${port}`,
      ...HTTPS_HEADER,
    });
    assert.strictEqual(res.status, 415, "form-urlencoded must be rejected on browser routes");
    const body = JSON.parse(res.body);
    assert.match(body.error, /unsupported content type/i);
  });

  it("POST /browser/chat with form-urlencoded body → 415", async () => {
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");
    const res = await request("POST", "/browser/chat", "text=hello", port, {
      "content-type": "application/x-www-form-urlencoded",
      origin: `https://localhost:${port}`,
      ...HTTPS_HEADER,
      cookie,
    });
    assert.strictEqual(res.status, 415, "form-urlencoded must be rejected on browser routes");
    const body = JSON.parse(res.body);
    assert.match(body.error, /unsupported content type/i);
  });

  it("POST /browser/login with text/plain body → 415", async () => {
    const res = await request("POST", "/browser/login", '{"code":"let-me-in"}', port, {
      "content-type": "text/plain",
      origin: `https://localhost:${port}`,
      ...HTTPS_HEADER,
    });
    assert.strictEqual(res.status, 415, "text/plain must be rejected on browser routes");
    const body = JSON.parse(res.body);
    assert.match(body.error, /unsupported content type/i);
  });

  it("POST /browser/logout with form-urlencoded body → 415", async () => {
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");
    const res = await request("POST", "/browser/logout", "", port, {
      "content-type": "application/x-www-form-urlencoded",
      origin: `https://localhost:${port}`,
      ...HTTPS_HEADER,
      cookie,
    });
    assert.strictEqual(res.status, 415, "form-urlencoded must be rejected on logout");
    const body = JSON.parse(res.body);
    assert.match(body.error, /unsupported content type/i);
  });

  it("POST /browser/logout with text/plain body → 415", async () => {
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");
    const res = await request("POST", "/browser/logout", "{}", port, {
      "content-type": "text/plain",
      origin: `https://localhost:${port}`,
      ...HTTPS_HEADER,
      cookie,
    });
    assert.strictEqual(res.status, 415, "text/plain must be rejected on logout");
    const body = JSON.parse(res.body);
    assert.match(body.error, /unsupported content type/i);
  });

  // ── /voice ───────────────────────────────────────────────────────────────

  it("POST /voice from allowed number → Gather TwiML", async () => {
    const res = await post(
      "/voice",
      { From: "+15550001111", CallSid: "CA-v-allowed" },
      port
    );
    assert.strictEqual(res.status, 200);
    assert.match(res.headers["content-type"], /text\/xml/);
    assert.match(res.body, /<Gather/);
    assert.match(res.body, /input="speech"/);
  });

  it("POST /voice from denied number → Hangup TwiML", async () => {
    const res = await post(
      "/voice",
      { From: "+15559999999", CallSid: "CA-v-denied" },
      port
    );
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /<Hangup/);
    assert.match(res.body, /not authorized/i);
  });

  it("POST /voice with number missing + prefix → normalized and allowed", async () => {
    // "15550001111" (no +) should be normalized to "+15550001111" and pass
    const res = await post(
      "/voice",
      { From: "15550001111", CallSid: "CA-v-noplus" },
      port
    );
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /<Gather/);
  });

  it("POST /voice with oversized body → 413", async () => {
    const res = await post("/voice", "x=" + "a".repeat(70_000), port);
    assert.strictEqual(res.status, 413);
    assert.match(res.body, /exceeded/i);
  });

  // ── /speech ──────────────────────────────────────────────────────────────

  it("POST /speech from allowed number → thinking redirect TwiML", async () => {
    const res = await post(
      "/speech",
      { From: "+15550001111", CallSid: "CA-sp-1", SpeechResult: "Hello" },
      port
    );
    assert.strictEqual(res.status, 200);
    assert.match(res.headers["content-type"], /text\/xml/);
    assert.match(res.body, /<Redirect/);
    assert.match(res.body, /speech-wait/);
    // Must include poll=1 so the first /speech-wait poll can play a filler phrase
    assert.match(res.body, /poll=1/);
  });

  it("POST /speech with empty SpeechResult → still returns thinking redirect", async () => {
    const res = await post(
      "/speech",
      { From: "+15550001111", CallSid: "CA-sp-2", SpeechResult: "" },
      port
    );
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /<Redirect/);
    assert.match(res.body, /speech-wait/);
  });

  it("POST /speech from denied number → Hangup TwiML", async () => {
    const res = await post(
      "/speech",
      { From: "+15559999999", CallSid: "CA-sp-3", SpeechResult: "hi" },
      port
    );
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /<Hangup/);
  });

  it("POST /speech with oversized body → 413", async () => {
    const res = await post("/speech", "x=" + "a".repeat(70_000), port);
    assert.strictEqual(res.status, 413);
  });

  // ── /speech-wait ─────────────────────────────────────────────────────────

  it("POST /speech-wait with unknown key → Okay + Hangup TwiML", async () => {
    const res = await post("/speech-wait?key=no-such-key", "", port);
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /Okay/);
    assert.match(res.body, /<Hangup/);
  });

  it("POST /speech-wait with pending (not done) turn, no poll param → Pause + Redirect", async () => {
    const callSid = "CA-sw-pending";
    const key = `${callSid}:t1`;
    createPendingTurn({ key, callSid, from: "+15550001111", said: "waiting" });

    const res = await post(
      `/speech-wait?key=${encodeURIComponent(key)}`,
      "",
      port
    );
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /<Pause/);
    assert.match(res.body, /speech-wait/);

    deleteTurn(key);
  });

  it("POST /speech-wait with pending turn + poll=1 → filler phrase + Redirect", async () => {
    const callSid = "CA-sw-filler1";
    const key = `${callSid}:t1`;
    createPendingTurn({ key, callSid, from: "+15550001111", said: "waiting" });

    const res = await post(
      `/speech-wait?key=${encodeURIComponent(key)}&poll=1`,
      "",
      port
    );
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /<Say/);
    assert.match(res.body, /speech-wait/);
    assert.match(res.body, /poll=2/);

    deleteTurn(key);
  });

  it("POST /speech-wait with pending turn + poll=2 → filler phrase + Redirect", async () => {
    const callSid = "CA-sw-filler2";
    const key = `${callSid}:t1`;
    createPendingTurn({ key, callSid, from: "+15550001111", said: "waiting" });

    const res = await post(
      `/speech-wait?key=${encodeURIComponent(key)}&poll=2`,
      "",
      port
    );
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /<Say/);
    assert.match(res.body, /speech-wait/);
    assert.match(res.body, /poll=3/);

    deleteTurn(key);
  });

  it("POST /speech-wait with pending turn + poll=3 → silent Pause + Redirect (fillers exhausted)", async () => {
    const callSid = "CA-sw-filler3";
    const key = `${callSid}:t1`;
    createPendingTurn({ key, callSid, from: "+15550001111", said: "waiting" });

    const res = await post(
      `/speech-wait?key=${encodeURIComponent(key)}&poll=3`,
      "",
      port
    );
    assert.strictEqual(res.status, 200);
    // With only 2 filler phrases (poll=1, poll=2), poll=3+ should be silent Pause
    assert.match(res.body, /<Pause/);
    assert.doesNotMatch(res.body, /<Say/);
    assert.match(res.body, /speech-wait/);
    assert.match(res.body, /poll=4/);

    deleteTurn(key);
  });

  it("POST /speech-wait with pending turn + poll=5 → silent Pause + Redirect (still no filler)", async () => {
    const callSid = "CA-sw-filler5";
    const key = `${callSid}:t1`;
    createPendingTurn({ key, callSid, from: "+15550001111", said: "waiting" });

    const res = await post(
      `/speech-wait?key=${encodeURIComponent(key)}&poll=5`,
      "",
      port
    );
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /<Pause/);
    assert.doesNotMatch(res.body, /<Say/);
    assert.match(res.body, /speech-wait/);
    assert.match(res.body, /poll=6/);

    deleteTurn(key);
  });

  it("POST /speech-wait with completed turn → delivers reply + Gather", async () => {
    const callSid = "CA-sw-done";
    const key = `${callSid}:t2`;
    createPendingTurn({ key, callSid, from: "+15550001111", said: "test" });
    completeTurn(key, "Here is my answer.");

    const res = await post(
      `/speech-wait?key=${encodeURIComponent(key)}`,
      "",
      port
    );
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /Here is my answer/);
    assert.match(res.body, /<Gather/);
    // Turn should have been deleted by handler
    assert.strictEqual(res.body.includes("Here is my answer"), true);
  });

  it("POST /speech-wait with superseded key → Okay + Hangup (turn was deleted)", async () => {
    // createPendingTurn(key2) deletes key1 from pending by design, so polling
    // for key1 hits the "!item" branch and returns Okay + Hangup.
    const callSid = "CA-sw-stale";
    const key1 = `${callSid}:t3`;
    const key2 = `${callSid}:t4`;
    createPendingTurn({ key: key1, callSid, from: "+15550001111", said: "first" });
    createPendingTurn({ key: key2, callSid, from: "+15550001111", said: "second" });

    const res = await post(
      `/speech-wait?key=${encodeURIComponent(key1)}`,
      "",
      port
    );
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /Okay/);
    assert.match(res.body, /<Hangup/);

    deleteTurn(key2);
  });

  // ── /sms ─────────────────────────────────────────────────────────────────

  it("POST /sms from denied number → Unauthorized TwiML", async () => {
    const res = await post(
      "/sms",
      { From: "+15559999999", To: "+15550001111", Body: "hi" },
      port
    );
    assert.strictEqual(res.status, 200);
    assert.match(res.headers["content-type"], /text\/xml/);
    assert.match(res.body, /Unauthorized/);
  });

  it("POST /sms from allowed number → TwiML response (ack or fast reply)", async () => {
    // openclaw binary doesn't exist in test env → fast path fails →
    // server returns ack TwiML; startAsync fires in background but
    // twilioClient is null so no real SMS is sent.
    const res = await post(
      "/sms",
      { From: "+15550001111", To: "+15550002222", Body: "hello" },
      port
    );
    assert.strictEqual(res.status, 200);
    assert.match(res.headers["content-type"], /text\/xml/);
    assert.match(res.body, /<Message>/);
  });

  it("POST /sms with oversized body → 413", async () => {
    const res = await post("/sms", "x=" + "a".repeat(70_000), port);
    assert.strictEqual(res.status, 413);
  });
});
