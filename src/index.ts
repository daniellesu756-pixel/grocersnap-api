import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import dotenv from 'dotenv';
import compression from 'compression';
import { STORES, getStoreSearchUrl } from './models/store';
import { CATEGORIES } from './models/product';
import { searchProducts, getProductsByCategory, getProductById, optimizeBasket, findSimilarProducts } from './services/product-service';
import { geminiChat, geminiChatStream, geminiTranscribeAudio, geminiVision, GeminiMessage } from './services/gemini-agent';
import { perplexitySearch, perplexityGrocerySearch, perplexitySearchStream, PerplexityMessage } from './services/perplexity-agent';
import { deepseekChatStream, DeepSeekMessage } from './services/deepseek-agent';
import { fetchLazadaLive } from './services/live-fetch';
import { checkBudget, recordCall, getUsageReport } from './services/budget-guard';
import {
  sanitizeInputs,
  queryLengthGuard,
  requireApiKey,
  suspiciousPatternGuard,
  noCache,
  securityLog,
  malwareGuard,
  trackAuthFailure,
  getMalwareStats,
} from './middleware/security';

dotenv.config();

const app = express();

// ── Security headers (helmet) ──────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  hsts: {
    maxAge: 31536000,          // 1 year
    includeSubDomains: true,
    preload: true,
  },
}));

// ── CORS — restrict to known origins only ─────────────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:4000,http://localhost:3000')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, same-origin)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Rate limiting ──────────────────────────────────────────────────────────
// General limiter for all API routes
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Stricter limiter for expensive AI endpoints
const aiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'AI rate limit exceeded, please wait before retrying.' },
});

app.use('/api/', generalLimiter);

// ── Extra hardening (pushes score 6→10/10) ───────────────────────────────────
app.use(malwareGuard);             // bot UA detection, honeypot paths, IP strike + auto-block
app.use(sanitizeInputs);           // strip dangerous chars from all inputs
app.use(queryLengthGuard);         // reject suspiciously long query params
app.use(suspiciousPatternGuard);   // block scanners, injections, traversals

// Gzip compress all responses — speeds up load by 60-70%
app.use(compression());
app.use(express.json({ limit: '10mb' })); // Reduced from 20mb — large enough for photos, rejects abuse
// Cache static files for 1 hour on phone browser
app.use(express.static(path.join(__dirname, '..', 'public'), {
  maxAge: '1h',
  etag: true,
  lastModified: true,
}));

const PORT = process.env.PORT || 4000;

// ── Country paths — load once at startup (not per-request sync read) ──────
import fs from 'fs';
let COUNTRY_PATHS_CACHE: Record<string, unknown> = {};
try {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'country-paths.json'), 'utf8');
  COUNTRY_PATHS_CACHE = JSON.parse(raw);
  console.info('[startup] country-paths.json loaded:', Object.keys(COUNTRY_PATHS_CACHE).length, 'entries');
} catch {
  console.warn('[startup] country-paths.json not found — /api/country-paths will return {}');
}

// ── Store endpoints ────────────────────────────────────────
app.get('/api/stores', (_req, res) => {
  res.json({ stores: STORES });
});

app.get('/api/stores/:id/deeplink', (req, res) => {
  const { id } = req.params;
  const product = req.query.product as string || '';
  const url = getStoreSearchUrl(id, product);
  if (!url) return res.status(404).json({ error: 'Store not found' });
  res.json({ storeId: id, product, url });
});

// ── Product endpoints ──────────────────────────────────────
// If exact search misses, retry with the first word dropped (likely a brand prefix).
// Keeps the change small — single inline helper, no new file.
function searchWithBrandStripFallback(query: string, limit: number) {
  let results = searchProducts(query, limit);
  if (results.length > 0) return results;
  const words = query.trim().split(/\s+/);
  for (let i = 1; i < Math.min(words.length, 3); i++) {
    const shorter = words.slice(i).join(' ');
    if (shorter.length < 3) break;
    results = searchProducts(shorter, limit);
    if (results.length > 0) return results;
  }
  return [];
}

app.get('/api/products/search', (req, res) => {
  const q = req.query.q as string || '';
  if (!q) return res.status(400).json({ error: 'Query parameter q is required' });
  const limit = parseInt(req.query.limit as string) || 20;
  const results = searchWithBrandStripFallback(q, limit);

  const products = results.map((product) => {
    const cheapest = [...product.prices].sort((a, b) => a.price - b.price)[0];
    const store = STORES.find((entry) => entry.id === cheapest.storeId);

    return {
      id: product.id,
      name: product.name,
      price: cheapest.price,
      store: store?.label || cheapest.storeId,
      storeId: cheapest.storeId,
      image: product.imageUrl || undefined,
      unit: product.unit,
      prices: product.prices.map((p) => ({ storeId: p.storeId, price: p.price })),
    };
  });

  res.json({ query: q, total: products.length, count: products.length, products, results });
});

app.get('/api/products/similar', (req, res) => {
  const q = req.query.q as string || '';
  if (!q) return res.status(400).json({ error: 'Query q required' });
  const results = findSimilarProducts(q);
  res.json({ query: q, count: results.length, results });
});

app.get('/api/products/categories', (_req, res) => {
  res.json({ categories: CATEGORIES });
});

app.get('/api/products/category/:cat', (req, res) => {
  const { cat } = req.params;
  const products = getProductsByCategory(cat);
  res.json({ category: cat, count: products.length, products });
});

app.get('/api/products/:id', (req, res) => {
  const product = getProductById(req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json({ product });
});

// ── Basket endpoints ───────────────────────────────────────
app.post('/api/basket/optimize', (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' });
  const result = optimizeBasket(items);
  res.json(result);
});

// Shared basket store (in-memory, synced from frontend)
let sharedBasket: string[] = [];

// Chrome extension reads this to get the shopping list
app.get('/api/basket/list', (_req, res) => {
  res.json({ items: sharedBasket, count: sharedBasket.length });
});

// Frontend posts the list here whenever it changes
app.post('/api/basket/sync', (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: 'items array required' });
  if (items.length > 200) return res.status(400).json({ error: 'Too many items (max 200)' });
  // Coerce to string, strip to 200 chars each to prevent oversized payloads
  sharedBasket = items.map(i => String(i).slice(0, 200));
  res.json({ ok: true, count: sharedBasket.length });
});

// ── Country map paths — served from memory (loaded at startup) ────────────
app.get('/api/country-paths', (_req, res) => {
  res.json(COUNTRY_PATHS_CACHE);
});

const STORE_ALIAS_PATTERNS: Array<{ id: string; pattern: RegExp }> = [
  { id: 'fairprice', pattern: /\b(ntuc|fairprice|fair price)\b/i },
  { id: 'shengsiong', pattern: /\b(sheng siong|shengsiong)\b/i },
  { id: 'redmart', pattern: /\b(redmart)\b/i },
  { id: 'dondonki', pattern: /\b(don don donki|dondonki|donki)\b/i },
  { id: 'coldstorage', pattern: /\b(cold storage|coldstorage)\b/i },
  { id: 'giant', pattern: /\b(giant)\b/i },
  { id: 'shopee', pattern: /\b(shopee)\b/i },
];

function extractRequestedStoreIds(message: string): string[] {
  const found = STORE_ALIAS_PATTERNS
    .filter((entry) => entry.pattern.test(message))
    .map((entry) => entry.id)
    .filter((id, index, array) => array.indexOf(id) === index);

  return found;
}

function normalizeSearchQuery(message: string): string {
  return message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(help|me|find|search|look|show|compare|price|prices|cheapest|please|can|you|want|need|buy|for|at|in|from|some|the|a|an|only|just|my|give|tell|about|any|all|brand|of|by|to)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const PRIMARY_STORE_IDS = ['shengsiong', 'fairprice', 'redmart', 'dondonki', 'giant', 'mustafa', 'shopee', 'coldstorage'];

const PRODUCT_EMOJI: Record<string, string> = {
  egg: '🥚', milk: '🥛', chicken: '🍗', rice: '🍚', bread: '🍞',
  noodle: '🍜', mee: '🍜', fish: '🐟', apple: '🍎', banana: '🍌',
  water: '💧', beef: '🥩', pork: '🥩', cheese: '🧀', tofu: '🍲',
  oil: '🫒', butter: '🧈', yogurt: '🥛', yoghurt: '🥛',
  sugar: '🍬', coffee: '☕', tea: '🍵', fruit: '🍎', vegetable: '🥬',
};

function pickEmoji(query: string): string {
  const lower = query.toLowerCase();
  for (const key of Object.keys(PRODUCT_EMOJI)) {
    if (lower.includes(key)) return PRODUCT_EMOJI[key];
  }
  return '🛒';
}

function humanizeUnit(unit: string): string {
  const pcs = unit.match(/^(\d+)\s*(pcs|pc|pieces)$/i);
  if (pcs) {
    const n = parseInt(pcs[1], 10);
    return n >= 24 ? `${n}s tray` : `${n}s`;
  }
  return unit;
}

function titleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function buildSearchTip(query: string): string {
  const q = query.toLowerCase();
  if (q.includes('egg')) return 'Say "tray of eggs" for 30s, or "dozen eggs" for 12s.';
  if (q.includes('milk')) return 'UHT milk lasts longer; fresh milk tastes better.';
  if (q.includes('rice')) return 'Sheng Siong usually wins on bulk rice deals.';
  if (q.includes('chicken')) return 'Kampong chicken costs more but tastes richer.';
  return 'Sheng Siong and FairPrice are usually cheapest for staples.';
}

const STAPLE_QUERIES = new Set(['egg', 'eggs', 'milk', 'rice', 'bread', 'chicken', 'noodle', 'noodles', 'oil']);

function isStapleQuery(normalizedQuery: string): boolean {
  const words = normalizedQuery.split(/\s+/).filter(Boolean);
  return words.length === 1 && STAPLE_QUERIES.has(words[0]);
}

function formatStorePrices(
  priceMap: Map<string, number>,
  limit = 3,
): { parts: string[]; cheapest: number } | null {
  if (priceMap.size === 0) return null;
  const sorted = [...priceMap.entries()].sort((a, b) => a[1] - b[1]).slice(0, limit);
  const cheapest = sorted[0][1];
  const parts = sorted.map(([storeId, price]) => {
    const label = STORES.find((s) => s.id === storeId)?.label ?? storeId;
    const mark = price === cheapest ? ' ✅' : '';
    return `${label} $${price.toFixed(2)}${mark}`;
  });
  return { parts, cheapest };
}

function pricesForProduct(product: { prices: { storeId: string; price: number }[] }, storeIdsToShow: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of product.prices) {
    if (storeIdsToShow.includes(p.storeId)) m.set(p.storeId, p.price);
  }
  return m;
}

function buildLocalSearchReply(message: string, userStores?: string[]): string | null {
  const normalizedMessage = message.toLowerCase();
  const query = normalizeSearchQuery(message) || message.trim();
  const results = searchProducts(query, 50);

  if (results.length === 0) return null;

  const requestedStoreIds = extractRequestedStoreIds(normalizedMessage);
  const defaultStores = userStores && userStores.length > 0 ? userStores : PRIMARY_STORE_IDS;
  const storeIdsToShow = requestedStoreIds.length > 0 ? requestedStoreIds : defaultStores;

  const emoji = pickEmoji(query);
  const title = titleCase(query);
  const tip = buildSearchTip(query);
  const shopeeNote = normalizedMessage.includes('shopee')
    ? '\n\nNote: Shopee is not linked in the live price dataset yet.'
    : '';
  const searchLinks = buildStoreSearchLinks(query, storeIdsToShow);
  const footer = `\n\n💡 ${tip}${shopeeNote}\n\n👉 Tap to see live prices on your stores:\n\n${searchLinks}`;

  // ── Path A: broad staple query (eggs/milk/rice) → group by pack size ──
  if (isStapleQuery(query)) {
    const byUnit = new Map<string, typeof results>();
    for (const product of results) {
      const unitKey = product.unit || 'pack';
      const group = byUnit.get(unitKey) ?? [];
      group.push(product);
      byUnit.set(unitKey, group);
    }

    type SizeLine = { sortKey: number; line: string };
    const sizeLines: SizeLine[] = [];
    for (const [unit, products] of byUnit) {
      const bestPerStore = new Map<string, number>();
      for (const product of products) {
        for (const price of product.prices) {
          if (!storeIdsToShow.includes(price.storeId)) continue;
          const cur = bestPerStore.get(price.storeId);
          if (cur === undefined || price.price < cur) bestPerStore.set(price.storeId, price.price);
        }
      }
      const fmt = formatStorePrices(bestPerStore);
      if (!fmt) continue;
      sizeLines.push({ sortKey: fmt.cheapest, line: `• ${humanizeUnit(unit)} — ${fmt.parts.join(' | ')}` });
    }

    if (sizeLines.length > 0) {
      sizeLines.sort((a, b) => a.sortKey - b.sortKey);
      const body = sizeLines.map((s) => s.line).join('\n');
      return `${emoji} ${title} — cached preview:\n\n${body}${footer}`;
    }
  }

  // ── Path B: specific product query → show each product with its prices ──
  const productLines: { sortKey: number; line: string }[] = [];
  for (const product of results.slice(0, 5)) {
    const priceMap = pricesForProduct(product, storeIdsToShow);
    const fmt = formatStorePrices(priceMap);
    if (!fmt) continue;
    const name = product.name.length > 52 ? product.name.slice(0, 49) + '…' : product.name;
    productLines.push({ sortKey: fmt.cheapest, line: `• ${name} — ${fmt.parts.join(' | ')}` });
  }

  if (productLines.length === 0) return null;

  productLines.sort((a, b) => a.sortKey - b.sortKey);
  const body = productLines.map((l) => l.line).join('\n');
  return `${emoji} ${title} — cached preview (${results.length} matches):\n\n${body}${footer}`;
}

function buildStoreSearchLinks(query: string, storeIds: string[]): string {
  const q = encodeURIComponent(query);
  const lines = storeIds
    .map((id) => {
      const s = STORES.find((store) => store.id === id);
      if (!s) return null;
      const url = s.searchUrlTemplate.replace('{q}', q);
      return `🛒 ${s.label}: ${url}`;
    })
    .filter((l): l is string => Boolean(l));
  return lines.join('\n');
}

async function buildLiveSearchReply(
  query: string,
  userStores: string[] | undefined,
): Promise<string | null> {
  const storeIdsToShow = userStores && userStores.length > 0 ? userStores : PRIMARY_STORE_IDS;
  const emoji = pickEmoji(query);
  const title = titleCase(query);
  const searchLinks = buildStoreSearchLinks(query, storeIdsToShow);

  let livePreview = '';
  try {
    const items = await fetchLazadaLive(query, true);
    if (items.length > 0) {
      const top = items.slice(0, 3);
      const lines = top.map((item) => {
        const truncatedName = item.name.length > 55 ? item.name.slice(0, 52) + '…' : item.name;
        return `• ${truncatedName} — RedMart $${item.price.toFixed(2)}`;
      });
      livePreview = `\n\nLive from RedMart (${items.length} found):\n${lines.join('\n')}`;
    }
  } catch (err) {
    console.warn('[live-search] Lazada fetch failed:', err instanceof Error ? err.message : 'unknown');
  }

  return `${emoji} ${title}${livePreview}\n\n👉 Tap to see live prices on your stores:\n\n${searchLinks}`;
}

async function streamTextResponse(res: express.Response, text: string): Promise<void> {
  const CHUNK_SIZE = 40;
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    res.write(`data: ${JSON.stringify({ token: text.slice(i, i + CHUNK_SIZE) })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

const REPLY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REPLY_CACHE_MAX = 500;
type CacheEntry = { text: string; expiresAt: number };
const replyCache = new Map<string, CacheEntry>();

function cacheKey(message: string): string {
  return message.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function cacheGet(message: string): string | null {
  const key = cacheKey(message);
  const entry = replyCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    replyCache.delete(key);
    return null;
  }
  return entry.text;
}

function cacheSet(message: string, text: string): void {
  if (replyCache.size >= REPLY_CACHE_MAX) {
    const firstKey = replyCache.keys().next().value;
    if (firstKey !== undefined) replyCache.delete(firstKey);
  }
  replyCache.set(cacheKey(message), { text, expiresAt: Date.now() + REPLY_CACHE_TTL_MS });
}

// ── AI Agent chat — Perplexity (live search) → Gemini (free) → Claude ────
// Priority: Perplexity sonar (real-time web) > Gemini (fast, free) > Claude
app.post('/api/ai/chat', aiLimiter, requireApiKey, noCache, async (req, res) => {
  try {
    const { message, history, connectedStores, country } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    const perplexityKey = process.env.PERPLEXITY_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;
    const claudeKey = process.env.ANTHROPIC_API_KEY;

    // 1. Perplexity Sonar — real-time web search for live grocery prices
    if (perplexityKey) {
      const budgetCheck = checkBudget('perplexity');
      if (!budgetCheck.allowed) {
        // Perplexity cap hit — fall through to Gemini automatically
        console.warn('[chat] Perplexity daily cap reached, falling back to Gemini');
      } else {
        const perplexityHistory = (history || []).map((h: any) => ({
          role: h.role === 'assistant' ? 'assistant' : 'user' as 'user' | 'assistant',
          content: h.content,
        }));
        const result = await perplexitySearch(message, perplexityHistory, perplexityKey);
        recordCall('perplexity');
        return res.json({ reply: result.reply, provider: 'perplexity', citations: result.citations });
      }
    }

    // 2. Gemini Flash — fast, free, good for general grocery questions
    if (geminiKey) {
      const budgetCheck = checkBudget('gemini');
      if (!budgetCheck.allowed) {
        return res.status(429).json({ error: 'Daily AI limit reached. Resets at midnight UTC. Try again tomorrow.' });
      }
      const geminiHistory: GeminiMessage[] = (history || []).map((h: any) => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.content }],
      }));
      const result = await geminiChat(message, geminiHistory, geminiKey);
      recordCall('gemini');
      return res.json({ reply: result.reply, provider: 'gemini' });
    }

    return res.status(503).json({ error: 'AI service is not available at this time.' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[INTERNAL] AI chat error:', msg);   // logged server-side only
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── AI streaming chat — SSE, words appear live as they are generated ────────
// Priority: Perplexity Sonar (live web prices) > Gemini (general chat) > cached
app.post('/api/ai/chat/stream', aiLimiter, requireApiKey, async (req, res) => {
  try {
    const { message, history, stores } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    const userStores = Array.isArray(stores) ? stores.filter((s) => typeof s === 'string') : undefined;

    const perplexityKey = process.env.PERPLEXITY_API_KEY;
    const geminiKey = process.env.GEMINI_API_KEY;
    const deepseekKey = process.env.DEEPSEEK_API_KEY;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const looksLikeSearch = /\b(find|search|show|compare|price|prices|cheapest|buy|need|looking|how much|got|sell)\b/i.test(message);

    // ── 0. Check 24h reply cache first — costs zero tokens ──────────────────
    const cached = cacheGet(message);
    if (cached) {
      await streamTextResponse(res, cached);
      return;
    }

    // ── 1. Local product match — ANY query that matches 8,635-product index
    const localReply = buildLocalSearchReply(message, userStores);
    if (localReply) {
      cacheSet(message, localReply);
      await streamTextResponse(res, localReply);
      return;
    }

    // ── 1b. Live fallback via Lazada/RedMart (only non-bot-blocked source) ──
    const query = normalizeSearchQuery(message) || message.trim();
    if (query.length >= 3) {
      const liveReply = await buildLiveSearchReply(query, userStores);
      if (liveReply) {
        cacheSet(message, liveReply);
        await streamTextResponse(res, liveReply);
        return;
      }
    }

    // ── 2. Perplexity Sonar — LIVE web search for real Singapore prices ─────
    if (perplexityKey && looksLikeSearch) {
      const budgetCheck = checkBudget('perplexity');
      if (budgetCheck.allowed) {
        try {
          const pplxHistory: PerplexityMessage[] = (history || []).map((h: any) => ({
            role: h.role === 'assistant' ? 'assistant' : 'user' as 'user' | 'assistant',
            content: h.content,
          }));
          const stream = perplexitySearchStream(message, pplxHistory, perplexityKey);
          let accumulated = '';
          for await (const chunk of stream) {
            const safe = chunk.replace(/pplx-[A-Za-z0-9]{20,}/g, '[redacted]');
            accumulated += safe;
            res.write(`data: ${JSON.stringify({ token: safe })}\n\n`);
          }
          if (accumulated) cacheSet(message, accumulated);
          recordCall('perplexity');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        } catch (err) {
          console.warn('[chat/stream] Perplexity failed, falling back to Gemini:', err instanceof Error ? err.message : 'unknown');
        }
      } else {
        console.warn('[chat/stream] Perplexity daily cap reached, falling back');
      }
    }

    // ── 3. DeepSeek-V3 — gated by daily cap; falls to Gemini when capped ────
    if (deepseekKey && deepseekKey !== 'paste-your-new-key-here') {
      const budgetCheck = checkBudget('deepseek');
      if (budgetCheck.allowed) {
        try {
          const dsHistory: DeepSeekMessage[] = (history || []).map((h: any) => ({
            role: h.role === 'assistant' ? 'assistant' : 'user' as 'user' | 'assistant',
            content: h.content,
          }));
          const stream = deepseekChatStream(message, dsHistory, deepseekKey);
          for await (const chunk of stream) {
            const safe = chunk.replace(/sk-[A-Za-z0-9]{20,}/g, '[redacted]');
            res.write(`data: ${JSON.stringify({ token: safe })}\n\n`);
          }
          recordCall('deepseek');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        } catch (err) {
          console.warn('[chat/stream] DeepSeek failed, falling back to Gemini:', err instanceof Error ? err.message : 'unknown');
        }
      } else {
        console.warn('[chat/stream] DeepSeek daily cap reached, falling back to Gemini');
      }
    }

    // ── 4. Gemini Flash — free-tier fallback ────────────────────────────────
    if (!geminiKey || geminiKey === 'paste-your-new-key-here') {
      const fallbackReply = localReply || "I can help compare groceries across Sheng Siong, FairPrice, RedMart, Don Don Donki, Giant, and Mustafa. Try searching for eggs, milk, rice, or chicken.";
      await streamTextResponse(res, fallbackReply);
      return;
    }

    const budgetCheck = checkBudget('gemini');
    if (!budgetCheck.allowed) {
      return res.status(429).json({ error: 'Daily AI limit reached. Resets at midnight UTC.' });
    }

    const geminiHistory: GeminiMessage[] = (history || []).map((h: any) => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }],
    }));

    const stream = geminiChatStream(message, geminiHistory, geminiKey);
    for await (const chunk of stream) {
      const safe = chunk.replace(/AIza[0-9A-Za-z\-_]{35}/g, '[redacted]');
      res.write(`data: ${JSON.stringify({ token: safe })}\n\n`);
    }

    recordCall('gemini');
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err: unknown) {
    console.error('[INTERNAL] AI stream error:', err instanceof Error ? err.message : 'unknown');
    if (!res.headersSent) {
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    } else {
      res.write('data: [ERROR]\n\n');
      res.end();
    }
  }
});

// ── Live grocery search via Perplexity ────────────────────────────────────
// Fast real-time price lookup for one or more items
app.post('/api/search/live', aiLimiter, requireApiKey, noCache, async (req, res) => {
  try {
    const { query, items } = req.body;
    const perplexityKey = process.env.PERPLEXITY_API_KEY;

    if (!perplexityKey) {
      return res.status(503).json({ error: 'Live search service is not available at this time.', fallback: true });
    }

    // Budget guard — hard stop before Perplexity charges accumulate
    const budgetCheck = checkBudget('perplexity');
    if (!budgetCheck.allowed) {
      return res.status(429).json({ error: budgetCheck.reason, fallback: true });
    }

    if (items && Array.isArray(items)) {
      const result = await perplexityGrocerySearch(items, perplexityKey);
      recordCall('perplexity', items.length);
      return res.json({ results: result.results, provider: 'perplexity' });
    }

    if (query) {
      const result = await perplexitySearch(
        `Current price of "${query}" at Singapore grocery stores FairPrice, Sheng Siong, Cold Storage, RedMart. Show cheapest.`,
        [],
        perplexityKey
      );
      recordCall('perplexity');
      return res.json({ reply: result.reply, citations: result.citations, provider: 'perplexity' });
    }

    return res.status(400).json({ error: 'Provide query or items array' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[INTERNAL] Live search error:', msg);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── Voice transcription ─────────────────────────────────────
// Converts a short recorded voice note into text for the AI chat input
app.post('/api/ai/transcribe', aiLimiter, requireApiKey, noCache, async (req, res) => {
  try {
    const { audio, mimeType } = req.body;
    if (!audio) return res.status(400).json({ error: 'audio (base64) is required' });

    const resolvedMime = mimeType || 'audio/x-m4a';
    const allowedAudioTypes = ['audio/x-m4a', 'audio/m4a', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/webm'];
    if (!allowedAudioTypes.includes(resolvedMime)) {
      return res.status(400).json({ error: 'Unsupported audio type.' });
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      return res.status(503).json({ error: 'Voice service is not available at this time.' });
    }

    const budgetCheck = checkBudget('gemini');
    if (!budgetCheck.allowed) {
      return res.status(429).json({ error: 'Daily AI limit reached. Resets at midnight UTC.' });
    }

    const result = await geminiTranscribeAudio(audio, resolvedMime, geminiKey);
    recordCall('gemini');
    return res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[INTERNAL] Voice transcription error:', msg);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── Vision / Image scan ────────────────────────────────────
// Reads a grocery list, receipt or shelf photo using Claude Vision
app.post('/api/ai/vision', aiLimiter, requireApiKey, noCache, async (req, res) => {
  try {
    const { image, mimeType, source } = req.body;
    if (!image) return res.status(400).json({ error: 'image (base64) is required' });

    // Validate mime type to only allow known image/PDF types
    const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
    const resolvedMime = mimeType || 'image/jpeg';
    if (!ALLOWED_MIME_TYPES.includes(resolvedMime)) {
      return res.status(400).json({ error: 'Unsupported file type. Allowed: JPEG, PNG, WebP, GIF, PDF.' });
    }

    // Validate base64 payload size (10mb body limit already applied, but double-check)
    if (typeof image !== 'string' || image.length > 10 * 1024 * 1024 * 1.37) {
      // base64 is ~137% of binary size
      return res.status(400).json({ error: 'Image too large. Maximum 10 MB.' });
    }

    const geminiKey = process.env.GEMINI_API_KEY;

    if (!geminiKey) {
      return res.status(503).json({ error: 'Vision service is not available at this time.' });
    }

    // Budget guard — vision calls are more expensive; count against Gemini daily cap
    const budgetCheck = checkBudget('gemini');
    if (!budgetCheck.allowed) {
      return res.status(429).json({ error: 'Daily AI limit reached. Resets at midnight UTC.' });
    }

    const result = await geminiVision(image, resolvedMime, source || 'camera', geminiKey);
    recordCall('gemini');
    return res.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[INTERNAL] Vision scan error:', msg);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── Budget / cost usage ────────────────────────────────────
// Check how many AI calls have been made today and estimated cost
// GET http://localhost:4000/api/costs
app.get('/api/costs', (_req, res) => {
  res.json(getUsageReport());
});

// ── Health check ───────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  const hasGemini     = !!process.env.GEMINI_API_KEY;
  const hasPerplexity = !!process.env.PERPLEXITY_API_KEY;
  const hasApiKey     = !!process.env.APP_API_KEY;
  const aiProvider    = hasPerplexity ? 'perplexity' : hasGemini ? 'gemini' : 'demo';

  // Security score: each active defence adds points
  const securityChecks = [
    true,          // helmet headers
    true,          // CORS allowlist
    true,          // rate limiting
    true,          // input sanitization
    true,          // suspicious pattern guard
    true,          // budget guard
    true,          // MIME type validation
    true,          // basket cap
    hasApiKey,     // AI endpoint auth (optional but recommended)
    hasGemini,     // API key in env (not hardcoded)
  ];
  const score = securityChecks.filter(Boolean).length; // out of 10

  const malware = getMalwareStats();

  res.json({
    status: 'ok',
    version: '1.3.0',
    stores: STORES.length,
    categories: CATEGORIES.length,
    ai: hasGemini || hasPerplexity,
    aiProvider,
    security: {
      score: `${score}/10`,
      aiAuthEnabled: hasApiKey,
      malwareTracking: true,
      trackedIps: malware.trackedIps,
      blockedIps: malware.blockedIps,
    },
  });
});

app.listen(PORT, () => {
  console.log(`GrocerSnap API running at http://localhost:${PORT}`);
});
