// @ts-check
import Twilio from "twilio";

/**
 * @typedef {object} SmsResult
 * @property {string} sid
 * @property {string} status
 * @property {*} errorCode
 * @property {*} errorMessage
 * @property {string} to
 * @property {string} from
 */

/**
 * @param {{ authToken: string, signature: string, url: string, params: Record }} opts
 * @returns {boolean}
 */
export function validateWebhookSignature({ authToken, signature, url, params }) {
  return Twilio.validateRequest(authToken, signature || "", url, params);
}

/**
 * Split long SMS body into chunks at word boundaries (max 160 chars per segment).
 * @param {string} body
 * @param {number} maxLen
 * @returns {string[]}
 */
export function splitSmsBody(body, maxLen = 160) {
  const s = String(body || "").trim();
  if (!s) return [];
  if (s.length <= maxLen) return [s];
  const chunks = [];
  let remaining = s;
  while (remaining) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.slice(0, maxLen).lastIndexOf(" ");
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  return chunks;
}

/**
 * @param {{ accountSid: string, authToken: string, _twilioFactory?: Function }} opts
 * @returns {{ sendSms: (opts: { to: string, from: string, body: string }) => Promise }}
 */
export function createTwilioClient({ accountSid, authToken, _twilioFactory }) {
  if (!accountSid || !authToken) {
    throw new Error("accountSid/authToken required");
  }

  const client = _twilioFactory
    ? _twilioFactory(accountSid, authToken)
    : new Twilio(accountSid, authToken);

  async function sendSms({ to, from, body }) {
    if (!to || !from) throw new Error(`Missing to/from (to=${to}, from=${from})`);

    const chunks = splitSmsBody(body || "", 160);
    let lastMsg = null;

    for (const chunk of chunks) {
      const msg = await client.messages.create({ to, from, body: chunk });
      lastMsg = {
        sid: msg.sid,
        status: msg.status,
        errorCode: msg.errorCode,
        errorMessage: msg.errorMessage,
        to: msg.to,
        from: msg.from,
      };
    }

    return lastMsg ?? { sid: "", status: "", errorCode: null, errorMessage: null, to, from };
  }

  return { sendSms };
}
