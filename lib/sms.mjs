// @ts-check
import { setTimeout as delay } from "node:timers/promises";
import twilio from "twilio";
import { splitSmsBody } from "./twilio.mjs";

/**
 * @typedef {object} SmsDeps
 * @property {(opts: { userText: string, mode: string }) => Promise} openclawReply
 * @property {((opts: { text: string }) => Promise)=} discordLog
 * @property {((opts: { to: string, from: string, body: string }) => Promise<*>)=} twilioSendSms
 * @property {string=} smsFrom
 */

/**
 * @typedef {object} SmsHandlerResult
 * @property {string} twiml
 * @property {boolean} didAck
 * @property {(() => Promise)|null} startAsync
 */

const { MessagingResponse } = twilio.twiml;

export function twimlMessage(text) {
  const r = new MessagingResponse();
  r.message(text || "Okay");
  return r.toString();
}

/** Build TwiML with multiple <Message> elements for long replies. */
export function twimlMessages(chunks) {
  const r = new MessagingResponse();
  for (const chunk of chunks) {
    r.message(chunk);
  }
  return r.toString();
}

// Best-effort normalization to avoid UCS2 where possible (which increases segments).
// HouseCarl patch: no truncation — twilio.mjs will split long replies into multiple SMS.
export function normalizeSmsText(input, { maxChars = 1600 } = {}) {
  let s = String(input || "");

  // Replace common Unicode punctuation with ASCII to reduce UCS2 likelihood.
  s = s
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...");

  // Collapse whitespace.
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

export async function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    (async () => {
      await delay(ms);
      throw new Error(`timeout after ${ms}ms`);
    })(),
  ]);
}

/**
 * Core SMS handler logic in a testable form.
 *
 * @param {{ form: Record, allowFrom?: string[], ackText?: string, fastTimeoutMs?: number, maxChars?: number, deps: SmsDeps, log?: Function, error?: Function }} opts
 * @returns {Promise}
 */
export async function handleIncomingSms({
  form,
  allowFrom = [],
  ackText = "Got it - thinking. I'll text you back in a moment.",
  fastTimeoutMs = 9000,
  maxChars = 1600,
  deps,
  log = () => {},
  error = (msg) => console.error(msg),
}) {
  if (!deps?.openclawReply) throw new Error("deps.openclawReply required");

  const from = form?.From;
  const to = form?.To;
  const text = form?.Body;
  const fromTrimmed = from?.trim() ?? "";
  const fromNormalized = fromTrimmed.startsWith("+") ? fromTrimmed : `+${fromTrimmed}`;
  const preview = String(text ?? "").slice(0, 80) + (String(text ?? "").length > 80 ? "…" : "");

  log(`[clawphone:sms] incoming from ${fromNormalized} to ${to}: ${preview}`);

  // Log to Discord if configured
  if (deps?.discordLog) {
    void deps.discordLog({ text: `💬 **SMS (${from})**: ${text}` }).catch(() => {});
  }

  // For SMS: accept from anyone, but only reply if sender is allowed
  const isAllowedSender = !allowFrom.length || (fromNormalized && allowFrom.includes(fromNormalized));

  if (!isAllowedSender) {
    log(`[clawphone:sms] rejected sender ${fromNormalized} (not in allowlist)`);
    return {
      twiml: twimlMessage("Unauthorized"),
      didAck: false,
      startAsync: null,
    };
  }

  const smsFrom = deps.smsFrom || to;

  // Try fast path
  try {
    const fastReplyRaw = await withTimeout(deps.openclawReply({ userText: text, mode: "sms" }), fastTimeoutMs);
    const fastReply = normalizeSmsText(fastReplyRaw || "Okay", { maxChars });
    log(`[clawphone:sms] reply (fast, ${fastReply.length} chars)`);
    const chunks = splitSmsBody(fastReply, 160);
    return {
      twiml: chunks.length <= 1 ? twimlMessage(fastReply) : twimlMessages(chunks),
      didAck: false,
      startAsync: null,
    };
  } catch (err) {
    log(`[clawphone:sms] fast path timeout/error, falling back to async: ${String(err)}`);
  }

  // Slow path: ack now, then async send
  const startAsync = async () => {
    let reply;
    try {
      const replyRaw = await deps.openclawReply({ userText: text, mode: "sms" });
      reply = normalizeSmsText(replyRaw || "Okay", { maxChars });
      log(`[clawphone:sms] reply (async, ${reply.length} chars)`);
    } catch (e) {
      error(`[clawphone:sms] agent error in async path: ${String(e)}`);
      reply = "Sorry — I hit an error generating a reply.";
    }

    if (!deps.twilioSendSms) {
      log("[clawphone:sms] twilioSendSms not configured; skipping async send");
      return;
    }

    try {
      const sent = await deps.twilioSendSms({ to: from, from: smsFrom, body: reply });
      log(`[clawphone:sms] async send ok sid=${sent?.sid ?? "(unknown)"}`);
    } catch (e) {
      error(`[clawphone:sms] async send failed: ${String(e)}`);
    }
  };

  return {
    twiml: twimlMessage(ackText),
    didAck: true,
    startAsync,
  };
}
