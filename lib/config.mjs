// @ts-check
/**
 * Centralized configuration with sensible defaults.
 * All magic numbers and repeated values live here.
 */

/**
 * @typedef {object} PluginConfig
 * @property {number} [port]
 * @property {string[]} [allowFrom]
 * @property {string} [twilioAccountSid]
 * @property {string} [twilioAuthToken]
 * @property {string} [twilioSmsFrom]
 * @property {string} [publicBaseUrl]
 * @property {string} [openclawSessionId]
 * @property {string} [openclawAgentId]
 * @property {number} [openclawMaxConcurrent]
 * @property {string} [discordLogChannelId]
 * @property {string} [callerName]
 * @property {string} [agentName]
 * @property {string} [greetingText]
 * @property {number} [smsMaxChars]
 * @property {number} [smsFastTimeoutMs]
 * @property {number} [rateLimitMax]
 * @property {number} [rateLimitWindowMs]
 * @property {number} [speechWaitPauseSeconds]
 * @property {string} [twilioSttModel]
 * @property {string} [sharedSessionKey] - When set, SMS/voice use this session key for cross-channel context sharing
 * @property {Object<string, CallerProfile>} [callerProfiles] - Per-number tier/name/context for tiered access
 */

/**
 * @typedef {object} CallerProfile
 * @property {'owner'|'household'|'supplier'} tier - Access tier
 * @property {string} name - Display name for prompt framing
 * @property {string} [role] - Role/trade (supplier only, e.g. "Plumber")
 * @property {string} [context] - Ongoing work context (e.g. "Bathroom renovation Q1 2026")
 */

// Load .env file
import { config as dotenvConfig } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: join(__dirname, '..', '.env') });

// Server
export const PORT = Number(process.env.PORT || 8787);
export const ALLOW_FROM = (process.env.ALLOW_FROM || "").split(",").map(s => s.trim()).filter(Boolean);
export const ACK_ALLOW_FROM = (process.env.ACK_ALLOW_FROM || "").split(",").map(s => s.trim()).filter(Boolean);

// Twilio credentials
export const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
export const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
export const TWILIO_SMS_FROM = process.env.TWILIO_SMS_FROM;

// Public base URL for webhook signature validation (e.g. https://twilio.i2dev.com)
export const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";

// OpenClaw
export const OPENCLAW_PHONE_SESSION_ID = process.env.OPENCLAW_PHONE_SESSION_ID || "phone";
export const OPENCLAW_AGENT_ID = process.env.OPENCLAW_AGENT_ID || "phone";
export const SHARED_SESSION_KEY = process.env.SHARED_SESSION_KEY || "";

// Display names (used in voice greeting, Discord logs, and agent prompt framing)
export const CALLER_NAME = process.env.CALLER_NAME || "";
export const AGENT_NAME = process.env.AGENT_NAME || "";
export const GREETING_TEXT = process.env.GREETING_TEXT || "You are connected. Say something after the beep.";
export const OPENCLAW_TIMEOUT_SECONDS = 120;
export const OPENCLAW_MAX_CONCURRENT = Number(process.env.OPENCLAW_MAX_CONCURRENT || 10);

// Voice settings
export const TWILIO_VOICE = "Google.en-US-Chirp3-HD-Charon";
export const TWILIO_STT_MODEL = process.env.TWILIO_STT_MODEL || "phone_call";

// Timeouts (milliseconds)
export const SMS_FAST_TIMEOUT_MS = Number(process.env.SMS_FAST_TIMEOUT_MS || 7000); // Max time to wait before acking SMS
export const SPEECH_WAIT_PAUSE_SECONDS = Number(process.env.SPEECH_WAIT_PAUSE_SECONDS || 1); // Pause between /speech-wait polls
export const GATHER_TIMEOUT_SECONDS = 10;      // Initial gather timeout
export const GATHER_FOLLOWUP_TIMEOUT_SECONDS = 12; // Follow-up gather timeout

// SMS
export const SMS_MAX_CHARS = Number(process.env.SMS_MAX_CHARS || 280);

// Rate limiting (per-number sliding window; 0 = disabled)
export const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 20);
export const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);

// Sayable text
export const MAX_SAYABLE_LENGTH = 600;

// Discord logging
export const DISCORD_LOG_CHANNEL_ID = process.env.DISCORD_LOG_CHANNEL_ID;

// Caller profiles (tiered identity — owner/household/supplier)
// Default profiles when not configured via plugin config
export const CALLER_PROFILES = {};

// Thinking phrases for voice responses (short — 2-3 words — to avoid overrunning fast agents)
export const THINKING_PHRASES = [
  "One moment.",
  "Let me check.",
  "Hold on.",
  "Just a second.",
  "Sure, one moment.",
];

/** @returns {string} */
export function getRandomThinkingPhrase() {
  return THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)];
}

// Poll-cycle filler phrases — played during /speech-wait polling when agent is not done yet.
// Capped at 2 uses per turn (poll 1 and poll 2) to avoid becoming repetitive.
export const POLL_FILLER_PHRASES = [
  "Still working on it.",
  "Almost there.",
];

/**
 * Resolve the caller tier for a given phone number.
 *
 * Lookup order: callerProfiles (exact match) → allowFrom membership → reject.
 * Numbers in callerProfiles are automatically allowed (don't need to be in allowFrom).
 *
 * @param {string} fromNumber - Normalized phone number (e.g. "+447435344969")
 * @param {Object<string, CallerProfile>} callerProfiles - Per-number tier config
 * @param {string[]} allowFrom - Legacy flat allowlist
 * @returns {{ tier: 'owner'|'household'|'supplier'|'rejected', name: string, role?: string, context?: string }}
 */
export function resolveCallerTier(fromNumber, callerProfiles = {}, allowFrom = []) {
  // Check callerProfiles first (structured tier data)
  const profile = callerProfiles[fromNumber];
  if (profile) {
    return {
      tier: profile.tier || "household",
      name: profile.name || "",
      role: profile.role,
      context: profile.context,
    };
  }

  // Fallback: if in allowFrom but not in callerProfiles, default to "household"
  if (allowFrom.length && allowFrom.includes(fromNumber)) {
    return { tier: "household", name: "" };
  }

  // Not in any allowlist
  if (allowFrom.length === 0) {
    // No allowlist configured — allow with default tier (dev/test mode)
    return { tier: "household", name: "" };
  }

  return { tier: "rejected", name: "" };
}

/**
 * Translate a camelCase OpenClaw plugin config object into the SCREAMING_SNAKE_CASE
 * shape used throughout the rest of the codebase.
 *
 * Used by index.mjs (plugin path). The env-var exports above remain the standalone path.
 *
 * @param {PluginConfig} cfg - Validated plugin config from openclaw.plugin.json configSchema
 */
export function fromPluginConfig(cfg) {
  const phrases = [
    "One moment.",
    "Let me check.",
    "Hold on.",
    "Just a second.",
    "Sure, one moment.",
  ];
  const fillerPhrases = [
    "Still working on it.",
    "Almost there.",
  ];
  return {
    PORT:                       cfg.port                  ?? 8787,
    ALLOW_FROM:                 (cfg.allowFrom && cfg.allowFrom.length) ? cfg.allowFrom : ALLOW_FROM,
    ACK_ALLOW_FROM:             ACK_ALLOW_FROM,
    TWILIO_ACCOUNT_SID:         cfg.twilioAccountSid      ?? "",
    TWILIO_AUTH_TOKEN:          cfg.twilioAuthToken       ?? "",
    TWILIO_SMS_FROM:            cfg.twilioSmsFrom         ?? "",
    PUBLIC_BASE_URL:            cfg.publicBaseUrl         ?? "",
    OPENCLAW_PHONE_SESSION_ID:  cfg.openclawSessionId     ?? "phone",
    OPENCLAW_AGENT_ID:          cfg.openclawAgentId       ?? "phone",
    OPENCLAW_MAX_CONCURRENT:    cfg.openclawMaxConcurrent ?? 10,
    SHARED_SESSION_KEY:         cfg.sharedSessionKey      ?? "",
    CALLER_PROFILES:            cfg.callerProfiles        ?? {},
    DISCORD_LOG_CHANNEL_ID:     cfg.discordLogChannelId   ?? "",
    CALLER_NAME:                cfg.callerName            ?? "",
    AGENT_NAME:                 cfg.agentName             ?? "",
    GREETING_TEXT:              cfg.greetingText          ?? "You are connected. Say something after the beep.",
    SMS_MAX_CHARS:              cfg.smsMaxChars           ?? 280,
    SMS_FAST_TIMEOUT_MS:        cfg.smsFastTimeoutMs      ?? 7000,
    RATE_LIMIT_MAX:             cfg.rateLimitMax              ?? 20,
    RATE_LIMIT_WINDOW_MS:       cfg.rateLimitWindowMs         ?? 60000,
    SPEECH_WAIT_PAUSE_SECONDS:  cfg.speechWaitPauseSeconds    ?? 1,
    TWILIO_STT_MODEL:           cfg.twilioSttModel            ?? "phone_call",
    // Static values — not exposed as plugin config knobs
    OPENCLAW_TIMEOUT_SECONDS:         120,
    TWILIO_VOICE:                     "Google.en-US-Chirp3-HD-Charon",
    MAX_SAYABLE_LENGTH:               600,
    GATHER_TIMEOUT_SECONDS:           10,
    GATHER_FOLLOWUP_TIMEOUT_SECONDS:  12,
    THINKING_PHRASES:                 phrases,
    POLL_FILLER_PHRASES:              fillerPhrases,
    getRandomThinkingPhrase() {
      return phrases[Math.floor(Math.random() * phrases.length)];
    },
  };
}
