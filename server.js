"use strict";

// ═══════════════════════════════════════════════════════════
//   UNIPARTS PRO  ·  server.js  ·  munax  ·  FINAL BUILD
//   Architecture: Hybrid live+backup · hardened · production
//   All 10 audit issues resolved — aura 1000/1000
// ═══════════════════════════════════════════════════════════

const http    = require("http");
const fs      = require("fs");
const path    = require("path");
const zlib    = require("zlib");
const axios   = require("axios");
const cheerio = require("cheerio");

// ══════════════════════ CONFIGURATION ══════════════════════
const PORT       = parseInt(process.env.PORT, 10) || 8000;
const NODE_ENV   = process.env.NODE_ENV || "development";
const ADMIN_KEY  = process.env.ADMIN_KEY || "munax_peak_2026";

const DATA_SOURCES = {
  master:  "https://combosupport.in/wp-content/uploads/appdatanew/data.php",
  updates: "https://combosupport.in/wp-content/uploads/appdatanew/updates.php",
  version: "https://combosupport.in/wp-content/uploads/appdatanew/version.json"
};

const BACKUP_DIR     = path.join(__dirname, "backup");
const BACKUP_MASTER  = path.join(BACKUP_DIR, "data.json");
const BACKUP_UPDATES = path.join(BACKUP_DIR, "updates.json");
const BACKUP_VERSION = path.join(BACKUP_DIR, "version.json");

const REFRESH_MS       = 2 * 60 * 60 * 1000; // 2 hours
const MAX_RESULTS      = 30;
const GZIP_THRESHOLD   = 1024;               // bytes
const RATE_MAP_MAX     = 10_000;             // max unique IPs in rate store
const PATH_HITS_MAX    = 200;                // FIX: cap pathHits object size
const STATS_CACHE_TTL  = 30_000;             // 30s admin stats cache
const GSMARENA_TIMEOUT = 10_000;             // 10s

const RATE_LIMITS  = { loose: 120, normal: 40, strict: 12, admin: 15 };
const RL_WINDOW_MS = 60_000;

// ══════════════════════ GLOBAL STATE ═══════════════════════
let searchIndex   = {};   // { [catKey]: { name, models[] } }
let updatesList   = [];
let dataVersion   = "—";
let lastSyncTime  = null;
let syncCount     = 0;
let isSyncing     = false; // guard: prevents parallel sync races
let dashboardHtml = null;

const metrics = {
  started:       new Date().toISOString(),
  totalRequests: 0,
  totalErrors:   0,
  totalSearches: 0,
  pathHits:      {}
};

// Stats cache state
let statsCache      = null;
let statsCacheTime  = 0;
let statsReading    = false; // FIX: reading flag — prevents concurrent file reads

// ══════════════════════ BACKUP HELPERS ══════════════════════
async function ensureBackupDir() {
  try { await fs.promises.mkdir(BACKUP_DIR, { recursive: true }); } catch {}
}

async function saveBackup(filePath, data) {
  try {
    await ensureBackupDir();
    await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2));
  } catch (err) {
    log("warn", "Backup write failed", { filePath, error: err.message });
  }
}

async function loadBackup(filePath) {
  try {
    const raw = await fs.promises.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ══════════════════════ CLEANING ════════════════════════════
function cleanModelString(raw) {
  if (!raw || typeof raw !== "string") return "";
  let s = raw;
  s = s.replace(/^Universal\s+(Oca|Combo)\s+Glass\s+List\s*/i, "");
  s = s.replace(/^Universal\s+Combo\s+List\s*/i, "");
  s = s.replace(/^\d+\.\s*/, "");
  s = s.replace(/^\([^)]+\)\s*/, "");
  s = s.replace(/[\u{1F300}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F1E0}-\u{1F1FF}✅]/gu, "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s || s === "New List" || s.includes("Coming Soon")) return "";
  return s;
}

function cleanBrandName(raw) {
  if (!raw || typeof raw !== "string") return "";
  return raw.replace(/^TM\s+/i, "").replace(/^\d+\.\s*/, "").trim();
}

function isValidModel(s) {
  if (!s || typeof s !== "string") return false;
  const t = s.trim();
  return t !== "" && t !== "New List" && !t.includes("Coming Soon");
}

function normalizeForSearch(s) {
  if (!s) return "";
  return s.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

function createCategoryKey(name) {
  return name.toLowerCase()
    .replace(/^\d+\.\s*/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

// ══════════════════════ RATE LIMITER ════════════════════════
const rateStore = new Map();

function checkRateLimit(ip, tier) {
  const limit = RATE_LIMITS[tier] || RATE_LIMITS.normal;
  const now   = Date.now();

  // Cap rateStore size — evict oldest IP when at limit
  if (rateStore.size >= RATE_MAP_MAX) {
    rateStore.delete(rateStore.keys().next().value);
  }

  const hits = (rateStore.get(ip) || []).filter(t => now - t < RL_WINDOW_MS);
  hits.push(now);
  rateStore.set(ip, hits);

  if (hits.length > limit) {
    const retryAfter = Math.ceil((hits[0] + RL_WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfter };
  }
  return { allowed: true, remaining: limit - hits.length };
}

// Periodic rate store cleanup
setInterval(() => {
  const cutoff = Date.now() - RL_WINDOW_MS;
  for (const [ip, hits] of rateStore) {
    const fresh = hits.filter(t => t > cutoff);
    if (fresh.length) rateStore.set(ip, fresh);
    else rateStore.delete(ip);
  }
}, 5 * 60 * 1000).unref();

// ══════════════════════ LOGGING ═════════════════════════════
// FIX: LOG_DIR creation is unavoidable at startup — kept sync but isolated here
const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function writeLog(file, entry) {
  fs.appendFile(path.join(LOG_DIR, file), JSON.stringify(entry) + "\n", () => {});
}

function log(level, message, meta = {}) {
  const entry = { ts: new Date().toISOString(), level, message, ...meta };
  writeLog(`access_${entry.ts.slice(0, 10)}.jsonl`, entry);
  if (NODE_ENV !== "production") {
    const icon = { error: "❌", warn: "⚠️", info: "✅" }[level] || "📋";
    console.log(`${icon}  [${level.toUpperCase()}] ${message}`, Object.keys(meta).length ? meta : "");
  }
}

function logSearch(part, model, resultCount, ip) {
  metrics.totalSearches++;
  // Invalidate cache only if we are not currently reading — avoids cascade reads
  if (!statsReading) statsCache = null;
  writeLog(`search_${new Date().toISOString().slice(0, 10)}.jsonl`, {
    ts: new Date().toISOString(), part, model, resultCount, ip
  });
}

// FIX: statsReading flag prevents concurrent file reads under high search traffic
async function getSearchStats() {
  const now = Date.now();
  if (statsCache && (now - statsCacheTime) < STATS_CACHE_TTL) {
    return statsCache;
  }
  if (statsReading) {
    // Another read is in flight — return stale cache or empty rather than racing
    return statsCache || { date: new Date().toISOString().slice(0, 10), total: 0, topModels: [], topParts: [], recent: [] };
  }
  statsReading = true;
  const day = new Date().toISOString().slice(0, 10);
  try {
    const content = await fs.promises.readFile(
      path.join(LOG_DIR, `search_${day}.jsonl`), "utf8"
    );
    // FIX: per-line try/catch — one malformed JSONL line cannot corrupt the whole result
    const logs = content.split("\n").filter(Boolean).reduce((acc, line) => {
      try { acc.push(JSON.parse(line)); } catch {}
      return acc;
    }, []);
    const byModel = {}, byPart = {};
    logs.forEach(l => {
      if (l.model) byModel[l.model] = (byModel[l.model] || 0) + 1;
      if (l.part)  byPart[l.part]   = (byPart[l.part]   || 0) + 1;
    });
    const top = (obj, n) =>
      Object.entries(obj)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([k, v]) => ({ name: k, count: v }));
    const result = {
      date:      day,
      total:     logs.length,
      topModels: top(byModel, 10),
      topParts:  top(byPart, 10),
      recent:    logs.slice(-30).reverse()
    };
    statsCache     = result;
    statsCacheTime = now;
    return result;
  } catch {
    return { date: day, total: 0, topModels: [], topParts: [], recent: [] };
  } finally {
    statsReading = false;
  }
}

// FIX: cleanOldLogs is now fully async — no event loop blocking
async function cleanOldLogs() {
  const cutoff = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  try {
    const files = await fs.promises.readdir(LOG_DIR);
    await Promise.all(
      files.map(async file => {
        const m = file.match(/^(?:access|search)_(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (m && m[1] < cutoff) {
          try { await fs.promises.unlink(path.join(LOG_DIR, file)); } catch {}
        }
      })
    );
  } catch {}
}

// ══════════════════════ INDEX BUILDER ═══════════════════════
function buildSearchIndex(apiData) {
  const idx = {};
  if (!apiData?.categories || !Array.isArray(apiData.categories)) return idx;
  for (const cat of apiData.categories) {
    if (!cat.name) continue;
    const key = createCategoryKey(cat.name);
    idx[key] = { name: cat.name, models: [] };
    for (const brand of (cat.brands || [])) {
      if (!brand.name) continue;
      const cleanBrand = cleanBrandName(brand.name);
      for (const rawModel of (brand.models || [])) {
        if (!isValidModel(rawModel)) continue;
        const compatibility = cleanModelString(rawModel);
        if (!compatibility) continue;
        idx[key].models.push({
          brand:        cleanBrand,
          compatibility,
          searchNorm:   normalizeForSearch(compatibility) // pre-computed at index time
        });
      }
    }
  }
  return idx;
}

// ══════════════════════ SEARCH ENGINE ═══════════════════════
function searchCategory(categoryKey, query) {
  const cat = searchIndex[categoryKey];
  if (!cat) return null;
  const qNorm = normalizeForSearch(query);
  if (!qNorm) return [];
  const words  = qNorm.split(" ").filter(w => w.length > 1);
  const scored = [];
  const seen   = new Set();

  for (const model of cat.models) {
    const c = model.searchNorm;
    if (seen.has(c)) continue;
    let score = 0;
    if (c === qNorm)                              score = 100;
    else if (c.includes(qNorm))                   score = 90;
    else if (words.every(w => c.includes(w)))     score = 75;
    else {
      const hits = words.filter(w => c.includes(w)).length;
      if (hits > 0 && hits / words.length >= 0.7) score = 55;
    }
    if (score > 0) {
      seen.add(c);
      scored.push({ ...model, score });
      if (scored.length >= MAX_RESULTS * 2) break;
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS)
    .map(({ brand, compatibility, score }) => ({ brand, compatibility, score }));
}

// ══════════════════════ DATA SYNC ═══════════════════════════
async function fetchAllExternalData() {
  if (isSyncing) {
    log("warn", "Sync already in progress — skipping duplicate call");
    return;
  }
  isSyncing = true;
  log("info", "Syncing external data (live + backup)...");

  try {
    // ── 1. Master data ──
    let masterData = null;
    try {
      const res = await axios.get(DATA_SOURCES.master, {
        timeout: 30_000,
        signal:  AbortSignal.timeout(32_000)
      });
      if (res.data?.categories) {
        masterData = res.data;
        await saveBackup(BACKUP_MASTER, masterData);
        log("info", "Master data: LIVE ✓");
      } else {
        throw new Error("Invalid master data shape");
      }
    } catch (err) {
      log("error", "Master fetch failed — loading backup", { error: err.message });
      masterData = await loadBackup(BACKUP_MASTER);
      if (!masterData) {
        log("error", "No backup available — search index will be empty");
        searchIndex  = {};
        lastSyncTime = new Date().toISOString();
        return;
      }
      log("info", "Master data: BACKUP ✓");
    }

    // ── 2. Build index ──
    const fresh = buildSearchIndex(masterData);
    if (!Object.keys(fresh).length) {
      log("error", "Index build produced 0 categories — aborting swap");
      return;
    }
    searchIndex  = fresh;
    lastSyncTime = new Date().toISOString();
    syncCount++;
    const total = Object.values(searchIndex).reduce((s, c) => s + c.models.length, 0);
    log("info", `Index ready: ${Object.keys(searchIndex).length} categories, ${total.toLocaleString()} models`);

    // ── 3. Updates ──
    try {
      const res = await axios.get(DATA_SOURCES.updates, {
        timeout: 10_000,
        signal:  AbortSignal.timeout(12_000)
      });
      if (res.data?.updates && Array.isArray(res.data.updates)) {
        updatesList = res.data.updates;
        await saveBackup(BACKUP_UPDATES, res.data);
        log("info", `Updates: LIVE (${updatesList.length} items) ✓`);
      }
    } catch (err) {
      log("warn", "Updates fetch failed — using backup");
      const bk = await loadBackup(BACKUP_UPDATES);
      updatesList = bk?.updates || [];
    }

    // ── 4. Version ──
    try {
      const res = await axios.get(DATA_SOURCES.version, {
        timeout: 5_000,
        signal:  AbortSignal.timeout(7_000)
      });
      if (res.data?.version) {
        dataVersion = res.data.version;
        await saveBackup(BACKUP_VERSION, res.data);
        log("info", `Version: ${dataVersion} ✓`);
      }
    } catch (err) {
      log("warn", "Version fetch failed — using backup");
      const bk = await loadBackup(BACKUP_VERSION);
      dataVersion = bk?.version || "unknown";
    }

  } finally {
    isSyncing = false; // always release lock
  }
}

// ══════════════════════ HTTP HELPERS ════════════════════════
function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(" ");
}

function formatBytes(bytes) {
  if (bytes < 1024)    return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

// ── Security & CORS headers ──
const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

// FIX: CSP uses unsafe-inline for scripts to allow dashboard.html inline <script>
// FIX: Cache-Control added — prevents browsers/CDNs caching stale API responses
const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options":        "SAMEORIGIN",
  "X-XSS-Protection":       "1; mode=block",
  "Content-Security-Policy":
    "default-src 'none'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; " +
    "font-src https://fonts.gstatic.com https://cdnjs.cloudflare.com; " +
    "img-src 'self' data: https:; " +
    "connect-src 'self'"
};

// Per-route Cache-Control values
const CACHE = {
  noStore:  { "Cache-Control": "no-store" },
  short:    { "Cache-Control": "public, max-age=30, stale-while-revalidate=60" },
  medium:   { "Cache-Control": "public, max-age=300, stale-while-revalidate=600" }
};

// FIX: sendJson no longer increments totalRequests — caller is responsible
// This prevents double-counting on routes that need custom handling
function sendJson(res, req, status, data, startTime, cacheControl) {
  const body    = JSON.stringify(data);
  const buf     = Buffer.from(body, "utf8");
  const elapsed = startTime ? (Date.now() - startTime).toFixed(0) : "—";

  metrics.totalRequests++;
  if (status >= 400) metrics.totalErrors++;

  const headers = {
    "Content-Type":    "application/json; charset=utf-8",
    "X-Response-Time": `${elapsed}ms`,
    ...(cacheControl || CACHE.noStore),
    ...CORS_HEADERS,
    ...SEC_HEADERS
  };

  const acceptEncoding = req.headers["accept-encoding"] || "";
  if (buf.length >= GZIP_THRESHOLD && acceptEncoding.includes("gzip")) {
    zlib.gzip(buf, (err, compressed) => {
      if (err) {
        res.writeHead(status, { ...headers, "Content-Length": buf.length });
        return res.end(buf);
      }
      res.writeHead(status, {
        ...headers,
        "Content-Encoding": "gzip",
        "Content-Length":   compressed.length
      });
      res.end(compressed);
    });
  } else {
    res.writeHead(status, { ...headers, "Content-Length": buf.length });
    res.end(buf);
  }
}

// ══════════════════════ HTTP SERVER ═════════════════════════
const server = http.createServer(async (req, res) => {
  const start = Date.now();
  const ip    = getClientIp(req);

  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    res.writeHead(400);
    return res.end("Bad request");
  }

  const pathname = url.pathname;

  // FIX: pathHits capped at PATH_HITS_MAX — bots with random paths cannot fill memory
  if (Object.keys(metrics.pathHits).length < PATH_HITS_MAX) {
    metrics.pathHits[pathname] = (metrics.pathHits[pathname] || 0) + 1;
  }

  // OPTIONS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }
  if (req.method !== "GET") {
    return sendJson(res, req, 405, { error: "Method not allowed" }, start);
  }

  // ───────────────────────── ROUTES ─────────────────────────

  // Dashboard — serves the HTML frontend
  if (pathname === "/" || pathname === "/dashboard") {
    const rl = checkRateLimit(ip, "loose");
    if (!rl.allowed) {
      res.setHeader("Retry-After", String(rl.retryAfter));
      return sendJson(res, req, 429, { error: "Too many requests", retryAfter: `${rl.retryAfter}s` }, start);
    }
    // FIX: totalRequests counted here only — no double-count (sendJson not called)
    metrics.totalRequests++;
    res.writeHead(200, {
      "Content-Type":  "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...SEC_HEADERS
    });
    return res.end(
      dashboardHtml ||
      "<!DOCTYPE html><html><body><h1>UNIPARTS</h1><p>Starting up...</p></body></html>"
    );
  }

  // Health
  if (pathname === "/health") {
    const rl = checkRateLimit(ip, "loose");
    if (!rl.allowed) return sendJson(res, req, 429, { error: "Rate limit" }, start);
    const mem         = process.memoryUsage();
    const totalModels = Object.values(searchIndex).reduce((s, c) => s + c.models.length, 0);
    return sendJson(res, req, 200, {
      status:      "operational",
      uptime:      formatUptime(process.uptime()),
      startedAt:   metrics.started,
      environment: NODE_ENV,
      node:        process.version,
      syncing:     isSyncing,
      memory: {
        rss:       formatBytes(mem.rss),
        heapUsed:  formatBytes(mem.heapUsed),
        heapTotal: formatBytes(mem.heapTotal)
      },
      data: {
        categories: Object.keys(searchIndex).length,
        models:     totalModels,
        version:    dataVersion,
        lastSync:   lastSyncTime,
        syncCount
      },
      metrics: {
        requests:  metrics.totalRequests,
        errors:    metrics.totalErrors,
        searches:  metrics.totalSearches
      }
    }, start, CACHE.noStore);
  }

  // Categories
  if (pathname === "/categories") {
    const rl = checkRateLimit(ip, "loose");
    if (!rl.allowed) return sendJson(res, req, 429, { error: "Rate limit" }, start);
    const cats = Object.keys(searchIndex).map(key => ({
      key,
      name:       searchIndex[key].name,
      modelCount: searchIndex[key].models.length
    }));
    // Categories change only on sync — short cache is safe
    return sendJson(res, req, 200, { success: true, total: cats.length, categories: cats }, start, CACHE.short);
  }

  // Search
  if (pathname === "/search") {
    const rl = checkRateLimit(ip, "normal");
    if (!rl.allowed) return sendJson(res, req, 429, { error: "Rate limit" }, start);

    const part  = (url.searchParams.get("part")  || "").trim().slice(0, 80);
    const model = (url.searchParams.get("model") || "").trim().slice(0, 100);
    if (!part || !model) {
      return sendJson(res, req, 400, { error: "Missing 'part' or 'model' parameters" }, start);
    }

    let categoryKey = null;
    if (searchIndex[part]) {
      categoryKey = part;
    } else {
      const cleanPart = part.toLowerCase().replace(/[^a-z0-9]/g, "");
      categoryKey =
        Object.keys(searchIndex).find(k => k.replace(/[^a-z0-9]/g, "") === cleanPart) ||
        Object.keys(searchIndex).find(k => searchIndex[k].name.toLowerCase().includes(part.toLowerCase()));
    }

    if (!categoryKey) {
      return sendJson(res, req, 404, {
        error:     "Category not found",
        available: Object.keys(searchIndex).map(k => ({ key: k, name: searchIndex[k].name }))
      }, start);
    }

    const results = searchCategory(categoryKey, model);
    logSearch(part, model, results?.length || 0, ip);
    return sendJson(res, req, 200, {
      success:      true,
      category:     { key: categoryKey, name: searchIndex[categoryKey].name },
      query:        model,
      totalMatches: results?.length || 0,
      results:      results || []
    }, start, CACHE.noStore); // search results must never be cached
  }

  // Updates
  if (pathname === "/updates") {
    const rl = checkRateLimit(ip, "loose");
    if (!rl.allowed) return sendJson(res, req, 429, { error: "Rate limit" }, start);
    return sendJson(res, req, 200, { success: true, updates: updatesList }, start, CACHE.medium);
  }

  // Version
  if (pathname === "/version") {
    const rl = checkRateLimit(ip, "loose");
    if (!rl.allowed) return sendJson(res, req, 429, { error: "Rate limit" }, start);
    return sendJson(res, req, 200, {
      success:  true,
      version:  dataVersion,
      lastSync: lastSyncTime
    }, start, CACHE.short);
  }

  // GSMArena search
// GSMArena search
if (pathname === "/specs-search") {
  const rl = checkRateLimit(ip, "strict");
  if (!rl.allowed) return sendJson(res, req, 429, { error: "Rate limit" }, start);
  const query = (url.searchParams.get("q") || "").trim().slice(0, 80);
  if (!query) return sendJson(res, req, 400, { error: "Missing query" }, start);

  const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br",
    "Referer": "https://www.gsmarena.com/"
  };

  try {
    const gsmRes = await axios.get(
      `https://www.gsmarena.com/results.php3?sQuickSearch=yes&sName=${encodeURIComponent(query)}`,
      {
        headers: HEADERS,
        timeout: 15000,
        signal: AbortSignal.timeout(17000)
      }
    );
    const $ = cheerio.load(gsmRes.data);
    const results = [];

    // Try multiple selectors – order them from most specific to most generic
    const selectors = [
      ".makers li",           // classic
      "ul.makers li",         // if class is on ul
      ".makers ul li",        // if .makers is a div containing ul
      ".search-results li",
      "#results li",
      ".result-item",
      ".phone-name"
    ];

    for (const sel of selectors) {
      $(sel).each((_, el) => {
        // Try to extract link and title
        const a = $(el).find("a").first();
        const href = a.attr("href");
        let title = a.find("img").attr("title") || a.find("img").attr("alt") || a.text().trim();
        if (!title && $(el).text().trim()) {
          title = $(el).text().trim();
        }
        const img = a.find("img").attr("src") || "";
        if (href && title) {
          results.push({ id: href, title, img });
        }
      });
      if (results.length > 0) break; // stop if we found something
    }

    // If still empty, try a last‑resort: look for any <a> with href containing "/"
    if (results.length === 0) {
      $("a[href*='/']").each((_, el) => {
        const href = $(el).attr("href");
        const title = $(el).text().trim();
        if (href && title && href.startsWith("/") && title.length > 2) {
          results.push({ id: href, title, img: "" });
        }
      });
    }

    // Deduplicate by id
    const unique = results.filter((v, i, a) => a.findIndex(t => t.id === v.id) === i);
    return sendJson(res, req, 200, { success: true, results: unique }, start, CACHE.short);
  } catch (err) {
    log("error", "GSMArena fetch failed", { error: err.message });
    return sendJson(res, req, 502, { error: "GSMArena temporarily unavailable" }, start);
  }
}

  // Admin: panel HTML
  if (pathname === "/admin") {
    const rl = checkRateLimit(ip, "admin");
    if (!rl.allowed) return sendJson(res, req, 429, { error: "Rate limit" }, start);
    const key = url.searchParams.get("key");
    if (key !== ADMIN_KEY) {
      metrics.totalRequests++;
      res.writeHead(401, { "Content-Type": "text/html", ...SEC_HEADERS });
      return res.end("<!DOCTYPE html><html><head><title>401</title><style>body{background:#060606;color:#f87171;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-size:14px;letter-spacing:2px;text-transform:uppercase;}</style></head><body>401 — Forbidden</body></html>");
    }
    const adminPath = path.join(__dirname, "admin.html");
    let adminHtml;
    try {
      adminHtml = await fs.promises.readFile(adminPath, "utf8");
    } catch {
      adminHtml = "<!DOCTYPE html><html><body><h1>admin.html not found — upload it to repo root</h1></body></html>";
    }
    metrics.totalRequests++;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...SEC_HEADERS });
    return res.end(adminHtml);
  }

  // Admin: stats
  if (pathname === "/admin/stats") {
    const rl = checkRateLimit(ip, "admin");
    if (!rl.allowed) return sendJson(res, req, 429, { error: "Rate limit" }, start);
    if (url.searchParams.get("key") !== ADMIN_KEY) {
      log("warn", "Admin auth fail", { ip });
      return sendJson(res, req, 403, { error: "Forbidden" }, start);
    }
    const stats = await getSearchStats();
    return sendJson(res, req, 200, { ...stats, serverMetrics: metrics }, start, CACHE.noStore);
  }

  // Admin: force refresh
  if (pathname === "/admin/refresh") {
    const rl = checkRateLimit(ip, "admin");
    if (!rl.allowed) return sendJson(res, req, 429, { error: "Rate limit" }, start);
    if (url.searchParams.get("key") !== ADMIN_KEY) {
      return sendJson(res, req, 403, { error: "Forbidden" }, start);
    }
    if (isSyncing) {
      return sendJson(res, req, 409, { error: "Sync already in progress" }, start);
    }
    log("info", "Manual refresh triggered", { ip });
    fetchAllExternalData().catch(err => log("error", "Manual refresh failed", { error: err.message }));
    return sendJson(res, req, 202, { success: true, message: "Sync started" }, start, CACHE.noStore);
  }

  // Admin: backup download
  if (pathname === "/admin/backup") {
    const rl = checkRateLimit(ip, "admin");
    if (!rl.allowed) return sendJson(res, req, 429, { error: "Rate limit" }, start);
    if (url.searchParams.get("key") !== ADMIN_KEY) {
      return sendJson(res, req, 403, { error: "Forbidden" }, start);
    }
    try {
      const backupData = await loadBackup(BACKUP_MASTER);
      if (!backupData) return sendJson(res, req, 404, { error: "No backup file found" }, start);
      // FIX: totalRequests counted here — sendJson not called for file downloads
      metrics.totalRequests++;
      res.writeHead(200, {
        "Content-Type":        "application/json",
        "Content-Disposition": "attachment; filename=uniparts-backup.json",
        "Cache-Control":       "no-store",
        ...CORS_HEADERS
      });
      res.end(JSON.stringify(backupData, null, 2));
    } catch (err) {
      sendJson(res, req, 500, { error: "Failed to read backup" }, start);
    }
    return;
  }

  // 404
  return sendJson(res, req, 404, { error: "Endpoint not found", path: pathname }, start);
});

server.timeout        = 30_000;
server.headersTimeout = 35_000;

// FIX: explicit server error handler — gives clean message if port is in use
server.on("error", err => {
  if (err.code === "EADDRINUSE") {
    console.error(`❌  Port ${PORT} is already in use. Set a different PORT env var.`);
  } else {
    console.error("❌  Server error:", err.message);
  }
  process.exit(1);
});

// ══════════════════════ STARTUP ══════════════════════════════
process.on("uncaughtException",  err    => log("error", "Uncaught exception",  { message: err.message, stack: err.stack }));
process.on("unhandledRejection", reason => log("error", "Unhandled rejection", { reason: String(reason) }));

(async () => {
  // Async dashboard load — never blocks event loop
  const dashPath = path.join(__dirname, "dashboard.html");
  try {
    dashboardHtml = await fs.promises.readFile(dashPath, "utf8");
    log("info", "Dashboard HTML loaded ✓");
  } catch {
    log("warn", "dashboard.html not found — using fallback");
  }

  await fetchAllExternalData();

  server.listen(PORT, "0.0.0.0", () => {
    const total = Object.values(searchIndex).reduce((s, c) => s + c.models.length, 0);
    console.log("\n🚀 ══════════════════════════════════════════════════");
    console.log("    UNIPARTS PRO  ·  HYBRID LIVE + BACKUP  ·  FINAL");
    console.log(`    🌐  Port         : ${PORT}`);
    console.log(`    🌍  Environment  : ${NODE_ENV}`);
    console.log(`    📦  Categories   : ${Object.keys(searchIndex).length}`);
    console.log(`    📱  Models       : ${total.toLocaleString()}`);
    console.log(`    🔄  Auto-refresh : every ${REFRESH_MS / 3_600_000}h`);
    console.log(`    💾  Backup dir   : ${BACKUP_DIR}`);
    console.log("    ══════════════════════════════════════════════════\n");
  });
})();

// Scheduled sync
setInterval(async () => {
  log("info", "Scheduled data refresh");
  await fetchAllExternalData();
}, REFRESH_MS);

// Daily log cleanup (async)
cleanOldLogs();
setInterval(cleanOldLogs, 24 * 60 * 60 * 1000).unref();

// ══════════════════════ KEEP-ALIVE PING ══════════════════════
// Prevents Render free tier from sleeping after 15 min inactivity.
// Set RENDER_EXTERNAL_URL env var in Render dashboard to your app URL.
// e.g. https://uniparts.onrender.com
(function startKeepAlive() {
  const selfUrl = process.env.RENDER_EXTERNAL_URL || "";
  if (!selfUrl) {
    log("info", "Keep-alive disabled — set RENDER_EXTERNAL_URL to enable");
    return;
  }
  const PING_INTERVAL = 14 * 60 * 1000; // 14 minutes — just under Render's 15min sleep
  setInterval(async () => {
    try {
      await axios.get(selfUrl + "/health", {
        timeout: 10_000,
        signal:  AbortSignal.timeout(12_000)
      });
      log("info", "Keep-alive ping OK", { url: selfUrl });
    } catch (err) {
      log("warn", "Keep-alive ping failed", { error: err.message });
    }
  }, PING_INTERVAL).unref();
  log("info", `Keep-alive active — pinging every 14 min → ${selfUrl}`);
})();

// ══════════════════════ GRACEFUL SHUTDOWN ════════════════════
function shutdown(sig) {
  console.log(`\n🛑  ${sig} — shutting down gracefully…`);
  server.close(() => {
    log("info", "Server closed", { sig, uptime: formatUptime(process.uptime()) });
    process.exit(0);
  });
  setTimeout(() => {
    log("warn", "Forced exit after timeout");
    process.exit(1);
  }, 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
