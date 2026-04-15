"use strict";

// ═══════════════════════════════════════════════════════════════════════════
//   UNIPARTS API SERVER  v6.0  —  PEAK AURA EDITION
//   External data from combosupport.in + GSMArena proxy
//   Fixed: removed dead imports, unused vars, preciseMatch split bug
// ═══════════════════════════════════════════════════════════════════════════

const http    = require("http");
const fs      = require("fs");
const path    = require("path");
const zlib    = require("zlib");
const axios   = require("axios");
const cheerio = require("cheerio");

// ───────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ───────────────────────────────────────────────────────────────────────────

const PORT     = parseInt(process.env.PORT, 10) || 8000;
const SECRET_KEY = process.env.SECRET_KEY;
const NODE_ENV = process.env.NODE_ENV || "development";
const API_BASE = process.env.API_BASE || `http://localhost:${PORT}`;

const EXTERNAL_API = {
  master:  "https://combosupport.in/wp-content/uploads/appdatanew/data.php",
  updates: "https://combosupport.in/wp-content/uploads/appdatanew/updates.php",
  version: "https://combosupport.in/wp-content/uploads/appdatanew/version.json",
};

const REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

if (!SECRET_KEY && NODE_ENV === "production") {
  console.error("❌ FATAL: SECRET_KEY environment variable not set!");
  process.exit(1);
}
const SECRET = SECRET_KEY || "munax_admin_2026";

const CFG = {
  cache:     { ttlMs: 3600000, maxSize: 500 },
  gsmarena:  { timeout: 10000, retries: 2, retryDelay: 1500, userAgent: "Mozilla/5.0" },
  rateLimit: { windowMs: 60000, tiers: { strict: 10, normal: 30, loose: 120, admin: 20 } },
  log:       { keepDays: 7 },
  server:    { timeout: 30000, maxHeaderSize: 16384 },
};

// ───────────────────────────────────────────────────────────────────────────
// CONSTANTS & STATE
// ───────────────────────────────────────────────────────────────────────────

const LOG_DIR   = path.join(__dirname, "logs");
const DASH_PATH = path.join(__dirname, "dashboard.html");

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const SEC = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options":        "DENY",
  "X-XSS-Protection":       "1; mode=block",
  "Content-Security-Policy": `default-src 'self'; script-src 'self' 'unsafe-inline' https://fonts.googleapis.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src * data:; font-src https://fonts.gstatic.com; connect-src 'self' ${API_BASE}`,
};

const PLACEHOLDER_TOKENS = ["coming soon", "new list", "universal"];

const VARIANT_GROUPS = {
  pro:    ["pro"],
  proplus:["proplus", "pro+", "pro plus"],
  promax: ["promax", "pro max"],
  ultra:  ["ultra"],
  lite:   ["lite"],
  se:     ["se"],
  prime:  ["prime"],
};

const metrics = {
  startedAt:     new Date().toISOString(),
  totalRequests: 0,
  errorCount:    0,
  cacheHits:     0,
  cacheMisses:   0,
  requestsByPath:{},
  lastSync:      null,
  syncCount:     0,
  lastSyncError: null,
};

let currentIndex  = {};
let dashboardHtml = null;

// ───────────────────────────────────────────────────────────────────────────
// LRU CACHE
// ───────────────────────────────────────────────────────────────────────────

const _cacheStore = new Map();
const cache = {
  get(key) {
    const entry = _cacheStore.get(key);
    if (!entry) { metrics.cacheMisses++; return null; }
    if (Date.now() - entry.cachedAt > CFG.cache.ttlMs) {
      _cacheStore.delete(key);
      metrics.cacheMisses++;
      return null;
    }
    // Move to end (LRU)
    _cacheStore.delete(key);
    _cacheStore.set(key, entry);
    metrics.cacheHits++;
    return entry.data;
  },
  set(key, data) {
    if (_cacheStore.size >= CFG.cache.maxSize)
      _cacheStore.delete(_cacheStore.keys().next().value);
    _cacheStore.set(key, { data, cachedAt: Date.now() });
  },
  clear() { _cacheStore.clear(); },
  stats() {
    const total = metrics.cacheHits + metrics.cacheMisses;
    return {
      entries:    _cacheStore.size,
      maxSize:    CFG.cache.maxSize,
      ttlMinutes: CFG.cache.ttlMs / 60000,
      hits:       metrics.cacheHits,
      misses:     metrics.cacheMisses,
      hitRate:    total > 0 ? `${((metrics.cacheHits / total) * 100).toFixed(1)}%` : "n/a",
    };
  },
};

// ───────────────────────────────────────────────────────────────────────────
// RATE LIMITER
// ───────────────────────────────────────────────────────────────────────────

const _rlStore = new Map();

function checkRateLimit(ip, tier) {
  const limit = CFG.rateLimit.tiers[tier] ?? CFG.rateLimit.tiers.normal;
  const now   = Date.now();
  const win   = CFG.rateLimit.windowMs;
  const hits  = (_rlStore.get(ip) || []).filter(t => now - t < win);
  hits.push(now);
  _rlStore.set(ip, hits);
  if (hits.length > limit) {
    const retryAfter = Math.ceil((hits[0] + win - now) / 1000);
    return { allowed: false, retryAfter, limit, used: hits.length };
  }
  return { allowed: true, remaining: limit - hits.length, limit };
}

// Clean stale rate-limit entries every 5 min
setInterval(() => {
  const cutoff = Date.now() - CFG.rateLimit.windowMs;
  for (const [ip, hits] of _rlStore) {
    const fresh = hits.filter(t => t > cutoff);
    if (fresh.length === 0) _rlStore.delete(ip);
    else _rlStore.set(ip, fresh);
  }
}, 5 * 60000).unref();

// ───────────────────────────────────────────────────────────────────────────
// LOGGING
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
  if (NODE_ENV !== "production") {
    const icon = level === "error" ? "❌" : level === "warn" ? "⚠️ " : "📋";
    console.log(`${icon} [${level.toUpperCase()}] ${message}`, Object.keys(meta).length ? meta : "");
  }
}

function searchLog(part, model, resultCount, ip, ua) {
  _writeLog(`search_${new Date().toISOString().split("T")[0]}.jsonl`, {
    ts: new Date().toISOString(), part, model, resultCount,
    ip: ip || "unknown", ua: (ua || "").slice(0, 100),
  });
}

async function getSearchStats() {
  const day = new Date().toISOString().split("T")[0];
  try {
    const content = await fs.promises.readFile(path.join(LOG_DIR, `search_${day}.jsonl`), "utf8");
    const logs    = content.split("\n").filter(Boolean).map(l => JSON.parse(l));
    const byModel = {}, byPart = {};
    logs.forEach(l => {
      byModel[l.model] = (byModel[l.model] || 0) + 1;
      byPart[l.part]   = (byPart[l.part]   || 0) + 1;
    });
    const top = (obj, n) => Object.entries(obj)
      .sort(([, a], [, b]) => b - a)
      .slice(0, n)
      .map(([k, v]) => ({ name: k, count: v }));
    return {
      date: day, total: logs.length,
      topModels: top(byModel, 10), topParts: top(byPart, 10),
      recent: logs.slice(-50).reverse(),
    };
  } catch {
    return { date: day, total: 0, topModels: [], topParts: [], recent: [] };
  }
}

function cleanOldLogs() {
  const cutoff = new Date(Date.now() - CFG.log.keepDays * 86400000).toISOString().split("T")[0];
  try {
    fs.readdirSync(LOG_DIR).forEach(file => {
      const m = file.match(/^(?:access|search)_(\d{4}-\d{2}-\d{2}).jsonl$/);
      if (m && m[1] < cutoff) fs.unlink(path.join(LOG_DIR, file), () => {});
    });
  } catch (err) { console.warn("⚠️ Log cleanup failed:", err.message); }
}

// ───────────────────────────────────────────────────────────────────────────
// UTILITIES
// ───────────────────────────────────────────────────────────────────────────

function normalize(t) {
  return t?.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim() || "";
}

function createCategoryKey(name) {
  return name.toLowerCase()
    .replace(/^\d+\.\s*/, "")
    .replace(/[^a-z0-9]/g, "*")
    .replace(/\*+/g, "*")
    .replace(/^\*|_$/, "");
}

function sanitizeInput(v, max = 100) {
  if (typeof v !== "string") return null;
  const t = v.trim().slice(0, max);
  return t || null;
}

function formatBytes(n) {
  if (n < 1024)       return `${n} B`;
  if (n < 1024 ** 2)  return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

function formatUptime(sec) {
  const d = Math.floor(sec / 86400),
        h = Math.floor((sec % 86400) / 3600),
        m = Math.floor((sec % 3600) / 60),
        s = sec % 60;
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(" ");
}

function getIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0].trim()
    || req.socket?.remoteAddress
    || "unknown";
}

// ───────────────────────────────────────────────────────────────────────────
// INDEX BUILDER & EXTERNAL SYNC
// ───────────────────────────────────────────────────────────────────────────

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
  (model.match(/[a-z]+\d+[a-z]*|\d+[a-z]+/g) || []).forEach(m => ids.push(m.toLowerCase()));
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

        // Helper: register one model entry
        const addModel = (original, groupLine) => {
          const norm = normalize(original);
          if (!norm || norm.includes("coming")) return;
          index[key].models.push({
            brand:       brand.name,
            original,
            normalized:  norm,
            groupLine,
            // Store the raw group line (may contain "=") for matching
            rawGroupLine: groupLine,
            identifiers: extractModelIdentifiers(norm),
          });
        };

        if (line.includes("=")) {
          const cleaned = line.replace(/^\d+\.\s*/, "");
          const parts   = cleaned
            .split("=")
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

async function fetchExternalData() {
  try {
    accessLog("info", "Fetching external data from combo support APIs");
    const [masterRes, updatesRes, versionRes] = await Promise.allSettled([
      axios.get(EXTERNAL_API.master,  { timeout: 15000 }),
      axios.get(EXTERNAL_API.updates, { timeout: 10000 }),
      axios.get(EXTERNAL_API.version, { timeout: 5000  }),
    ]);

    let masterData = null;
    let updates    = [];
    let version    = { version: "unknown" };

    if (masterRes.status === "fulfilled" && masterRes.value.data) {
      masterData = masterRes.value.data;
      accessLog("info", "Master data fetched successfully");
    } else {
      accessLog("error", "Failed to fetch master data", { reason: masterRes.reason?.message });
      metrics.lastSyncError = "master data fetch failed";
    }

    if (updatesRes.status === "fulfilled" && updatesRes.value.data)
      updates = updatesRes.value.data;
    else
      accessLog("warn", "Updates fetch failed, using empty array");

    if (versionRes.status === "fulfilled" && versionRes.value.data)
      version = versionRes.value.data;
    else
      accessLog("warn", "Version fetch failed, using default");

    if (!masterData) throw new Error("No master data received");

    const index  = buildIndex(masterData);
    const total  = Object.values(index).reduce((s, c) => s + c.models.length, 0);
    index._meta  = { updates, version, lastSync: new Date().toISOString() };

    metrics.lastSync      = new Date().toISOString();
    metrics.syncCount++;
    metrics.lastSyncError = null;

    accessLog("info", "External data sync completed", {
      categories:    Object.keys(index).length,
      models:        total,
      updatesCount:  updates.length,
      version:       version.version,
    });
    return index;
  } catch (err) {
    accessLog("error", "External data sync failed", { error: err.message });
    metrics.lastSyncError = err.message;
    throw err;
  }
}

async function syncExternalData() {
  try {
    const newIndex = await fetchExternalData();
    if (Object.keys(newIndex).length > 0) {
      currentIndex = newIndex;
      console.log(`♻️  External data synced — sync #${metrics.syncCount}`);
      return true;
    }
    return false;
  } catch {
    console.error("❌ External sync failed, keeping existing index");
    return false;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// PRECISE MATCHING ENGINE
// ───────────────────────────────────────────────────────────────────────────

function sameVariant(a, b) {
  const na = a.replace(/\s+/g, "").toLowerCase();
  const nb = b.replace(/\s+/g, "").toLowerCase();
  for (const values of Object.values(VARIANT_GROUPS))
    if (values.includes(na) && values.includes(nb)) return true;
  return false;
}

function preciseMatch(searchModel, modelEntry) {
  if (!searchModel || !modelEntry) return { match: false, score: 0 };

  const cleanSearch = normalize(searchModel);

  // ── FIX: split rawGroupLine (original, may contain "=") not normalized ──
  // normalized strings never contain "=" so splitting them was dead logic.
  const rawLine  = modelEntry.rawGroupLine || modelEntry.original || "";
  const candidates = rawLine.includes("=")
    ? rawLine.split("=").map(m => m.replace(/^\d+\.\s*/, "").trim()).filter(Boolean)
    : [rawLine.trim()];

  for (const candidate of candidates) {
    const cleanCandidate = normalize(candidate);
    if (!cleanCandidate) continue;

    // Exact
    if (cleanCandidate === cleanSearch)
      return { match: true, score: 100, type: "exact" };

    // Word-boundary containment
    const wbRe = new RegExp(`\\b${cleanSearch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (wbRe.test(cleanCandidate))
      return { match: true, score: 95, type: "contained_in_chain" };

    // Search contains candidate
    if (cleanSearch.includes(cleanCandidate) && cleanCandidate.length > 3)
      return { match: true, score: 90, type: "candidate_subset" };

    // Note series matching
    if (cleanSearch.includes("note") && cleanCandidate.includes("note")) {
      const NOTE_RE = /note[\s-]*(\d+)(?:\s*(pro\+?|pro\s*plus|pro\s*max|pro|plus|max|ultra|lite|se|prime))?/i;
      const sn = cleanSearch.match(NOTE_RE), mn = cleanCandidate.match(NOTE_RE);
      if (sn && mn && sn[1] === mn[1]) {
        if (sn[2] && mn[2] && !sameVariant(sn[2], mn[2])) continue;
        if (Boolean(sn[2]) !== Boolean(mn[2])) continue;
        return { match: true, score: sn[2] ? 90 : 85, type: sn[2] ? "note_exact_variant" : "note_series" };
      }
    }

    // Prevent cross-model matches (e.g. A15 vs A25)
    const sNum = cleanSearch.match(/\b[a-z]\d+\b/i)?.[0]?.toLowerCase();
    const cNum = cleanCandidate.match(/\b[a-z]\d+\b/i)?.[0]?.toLowerCase();
    if (sNum && cNum && sNum !== cNum) continue;

    // Numbered list item
    const stripped = candidate.match(/^\d+\.\s*(.+)/)?.[1];
    if (stripped && normalize(stripped) === cleanSearch)
      return { match: true, score: 90, type: "list_item" };

    // Identifier match
    const si = extractModelIdentifiers(cleanSearch);
    const mi = extractModelIdentifiers(cleanCandidate);
    for (const s of si)
      for (const m of mi)
        if (s === m) return { match: true, score: 80, type: "identifier_match" };
  }

  return { match: false, score: 0 };
}

// ───────────────────────────────────────────────────────────────────────────
// GSMARENA HELPERS
// ───────────────────────────────────────────────────────────────────────────

async function fetchWithRetry(url, retries = CFG.gsmarena.retries, delay = CFG.gsmarena.retryDelay) {
  try {
    return await axios.get(url, {
      headers: { "User-Agent": CFG.gsmarena.userAgent },
      timeout: CFG.gsmarena.timeout,
    });
  } catch (err) {
    if (retries === 0) throw err;
    accessLog("warn", "GSMArena fetch failed, retrying", { url, retriesLeft: retries, delayMs: delay });
    await new Promise(r => setTimeout(r, delay));
    return fetchWithRetry(url, retries - 1, delay * 2);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// HTTP HELPERS
// ───────────────────────────────────────────────────────────────────────────

let _reqCounter = 0;

function createCtx(req) {
  return {
    id: `${Date.now().toString(36)}-${(++_reqCounter).toString(36).padStart(4, "0")}`,
    ip: getIp(req),
    ua: req.headers["user-agent"] || "",
    t0: process.hrtime.bigint(),
  };
}

function sendJson(res, req, status, data, ctx) {
  const body       = JSON.stringify(data, null, 2);
  const durationMs = (Number(process.hrtime.bigint() - ctx.t0) / 1e6).toFixed(2);
  let pathname; try { pathname = new URL(req.url, "http://x").pathname; } catch { pathname = req.url; }

  const baseHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "X-Request-Id":    ctx.id,
    "X-Response-Time": `${durationMs}ms`,
    ...SEC, ...CORS,
  };

  metrics.totalRequests++;
  metrics.requestsByPath[pathname] = (metrics.requestsByPath[pathname] || 0) + 1;
  if (status >= 400) metrics.errorCount++;

  accessLog("access", `${req.method} ${pathname} → ${status}`, {
    reqId: ctx.id, ip: ctx.ip, status, ms: parseFloat(durationMs),
  });

  const bodyBuf      = Buffer.from(body, "utf8");
  const acceptsGzip  = (req.headers["accept-encoding"] || "").includes("gzip");

  if (bodyBuf.length > 1024 && acceptsGzip) {
    zlib.gzip(bodyBuf, (err, compressed) => {
      if (err) {
        res.writeHead(status, { ...baseHeaders, "Content-Length": bodyBuf.length });
        return res.end(bodyBuf);
      }
      res.writeHead(status, { ...baseHeaders, "Content-Encoding": "gzip", "Content-Length": compressed.length });
      res.end(compressed);
    });
  } else {
    res.writeHead(status, { ...baseHeaders, "Content-Length": bodyBuf.length });
    res.end(bodyBuf);
  }
}

function rejectRateLimit(res, req, info, ctx) {
  res.setHeader("Retry-After",      String(info.retryAfter));
  res.setHeader("X-RateLimit-Limit",String(info.limit));
  sendJson(res, req, 429, { error: "Too many requests", retryAfter: `${info.retryAfter}s`, watermark: "Created by Munax" }, ctx);
}

// ───────────────────────────────────────────────────────────────────────────
// ROUTE HANDLERS
// ───────────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const ctx = createCtx(req);
  let url;
  try { url = new URL(req.url, `http://${req.headers.host}`); }
  catch { return sendJson(res, req, 400, { error: "Malformed request URL" }, ctx); }

  const { pathname } = url;

  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  if (req.method !== "GET")
    return sendJson(res, req, 405, { error: "Method not allowed. Use GET.", watermark: "Created by Munax" }, ctx);

  // ── ADMIN ROUTES ────────────────────────────────────────────────────────
  if (pathname.startsWith("/admin")) {
    const rl = checkRateLimit(ctx.ip, "admin");
    if (!rl.allowed) return rejectRateLimit(res, req, rl, ctx);
    if (url.searchParams.get("key") !== SECRET) {
      accessLog("warn", "Admin auth failure", { ip: ctx.ip, path: pathname });
      return sendJson(res, req, 403, { error: "Forbidden — invalid key" }, ctx);
    }
    if (pathname === "/admin/stats") {
      try {
        const stats = await getSearchStats();
        return sendJson(res, req, 200, { ...stats, serverMetrics: metrics, watermark: "Created by Munax" }, ctx);
      } catch { return sendJson(res, req, 500, { error: "Internal error" }, ctx); }
    }
    if (pathname === "/admin/cache") {
      if (url.searchParams.get("action") === "clear") {
        const cleared = _cacheStore.size;
        cache.clear();
        return sendJson(res, req, 200, { success: true, cleared, watermark: "Created by Munax" }, ctx);
      }
      return sendJson(res, req, 200, { ...cache.stats(), watermark: "Created by Munax" }, ctx);
    }
    if (pathname === "/admin/refresh") {
      accessLog("info", "Manual refresh triggered", { ip: ctx.ip });
      const success = await syncExternalData();
      if (success)
        return sendJson(res, req, 200, { success: true, message: "External data refreshed", syncCount: metrics.syncCount, lastSync: metrics.lastSync, watermark: "Created by Munax" }, ctx);
      else
        return sendJson(res, req, 500, { success: false, error: "Refresh failed", lastSyncError: metrics.lastSyncError, watermark: "Created by Munax" }, ctx);
    }
    return sendJson(res, req, 404, { error: "Admin endpoint not found" }, ctx);
  }

  // ── /health ─────────────────────────────────────────────────────────────
  if (pathname === "/health") {
    const rl = checkRateLimit(ctx.ip, "loose");
    if (!rl.allowed) return rejectRateLimit(res, req, rl, ctx);
    const mem         = process.memoryUsage();
    const totalModels = Object.values(currentIndex).reduce((s, c) => s + (c.models?.length || 0), 0);
    return sendJson(res, req, 200, {
      status: "healthy",
      uptime: formatUptime(Math.floor(process.uptime())),
      startedAt: metrics.startedAt,
      memory: {
        rss:       formatBytes(mem.rss),
        heapUsed:  formatBytes(mem.heapUsed),
        heapTotal: formatBytes(mem.heapTotal),
        external:  formatBytes(mem.external),
      },
      index: { categories: Object.keys(currentIndex).filter(k => !k.startsWith("_")).length, totalModels },
      cache: cache.stats(),
      requests: { total: metrics.totalRequests, errors: metrics.errorCount, byPath: metrics.requestsByPath },
      rateLimit: { activeIPs: _rlStore.size, tiers: CFG.rateLimit.tiers },
      node: process.version, pid: process.pid, env: NODE_ENV,
      externalSync: { lastSync: metrics.lastSync, syncCount: metrics.syncCount, lastError: metrics.lastSyncError },
      watermark: "Created by Munax",
    }, ctx);
  }

  // ── /updates ────────────────────────────────────────────────────────────
  if (pathname === "/updates") {
    const rl = checkRateLimit(ctx.ip, "loose");
    if (!rl.allowed) return rejectRateLimit(res, req, rl, ctx);
    const updates = currentIndex._meta?.updates || [];
    return sendJson(res, req, 200, { success: true, updates, watermark: "Created by Munax" }, ctx);
  }

  // ── /version ────────────────────────────────────────────────────────────
  if (pathname === "/version") {
    const rl = checkRateLimit(ctx.ip, "loose");
    if (!rl.allowed) return rejectRateLimit(res, req, rl, ctx);
    const version = currentIndex._meta?.version || { version: "unknown" };
    return sendJson(res, req, 200, { success: true, ...version, watermark: "Created by Munax" }, ctx);
  }

  // ── /specs-search ───────────────────────────────────────────────────────
  if (pathname === "/specs-search") {
    const rl = checkRateLimit(ctx.ip, "strict");
    if (!rl.allowed) return rejectRateLimit(res, req, rl, ctx);
    const query = sanitizeInput(url.searchParams.get("q"), 80);
    if (!query) return sendJson(res, req, 400, { error: "Missing query parameter" }, ctx);
    const cacheKey = `search:${query.toLowerCase()}`;
    const cached   = cache.get(cacheKey);
    if (cached) return sendJson(res, req, 200, { ...cached, cached: true }, ctx);
    try {
      const resp = await fetchWithRetry(`https://www.gsmarena.com/results.php3?sQuickSearch=yes&sName=${encodeURIComponent(query)}`);
      const $    = cheerio.load(resp.data);
      const results = [];
      $(".makers li").each((_, el) => {
        const a     = $(el).find("a");
        const href  = a.attr("href");
        const title = a.find("img").attr("title") || a.text().trim();
        const img   = a.find("img").attr("src");
        if (href && title) results.push({ id: href, title, img });
      });
      const data = { success: true, results };
      cache.set(cacheKey, data);
      return sendJson(res, req, 200, data, ctx);
    } catch (err) {
      accessLog("error", "specs-search failed", { error: err.message, query });
      return sendJson(res, req, 500, { success: false, error: "GSMArena unavailable" }, ctx);
    }
  }

  // ── /specs-details ──────────────────────────────────────────────────────
  if (pathname === "/specs-details") {
    const rl = checkRateLimit(ctx.ip, "strict");
    if (!rl.allowed) return rejectRateLimit(res, req, rl, ctx);
    const id = sanitizeInput(url.searchParams.get("id"), 120);
    if (!id || /[<>"'\\]/.test(id) || id.includes("..") || id.includes("//"))
      return sendJson(res, req, 400, { error: "Invalid id" }, ctx);
    const cacheKey = `details:${id}`;
    const cached   = cache.get(cacheKey);
    if (cached) return sendJson(res, req, 200, { ...cached, cached: true }, ctx);
    try {
      const resp = await fetchWithRetry(`https://www.gsmarena.com/${id}`);
      const $    = cheerio.load(resp.data);
      const name = $(".specs-phone-name-title").text().trim();
      const img  = $(".specs-photo-main img").attr("src");
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
      return sendJson(res, req, 500, { success: false, error: "GSMArena unavailable" }, ctx);
    }
  }

  // ── / or /dashboard ─────────────────────────────────────────────────────
  if (pathname === "/" || pathname === "/dashboard") {
    const rl = checkRateLimit(ctx.ip, "loose");
    if (!rl.allowed) return rejectRateLimit(res, req, rl, ctx);
    if (dashboardHtml) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...SEC });
      return res.end(dashboardHtml);
    }
    return res.end(`<!DOCTYPE html><html><head><title>UNIPARTS · munax</title></head><body><h1>🔧 UNIPARTS v6.0</h1><p>Server running. <a href="/categories">Categories</a> · <a href="/health">Health</a></p></body></html>`);
  }

  // ── /api ────────────────────────────────────────────────────────────────
  if (pathname === "/api" || pathname === "/api/") {
    const rl = checkRateLimit(ctx.ip, "loose");
    if (!rl.allowed) return rejectRateLimit(res, req, rl, ctx);
    return sendJson(res, req, 200, {
      name: "UNIPARTS API", version: "6.0.0", status: "running", watermark: "Created by Munax",
      endpoints: {
        "/":                  "Dashboard (HTML)",
        "/search?part=X&model=Y": "Search compatibility",
        "/categories":        "List all categories",
        "/health":            "Health + metrics",
        "/specs-search?q=X":  "Search GSMArena",
        "/specs-details?id=X":"Full phone specs",
        "/updates":           "Recent data updates",
        "/version":           "Data version info",
        "/admin/*?key=K":     "Admin endpoints",
      },
      rateLimits:  CFG.rateLimit.tiers,
      dataSources: EXTERNAL_API,
    }, ctx);
  }

  // ── /categories ─────────────────────────────────────────────────────────
  if (pathname === "/categories") {
    const rl = checkRateLimit(ctx.ip, "loose");
    if (!rl.allowed) return rejectRateLimit(res, req, rl, ctx);
    return sendJson(res, req, 200, {
      watermark: "Created by Munax",
      total: Object.keys(currentIndex).filter(k => !k.startsWith("_")).length,
      categories: Object.keys(currentIndex)
        .filter(k => !k.startsWith("_"))
        .map(key => ({
          key,
          name:       currentIndex[key].name,
          brands:     currentIndex[key].brands.map(b => b.name),
          modelCount: currentIndex[key].models.length,
        })),
    }, ctx);
  }

  // ── /search ─────────────────────────────────────────────────────────────
  if (pathname === "/search") {
    const rl = checkRateLimit(ctx.ip, "normal");
    if (!rl.allowed) return rejectRateLimit(res, req, rl, ctx);

    const part  = sanitizeInput(url.searchParams.get("part"),  60);
    const model = sanitizeInput(url.searchParams.get("model"), 80);
    if (!part || !model)
      return sendJson(res, req, 400, { error: "Both 'part' and 'model' required", watermark: "Created by Munax" }, ctx);

    const categoryKey = Object.keys(currentIndex).find(key =>
      !key.startsWith("_") && (
        key.includes(part.toLowerCase().replace(/[^a-z0-9]/g, "_")) ||
        currentIndex[key]?.name.toLowerCase().includes(part.toLowerCase())
      )
    );

    if (!categoryKey)
      return sendJson(res, req, 404, {
        error: "Category not found",
        available: Object.keys(currentIndex).filter(k => !k.startsWith("_")).map(k => ({ key: k, name: currentIndex[k].name })),
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
          brand:        entry.brand,
          compatibility:entry.groupLine,
          matchType:    result.type,
          score:        result.score,
          matchedModel: entry.original,
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
      summary:      matches.length
        ? `Found ${matches.length} compatible listing${matches.length !== 1 ? "s" : ""} for ${model}`
        : `No exact matches for "${model}". Try a more specific model.`,
      results: matches.slice(0, 20),
    }, ctx);
  }

  return sendJson(res, req, 404, { error: "Endpoint not found", watermark: "Created by Munax" }, ctx);
});

server.timeout        = CFG.server.timeout;
server.headersTimeout = CFG.server.timeout + 5000;

// ───────────────────────────────────────────────────────────────────────────
// STARTUP
// ───────────────────────────────────────────────────────────────────────────

process.on("uncaughtException",   err    => { accessLog("error", "Uncaught exception",  { message: err.message, stack: err.stack }); console.error("💥", err); });
process.on("unhandledRejection",  reason => { accessLog("error", "Unhandled rejection", { reason: String(reason) }); console.error("💥", reason); });

// Load dashboard HTML
try {
  if (fs.existsSync(DASH_PATH)) {
    let html    = fs.readFileSync(DASH_PATH, "utf8");
    html        = html.replace(/__API_BASE__/g, API_BASE);
    dashboardHtml = html;
    console.log("✅ Dashboard HTML cached (API_BASE injected)");
  }
} catch (err) { console.warn("⚠️  Could not read dashboard.html:", err.message); }

// Initial sync
(async () => {
  console.log("🔄 Initial external data sync...");
  await syncExternalData();
  console.log("✅ Initial sync complete");
})();

// Scheduled hourly refresh
setInterval(async () => {
  console.log("🔄 Scheduled external data refresh...");
  await syncExternalData();
}, REFRESH_INTERVAL_MS);

// Log cleanup
cleanOldLogs();
(function scheduleDailyLogClean() {
  const now      = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  setTimeout(() => {
    cleanOldLogs();
    setInterval(cleanOldLogs, 24 * 60 * 60000).unref();
  }, tomorrow - now);
})();

// Start server
server.listen(PORT, "0.0.0.0", () => {
  const total = Object.values(currentIndex).reduce((s, c) => s + (c.models?.length || 0), 0);
  console.log("\n🚀 ════════════════════════════════════════════════");
  console.log("   UNIPARTS API SERVER  v6.0  —  PEAK AURA EDITION");
  console.log(`   🌐 Port          ${PORT}`);
  console.log(`   🌍 Environment   ${NODE_ENV}`);
  console.log(`   📦 Categories    ${Object.keys(currentIndex).filter(k => !k.startsWith("_")).length}`);
  console.log(`   📱 Models        ${total.toLocaleString()}`);
  console.log(`   💾 Cache TTL     ${CFG.cache.ttlMs / 60000} min (max ${CFG.cache.maxSize})`);
  console.log(`   🚦 Rate limits   strict=${CFG.rateLimit.tiers.strict}/min  normal=${CFG.rateLimit.tiers.normal}/min`);
  console.log(`   🔄 Auto-refresh  Every ${REFRESH_INTERVAL_MS / 60000} min`);
  console.log(`   📋 Logging       ${LOG_DIR} (kept ${CFG.log.keepDays} days)`);
  console.log(`   🔐 Admin         /admin/*?key=<SECRET_KEY>`);
  console.log(`   📡 Data sources:`);
  console.log(`      • Master:  ${EXTERNAL_API.master}`);
  console.log(`      • Updates: ${EXTERNAL_API.updates}`);
  console.log(`      • Version: ${EXTERNAL_API.version}`);
  console.log("   ════════════════════════════════════════════════\n");
});

// ───────────────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ───────────────────────────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`\n🛑 ${signal} — shutting down gracefully…`);
  server.close(() => {
    accessLog("info", "Server shutdown", { signal, uptime: formatUptime(Math.floor(process.uptime())), requests: metrics.totalRequests });
    console.log("✅ Server closed cleanly. Goodbye.");
    process.exit(0);
  });
  setTimeout(() => { console.error("⚠️  Force-exiting after timeout"); process.exit(1); }, 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
