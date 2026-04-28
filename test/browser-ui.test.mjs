// @ts-check
/**
 * Unit tests for lib/browser-ui.mjs — renderBrowserPage().
 *
 * These tests import the template function directly and validate the
 * structural invariants of the client-side JavaScript it emits.
 * They verify that auth/session/recognition hardening code is present
 * and correctly wired without needing a DOM runtime.
 *
 * The "executable logout behavior" suite uses node:vm to actually run the
 * inline client script with minimal DOM stubs, giving real coverage of
 * the async logout error-handling path.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import vm from "node:vm";
import { renderBrowserPage } from "../lib/browser-ui.mjs";

/** Extract the contents of the first <script> tag from an HTML string. */
function extractScript(html) {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  return match ? match[1] : "";
}

describe("renderBrowserPage — client-side hardening", () => {
  const html = renderBrowserPage({
    authenticated: false,
    browserPath: "/browser",
    agentName: "HouseCarl",
  });
  const script = extractScript(html);

  // ── stopRecognition lifecycle ──────────────────────────────────────

  it("defines stopRecognition that aborts recognition", () => {
    assert.match(script, /function stopRecognition\b/, "stopRecognition must be defined");
    assert.match(script, /recognition\.abort\(\)/, "stopRecognition must call recognition.abort()");
  });

  it("logout() calls stopRecognition before clearing state", () => {
    // Extract from logout() signature to the next top-level function
    const logoutBody = script.match(
      /async function logout\(\)\s*\{([\s\S]*?)(?=\n\s*async function|\n\s*function\s+\w)/
    );
    assert.ok(logoutBody, "logout function must exist");
    const body = logoutBody[1];
    const stopIdx = body.indexOf("stopRecognition()");
    const authIdx = body.indexOf("state.authenticated = false");
    assert.ok(stopIdx >= 0, "logout must call stopRecognition()");
    assert.ok(authIdx >= 0, "logout must clear state.authenticated");
    assert.ok(stopIdx < authIdx, "stopRecognition must be called before clearing authenticated flag");
  });

  it("401 handler calls stopRecognition", () => {
    // The 401 branch inside sendMessage's catch
    const handler401 = script.match(
      /err\.status === 401\)\s*\{([\s\S]*?)\breturn;/
    );
    assert.ok(handler401, "401 error handler must exist in sendMessage");
    assert.match(handler401[1], /stopRecognition\(\)/, "401 handler must call stopRecognition()");
  });

  // ── sendMessage auth guard ─────────────────────────────────────────

  it("sendMessage guards on state.authenticated", () => {
    const sendBody = script.match(
      /async function sendMessage\b[\s\S]*?if\s*\(([^)]+)\)\s*return;/
    );
    assert.ok(sendBody, "sendMessage must have an early-return guard");
    assert.match(sendBody[1], /!state\.authenticated/, "sendMessage guard must check !state.authenticated");
  });

  // ── authEpoch ──────────────────────────────────────────────────────

  it("state initializer includes authEpoch", () => {
    assert.match(script, /authEpoch:\s*0/, "client state must initialize authEpoch to 0");
  });

  it("sendMessage checks epoch after await to discard stale replies", () => {
    const epochCheck = script.match(
      /epoch\s*!==\s*state\.authEpoch/
    );
    assert.ok(epochCheck, "sendMessage must compare saved epoch to current authEpoch after await");
  });

  // ── resetConversationUi ────────────────────────────────────────────

  it("resetConversationUi clears transcript, interim, and input", () => {
    const resetBody = script.match(
      /function resetConversationUi\(\)\s*\{([\s\S]*?)(?=\n\s*async function|\n\s*function\s+\w)/
    );
    assert.ok(resetBody, "resetConversationUi must be defined");
    const body = resetBody[1];
    assert.match(body, /transcriptEl\.textContent\s*=\s*''/, "must clear transcript");
    assert.match(body, /interimEl\.textContent\s*=\s*''/, "must clear interim");
    assert.match(body, /messageInput\.value\s*=\s*''/, "must clear message input");
  });

  it("logout catches /logout errors and returns early without clearing auth", () => {
    const logoutBody = script.match(
      /async function logout\(\)\s*\{([\s\S]*?)(?=\n\s*async function|\n\s*function\s+\w)/
    );
    assert.ok(logoutBody, "logout function must exist");
    const body = logoutBody[1];
    // The catch block must set an error status and return, not fall through
    assert.match(body, /catch\s*\(err\)/, "logout must catch errors with a named binding");
    assert.match(body, /Lock failed/, "catch block must surface the failure to the user");
    // The return must be inside the catch block, before state.authenticated = false
    const catchIdx = body.indexOf("catch (err)");
    const returnIdx = body.indexOf("return;", catchIdx);
    const authClearIdx = body.indexOf("state.authenticated = false");
    assert.ok(returnIdx >= 0, "catch block must contain a return statement");
    assert.ok(returnIdx < authClearIdx, "catch must return before state.authenticated is cleared");
  });

  it("logout calls resetConversationUi on success path", () => {
    const logoutBody = script.match(
      /async function logout\(\)\s*\{([\s\S]*?)(?=\n\s*async function|\n\s*function\s+\w)/
    );
    assert.ok(logoutBody);
    assert.match(logoutBody[1], /resetConversationUi\(\)/, "logout must call resetConversationUi");
  });

  it("logout success message targets loginStatusEl after renderAuth", () => {
    const logoutBody = script.match(
      /async function logout\(\)\s*\{([\s\S]*?)(?=\n\s*async function|\n\s*function\s+\w)/
    );
    assert.ok(logoutBody, "logout function must exist");
    const body = logoutBody[1];
    const renderIdx = body.indexOf("renderAuth()");
    const lockedIdx = body.indexOf("Locked.", renderIdx);
    const loginStatusIdx = body.indexOf("loginStatusEl", lockedIdx);
    assert.ok(renderIdx >= 0, "logout must call renderAuth");
    assert.ok(lockedIdx > renderIdx, "Locked status must come after renderAuth");
    assert.ok(loginStatusIdx > 0, "Locked status must target loginStatusEl");
  });

  it("401 handler calls resetConversationUi", () => {
    const handler401 = script.match(
      /err\.status === 401\)\s*\{([\s\S]*?)\breturn;/
    );
    assert.ok(handler401);
    assert.match(handler401[1], /resetConversationUi\(\)/, "401 handler must call resetConversationUi");
  });

  // ── HTML structure ─────────────────────────────────────────────────

  it("login card has error feedback element", () => {
    assert.match(html, /id="loginStatus"/, "login status element must exist");
    assert.match(html, /id="loginCard"/, "login card must exist");
  });

  it("page title reflects agent name", () => {
    assert.match(html, /<title>HouseCarl Voice<\/title>/);
  });

  it("XSS in agentName is escaped", () => {
    const xss = renderBrowserPage({
      authenticated: false,
      browserPath: "/browser",
      agentName: '<script>alert(1)</script>',
    });
    assert.doesNotMatch(xss, /<script>alert\(1\)<\/script>/, "agentName must be HTML-escaped");
    assert.match(xss, /&lt;script&gt;/, "angle brackets must be entity-encoded");
  });
});

// ── Executable logout behavior via node:vm ──────────────────────────────
//
// These tests actually run the inline <script> inside a lightweight vm
// sandbox with minimal DOM stubs, exercising the async logout codepath
// end-to-end rather than relying on regex pattern matching.

describe("renderBrowserPage — executable logout behavior", () => {
  /** Create minimal DOM element stubs for the inline script. */
  function createMockDom() {
    const handlers = {};
    const makeEl = (id) => ({
      textContent: "",
      value: "",
      className: "",
      checked: true,
      scrollHeight: 0,
      scrollTop: 0,
      classList: {
        _s: new Set(),
        toggle(c, f) { f ? this._s.add(c) : this._s.delete(c); },
        contains(c) { return this._s.has(c); },
      },
      focus() {},
      appendChild() {},
      addEventListener(evt, fn) { handlers[id + ":" + evt] = fn; },
    });
    const els = {};
    for (const id of [
      "loginCard", "appCard", "loginForm", "accessCode",
      "micButton", "sendButton", "logoutButton", "autoSpeak",
      "status", "loginStatus", "transcript", "interim", "messageInput",
    ]) {
      els[id] = makeEl(id);
    }
    return { els, handlers };
  }

  /** Minimal SpeechRecognition stub that records lifecycle calls. */
  class FakeSpeechRecognition {
    constructor() {
      this.handlers = {};
      this.aborted = false;
      this.started = false;
      this.continuous = false;
      this.interimResults = false;
      this.lang = "";
    }
    addEventListener(name, fn) { this.handlers[name] = fn; }
    start() { this.started = true; this.handlers.start?.(); }
    stop() { this.handlers.end?.(); }
    abort() { this.aborted = true; this.handlers.end?.(); }
  }

  /** Boot the inline script inside a vm context and return helpers. */
  function bootScript({ fetchImpl, withSpeechRecognition = false }) {
    const html = renderBrowserPage({
      authenticated: true,
      browserPath: "/browser",
      agentName: "HouseCarl",
    });
    const script = extractScript(html);
    const { els, handlers } = createMockDom();

    /** @type {FakeSpeechRecognition|null} */
    let lastRecognition = null;
    const SpeechRecognitionCtor = withSpeechRecognition
      ? function () {
          lastRecognition = new FakeSpeechRecognition();
          return lastRecognition;
        }
      : undefined;

    const ctx = vm.createContext({
      document: {
        getElementById: (id) => els[id],
        createElement: () => ({
          textContent: "", className: "",
          appendChild() {},
        }),
      },
      window: {
        SpeechRecognition: SpeechRecognitionCtor,
        speechSynthesis: { cancel() {} },
      },
      navigator: { language: "en-US" },
      fetch: fetchImpl,
      console,
    });

    vm.runInContext(script, ctx);

    return {
      els,
      handlers,
      getState: () => vm.runInContext("state", ctx),
      getRecognition: () => lastRecognition,
    };
  }

  it("keeps session authenticated when /logout request fails", async () => {
    const { els, handlers, getState } = bootScript({
      fetchImpl: async () => { throw new Error("network down"); },
    });

    const logoutFn = handlers["logoutButton:click"];
    assert.ok(logoutFn, "logout click handler must be registered");

    await logoutFn();

    const state = getState();
    assert.strictEqual(state.authenticated, true,
      "session must stay authenticated when /logout request fails");
    assert.ok(!els.appCard.classList.contains("hidden"),
      "app card must remain visible on logout failure");
    assert.match(els.status.textContent, /[Ll]ock failed/,
      "status must show lock failure message");
    assert.match(els.status.className, /error/,
      "status must have error styling");
  });

  it("clears session and shows confirmation on successful /logout", async () => {
    const { els, handlers, getState } = bootScript({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      }),
    });

    const logoutFn = handlers["logoutButton:click"];
    await logoutFn();

    const state = getState();
    assert.strictEqual(state.authenticated, false,
      "session must be cleared after successful logout");
    assert.ok(els.appCard.classList.contains("hidden"),
      "app card must be hidden after logout");
    assert.ok(!els.loginCard.classList.contains("hidden"),
      "login card must be visible after logout");
    assert.match(els.loginStatus.textContent, /[Ll]ocked/,
      "login status must show locked confirmation");
  });

  it("logout aborts active SpeechRecognition", async () => {
    const { handlers, getRecognition } = bootScript({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      }),
      withSpeechRecognition: true,
    });

    // Start the mic so a recognition object is active
    const micClickFn = handlers["micButton:click"];
    assert.ok(micClickFn, "mic click handler must be registered");
    micClickFn();

    const rec = getRecognition();
    assert.ok(rec, "FakeSpeechRecognition must have been created");
    assert.strictEqual(rec.started, true, "recognition must have been started");

    // Now logout
    const logoutFn = handlers["logoutButton:click"];
    await logoutFn();

    assert.strictEqual(rec.aborted, true,
      "logout must abort the active SpeechRecognition");
  });

  it("401 on chat aborts active SpeechRecognition", async () => {
    let callCount = 0;
    const { handlers, getRecognition, getState } = bootScript({
      fetchImpl: async (url) => {
        callCount++;
        // First call is /login (from the mic-based sendMessage flow)
        // Actually, sendMessage calls /chat
        if (String(url).includes("/chat")) {
          return {
            ok: false,
            status: 401,
            json: async () => ({ error: "Unauthorized." }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        };
      },
      withSpeechRecognition: true,
    });

    // Start the mic
    const micClickFn = handlers["micButton:click"];
    micClickFn();
    const rec = getRecognition();
    assert.ok(rec, "recognition must exist");

    // Simulate a chat message (which will get a 401)
    const sendClickFn = handlers["sendButton:click"];
    assert.ok(sendClickFn, "send click handler must be registered");

    // We need to set the message input text
    // sendButton click calls sendMessage(messageInput.value)
    // The state is authenticated: true from bootScript
    // But we need text in the input
    // Let's directly call sendMessage via the send button
    // Actually, sendMessage checks !trimmed and returns early.
    // Let me just set the message input value:
    // We have access to els... but handlers["sendButton:click"] just calls sendMessage(messageInput.value)
    // We need to get els from bootScript. Let me re-check the destructuring.

    // Actually, the test doesn't have access to els through this destructuring.
    // Let's just verify that after a 401, recognition is aborted.
    // The simplest way: trigger recognition result event which calls sendMessage.
    const resultHandler = rec.handlers.result;
    if (resultHandler) {
      // Simulate a final speech result
      resultHandler({
        resultIndex: 0,
        results: {
          length: 1,
          0: { 0: { transcript: "hello" }, isFinal: true, length: 1 },
        },
      });
      // Wait for the async sendMessage to complete
      await new Promise(r => setTimeout(r, 50));
    }

    assert.strictEqual(rec.aborted, true,
      "401 response must abort the active SpeechRecognition");
    assert.strictEqual(getState().authenticated, false,
      "401 must clear authenticated state");
  });
});
