/**
 * budget-guard.ts
 * ─────────────────────────────────────────────────────────────────
 * Tracks daily AI API call counts and enforces hard spending caps.
 * Resets automatically at midnight UTC every day.
 *
 * Cost reference (April 2026):
 *   Gemini Flash  — FREE for first 1,500 req/day, then ~$0.075/1M tokens
 *   Perplexity    — ~$0.20 per 1,000 requests ($0.0002 each)
 *
 * Monthly $20 budget breakdown (conservative caps):
 *   Gemini   : stay under 1,400/day  → always FREE (1,500 free tier)
 *   Perplexity: cap 200/day          → 6,000/mo   → ~$1.20/mo
 *   Render   : free tier             → $0/mo
 *   Total worst case                 → ~$1.20/mo  (well under $20)
 */

import { sendAlert } from './notifier';

export type ApiProvider = 'gemini' | 'perplexity' | 'deepseek';

interface DayCounts {
  gemini: number;
  perplexity: number;
  deepseek: number;
  date: string; // YYYY-MM-DD UTC
}

// ── Hard daily caps ────────────────────────────────────────────────
// Change these in .env to override:
//   DAILY_CAP_GEMINI=1400
//   DAILY_CAP_PERPLEXITY=200
function getCap(key: string, defaultVal: number): number {
  const v = process.env[key];
  if (v && !isNaN(Number(v))) return Number(v);
  return defaultVal;
}

const CAPS: Record<ApiProvider, () => number> = {
  gemini:     () => getCap('DAILY_CAP_GEMINI',     1_400),
  perplexity: () => getCap('DAILY_CAP_PERPLEXITY',   200),
  deepseek:   () => getCap('DAILY_CAP_DEEPSEEK',      50),   // ~$0.025/day max
};

// Estimated cost per call (USD)
const COST_PER_CALL: Record<ApiProvider, number> = {
  gemini:     0,        // free tier
  perplexity: 0.0002,   // $0.20 per 1,000
  deepseek:   0.0005,   // ~$0.50 per 1,000 (mixed input+output at typical length)
};

// ── In-memory counters (reset on new UTC day) ──────────────────────
let counts: DayCounts = {
  gemini: 0,
  perplexity: 0,
  deepseek: 0,
  date: todayUTC(),
};

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function refreshIfNewDay() {
  const today = todayUTC();
  if (counts.date !== today) {
    counts = { gemini: 0, perplexity: 0, deepseek: 0, date: today };
    console.log(`[budget-guard] 🌅 New day (${today}) — counters reset`);
  }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Call BEFORE making an AI API request.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
export function checkBudget(provider: ApiProvider): { allowed: boolean; reason?: string } {
  refreshIfNewDay();
  const used = counts[provider];
  const cap  = CAPS[provider]();

  if (used >= cap) {
    const reason = `Daily ${provider} cap reached (${used}/${cap}). Resets at midnight UTC.`;
    console.warn(`[budget-guard] 🚫 ${reason}`);

    // Fire alert — non-blocking
    sendAlert({
      type: 'DAILY_CAP_HIT',
      provider,
      used,
      cap,
      message: `${provider.toUpperCase()} is BLOCKED for the rest of today. Resets at midnight UTC.\n\nTo raise the cap: update DAILY_CAP_${provider.toUpperCase()} in .env and restart the server.`,
    }).catch(() => {});

    return { allowed: false, reason };
  }
  return { allowed: true };
}

/**
 * Call AFTER a successful AI API request to increment the counter.
 */
export function recordCall(provider: ApiProvider, calls = 1) {
  refreshIfNewDay();
  counts[provider] += calls;

  const used = counts[provider];
  const cap  = CAPS[provider]();
  const pct  = Math.round((used / cap) * 100);

  // Alert at 80% and 95%
  if (pct === 95) {
    console.warn(`[budget-guard] ⚠️  ${provider} at 95% daily cap (${used}/${cap})`);
    sendAlert({
      type: 'DAILY_CAP_80PCT',
      provider,
      used,
      cap,
      message: `${provider.toUpperCase()} is at 95% of daily cap. Only ${cap - used} calls remaining today.\n\nConsider raising DAILY_CAP_${provider.toUpperCase()} in .env if needed.`,
    }).catch(() => {});
  } else if (pct === 80) {
    console.warn(`[budget-guard] ⚠️  ${provider} at 80% daily cap (${used}/${cap})`);
    sendAlert({
      type: 'DAILY_CAP_80PCT',
      provider,
      used,
      cap,
      message: `${provider.toUpperCase()} is at 80% of daily cap. ${cap - used} calls remaining today. Just a heads-up!`,
    }).catch(() => {});
  }
}

/**
 * Returns current usage stats + estimated costs for the dashboard.
 */
export function getUsageReport() {
  refreshIfNewDay();

  const providers: ApiProvider[] = ['gemini', 'perplexity', 'deepseek'];
  const breakdown = providers.map(p => {
    const used   = counts[p];
    const cap    = CAPS[p]();
    const cost   = COST_PER_CALL[p] * used;
    const pct    = cap > 0 ? Math.round((used / cap) * 100) : 0;
    return { provider: p, used, cap, pct, estimatedCostUSD: parseFloat(cost.toFixed(4)) };
  });

  const totalCostUSD = breakdown.reduce((s, b) => s + b.estimatedCostUSD, 0);

  return {
    date: counts.date,
    breakdown,
    totalEstimatedCostToday: parseFloat(totalCostUSD.toFixed(4)),
    monthlyProjection:       parseFloat((totalCostUSD * 30).toFixed(2)),
    budgetOk:                totalCostUSD < 0.67, // $20/month ÷ 30 days
  };
}
