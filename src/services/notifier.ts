/**
 * notifier.ts
 * ─────────────────────────────────────────────────────────────────
 * Sends approval/alert messages to the owner when a limit is hit.
 *
 * Supported channels (configure in .env):
 *   Telegram  — TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
 *   Webhook   — ALERT_WEBHOOK_URL  (Slack / Discord / any HTTP POST)
 *   Console   — always logs (fallback, no config needed)
 *
 * Setup guide is at the bottom of this file.
 */

export type AlertType =
  | 'DAILY_CAP_HIT'
  | 'DAILY_CAP_80PCT'
  | 'RATE_LIMIT_HIT'
  | 'SUSPICIOUS_REQUEST'
  | 'INVALID_API_KEY'
  | 'BUDGET_OK';          // daily reset confirmation (morning)

export interface AlertPayload {
  type:     AlertType;
  provider?: string;      // 'gemini' | 'perplexity'
  used?:    number;
  cap?:     number;
  ip?:      string;
  path?:    string;
  message:  string;
}

// ── Emoji + severity per alert type ───────────────────────────────
const META: Record<AlertType, { emoji: string; label: string }> = {
  DAILY_CAP_HIT:       { emoji: '🚨', label: 'DAILY CAP HIT — AI blocked' },
  DAILY_CAP_80PCT:     { emoji: '⚠️',  label: 'APPROACHING DAILY CAP (80%)' },
  RATE_LIMIT_HIT:      { emoji: '🚦', label: 'RATE LIMIT TRIGGERED' },
  SUSPICIOUS_REQUEST:  { emoji: '🔴', label: 'SUSPICIOUS REQUEST BLOCKED' },
  INVALID_API_KEY:     { emoji: '🔑', label: 'INVALID API KEY ATTEMPT' },
  BUDGET_OK:           { emoji: '✅', label: 'Daily counters reset — all good' },
};

// ── Main send function ─────────────────────────────────────────────
export async function sendAlert(payload: AlertPayload): Promise<void> {
  const { emoji, label } = META[payload.type];
  const ts   = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const env  = process.env.NODE_ENV || 'development';

  const lines = [
    `${emoji} GrocerSnap Alert`,
    `📋 ${label}`,
    `🕐 ${ts}`,
    `🌍 Env: ${env}`,
    payload.provider ? `🤖 Provider: ${payload.provider}` : '',
    payload.used !== undefined && payload.cap !== undefined
      ? `📊 Usage: ${payload.used} / ${payload.cap} (${Math.round((payload.used/payload.cap)*100)}%)`
      : '',
    payload.ip   ? `🌐 IP: ${payload.ip}` : '',
    payload.path ? `📂 Path: ${payload.path}` : '',
    `💬 ${payload.message}`,
  ].filter(Boolean);

  const text = lines.join('\n');

  // Always log to console
  console.warn(`[ALERT] ${text.replace(/\n/g, ' | ')}`);

  // Send in parallel — failures are swallowed so they never crash the API
  await Promise.allSettled([
    sendTelegram(text),
    sendWebhook(payload, text),
  ]);
}

// ── Telegram ──────────────────────────────────────────────────────
async function sendTelegram(text: string): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    signal: AbortSignal.timeout(5000),
  });
}

// ── Generic Webhook (Slack / Discord / custom) ────────────────────
async function sendWebhook(payload: AlertPayload, text: string): Promise<void> {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;

  const { emoji, label } = META[payload.type];

  // Auto-detect Slack vs Discord vs generic by URL shape
  let body: string;

  if (url.includes('hooks.slack.com')) {
    // Slack format
    body = JSON.stringify({ text: `*${emoji} ${label}*\n${text}` });
  } else if (url.includes('discord.com/api/webhooks')) {
    // Discord format
    body = JSON.stringify({ content: `**${emoji} ${label}**\n\`\`\`${text}\`\`\`` });
  } else {
    // Generic webhook — plain JSON
    body = JSON.stringify({ alert: payload.type, ...payload, formatted: text });
  }

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(5000),
  });
}

/*
 ═══════════════════════════════════════════════════════════════════
 SETUP GUIDE — TELEGRAM (FREE, 2 minutes)
 ═══════════════════════════════════════════════════════════════════

 Step 1: Create your bot
   • Open Telegram → search @BotFather → send /newbot
   • Follow prompts → copy the token it gives you

 Step 2: Get your Chat ID
   • Send any message to your new bot
   • Open: https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
   • Find "chat":{"id": XXXXXXX} — that number is your Chat ID

 Step 3: Add to .env
   TELEGRAM_BOT_TOKEN=123456789:ABCdef...
   TELEGRAM_CHAT_ID=987654321

 ═══════════════════════════════════════════════════════════════════
 SETUP GUIDE — SLACK
 ═══════════════════════════════════════════════════════════════════

   • Slack → Your workspace → Apps → Incoming Webhooks → Add
   • Copy the webhook URL → paste into .env:
   ALERT_WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz

 ═══════════════════════════════════════════════════════════════════
 SETUP GUIDE — DISCORD
 ═══════════════════════════════════════════════════════════════════

   • Discord server → channel settings ⚙️ → Integrations → Webhooks
   • Create Webhook → Copy URL → paste into .env:
   ALERT_WEBHOOK_URL=https://discord.com/api/webhooks/xxx/yyy

 ═══════════════════════════════════════════════════════════════════
*/
