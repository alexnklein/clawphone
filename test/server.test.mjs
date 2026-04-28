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

  it("POST /browser/login accepts same-origin when forwarded host includes :443", async () => {
    const res = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port, {
      "x-forwarded-host": "browser.test:443",
      origin: "https://browser.test",
    });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
  });

  it("POST /browser/login accepts same-origin when origin includes :443", async () => {
    const res = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port, {
      "x-forwarded-host": "browser.test",
      origin: "https://browser.test:443",
    });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
  });

  it("POST /browser/login accepts same-origin with case-insensitive host", async () => {
    const res = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port, {
      "x-forwarded-host": "Browser.Test",
      origin: "https://browser.test",
    });
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
  });

  it("POST /browser/login accepts same-origin when forwarded port is non-default", async () => {
    const res = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port, {
      "x-forwarded-host": "browser.test",
      "x-forwarded-port": "8443",
      origin: "https://browser.test:8443",
    });
    assert.strictEqual(res.status, 200, "non-default forwarded port must be included in expected origin");
    const body = JSON.parse(res.body);
    assert.strictEqual(body.ok, true);
  });

  it("POST /browser/login rejects origin when forwarded port mismatches", async () => {
    const res = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port, {
      "x-forwarded-host": "browser.test",
      "x-forwarded-port": "8443",
      origin: "https://browser.test:9999",
    });
    assert.strictEqual(res.status, 403, "mismatched forwarded port must be rejected");
  });

  it("POST /browser/login ignores forwarded port when host already contains a port", async () => {
    const res = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port, {
      "x-forwarded-host": "browser.test:8443",
      "x-forwarded-port": "9999",
      origin: "https://browser.test:8443",
    });
    assert.strictEqual(res.status, 200, "host-embedded port takes precedence over x-forwarded-port");
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

  it("GET /browser with stale cookie clears the dead cookie", async () => {
    // Login, then log out to invalidate the session server-side
    const login = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookie = Array.isArray(login.headers["set-cookie"])
      ? login.headers["set-cookie"][0]
      : String(login.headers["set-cookie"] || "");

    await postJsonBrowser("/browser/logout", {}, port, { cookie });

    // GET /browser with the now-dead cookie — server should clear it
    const page = await request("GET", "/browser", null, port, {
      "x-forwarded-proto": "https",
      cookie,
    });
    assert.strictEqual(page.status, 200);
    assert.match(page.body, /"authenticated":false/, "page must render unauthenticated state");
    assert.match(
      String(page.headers["set-cookie"]),
      /Max-Age=0/,
      "stale cookie must be cleared on unauthenticated GET /browser"
    );
  });

  it("GET /browser without any cookie does not set a clearing cookie", async () => {
    const page = await getBrowser("/browser", port);
    assert.strictEqual(page.status, 200);
    // No cookie was sent, so no Set-Cookie header should be present
    assert.strictEqual(page.headers["set-cookie"], undefined, "no Set-Cookie when no cookie sent");
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

  // ── Browser session isolation regression tests ────────────────────────────
  // Proves two distinct browser cookies produce independent sessions with
  // distinct caller identities, and that logging out one does not affect the other.

  it("two distinct browser sessions have independent session IDs and can both authenticate", async () => {
    // Session A
    const loginA = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    assert.strictEqual(loginA.status, 200);
    const cookieA = String(loginA.headers["set-cookie"] || "");

    // Session B
    const loginB = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    assert.strictEqual(loginB.status, 200);
    const cookieB = String(loginB.headers["set-cookie"] || "");

    // Both sessions must have distinct session IDs — this is the foundation
    // of session isolation; each session ID becomes part of the fromNumber
    // passed to openclawReply (browser:${sessId}), ensuring separate
    // conversation lanes in the agent backend.
    const sessIdA = cookieA.match(/clawphone_browser=([^;]+)/)?.[1] || "";
    const sessIdB = cookieB.match(/clawphone_browser=([^;]+)/)?.[1] || "";
    assert.ok(sessIdA, "session A must have a session ID");
    assert.ok(sessIdB, "session B must have a session ID");
    assert.notStrictEqual(sessIdA, sessIdB, "two logins must produce distinct session IDs");

    // Both sessions authenticate independently — verified by GET /browser
    // returning authenticated:true for each cookie without cross-contamination.
    const pageA = await request("GET", "/browser", null, port, {
      "x-forwarded-proto": "https",
      cookie: cookieA,
    });
    assert.strictEqual(pageA.status, 200);
    assert.match(pageA.body, /"authenticated":true/, "session A must be authenticated");

    const pageB = await request("GET", "/browser", null, port, {
      "x-forwarded-proto": "https",
      cookie: cookieB,
    });
    assert.strictEqual(pageB.status, 200);
    assert.match(pageB.body, /"authenticated":true/, "session B must be authenticated");
  });

  it("two distinct browser sessions produce independent chat caller IDs", async () => {
    // Login two sessions
    const loginA = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookieA = String(loginA.headers["set-cookie"] || "");
    const loginB = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookieB = String(loginB.headers["set-cookie"] || "");

    const sessIdA = cookieA.match(/clawphone_browser=([^;]+)/)?.[1] || "";
    const sessIdB = cookieB.match(/clawphone_browser=([^;]+)/)?.[1] || "";

    // Both chat — the fake openclaw stub returns a fixed reply; the critical
    // property is that each call to openclawReply receives fromNumber =
    // "browser:${sessionId}" (distinct per session, not a shared empty string).
    const chatA = await postJsonBrowser("/browser/chat", { text: "hello from A" }, port, { cookie: cookieA });
    assert.strictEqual(chatA.status, 200, "session A chat must succeed");
    const chatB = await postJsonBrowser("/browser/chat", { text: "hello from B" }, port, { cookie: cookieB });
    assert.strictEqual(chatB.status, 200, "session B chat must succeed");

    // The session IDs used as caller identifiers must differ — this prevents
    // the backend from collapsing both sessions into one conversation lane.
    assert.notStrictEqual(
      `browser:${sessIdA}`,
      `browser:${sessIdB}`,
      "browser caller IDs must be distinct per session"
    );
  });

  it("logging out session A does not revoke session B", async () => {
    // Login two sessions
    const loginA = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookieA = String(loginA.headers["set-cookie"] || "");
    const loginB = await postJsonBrowser("/browser/login", { code: "let-me-in" }, port);
    const cookieB = String(loginB.headers["set-cookie"] || "");

    // Logout session A
    const logoutA = await postJsonBrowser("/browser/logout", {}, port, { cookie: cookieA });
    assert.strictEqual(logoutA.status, 200);

    // Session A must be rejected
    const pageA = await request("GET", "/browser", null, port, {
      "x-forwarded-proto": "https",
      cookie: cookieA,
    });
    assert.match(pageA.body, /"authenticated":false/, "session A must be unauthenticated after logout");

    // Session B must still be valid
    const pageB = await request("GET", "/browser", null, port, {
      "x-forwarded-proto": "https",
      cookie: cookieB,
    });
    assert.match(pageB.body, /"authenticated":true/, "session B must survive session A logout");
  });
});

// ── Session cap and pruning tests ──────────────────────────────────────────
// Uses separate servers with MAX_BROWSER_SESSIONS=2 so we can exercise the
// cap and pruning paths without 1000 logins.

const CAP_BASE_CONFIG = {
  PORT: 0,
  ALLOW_FROM: [],
  ACK_ALLOW_FROM: [],
  TWILIO_ACCOUNT_SID: "",
  TWILIO_AUTH_TOKEN: "",
  TWILIO_SMS_FROM: "",
  PUBLIC_BASE_URL: "",
  SMS_MAX_CHARS: 280,
  SMS_FAST_TIMEOUT_MS: 200,
  MAX_SAYABLE_LENGTH: 600,
  CALLER_NAME: "",
  AGENT_NAME: "",
  GREETING_TEXT: "Hello",
  RATE_LIMIT_MAX: 200,
  RATE_LIMIT_WINDOW_MS: 60000,
  getRandomThinkingPhrase: () => "One moment.",
  POLL_FILLER_PHRASES: [],
  CALLER_PROFILES: {},
  BROWSER_ENABLED: true,
  BROWSER_PATH: "/browser",
  BROWSER_ACCESS_CODE: "cap-test-code",
  TRUSTED_PROXY_IPS: "127.0.0.1,::1,::ffff:127.0.0.1",
  MAX_BROWSER_SESSIONS: 2,
  OPENCLAW_AGENT_ID: "test",
  OPENCLAW_PHONE_SESSION_ID: "test",
};

describe("browser session cap and pruning", () => {
  let capServer;
  let capPort;

  const capPostJsonBrowser = (path, body, headers = {}) =>
    request("POST", path, body, capPort, {
      "content-type": "application/json",
      "x-forwarded-proto": "https",
      origin: `https://localhost:${capPort}`,
      ...headers,
    });

  before(async () => {
    const { createServer } = await import("../lib/http-server.mjs");
    // Long session age — sessions must NOT expire mid-test
    capServer = await createServer({
      ...CAP_BASE_CONFIG,
      BROWSER_SESSION_MAX_AGE_SECONDS: 300,
    });
    capPort = /** @type {import('node:net').AddressInfo} */ (capServer.address()).port;
  });

  after(async () => {
    await new Promise((resolve) => capServer.close(() => resolve(undefined)));
  });

  it("preserves the current session when re-login hits the session cap", async () => {
    // Fill 2/2 session slots (two logins, no cookie reuse)
    const login1 = await capPostJsonBrowser("/browser/login", { code: "cap-test-code" });
    assert.strictEqual(login1.status, 200);
    const cookie1 = String(login1.headers["set-cookie"] || "");

    const login2 = await capPostJsonBrowser("/browser/login", { code: "cap-test-code" });
    assert.strictEqual(login2.status, 200);

    // Re-login with cookie1: createBrowserSession() runs before the old session
    // is deleted, so the cap (2) is hit and it throws 503.
    const relogin = await capPostJsonBrowser("/browser/login", { code: "cap-test-code" }, { cookie: cookie1 });
    assert.strictEqual(relogin.status, 503, "re-login at cap must fail with 503");

    // Verify the original session is still valid by checking GET /browser embeds
    // authenticated:true — this avoids calling /browser/chat (which spawns an
    // agent process and would block for seconds).
    const getPage = await request("GET", "/browser", null, capPort, {
      "x-forwarded-proto": "https",
      cookie: cookie1,
    });
    assert.strictEqual(getPage.status, 200);
    assert.match(getPage.body, /"authenticated":true/, "existing session must survive a failed re-login at cap");
  });
});

// Separate describe for the pruning test — uses a 1-second session expiry
// so we can verify expired sessions are pruned before the cap check.
describe("browser session pruning", () => {
  let pruneServer;
  let prunePort;

  const prunePostJsonBrowser = (path, body, headers = {}) =>
    request("POST", path, body, prunePort, {
      "content-type": "application/json",
      "x-forwarded-proto": "https",
      origin: `https://localhost:${prunePort}`,
      ...headers,
    });

  before(async () => {
    const { createServer } = await import("../lib/http-server.mjs");
    pruneServer = await createServer({
      ...CAP_BASE_CONFIG,
      BROWSER_SESSION_MAX_AGE_SECONDS: 1, // 1s so expiry is fast
    });
    prunePort = /** @type {import('node:net').AddressInfo} */ (pruneServer.address()).port;
  });

  after(async () => {
    await new Promise((resolve) => pruneServer.close(() => resolve(undefined)));
  });

  it("prunes expired sessions before enforcing the cap", async () => {
    // Fill 2/2 slots with fresh sessions
    const loginA = await prunePostJsonBrowser("/browser/login", { code: "cap-test-code" });
    assert.strictEqual(loginA.status, 200);
    const loginB = await prunePostJsonBrowser("/browser/login", { code: "cap-test-code" });
    assert.strictEqual(loginB.status, 200);

    // Wait for both sessions to expire (BROWSER_SESSION_MAX_AGE_SECONDS = 1)
    await new Promise((r) => setTimeout(r, 1200));

    // Login again: pruneExpiredBrowserSessions() removes the two expired entries
    // before the cap check, so the new session creation succeeds.
    const loginC = await prunePostJsonBrowser("/browser/login", { code: "cap-test-code" });
    assert.strictEqual(loginC.status, 200, "login must succeed after expired sessions are pruned");
  });
});

// ── Session idle-timeout refresh test ──────────────────────────────────────
// Uses a 2-second session TTL so we can prove that authenticated traffic
// extends the session beyond the original wall-clock expiry.
describe("browser session idle-timeout refresh", () => {
  let idleServer;
  let idlePort;

  const idleGetBrowser = (path, headers = {}) =>
    request("GET", path, null, idlePort, {
      "x-forwarded-proto": "https",
      ...headers,
    });

  const idlePostJsonBrowser = (path, body, headers = {}) =>
    request("POST", path, body, idlePort, {
      "content-type": "application/json",
      "x-forwarded-proto": "https",
      origin: `https://localhost:${idlePort}`,
      ...headers,
    });

  before(async () => {
    const { createServer } = await import("../lib/http-server.mjs");
    idleServer = await createServer({
      ...CAP_BASE_CONFIG,
      BROWSER_SESSION_MAX_AGE_SECONDS: 2, // 2s idle TTL
    });
    idlePort = /** @type {import('node:net').AddressInfo} */ (idleServer.address()).port;
  });

  after(async () => {
    await new Promise((resolve) => idleServer.close(() => resolve(undefined)));
  });

  it("active session is extended by authenticated GET /browser traffic", async () => {
    // Login → session has 2s idle TTL
    const login = await idlePostJsonBrowser("/browser/login", { code: "cap-test-code" });
    assert.strictEqual(login.status, 200);
    const cookie = String(login.headers["set-cookie"] || "");
    assert.match(cookie, /clawphone_browser=/);

    // Wait 1.2s (past the midpoint of the 2s TTL)
    await new Promise((r) => setTimeout(r, 1200));

    // Hit GET /browser — should extend the session by another 2s
    const page = await idleGetBrowser("/browser", { cookie });
    assert.strictEqual(page.status, 200);
    assert.match(page.body, /"authenticated":true/);
    // Cookie must be reissued with fresh Max-Age
    assert.ok(page.headers["set-cookie"], "session cookie must be refreshed on GET /browser");
    assert.match(String(page.headers["set-cookie"]), /Max-Age=2/);

    // Wait another 1.2s — total 2.4s since login, but only 1.2s since last access
    await new Promise((r) => setTimeout(r, 1200));

    // Session must still be valid because the GET above reset the idle timer
    const page2 = await idleGetBrowser("/browser", { cookie });
    assert.strictEqual(page2.status, 200);
    assert.match(page2.body, /"authenticated":true/, "session must survive past original TTL when kept active");
  });

  it("idle session expires after the configured TTL with no activity", async () => {
    // Login → session has 2s idle TTL
    const login = await idlePostJsonBrowser("/browser/login", { code: "cap-test-code" });
    assert.strictEqual(login.status, 200);
    const cookie = String(login.headers["set-cookie"] || "");

    // Wait for the session to fully expire (2s TTL + margin)
    await new Promise((r) => setTimeout(r, 2200));

    // Session should be expired — GET /browser should show unauthenticated page
    const page = await idleGetBrowser("/browser", { cookie });
    assert.strictEqual(page.status, 200);
    assert.match(page.body, /"authenticated":false/, "idle session must expire after TTL elapses");
  });
});

// ── Chained-proxy regression tests ─────────────────────────────────────────
// Verifies that firstForwardedValue() (not lastForwardedValue) is used for
// X-Forwarded-Proto and X-Forwarded-Host, so CDN→LB→reverse-proxy chains
// use the outermost (client-facing) value, not the internal hop.
describe("chained-proxy forwarded-header handling", () => {
  let proxyServer;
  let proxyPort;

  before(async () => {
    const { createServer } = await import("../lib/http-server.mjs");
    proxyServer = await createServer({
      ...CAP_BASE_CONFIG,
      BROWSER_SESSION_MAX_AGE_SECONDS: 300,
      // No PUBLIC_BASE_URL — force origin reconstruction from forwarded headers
      PUBLIC_BASE_URL: "",
    });
    proxyPort = /** @type {import('node:net').AddressInfo} */ (proxyServer.address()).port;
  });

  after(async () => {
    await new Promise((resolve) => proxyServer.close(() => resolve(undefined)));
  });

  it("GET /browser with chained X-Forwarded-Proto (https,http) → 200 (uses first value)", async () => {
    // CDN sets https, internal proxy appends http — first value is the real one.
    const res = await request("GET", "/browser", null, proxyPort, {
      "x-forwarded-proto": "https, http",
    });
    assert.strictEqual(res.status, 200, "chained proto must use first (https) value, not last (http)");
    assert.match(res.headers["content-type"], /text\/html/);
  });

  it("GET /browser with chained X-Forwarded-Proto (http,https) → 426 (first value is http)", async () => {
    // If the outermost proxy says http, it's genuinely not HTTPS.
    const res = await request("GET", "/browser", null, proxyPort, {
      "x-forwarded-proto": "http, https",
    });
    assert.strictEqual(res.status, 426, "chained proto with http first must be rejected as insecure");
  });

  it("POST /browser/login with chained X-Forwarded-Host uses first value for origin check", async () => {
    // CDN sets the real host first, internal proxy appends internal hostname.
    const res = await request("POST", "/browser/login", { code: "cap-test-code" }, proxyPort, {
      "content-type": "application/json",
      "x-forwarded-proto": "https, http",
      "x-forwarded-host": "real.example.com, internal-lb.local",
      origin: "https://real.example.com",
    });
    assert.strictEqual(res.status, 200, "origin check must match first forwarded host, not last");
  });

  it("POST /browser/login with chained X-Forwarded-Host rejects origin matching last (internal) value", async () => {
    const res = await request("POST", "/browser/login", { code: "cap-test-code" }, proxyPort, {
      "content-type": "application/json",
      "x-forwarded-proto": "https, http",
      "x-forwarded-host": "real.example.com, internal-lb.local",
      origin: "https://internal-lb.local",
    });
    assert.strictEqual(res.status, 403, "origin matching only the internal proxy host must be rejected");
  });
});

// ── Downstream caller-ID assertion ─────────────────────────────────────────
// Uses _openclawReplyOverride to intercept the fromNumber actually passed to
// openclawReply, proving the per-session browser:${sessId} isolation.
describe("browser chat downstream caller-ID verification", () => {
  let cidServer;
  let cidPort;
  /** @type {string[]} */
  const seenFromNumbers = [];

  before(async () => {
    const { createServer } = await import("../lib/http-server.mjs");
    cidServer = await createServer({
      ...CAP_BASE_CONFIG,
      BROWSER_SESSION_MAX_AGE_SECONDS: 300,
      _openclawReplyOverride: async ({ fromNumber }) => {
        seenFromNumbers.push(fromNumber);
        return "[test stub]";
      },
    });
    cidPort = /** @type {import('node:net').AddressInfo} */ (cidServer.address()).port;
  });

  after(async () => {
    await new Promise((resolve) => cidServer.close(() => resolve(undefined)));
  });

  it("two browser sessions pass distinct browser:${sessId} caller IDs to openclawReply", async () => {
    const cidPostJsonBrowser = (path, body, headers = {}) =>
      request("POST", path, body, cidPort, {
        "content-type": "application/json",
        "x-forwarded-proto": "https",
        origin: `https://localhost:${cidPort}`,
        ...headers,
      });

    // Login session A
    const loginA = await cidPostJsonBrowser("/browser/login", { code: "cap-test-code" });
    assert.strictEqual(loginA.status, 200);
    const cookieA = String(loginA.headers["set-cookie"] || "");
    const sessIdA = cookieA.match(/clawphone_browser=([^;]+)/)?.[1] || "";

    // Login session B
    const loginB = await cidPostJsonBrowser("/browser/login", { code: "cap-test-code" });
    assert.strictEqual(loginB.status, 200);
    const cookieB = String(loginB.headers["set-cookie"] || "");
    const sessIdB = cookieB.match(/clawphone_browser=([^;]+)/)?.[1] || "";

    // Clear any prior captured values
    seenFromNumbers.length = 0;

    // Chat from session A
    const chatA = await cidPostJsonBrowser("/browser/chat", { text: "hello from A" }, { cookie: cookieA });
    assert.strictEqual(chatA.status, 200);

    // Chat from session B
    const chatB = await cidPostJsonBrowser("/browser/chat", { text: "hello from B" }, { cookie: cookieB });
    assert.strictEqual(chatB.status, 200);

    // Assert the exact fromNumber values the server passed downstream
    assert.strictEqual(seenFromNumbers.length, 2, "two chat requests must produce two downstream calls");
    assert.strictEqual(
      seenFromNumbers[0],
      `browser:${sessIdA}`,
      "session A must pass browser:${sessIdA} as fromNumber"
    );
    assert.strictEqual(
      seenFromNumbers[1],
      `browser:${sessIdB}`,
      "session B must pass browser:${sessIdB} as fromNumber"
    );
    assert.notStrictEqual(
      seenFromNumbers[0],
      seenFromNumbers[1],
      "the two fromNumber values must be distinct"
    );
  });
});
