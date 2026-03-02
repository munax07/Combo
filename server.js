"use strict";

// ═══════════════════════════════════════════════════════════════════════════
//   UNIPARTS API SERVER  v4.1  —  Created by Munax
//   ─────────────────────────────────────────────────────────────────────────
//   § 1  Configuration
//   § 2  Constants & Shared State
//   § 3  LRU Cache
//   § 4  Rate Limiter
//   § 5  Logging
//   § 6  Text & Utility Helpers
//   § 7  Search Index (build + auto-reload)
//   § 8  Precise Matching Engine
//   § 9  GSMArena Fetch with Retry
//   § 10 HTTP Helpers (sendJson, gzip, request context)
//   § 11 Route Handlers
//   § 12 Server + Startup
//   § 13 Graceful Shutdown
// ═══════════════════════════════════════════════════════════════════════════

const http    = require("http");
const fs      = require("fs");
const path    = require("path");
const zlib    = require("zlib");
const axios   = require("axios");
const cheerio = require("cheerio");

// ───────────────────────────────────────────────────────────────────────────
// § 1  CONFIGURATION
// ───────────────────────────────────────────────────────────────────────────

const PORT       = parseInt(process.env.PORT, 10) || 8000;
const SECRET_KEY = process.env.SECRET_KEY; // ⚠️ MUST be set in production!
const NODE_ENV   = process.env.NODE_ENV    || "development";

// Warn if SECRET_KEY is missing (but still allow fallback in dev)
if (!SECRET_KEY && NODE_ENV === "production") {
  console.error("❌ FATAL: SECRET_KEY environment variable not set!");
  process.exit(1);
} else if (!SECRET_KEY) {
  console.warn("⚠️  SECRET_KEY not set, using default 'munax_admin_2026' (dev only)");
}

const SECRET = SECRET_KEY || "munax_admin_2026";

const CFG = {
  cache: {
    ttlMs:   60 * 60 * 1000,   // 1 h per entry
    maxSize: 500,               // LRU evict oldest when exceeded
  },
  gsmarena: {
    timeout:    10_000,         // 10 s per request
    retries:    2,              // max retries on transient failure
    retryDelay: 1_500,          // initial retry delay — doubles each attempt
    userAgent:  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  },
  rateLimit: {
    windowMs: 60_000,           // 1-minute sliding window
    tiers: {
      strict: 10,               // /specs-search, /specs-details (costly external calls)
      normal: 30,               // /search
      loose:  120,              // /categories, /health, /api, /
      admin:  20,               // /admin/*
    },
  },
  log: {
    keepDays: 7,                // retain log files this many days
  },
};

// ───────────────────────────────────────────────────────────────────────────
// § 2  CONSTANTS & SHARED STATE
// ───────────────────────────────────────────────────────────────────────────

const LOG_DIR   = path.join(__dirname, "logs");
const DATA_PATH = path.join(__dirname, "data.json");
const DASH_PATH = path.join(__dirname, "dashboard.html");

// HTTP headers applied to every response
const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const SEC = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options":        "DENY",
  "X-XSS-Protection":       "1; mode=block",
};

// Token patterns that mark placeholder / filler entries in data.json
const PLACEHOLDER_TOKENS = ["coming soon", "new list", "universal"];

// Variant synonym groups for Note-series matching
const VARIANT_GROUPS = {
  pro:     ["pro"],
  proplus: ["proplus", "pro+", "pro plus"],
  promax:  ["promax", "pro max"],
  ultra:   ["ultra"],
  lite:    ["lite"],
  se:      ["se"],
  prime:   ["prime"],
};

// In-memory metrics counters (reset on restart — intentional)
const metrics = {
  startedAt:      new Date().toISOString(),
  totalRequests:  0,
  errorCount:     0,
  cacheHits:      0,
  cacheMisses:    0,
  requestsByPath: {},
  lastReload:     null,
  reloadCount:    0,
};

// Dashboard HTML — loaded once at startup, served from memory
let dashboardHtml = null;

// ───────────────────────────────────────────────────────────────────────────
// § 3  LRU CACHE
//   Map preserves insertion order; we delete-and-reinsert on hit to keep
//   the most recently used entry at the "end", oldest at the "start".
//   When capacity is exceeded, the first (oldest) key is evicted.
// ───────────────────────────────────────────────────────────────────────────

const _cacheStore = new Map();

const cache = {
  get(key) {
    const entry = _cacheStore.get(key);
    if (!entry) {
      metrics.cacheMisses++;
      return null;
    }
    if (Date.now() - entry.cachedAt > CFG.cache.ttlMs) {
      _cacheStore.delete(key);
      metrics.cacheMisses++;
      return null;
    }
    // Promote to most-recently-used position
    _cacheStore.delete(key);
    _cacheStore.set(key, entry);
    metrics.cacheHits++;
    return entry.data;
  },

  set(key, data) {
    if (_cacheStore.size >= CFG.cache.maxSize) {
      // Evict the least-recently-used (first) entry
      _cacheStore.delete(_cacheStore.keys().next().value);
    }
    _cacheStore.set(key, { data, cachedAt: Date.now() });
  },

  clear() { _cacheStore.clear(); },

  stats() {
    const total = metrics.cacheHits + metrics.cacheMisses;
    return {
      entries:    _cacheStore.size,
      maxSize:    CFG.cache.maxSize,
      ttlMinutes: CFG.cache.ttlMs / 60_000,
      hits:       metrics.cacheHits,
      misses:     metrics.cacheMisses,
      hitRate:    total > 0
        ? `${((metrics.cacheHits / total) * 100).toFixed(1)}%`
        : "n/a",
    };
  },
};

// ───────────────────────────────────────────────────────────────────────────
// § 4  RATE LIMITER
//   Sliding-window counter per IP address.
//   Each entry in _rlStore is an array of hit timestamps within the window.
//   Old timestamps are pruned on every check and by a background interval.
// ───────────────────────────────────────────────────────────────────────────

const _rlStore = new Map();

function checkRateLimit(ip, tier) {
  const limit = CFG.rateLimit.tiers[tier] ?? CFG.rateLimit.tiers.normal;
  const now   = Date.now();
  const win   = CFG.rateLimit.windowMs;

  // Prune expired hits and add this hit
  const hits = (_rlStore.get(ip) || []).filter(t => now - t < win);
  hits.push(now);
  _rlStore.set(ip, hits);

  if (hits.length > limit) {
    const retryAfter = Math.ceil((hits[0] + win - now) / 1000);
    return { allowed: false, retryAfter, limit, used: hits.length };
  }
  return { allowed: true, remaining: limit - hits.length, limit };
}

// Background pruning — keeps _rlStore from growing unbounded
setInterval(() => {
  const cutoff = Date.now() - CFG.rateLimit.windowMs;
  for (const [ip, hits] of _rlStore) {
    const fresh = hits.filter(t => t > cutoff);
    if (fresh.length === 0) _rlStore.delete(ip);
    else _rlStore.set(ip, fresh);
  }
}, 5 * 60_000).unref(); // .unref() so this doesn't block clean shutdown

// ───────────────────────────────────────────────────────────────────────────
// § 5  LOGGING
//   Two log streams per day:
//     access_YYYY-MM-DD.jsonl  — every HTTP request (method, path, status, ms)
//     search_YYYY-MM-DD.jsonl  — part/model search queries (analytics)
//   Files older than CFG.log.keepDays are deleted on startup and nightly.
// ───────────────────────────────────────────────────────────────────────────

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function _writeLog(filename, obj) {
  fs.appendFile(
    path.join(LOG_DIR, filename),
    JSON.stringify(obj) + "\n",
    err => { if (err) console.error("Log write failed:", err.message); }
  );
}

function accessLog(level, message, meta = {}) {
  const entry = { ts: new Date().toISOString(), level, message, ...meta };
  _writeLog(`access_${entry.ts.split("T")[0]}.jsonl`, entry);

  // Mirror to console in non-production environments
  if (NODE_ENV !== "production") {
    const icon = level === "error" ? "❌" : level === "warn" ? "⚠️ " : "📋";
    const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    console.log(`${icon} [${level.toUpperCase()}] ${message}${extra}`);
  }
}

function searchLog(part, model, resultCount, ip, ua) {
  _writeLog(`search_${new Date().toISOString().split("T")[0]}.jsonl`, {
    ts: new Date().toISOString(),
    part, model, resultCount,
    ip:  ip || "unknown",
    ua:  (ua || "").slice(0, 100),
  });
}

async function getSearchStats() {
  const day = new Date().toISOString().split("T")[0];
  try {
    const content = await fs.promises.readFile(
      path.join(LOG_DIR, `search_${day}.jsonl`), "utf8"
    );
    const logs   = content.split("\n").filter(Boolean).map(l => JSON.parse(l));
    const byModel = {}, byPart = {};
    logs.forEach(l => {
      byModel[l.model] = (byModel[l.model] || 0) + 1;
      byPart[l.part]   = (byPart[l.part]   || 0) + 1;
    });
    const top = (obj, n) =>
      Object.entries(obj).sort(([, a], [, b]) => b - a).slice(0, n)
        .map(([k, v]) => ({ name: k, count: v }));

    return {
      date:       day,
      total:      logs.length,
      topModels:  top(byModel, 10),
      topParts:   top(byPart,  10),
      recent:     logs.slice(-50).reverse(),
    };
  } catch {
    return { date: day, total: 0, topModels: [], topParts: [], recent: [] };
  }
}

function cleanOldLogs() {
  const cutoff = new Date(Date.now() - CFG.log.keepDays * 86_400_000)
    .toISOString().split("T")[0];
  try {
    fs.readdirSync(LOG_DIR).forEach(file => {
      const m = file.match(/^(?:access|search)_(\d{4}-\d{2}-\d{2}).jsonl$/);
      if (m && m[1] < cutoff) {
        fs.unlink(path.join(LOG_DIR, file), () => {});
        console.log(`🗑️  Deleted old log: ${file}`);
      }
    });
  } catch (err) {
    console.warn("⚠️  Log cleanup failed:", err.message);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// § 6  TEXT & UTILITY HELPERS
// ───────────────────────────────────────────────────────────────────────────

function normalize(text) {
  if (!text) return "";
  return text.toString().toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function createCategoryKey(name) {
  if (!name) return "";
  return name.toLowerCase()
    .replace(/^\d+\.\s*/, "")
    .replace(/[^a-z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/, "");
}

function sanitizeInput(value, maxLength = 100) {
  if (typeof value !== "string") return null;
  const t = value.trim().slice(0, maxLength);
  return t || null;
}

function formatBytes(n) {
  if (n < 1_024)          return `${n} B`;
  if (n < 1_024 ** 2)     return `${(n / 1_024).toFixed(1)} KB`;
  return `${(n / 1_024 ** 2).toFixed(1)} MB`;
}

function formatUptime(sec) {
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3_600);
  const m = Math.floor((sec % 3_600) / 60);
  const s = sec % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`]
    .filter(Boolean).join(" ");
}

function getIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0].trim()
    || req.socket?.remoteAddress
    || "unknown";
}

// ───────────────────────────────────────────────────────────────────────────
// § 7  SEARCH INDEX  (build + live auto-reload)
//   currentIndex is swapped atomically — in-flight requests finish against
//   the old index; new requests immediately use the updated one.
//   Note: fs.watch is not 100% reliable on all platforms; if you experience
//   missed updates, consider adding a polling fallback (see commented code).
// ───────────────────────────────────────────────────────────────────────────

let currentIndex = {};

function extractModelIdentifiers(model) {
  if (!model) return [];
  const ids = [];
  const patterns = [
    /(redmi|mi|poco)\s*(note)?\s*(\d+[a-z]*)/i,
    /(samsung|galaxy)\s*([a-z]\d+)/i,
    /(oppo|realme|oneplus)\s*([a-z]+\d+)/i,
    /(vivo|iqoo)\s*([a-z]+\d+)/i,
    /(infinix|tecno|itel)\s*([a-z]+\d+)/i,
    /(moto|motorola|lava)\s*([a-z]+\d+)/i,
  ];
  patterns.forEach(p => {
    const m = model.match(p);
    if (m) ids.push(m[0].replace(/\s+/g, "").toLowerCase());
  });
  (model.match(/[a-z]+\d+[a-z]*|\d+[a-z]+/g) || [])
    .forEach(m => ids.push(m.toLowerCase()));
  return [...new Set(ids)];
}

function buildIndex(data) {
  const index = {};
  if (!Array.isArray(data.categories)) return index;

  data.categories.forEach(category => {
    if (!category?.name) return;
    const key = createCategoryKey(category.name);
    index[key] = { name: category.name, brands: [], models: [] };

    (category.brands || []).forEach(brand => {
      if (!brand?.name) return;
      const brandInfo = { name: brand.name, compatibilityGroups: [] };

      (brand.models || []).forEach(line => {
        if (!line) return;
        const lc = line.toLowerCase().trim();
        if (!lc || PLACEHOLDER_TOKENS.some(t => lc.includes(t))) return;

        const addModel = (original, groupLine) => {
          const norm = normalize(original);
          if (!norm || norm.includes("coming")) return;
          index[key].models.push({
            brand:       brand.name,
            original,
            normalized:  norm,
            groupLine,
            identifiers: extractModelIdentifiers(norm),
          });
        };

        if (line.includes("=")) {
          const cleaned = line.replace(/^\d+\.\s*/, "");
          const parts   = cleaned.split("=")
            .map(m => m.replace(/^\d+\.\s*/, "").trim())
            .filter(m => m && !PLACEHOLDER_TOKENS.some(t => m.toLowerCase().includes(t)));
          if (parts.length) {
            brandInfo.compatibilityGroups.push({ originalLine: line, models: parts });
            parts.forEach(p => addModel(p, line));
          }
        } else {
          addModel(line.trim(), line.trim());
        }
      });

      if (brandInfo.compatibilityGroups.length) index[key].brands.push(brandInfo);
    });
  });

  return index;
}

function loadAndBuildIndex() {
  try {
    if (!fs.existsSync(DATA_PATH)) {
      accessLog("error", "data.json not found at startup");
      return {};
    }
    const data  = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
    const index = buildIndex(data);
    const total = Object.values(index).reduce((s, c) => s + c.models.length, 0);
    accessLog("info", "Index built", { categories: Object.keys(index).length, models: total });
    return index;
  } catch (err) {
    accessLog("error", "Failed to build index", { error: err.message });
    return currentIndex; // keep previous index on failure — safe fallback
  }
}

// Auto-reload: debounced fs.watch so rapid file saves don't thrash
let _reloadDebounce = null;

function reloadData() {
  const newIndex = loadAndBuildIndex();
  if (Object.keys(newIndex).length > 0) {
    currentIndex          = newIndex; // atomic reference swap
    metrics.lastReload    = new Date().toISOString();
    metrics.reloadCount++;
    console.log(`♻️  Index reloaded — reload #${metrics.reloadCount}`);
  }
}

function watchDataFile() {
  if (!fs.existsSync(DATA_PATH)) return;
  try {
    fs.watch(DATA_PATH, { persistent: false }, eventType => {
      if (eventType !== "change") return;
      clearTimeout(_reloadDebounce);
      _reloadDebounce = setTimeout(() => {
        accessLog("info", "data.json changed — triggering live reload");
        reloadData();
      }, 500); // 500 ms debounce: wait for the file write to complete
    });
    console.log("👁️  Watching data.json for live changes");
    // Optional polling fallback for platforms where fs.watch is unreliable:
    // setInterval(() => { if (fs.statSync(DATA_PATH).mtimeMs > lastMtime) reloadData(); }, 5000);
  } catch (err) {
    console.warn("⚠️  Could not watch data.json:", err.message);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// § 8  PRECISE MATCHING ENGINE
// ───────────────────────────────────────────────────────────────────────────

function sameVariant(a, b) {
  const na = a.replace(/\s+/g, "").toLowerCase();
  const nb = b.replace(/\s+/g, "").toLowerCase();
  for (const values of Object.values(VARIANT_GROUPS)) {
    if (values.includes(na) && values.includes(nb)) return true;
  }
  return false;
}

function preciseMatch(searchModel, modelEntry) {
  if (!searchModel || !modelEntry) return { match: false, score: 0 };

  const cs         = normalize(searchModel);
  const candidates = modelEntry.normalized.split("=").map(m => m.trim()).filter(Boolean);

  for (const cand of candidates) {
    const cc = normalize(cand);

    // 1. Exact string match
    if (cc === cs)
      return { match: true, score: 100, type: "exact" };

    // 2. Match ignoring all spaces  (e.g. "Note10" === "Note 10")
    if (cc.replace(/\s+/g, "") === cs.replace(/\s+/g, ""))
      return { match: true, score: 95, type: "exact_normalized" };

    // 3. Note-series smart matching
    if (cs.includes("note") && cc.includes("note")) {
      const NOTE_RE = /note[\s-]*(\d+)(?:\s*(pro\+?|pro\s*plus|pro\s*max|pro|plus|max|ultra|lite|se|prime))?/i;
      const sn = cs.match(NOTE_RE);
      const mn = cc.match(NOTE_RE);
      if (sn && mn) {
        if (sn[1] !== mn[1]) continue;                                    // different series number
        if (sn[2] && mn[2] && !sameVariant(sn[2], mn[2])) continue;      // mismatched variants
        if (Boolean(sn[2]) !== Boolean(mn[2])) continue;                  // one has variant, other doesn't
        return { match: true, score: sn[2] ? 90 : 85,
                 type: sn[2] ? "note_exact_variant" : "note_series" };
      }
    }

    // 4. Samsung/Xiaomi-style model-number guard  (A55 ≠ A35, Redmi 12 ≠ Redmi 12C)
    const sNum = cs.match(/\b[a-z]\d+\b/i)?.[0]?.toLowerCase();
    const cNum = cc.match(/\b[a-z]\d+\b/i)?.[0]?.toLowerCase();
    if (sNum && cNum && sNum !== cNum) continue;

    // 5. Strip leading list-item numbers  ("3. Redmi 12" → "Redmi 12")
    const stripped = cand.match(/^\d+\.\s*(.+)/)?.[1];
    if (stripped) {
      const ns = normalize(stripped);
      if (ns === cs || ns.replace(/\s+/g, "") === cs.replace(/\s+/g, ""))
        return { match: true, score: 90, type: "list_item" };
    }

    // 6. Identifier fallback  (last resort — requires containment to reduce false positives)
    const si = extractModelIdentifiers(cs);
    const mi = extractModelIdentifiers(cc);
    for (const s of si) for (const m of mi) {
      if (s === m && (cc.includes(cs) || cs.includes(cc)))
        return { match: true, score: 80, type: "identifier_match" };
    }
  }

  return { match: false, score: 0 };
}

// ───────────────────────────────────────────────────────────────────────────
// § 9  GSMARENA FETCH WITH EXPONENTIAL-BACKOFF RETRY
// ───────────────────────────────────────────────────────────────────────────

async function fetchWithRetry(
  url,
  retries = CFG.gsmarena.retries,
  delay   = CFG.gsmarena.retryDelay
) {
  try {
    return await axios.get(url, {
      headers: { "User-Agent": CFG.gsmarena.userAgent },
      timeout: CFG.gsmarena.timeout,
    });
  } catch (err) {
    if (retries === 0) throw err;
    accessLog("warn", "GSMArena fetch failed, retrying", {
      url, retriesLeft: retries, delayMs: delay,
    });
    await new Promise(r => setTimeout(r, delay));
    return fetchWithRetry(url, retries - 1, delay * 2); // exponential backoff
  }
}

// ───────────────────────────────────────────────────────────────────────────
// § 10  HTTP HELPERS
// ───────────────────────────────────────────────────────────────────────────

let _reqCounter = 0;

/** Create a per-request context (ID, IP, UA, start timer) */
function createCtx(req) {
  return {
    id: `${Date.now().toString(36)}-${(++_reqCounter).toString(36).padStart(4, "0")}`,
    ip: getIp(req),
    ua: req.headers["user-agent"] || "",
    t0: process.hrtime.bigint(),
  };
}

/**
 * Write a JSON response.
 * Automatically compresses with gzip when:
 *   • Client sends Accept-Encoding: gzip
 *   • Body is larger than 1 KB
 * Adds X-Request-Id, X-Response-Time, security headers, and logs the request.
 */
function sendJson(res, req, status, data, ctx) {
  const body      = JSON.stringify(data, null, 2);
  const durationMs = (Number(process.hrtime.bigint() - ctx.t0) / 1e6).toFixed(2);
  let pathname;
  try { pathname = new URL(req.url, "http://x").pathname; } catch { pathname = req.url; }

  const baseHeaders = {
    "Content-Type":  "application/json; charset=utf-8",
    "X-Request-Id":    ctx.id,
    "X-Response-Time": `${durationMs}ms`,
    ...SEC,
    ...CORS,
  };

  // Update metrics
  metrics.totalRequests++;
  metrics.requestsByPath[pathname] = (metrics.requestsByPath[pathname] || 0) + 1;
  if (status >= 400) metrics.errorCount++;

  accessLog("access", `${req.method} ${pathname} → ${status}`, {
    reqId: ctx.id,
    ip:    ctx.ip,
    status,
    ms:    parseFloat(durationMs),
  });

  // Gzip if supported and body warrants it
  const bodyBuf    = Buffer.from(body, "utf8");
  const acceptsGzip = (req.headers["accept-encoding"] || "").includes("gzip");

  if (bodyBuf.length > 1024 && acceptsGzip) {
    zlib.gzip(bodyBuf, (err, compressed) => {
      if (err) {
        res.writeHead(status, { ...baseHeaders, "Content-Length": bodyBuf.length });
        return res.end(bodyBuf);
      }
      res.writeHead(status, {
        ...baseHeaders,
        "Content-Encoding": "gzip",
        "Content-Length":   compressed.length,
      });
      res.end(compressed);
    });
  } else {
    res.writeHead(status, { ...baseHeaders, "Content-Length": bodyBuf.length });
    res.end(bodyBuf);
  }
}

/** Reject a rate-limited request with proper headers */
function rejectRateLimit(res, req, info, ctx) {
  res.setHeader("Retry-After",       String(info.retryAfter));
  res.setHeader("X-RateLimit-Limit", String(info.limit));
  sendJson(res, req, 429, {
    error:      "Too many requests",
    retryAfter: `${info.retryAfter}s`,
    watermark:  "Created by Munax",
  }, ctx);
}

// ───────────────────────────────────────────────────────────────────────────
// § 11  ROUTE HANDLERS
// ───────────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const ctx = createCtx(req);
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    return sendJson(res, req, 400, { error: "Malformed request URL" }, ctx);
  }
  const { pathname } = url;

  // ── CORS preflight ────────────────────────────────────────────────────
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  // ── Method guard — only GET is accepted ──────────────────────────────
  if (req.method !== "GET") {
    return sendJson(res, req, 405, {
      error: "Method not allowed. Use GET.",
      watermark: "Created by Munax",
    }, ctx);
  }

  // ══════════════════════════════════════════════════════════════════════
  //  ADMIN ROUTES  (/admin/*)
  // ══════════════════════════════════════════════════════════════════════
  if (pathname.startsWith("/admin")) {
    const rl = checkRateLimit(ctx.ip, "admin");
    if (!rl.allowed) return rejectRateLimit(res, req, rl, ctx);

    // Auth check — all admin routes require the secret key
    if (url.searchParams.get("key") !== SECRET) {
      accessLog("warn", "Admin auth failure", { ip: ctx.ip, path: pathname });
      return sendJson(res, req, 403, { error: "Forbidden — invalid key" }, ctx);
    }

    // ── /admin/stats ─────────────────────────────────────────────────
    if (pathname === "/admin/stats") {
      try {
        const stats = await getSearchStats();
        return sendJson(res, req, 200, {
          ...stats,
          serverMetrics: {
            ...metrics,
            requestsByPath: metrics.requestsByPath,
          },
          watermark: "Created by Munax",
        }, ctx);
      } catch (err) {
        accessLog("error", "/admin/stats failed", { error: err.message });
        return sendJson(res, req, 500, { error: "Internal error" }, ctx);
      }
    }

    // ── /admin/cache ─────────────────────────────────────────────────
    if (pathname === "/admin/cache") {
      const action = sanitizeInput(url.searchParams.get("action"));
      if (action === "clear") {
        const cleared = _cacheStore.size;
        cache.clear();
        accessLog("warn", "Cache cleared by admin", { reqId: ctx.id, entriesCleared: cleared });
        return sendJson(res, req, 200, {
          success: true, cleared, watermark: "Created by Munax",
        }, ctx);
      }
      return sendJson(res, req, 200, {
        ...cache.stats(),
        watermark: "Created by Munax",
      }, ctx);
    }

    // ── /admin/reload ────────────────────────────────────────────────
    if (pathname === "/admin/reload") {
      reloadData();
      const totalModels = Object.values(currentIndex)
        .reduce((s, c) => s + c.models.length, 0);
      return sendJson(res, req, 200, {
        success:     true,
        message:     "data.json reloaded successfully",
        categories:  Object.keys(currentIndex).length,
        totalModels,
        reloadCount: metrics.reloadCount,
        lastReload:  metrics.lastReload,
        watermark:   "Created by Munax",
      }, ctx);
    }

    return sendJson(res, req, 404, { error: "Admin endpoint not found" }, ctx);
  }

  // ══════════════════════════════════════════════════════════════════════
  //  PUBLIC ROUTES
  // ══════════════════════════════════════════════════════════════════════

  // ── /health ──────────────────────────────────────────────────────────
  if (pathname === "/health") {
    const rl = checkRateLimit(ctx.ip, "loose");
    if (!rl.allowed) return rejectRateLimit(res, req, rl, ctx);

    const mem       = process.memoryUsage();
    const uptimeSec = Math.floor(process.uptime());
    const totalModels = Object.values(currentIndex)
      .reduce((s, c) => s + c.models.length, 0);

    return sendJson(res, req, 200, {
      status:    "healthy",
      uptime:    formatUptime(uptimeSec),
      uptimeSec,
      startedAt: metrics.startedAt,
      memory: {
        rss:       formatBytes(mem.rss),
        heapUsed:  formatBytes(mem.heapUsed),
        heapTotal: formatBytes(mem.heapTotal),
        external:  formatBytes(mem.external),
      },
      index: {
        categories:  Object.keys(currentIndex).length,
        totalModels,
        lastReload:  metrics.lastReload,
        reloadCount: metrics.reloadCount,
      },
      cache: cache.stats(),
      requests: {
        total:     metrics.totalRequests,
        errors:    metrics.errorCount,
        byPath:    metrics.requestsByPath,
      },
      rateLimit: {
        activeIPs: _rlStore.size,
        tiers:     CFG.rateLimit.tiers,
      },
      node:      process.version,
      pid:       process.pid,
      env:       NODE_ENV,
      watermark: "Created by Munax",
    }, ctx);
  }

  // ── /specs-search ────────────────────────────────────────────────────
  if (pathname === "/specs-search") {
    const rl = checkRateLimit(ctx.ip, "strict");
    if (!rl.allowed) return rejectRateLimit(res, req, rl, ctx);

    const query = sanitizeInput(url.searchParams.get("q"), 80);
    if (!query)
      return sendJson(res, req, 400, { error: "Missing or invalid query parameter" }, ctx);

    const cacheKey = `search:${query.toLowerCase()}`;
    const cached   = cache.get(cacheKey);
    if (cached)
      return sendJson(res, req, 200, { ...cached, cached: true }, ctx);

    try {
      const resp = await fetchWithRetry(
        `https://www.gsmarena.com/results.php3?sQuickSearch=yes&sName=${encodeURIComponent(query)}`
      );
      const $       = cheerio.load(resp.data);
      const results = [];
      $("#review-body.section-body div ul li").each((_, el) => {
        const id    = $(el).find("a").attr("href");
        const title = $(el).find("img").attr("title");
        const img   = $(el).find("img").attr("src");
        if (id && title) results.push({ id, title, img });
      });
      const data = { success: true, results };
      cache.set(cacheKey, data);
      return sendJson(res, req, 200, data, ctx);
    } catch (err) {
      accessLog("error", "specs-search failed", { error: err.message, query });
      return sendJson(res, req, 500, {
        success: false, error: "GSMArena unavailable or rate-limited",
      }, ctx);
    }
  }

  // ── /specs-details ───────────────────────────────────────────────────
  if (pathname === "/specs-details") {
    const rl = checkRateLimit(ctx.ip, "strict");
    if (!rl.allowed) return rejectRateLimit(res, req, rl, ctx);

    const id = sanitizeInput(url.searchParams.get("id"), 120);
    if (!id)
      return sendJson(res, req, 400, { error: "Missing or invalid id parameter" }, ctx);

    // Guard against path traversal attempts
    if (/[<>"'\\]/.test(id) || id.includes("..") || id.includes("//"))
      return sendJson(res, req, 400, { error: "Invalid id format" }, ctx);

    const cacheKey = `details:${id}`;
    const cached   = cache.get(cacheKey);
    if (cached)
      return sendJson(res, req, 200, { ...cached, cached: true }, ctx);

    try {
      const resp  = await fetchWithRetry(`https://www.gsmarena.com/${id}`);
      const $     = cheerio.load(resp.data);
      const name  = $(".specs-phone-name-title").text().trim();
      const img   = $(".specs-photo-main img").attr("src");
      const specs = {};
      $("table").each((_, table) => {
        const head = $(table).find("th").text().trim();
        if (!head) return;
        specs[head] = {};
        $(table).find("tr").each((_, row) => {
          const k = $(row).find("td").eq(0).text().trim();
          const v = $(row).find("td").eq(1).text().replace(/\n/g, " ").trim();
          if (k && v) specs[head][k] = v;
        });
      });
      const data = { success: true, name, img, specs };
      cache.set(cacheKey, data);
      return sendJson(res, req, 200, data, ctx);
    } catch (err) {
      accessLog("error", "specs-details failed", { error: err.message, id });
      return sendJson(res, req, 500, {
        success: false, error: "GSMArena unavailable or rate-limited",
      }, ctx);
    }
  }

  // ── /  and  /dashboard ───────────────────────────────────────────────
  if (pathname === "/" || pathname === "/dashboard") {
    const rl = checkRateLimit(ctx.ip, "loose");
    if (!rl.allowed) return rejectRateLimit(res, req, rl, ctx);
    if (dashboardHtml) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...SEC });
      return res.end(dashboardHtml);
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...SEC });
    return res.end(
      `<!DOCTYPE html><html><head><title>Universal Parts API</title></head> <body style="font-family:sans-serif;padding:40px;text-align:center"> <h1>🔧 Universal Parts API  v4.1</h1> <p>Server is running. No <code>dashboard.html</code> found.</p> <p> <a href="/categories">Categories</a> · <a href="/health">Health</a> · <a href="/api">API Info</a> </p> <p style="color:#999;margin-top:40px">Created by Munax</p> </body></html>`
    );
  }

  // ── /api ─────────────────────────────────────────────────────────────
  if (pathname === "/api" || pathname === "/api/") {
    const rl = checkRateLimit(ctx.ip, "loose");
    if (!rl.allowed) return rejectRateLimit(res, req, rl, ctx);
    return sendJson(res, req, 200, {
      name:      "Universal Parts API",
      version:   "4.1.0",
      status:    "running",
      watermark: "Created by Munax",
      endpoints: {
        "/":                                  "Technician Dashboard (HTML)",
        "/search?part=X&model=Y":             "Search compatible parts",
        "/categories":                        "List all part categories",
        "/health":                            "Health check + live metrics",
        "/specs-search?q=X":                 "Search device specs on GSMArena",
        "/specs-details?id=X":               "Full device specs by GSMArena ID",
        "/admin/stats?key=K":                "Today's search analytics",
        "/admin/cache?key=K":                "Cache statistics",
        "/admin/cache?key=K&action=clear":   "Flush entire cache",
        "/admin/reload?key=K":               "Reload data.json without restart",
      },
      rateLimits: {
        note:   "Limits are per IP per 60-second window",
        ...CFG.rateLimit.tiers,
      },
    }, ctx);
  }

  // ── /categories ──────────────────────────────────────────────────────
  if (pathname === "/categories") {
    const rl = checkRateLimit(ctx.ip, "loose");
    if (!rl.allowed) return rejectRateLimit(res, req, rl, ctx);
    return sendJson(res, req, 200, {
      watermark: "Created by Munax",
      total:     Object.keys(currentIndex).length,
      categories: Object.keys(currentIndex).map(key => ({
        key,
        name:       currentIndex[key].name,
        brands:     currentIndex[key].brands.map(b => b.name),
        modelCount: currentIndex[key].models.length,
      })),
    }, ctx);
  }

  // ── /search ──────────────────────────────────────────────────────────
  if (pathname === "/search") {
    const rl = checkRateLimit(ctx.ip, "normal");
    if (!rl.allowed) return rejectRateLimit(res, req, rl, ctx);

    const part  = sanitizeInput(url.searchParams.get("part"),  60);
    const model = sanitizeInput(url.searchParams.get("model"), 80);

    if (!part || !model)
      return sendJson(res, req, 400, {
        error: "Both 'part' and 'model' query parameters are required",
        watermark: "Created by Munax",
      }, ctx);

    const categoryKey = Object.keys(currentIndex).find(key =>
      key.includes(part.toLowerCase().replace(/[^a-z0-9]/g, "_")) ||
      currentIndex[key]?.name.toLowerCase().includes(part.toLowerCase())
    );

    if (!categoryKey)
      return sendJson(res, req, 404, {
        error:     "Category not found",
        available: Object.keys(currentIndex).map(k => ({
          key: k, name: currentIndex[k].name,
        })),
        watermark: "Created by Munax",
      }, ctx);

    const catData    = currentIndex[categoryKey];
    const seenGroups = new Set();
    const matches    = [];

    for (const entry of catData.models) {
      const result = preciseMatch(model, entry);
      if (result.match && !seenGroups.has(entry.groupLine)) {
        seenGroups.add(entry.groupLine);
        matches.push({
          brand:         entry.brand,
          compatibility: entry.groupLine,
          matchType:     result.type,
          score:         result.score,
          matchedModel:  entry.original,
        });
      }
    }

    matches.sort((a, b) => b.score - a.score);
    searchLog(part, model, matches.length, ctx.ip, ctx.ua);

    return sendJson(res, req, 200, {
      success:      true,
      watermark:    "Created by Munax",
      part:         { key: categoryKey, name: catData.name },
      searchModel:  model,
      totalMatches: matches.length,
      exactMatches: matches.filter(m => m.score >= 95).length,
      summary: matches.length > 0
        ? `Found ${matches.length} compatible listing${matches.length !== 1 ? "s" : ""} for ${model}`
        : `No exact matches found for "${model}". Try a more specific model name.`,
      results: matches.slice(0, 20),
    }, ctx);
  }

  // ── 404 ──────────────────────────────────────────────────────────────
  return sendJson(res, req, 404, {
    error:     "Endpoint not found",
    watermark: "Created by Munax",
  }, ctx);
});

// ───────────────────────────────────────────────────────────────────────────
// § 12  STARTUP
// ───────────────────────────────────────────────────────────────────────────

// Global safety net — catches any unhandled errors so the server never crashes
process.on("uncaughtException", err => {
  accessLog("error", "Uncaught exception", { message: err.message, stack: err.stack });
  console.error("💥 Uncaught exception:", err);
});

process.on("unhandledRejection", reason => {
  accessLog("error", "Unhandled promise rejection", { reason: String(reason) });
  console.error("💥 Unhandled rejection:", reason);
});

// Load dashboard HTML once at startup
try {
  if (fs.existsSync(DASH_PATH)) {
    dashboardHtml = fs.readFileSync(DASH_PATH, "utf8");
    console.log("✅ Dashboard HTML cached in memory");
  }
} catch (err) {
  console.warn("⚠️  Could not read dashboard.html:", err.message);
}

// Build search index
currentIndex = loadAndBuildIndex();

// Watch data.json for live changes
watchDataFile();

// Clean old logs now, and schedule nightly cleanup
cleanOldLogs();
(function scheduleDailyLogClean() {
  const now          = new Date();
  const tomorrow     = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const msToMidnight = tomorrow - now;
  setTimeout(() => {
    cleanOldLogs();
    setInterval(cleanOldLogs, 24 * 60 * 60_000).unref();
  }, msToMidnight);
})();

// Start server
server.listen(PORT, "0.0.0.0", () => {
  const total = Object.values(currentIndex).reduce((s, c) => s + c.models.length, 0);
  console.log("\n🚀 ════════════════════════════════════════════════");
  console.log("   UNIPARTS API SERVER  v4.1  —  Created by Munax");
  console.log("   ──────────────────────────────────────────────");
  console.log(`   🌐 Port          ${PORT}`);
  console.log(`   🌍 Environment   ${NODE_ENV}`);
  console.log(`   📦 Categories    ${Object.keys(currentIndex).length}`);
  console.log(`   📱 Models        ${total.toLocaleString()}`);
  console.log(`   💾 Cache TTL     ${CFG.cache.ttlMs / 60_000} min  (max ${CFG.cache.maxSize} entries, LRU)`);
  console.log(`   🚦 Rate limits   strict=${CFG.rateLimit.tiers.strict}/min  normal=${CFG.rateLimit.tiers.normal}/min  loose=${CFG.rateLimit.tiers.loose}/min`);
  console.log(`   ♻️  Auto-reload   data.json is being watched for changes`);
  console.log(`   📋 Logging       ${LOG_DIR}  (kept ${CFG.log.keepDays} days)`);
  console.log(`   🔐 Admin         /admin/*?key=<SECRET_KEY>`);
  console.log("   ════════════════════════════════════════════════\n");
});

// ───────────────────────────────────────────────────────────────────────────
// § 13  GRACEFUL SHUTDOWN
// ───────────────────────────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`\n🛑 ${signal} — shutting down gracefully…`);
  server.close(() => {
    accessLog("info", "Server shutdown", {
      signal,
      uptime: formatUptime(Math.floor(process.uptime())),
      requests: metrics.totalRequests,
    });
    console.log("✅ Server closed cleanly. Goodbye.");
    process.exit(0);
  });

  // Force-exit after 10 s if lingering connections prevent server.close from resolving
  setTimeout(() => {
    accessLog("error", "Forced exit after shutdown timeout");
    console.error("⚠️  Force-exiting after 10 s timeout");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
