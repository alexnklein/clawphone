// @ts-check
import crypto from "node:crypto";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { run as defaultRun, createSemaphore } from "./utils.mjs";
import {
  OPENCLAW_AGENT_ID,
  OPENCLAW_PHONE_SESSION_ID,
  OPENCLAW_TIMEOUT_SECONDS,
  OPENCLAW_MAX_CONCURRENT,
  SMS_MAX_CHARS,
  DISCORD_LOG_CHANNEL_ID,
  SHARED_SESSION_KEY,
  CALLER_PROFILES,
  resolveCallerTier,
} from "./config.mjs";

const agentSem = createSemaphore(OPENCLAW_MAX_CONCURRENT);
let discordInFlight = 0;
const DISCORD_MAX_IN_FLIGHT = 5;

// ─────────────────────────────────────────────────────────────
// Plugin path: lazy-load runEmbeddedPiAgent from openclaw dist
// ─────────────────────────────────────────────────────────────

let _coreDeps = null;

async function _getCoreDeps() {
  if (_coreDeps) return _coreDeps;
  // The plugin runs inside the openclaw process; process.argv[1] is the openclaw
  // entry point (e.g. /.../openclaw/dist/index.js). extensionAPI.js lives alongside it.
  const distPath = join(dirname(process.argv[1]), "extensionAPI.js");
  _coreDeps = await import(pathToFileURL(distPath).href);
  return _coreDeps;
}

// ─────────────────────────────────────────────────────────────
// Tier-aware prompt builder
// ─────────────────────────────────────────────────────────────

/**
 * Build channel-specific capability block based on caller tier.
 * @param {'owner'|'household'|'supplier'} tier
 * @returns {string}
 */
function _buildCapabilities(tier) {
  if (tier === "supplier") {
    return (
      `SUPPLIER INTERACTION — RESTRICTED MODE\n` +
      `You are speaking with a supplier/contractor. You may:\n` +
      `- Confirm or discuss appointment times and scheduling\n` +
      `- Provide property access instructions (address, gate code, parking)\n` +
      `- Answer questions about ongoing work scope and context\n` +
      `- Accept work status updates and relay to owner\n` +
      `- Use the exec tool to check calendar or scheduling info\n\n` +
      `You must NOT:\n` +
      `- Control any smart home devices (lights, heating, pool, etc.)\n` +
      `- Access or share financial information (Wise, invoices, etc.)\n` +
      `- Access or share personal/family information from MEMORY.md or USER.md\n` +
      `- Send messages to other people on behalf of the supplier\n` +
      `- Execute system commands, restart services, or modify configuration\n` +
      `- Share details about other suppliers or household members\n\n` +
      `If the supplier asks for something outside your authorized scope, ` +
      `politely decline and offer to relay the request to Alex.\n` +
      `All messages from this supplier are logged and visible to the owner.`
    );
  }

  // Owner and household get full capabilities — include explicit tool paths
  // to ensure parity with Telegram even when bootstrap files are truncated
  return (
    `IMPORTANT: You have FULL tool access on this channel — exec, read, write, web_search, etc. ` +
    `Use tools whenever the request requires action (device control, sending messages, checking status, running scripts). ` +
    `Do NOT hallucinate actions — if you need to run a command, actually use the exec tool. ` +
    `If you cannot perform an action, say so honestly rather than claiming you did it.\n\n` +
    `KEY TOOLS (use exec to run these):\n` +
    `- Send SMS: python3 ~/.openclaw/scripts/send_sms.py --to <number> --message "<text>"\n` +
    `- House status: python3 ~/.openclaw/scripts/house_status.py\n` +
    `- Shelly devices: python3 ~/.openclaw/scripts/shelly_control.py status\n` +
    `- Hue lights: openhue get lights (bridge at 192.168.4.214)\n` +
    `- Full tool reference: Read ~/.openclaw/workspace/TOOLS.md\n` +
    `- Channel rules: Read ~/.openclaw/workspace/CHANNELS.md\n\n` +
    `KNOWN CONTACTS:\n` +
    `- Alex Klein: +447435344969 (owner)\n` +
    `- Taylor Klein: +447398219090 (household)\n` +
    `- HouseCarl Twilio: +447446605428 (our number)`
  );
}

/**
 * Build the prompt sent to the OpenClaw agent.
 *
 * @param {string} userText - User's message
 * @param {'voice'|'sms'} mode - Channel mode
 * @param {string} [callerName] - Display name
 * @param {{ tier: string, role?: string, context?: string }} [callerInfo] - Tier info from resolveCallerTier
 * @returns {string}
 */
function _buildPrompt(userText, mode, callerName = "", callerInfo = null) {
  const tier = callerInfo?.tier || "household";
  const capabilities = _buildCapabilities(tier);

  // Build caller label
  let callerLabel = "";
  if (tier === "supplier") {
    const parts = [callerName, callerInfo?.role].filter(Boolean);
    const supplierDesc = parts.length ? parts.join(" - ") : "unknown supplier";
    const contextNote = callerInfo?.context ? `, context: ${callerInfo.context}` : "";
    callerLabel = ` from supplier (${supplierDesc}${contextNote})`;
  } else {
    callerLabel = callerName ? ` (${callerName})` : "";
  }

  if (mode === "sms") {
    const responseFormat =
      `RESPONSE FORMAT: Your final reply will be sent as SMS. ` +
      `Keep the reply text <= ${SMS_MAX_CHARS} characters. ` +
      `Use plain ASCII only (no emojis, no curly quotes, no em-dashes). ` +
      `No markdown. If the answer is too long, give the single most important sentence. ` +
      `But you CAN and SHOULD use tools before replying — tool usage does not count toward the character limit.`;
    return `SMS${callerLabel}: ${userText}\n\n${capabilities}\n\n${responseFormat}`;
  }

  // Voice mode
  const responseFormat =
    `RESPONSE FORMAT: Your reply will be spoken aloud via TTS. ` +
    `Keep it conversational and natural. ` +
    `You CAN and SHOULD use tools before replying — only your final spoken text matters.`;
  return `Phone call${callerLabel}: ${userText}\n\n${capabilities}\n\n${responseFormat}`;
}

// ─────────────────────────────────────────────────────────────
// discordLog
// ─────────────────────────────────────────────────────────────

/**
 * Log a message to Discord (fire-and-forget).
 *
 * Plugin path (_api provided): calls api.runtime.channel.discord.sendMessageDiscord.
 * Standalone / PM2 path: spawns `openclaw message send` CLI subprocess.
 *
 * @param {object} options
 * @param {string}   options.text   - Message to log
 * @param {Function} [options.run]  - Injectable run fn (standalone path, for testing)
 * @param {object}   [options._api] - OpenClaw plugin api object (plugin path)
 */
export async function discordLog({ text, run = defaultRun, _api }) {
  if (!DISCORD_LOG_CHANNEL_ID) return;

  // ── Plugin path ────────────────────────────────────────────────────────
  if (_api) {
    return _api.runtime.channel.discord
      .sendMessageDiscord(DISCORD_LOG_CHANNEL_ID, text, { accountId: "default" })
      .catch(() => {});
  }

  // ── Standalone / PM2 path ─────────────────────────────────────────────
  if (discordInFlight >= DISCORD_MAX_IN_FLIGHT) return;
  discordInFlight++;
  try {
    const target = `channel:${DISCORD_LOG_CHANNEL_ID}`;
    await run("openclaw", [
      "message",
      "send",
      "--channel",
      "discord",
      "--target",
      target,
      "--message",
      text,
    ]);
  } finally {
    discordInFlight--;
  }
}

// ─────────────────────────────────────────────────────────────
// openclawReply
// ─────────────────────────────────────────────────────────────

/**
 * Get a reply from the OpenClaw agent.
 *
 * Plugin path (_api provided): calls runEmbeddedPiAgent in-process via
 * openclaw/dist/extensionAPI.js. Pass _coreDeps to inject a mock in tests.
 *
 * Standalone / PM2 path: spawns `openclaw agent` CLI subprocess.
 *
 * @param {object}   options
 * @param {string}   options.userText    - The user's message
 * @param {'voice'|'sms'} [options.mode] - Response mode (affects prompt framing)
 * @param {string}   [options.callerName] - Optional caller name for prompt framing
 * @param {{ tier: string, name: string, role?: string, context?: string }} [options.callerInfo] - Tier info from resolveCallerTier
 * @param {Function} [options.run]        - Injectable run fn (standalone path, for testing)
 * @param {object}   [options._api]       - OpenClaw plugin api object (plugin path)
 * @param {object}   [options._coreDeps]  - Injectable core deps (plugin path, for testing)
 * @param {string}   [options.agentId]    - Override agent ID (from plugin config)
 * @param {string}   [options.sessionId]  - Override session ID (from plugin config)
 * @param {string}   [options.fromNumber] - Caller's phone number (for supplier session isolation)
 * @returns {Promise<string>} The agent's reply text
 */
export async function openclawReply({
  userText,
  mode = "voice",
  callerName = "",
  callerInfo = null,
  run = defaultRun,
  _api,
  _coreDeps,
  agentId: agentIdOverride,
  sessionId: sessionIdOverride,
  fromNumber = "",
}) {
  // ── Plugin path ────────────────────────────────────────────────────────
  if (_api) {
    const deps = _coreDeps ?? await _getCoreDeps();
    const cfg = _api.config;
    const agentId = agentIdOverride ?? OPENCLAW_AGENT_ID;
    const sessionId = sessionIdOverride ?? OPENCLAW_PHONE_SESSION_ID;
    // Session key strategy depends on caller tier:
    // - Supplier: isolated per-supplier session (never shares household context)
    // - Owner/Household: shared session key (cross-channel context with Telegram)
    const tier = callerInfo?.tier || "household";
    let sessionKey;
    if (tier === "supplier" && fromNumber) {
      // Suppliers get isolated sessions — they never see household conversation history
      sessionKey = `supplier:${fromNumber}`;
    } else {
      // Owner/household share context with Telegram
      const sharedKey = SHARED_SESSION_KEY || cfg?.plugins?.entries?.clawphone?.config?.sharedSessionKey || "";
      sessionKey = sharedKey || `${mode}:${sessionId}`;
    }

    const storePath = deps.resolveStorePath(cfg.session?.store, { agentId });
    const agentDir = deps.resolveAgentDir(cfg, agentId);
    const workspaceDir = deps.resolveAgentWorkspaceDir(cfg, agentId);
    await deps.ensureAgentWorkspace({ dir: workspaceDir });

    const store = deps.loadSessionStore(storePath);
    const entry = store[sessionKey] ?? { sessionId: crypto.randomUUID(), updatedAt: Date.now() };
    store[sessionKey] = { ...entry, updatedAt: Date.now() };
    await deps.saveSessionStore(storePath, store);

    const sessionFile = deps.resolveSessionFilePath(entry.sessionId, entry, { agentId });
    const timeoutMs = deps.resolveAgentTimeoutMs({ cfg });

    await agentSem.acquire();
    try {
      const result = await deps.runEmbeddedPiAgent({
        sessionId:       entry.sessionId,
        sessionKey,
        messageProvider: mode,
        sessionFile,
        workspaceDir,
        agentDir,
        config:          cfg,
        prompt:          _buildPrompt(userText, mode, callerName, callerInfo),
        // Pin provider/model to the working local Claude CLI bridge.
        provider:        "hc-bridge",
        model:           "opus",
        verboseLevel:    "off",
        timeoutMs,
        runId:           `${mode}:${Date.now()}`,
        // Use main lane so SMS uses the same stable model routing
        // as the rest of HouseCarl (hc-bridge/opus -> local fallback chain).
        lane:            "main",
      });
      return (result.payloads ?? [])
        .filter(p => p.text && !p.isError)
        .map(p => p.text?.trim())
        .filter(Boolean)
        .join(" ") || "";
    } finally {
      agentSem.release();
    }
  }

  // ── Standalone / PM2 path ─────────────────────────────────────────────
  const prompt = _buildPrompt(userText, mode, callerName, callerInfo);

  await agentSem.acquire();
  try {
    const { stdout } = await run("openclaw", [
      "agent",
      "--agent",
      OPENCLAW_AGENT_ID,
      "--session-id",
      OPENCLAW_PHONE_SESSION_ID,
      "--channel",
      "discord",
      "--message",
      prompt,
      "--thinking",
      "off",
      "--json",
      "--timeout",
      String(OPENCLAW_TIMEOUT_SECONDS),
    ]);

    // Resilient to schema differences across openclaw versions.
    try {
      const j = JSON.parse(stdout);
      return (
        j?.result?.payloads?.[0]?.text ||
        j?.reply?.text ||
        j?.message?.content ||
        j?.content ||
        j?.text ||
        j?.output?.text ||
        ""
      ).trim();
    } catch {
      return stdout.trim();
    }
  } finally {
    agentSem.release();
  }
}
