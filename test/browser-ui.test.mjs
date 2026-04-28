// @ts-check
/**
 * Unit tests for lib/browser-ui.mjs — renderBrowserPage().
 *
 * These tests import the template function directly and validate the
 * structural invariants of the client-side JavaScript it emits.
 * They verify that auth/session/recognition hardening code is present
 * and correctly wired without needing a DOM runtime.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
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

  it("logout calls resetConversationUi", () => {
    const logoutBody = script.match(
      /async function logout\(\)\s*\{([\s\S]*?)(?=\n\s*async function|\n\s*function\s+\w)/
    );
    assert.ok(logoutBody);
    assert.match(logoutBody[1], /resetConversationUi\(\)/, "logout must call resetConversationUi");
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
