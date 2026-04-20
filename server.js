"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const axios = require("axios");
const cheerio = require("cheerio");

// ==================== CONFIGURATION ====================
const PORT = parseInt(process.env.PORT, 10) || 8000;
const NODE_ENV = process.env.NODE_ENV || "development";
const ADMIN_KEY = process.env.ADMIN_KEY || "munax_peak_2026";

const DATA_SOURCES = {
  master: "https://combosupport.in/wp-content/uploads/appdatanew/data.php",
  updates: "https://combosupport.in/wp-content/uploads/appdatanew/updates.php",
  version: "https://combosupport.in/wp-content/uploads/appdatanew/version.json"
};

const REFRESH_MS = 2 * 60 * 60 * 1000;   // 2 hours
const MAX_RESULTS = 30;
const GZIP_THRESHOLD = 1024;

const RATE_LIMITS = {
  loose: 120,    // categories, health, updates, version
  normal: 40,    // search
  strict: 12,    // GSMArena calls
  admin: 15      // admin endpoints
};
const RL_WINDOW_MS = 60 * 1000; // 1 minute

// ==================== GLOBAL STATE ====================
let searchIndex = {};      // categoryKey -> { name, models[] }
let updatesList = [];
let dataVersion = "—";
let lastSyncTime = null;
let syncCount = 0;
let dashboardHtml = null;

const metrics = {
  started: new Date().toISOString(),
  totalRequests: 0,
  totalErrors: 0,
  totalSearches: 0,
  pathHits: {}
};

// ==================== UTILITIES ====================
function normalizeForSearch(s) {
  if (!s) return "";
  return s.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

function isValidModel(s) {
  if (!s || typeof s !== "string") return false;
  const t = s.trim();
  return t !== "" && t !== "New List" && !t.includes("Coming Soon");
}

function cleanModel(s) {
  return s.replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

function createCategoryKey(name) {
  return name.toLowerCase()
    .replace(/^\d+\.\s*/, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

// ==================== RATE LIMITER ====================
const rateStore = new Map();
function checkRateLimit(ip, tier) {
  const limit = RATE_LIMITS[tier] || RATE_LIMITS.normal;
  const now = Date.now();
  const hits = (rateStore.get(ip) || []).filter(t => now - t < RL_WINDOW_MS);
  hits.push(now);
  rateStore.set(ip, hits);
  if (hits.length > limit) {
    const retryAfter = Math.ceil((hits[0] + RL_WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfter };
  }
  return { allowed: true, remaining: limit - hits.length };
}
setInterval(() => {
  const cutoff = Date.now() - RL_WINDOW_MS;
  for (const [ip, hits] of rateStore) {
    const fresh = hits.filter(t => t > cutoff);
    if (fresh.length) rateStore.set(ip, fresh);
    else rateStore.delete(ip);
  }
}, 5 * 60 * 1000).unref();

// ==================== LOGGING ====================
const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function writeLog(file, entry) {
  fs.appendFile(path.join(LOG_DIR, file), JSON.stringify(entry) + "\n", () => {});
}

function log(level, message, meta = {}) {
  const entry = { ts: new Date().toISOString(), level, message, ...meta };
  writeLog(`access_${entry.ts.slice(0, 10)}.jsonl`, entry);
  if (NODE_ENV !== "production") {
    const icon = { error: "❌", warn: "⚠️", info: "📋" }[level] || "📋";
    console.log(`${icon} ${message}`, Object.keys(meta).length ? meta : "");
  }
}

function logSearch(part, model, resultCount, ip) {
  metrics.totalSearches++;
  writeLog(`search_${new Date().toISOString().slice(0, 10)}.jsonl`, {
    ts: new Date().toISOString(), part, model, resultCount, ip
  });
}

async function getSearchStats() {
  const day = new Date().toISOString().slice(0, 10);
  try {
    const content = await fs.promises.readFile(path.join(LOG_DIR, `search_${day}.jsonl`), "utf8");
    const logs = content.split("\n").filter(Boolean).map(l => JSON.parse(l));
    const byModel = {}, byPart = {};
    logs.forEach(l => {
      byModel[l.model] = (byModel[l.model] || 0) + 1;
      byPart[l.part] = (byPart[l.part] || 0) + 1;
    });
    const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ name: k, count: v }));
    return { date: day, total: logs.length, topModels: top(byModel, 10), topParts: top(byPart, 10), recent: logs.slice(-30).reverse() };
  } catch {
    return { date: day, total: 0, topModels: [], topParts: [], recent: [] };
  }
}

function cleanOldLogs() {
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  try {
    fs.readdirSync(LOG_DIR).forEach(file => {
      const m = file.match(/^(?:access|search)_(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (m && m[1] < cutoff) fs.unlink(path.join(LOG_DIR, file), () => {});
    });
  } catch (err) {}
}

// ==================== INDEX BUILDER ====================
function buildSearchIndex(apiData) {
  const idx = {};
  if (!apiData.categories || !Array.isArray(apiData.categories)) return idx;
  for (const cat of apiData.categories) {
    if (!cat.name) continue;
    const key = createCategoryKey(cat.name);
    idx[key] = { name: cat.name, models: [] };
    for (const brand of (cat.brands || [])) {
      if (!brand.name) continue;
      for (const rawModel of (brand.models || [])) {
        if (!isValidModel(rawModel)) continue;
        const compatibility = cleanModel(rawModel);
        idx[key].models.push({
          brand: brand.name,
          compatibility,
          searchNorm: normalizeForSearch(compatibility)
        });
      }
    }
  }
  return idx;
}

// ==================== SEARCH ENGINE ====================
function searchCategory(categoryKey, query) {
  const cat = searchIndex[categoryKey];
  if (!cat) return null;
  const qNorm = normalizeForSearch(query);
  if (!qNorm) return [];
  const words = qNorm.split(" ").filter(w => w.length > 1);
  const scored = [];
  const seen = new Set();
  for (const model of cat.models) {
    const c = model.searchNorm;
    if (seen.has(c)) continue;
    let score = 0;
    if (c === qNorm) score = 100;
    else if (c.includes(qNorm)) score = 90;
    else if (words.every(w => c.includes(w))) score = 75;
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
  return scored.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS)
    .map(({ brand, compatibility, score }) => ({ brand, compatibility, score }));
}

// ==================== EXTERNAL DATA FETCH ====================
async function fetchAllExternalData() {
  log("info", "🔄 Syncing external data...");
  let masterOk = false;
  try {
    const masterRes = await axios.get(DATA_SOURCES.master, { timeout: 30000 });
    const fresh = buildSearchIndex(masterRes.data);
    if (Object.keys(fresh).length === 0) throw new Error("Empty index");
    searchIndex = fresh;
    masterOk = true;
    lastSyncTime = new Date().toISOString();
    syncCount++;
    const totalModels = Object.values(searchIndex).reduce((s, c) => s + c.models.length, 0);
    log("info", `✅ Master data: ${Object.keys(searchIndex).length} categories, ${totalModels} models`);
  } catch (err) {
    log("error", "❌ Master fetch failed", { error: err.message });
  }
  try {
    const updatesRes = await axios.get(DATA_SOURCES.updates, { timeout: 10000 });
    if (updatesRes.data && Array.isArray(updatesRes.data.updates)) {
      updatesList = updatesRes.data.updates;
      log("info", `✅ Updates: ${updatesList.length} items`);
    }
  } catch (err) {
    log("warn", "⚠️ Updates fetch failed");
  }
  try {
    const versionRes = await axios.get(DATA_SOURCES.version, { timeout: 5000 });
    if (versionRes.data && versionRes.data.version) {
      dataVersion = versionRes.data.version;
      log("info", `✅ Version: ${dataVersion}`);
    }
  } catch (err) {
    log("warn", "⚠️ Version fetch failed");
  }
  if (!masterOk) log("error", "❌ No master data available – search will be empty");
}

// ==================== HTTP HELPERS ====================
function getClientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket?.remoteAddress || "unknown";
}

function formatUptime(sec) {
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, `${s}s`].filter(Boolean).join(" ");
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
const SEC = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "X-XSS-Protection": "1; mode=block"
};

function sendJson(res, req, status, data, startTime) {
  const body = JSON.stringify(data);
  const buf = Buffer.from(body, "utf8");
  const elapsed = startTime ? (Date.now() - startTime).toFixed(0) : "—";
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "X-Response-Time": `${elapsed}ms`,
    ...CORS,
    ...SEC
  };
  metrics.totalRequests++;
  if (status >= 400) metrics.totalErrors++;
  const acceptEncoding = req.headers["accept-encoding"] || "";
  if (buf.length >= GZIP_THRESHOLD && acceptEncoding.includes("gzip")) {
    zlib.gzip(buf, (err, compressed) => {
      if (err) {
        res.writeHead(status, { ...headers, "Content-Length": buf.length });
        return res.end(buf);
      }
      res.writeHead(status, { ...headers, "Content-Encoding": "gzip", "Content-Length": compressed.length });
      res.end(compressed);
    });
  } else {
    res.writeHead(status, { ...headers, "Content-Length": buf.length });
    res.end(buf);
  }
}

// ==================== HTTP SERVER ====================
const server = http.createServer(async (req, res) => {
  const start = Date.now();
  const ip = getClientIp(req);
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch {
    res.writeHead(400);
    return res.end("Bad request");
  }
  const pathname = url.pathname;
  metrics.pathHits[pathname] = (metrics.pathHits[pathname] || 0) + 1;

  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (req.method !== "GET") {
    return sendJson(res, req, 405, { error: "Method not allowed" }, start);
  }

  // ---- Dashboard ----
  if (pathname === "/" || pathname === "/dashboard") {
    const rl = checkRateLimit(ip, "loose");
    if (!rl.allowed) {
      res.setHeader("Retry-After", String(rl.retryAfter));
      return sendJson(res, req, 429, { error: "Too many requests", retryAfter: `${rl.retryAfter}s` }, start);
    }
    if (dashboardHtml) {
      res.writeHead(200, { "Content-Type": "text/html", ...SEC });
      return res.end(dashboardHtml);
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end("<!DOCTYPE html><html><body><h1>UNIPARTS PRO</h1><p>Starting up...</p></body></html>");
  }

  // ---- Health ----
  if (pathname === "/health") {
    const rl = checkRateLimit(ip, "loose");
    if (!rl.allowed) return sendJson(res, req, 429, { error: "Rate limit" }, start);
    const mem = process.memoryUsage();
    const totalModels = Object.values(searchIndex).reduce((s, c) => s + c.models.length, 0);
    return sendJson(res, req, 200, {
      status: "operational",
      uptime: formatUptime(process.uptime()),
      startedAt: metrics.started,
      environment: NODE_ENV,
      node: process.version,
      memory: {
        rss: formatBytes(mem.rss),
        heapUsed: formatBytes(mem.heapUsed),
        heapTotal: formatBytes(mem.heapTotal)
      },
      data: {
        categories: Object.keys(searchIndex).length,
        models: totalModels,
        version: dataVersion,
        lastSync: lastSyncTime,
        syncCount
      },
      metrics: {
        requests: metrics.totalRequests,
        errors: metrics.totalErrors,
        searches: metrics.totalSearches
      }
    }, start);
  }

  // ---- Categories ----
  if (pathname === "/categories") {
    const rl = checkRateLimit(ip, "loose");
    if (!rl.allowed) return sendJson(res, req, 429, { error: "Rate limit" }, start);
    const cats = Object.keys(searchIndex).map(key => ({
      key,
      name: searchIndex[key].name,
      modelCount: searchIndex[key].models.length
    }));
    return sendJson(res, req, 200, { success: true, total: cats.length, categories: cats }, start);
  }

  // ---- Search ----
  if (pathname === "/search") {
    const rl = checkRateLimit(ip, "normal");
    if (!rl.allowed) return sendJson(res, req, 429, { error: "Rate limit" }, start);
    let part = (url.searchParams.get("part") || "").trim().slice(0, 80);
    let model = (url.searchParams.get("model") || "").trim().slice(0, 100);
    if (!part || !model) {
      return sendJson(res, req, 400, { error: "Missing 'part' or 'model' parameters" }, start);
    }
    let categoryKey = null;
    if (searchIndex[part]) {
      categoryKey = part;
    } else {
      const cleanPart = part.toLowerCase().replace(/[^a-z0-9]/g, "");
      categoryKey = Object.keys(searchIndex).find(k => k.replace(/[^a-z0-9]/g, "") === cleanPart)
        || Object.keys(searchIndex).find(k => searchIndex[k].name.toLowerCase().includes(part.toLowerCase()));
    }
    if (!categoryKey) {
      return sendJson(res, req, 404, {
        error: "Category not found",
        available: Object.keys(searchIndex).map(k => ({ key: k, name: searchIndex[k].name }))
      }, start);
    }
    const results = searchCategory(categoryKey, model);
    logSearch(part, model, results ? results.length : 0, ip);
    return sendJson(res, req, 200, {
      success: true,
      category: { key: categoryKey, name: searchIndex[categoryKey].name },
      query: model,
      totalMatches: results ? results.length : 0,
      results: results || []
    }, start);
  }

  // ---- Updates ----
  if (pathname === "/updates") {
    const rl = checkRateLimit(ip, "loose");
    if (!rl.allowed) return sendJson(res, req, 429, { error: "Rate limit" }, start);
    return sendJson(res, req, 200, { success: true, updates: updatesList }, start);
  }

  // ---- Version ----
  if (pathname === "/version") {
    const rl = checkRateLimit(ip, "loose");
    if (!rl.allowed) return sendJson(res, req, 429, { error: "Rate limit" }, start);
    return sendJson(res, req, 200, { success: true, version: dataVersion, lastSync: lastSyncTime }, start);
  }

  // ---- GSMArena Search ----
  if (pathname === "/specs-search") {
    const rl = checkRateLimit(ip, "strict");
    if (!rl.allowed) return sendJson(res, req, 429, { error: "Rate limit" }, start);
    const query = (url.searchParams.get("q") || "").trim().slice(0, 80);
    if (!query) return sendJson(res, req, 400, { error: "Missing query" }, start);
    try {
      const gsmRes = await axios.get(`https://www.gsmarena.com/results.php3?sQuickSearch=yes&sName=${encodeURIComponent(query)}`, {
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 10000
      });
      const $ = cheerio.load(gsmRes.data);
      const results = [];
      $(".makers li").each((_, el) => {
        const a = $(el).find("a");
        const href = a.attr("href");
        const title = a.find("img").attr("title") || a.text().trim();
        const img = a.find("img").attr("src");
        if (href && title) results.push({ id: href, title, img });
      });
      return sendJson(res, req, 200, { success: true, results }, start);
    } catch (err) {
      return sendJson(res, req, 502, { error: "GSMArena temporarily unavailable" }, start);
    }
  }

  // ---- GSMArena Details ----
  if (pathname === "/specs-details") {
    const rl = checkRateLimit(ip, "strict");
    if (!rl.allowed) return sendJson(res, req, 429, { error: "Rate limit" }, start);
    const id = (url.searchParams.get("id") || "").trim().slice(0, 120);
    if (!id || /[<>"'\\]/.test(id) || id.includes("..") || id.includes("//")) {
      return sendJson(res, req, 400, { error: "Invalid id" }, start);
    }
    try {
      const detailRes = await axios.get(`https://www.gsmarena.com/${id}`, {
        headers: { "User-Agent": "Mozilla/5.0" },
        timeout: 10000
      });
      const $ = cheerio.load(detailRes.data);
      const name = $(".specs-phone-name-title").text().trim();
      const img = $(".specs-photo-main img").attr("src");
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
      return sendJson(res, req, 200, { success: true, name, img, specs }, start);
    } catch (err) {
      return sendJson(res, req, 502, { error: "GSMArena temporarily unavailable" }, start);
    }
  }

  // ---- Admin Stats ----
  if (pathname === "/admin/stats") {
    const rl = checkRateLimit(ip, "admin");
    if (!rl.allowed) return sendJson(res, req, 429, { error: "Rate limit" }, start);
    const key = url.searchParams.get("key");
    if (key !== ADMIN_KEY) {
      log("warn", "Admin auth fail", { ip });
      return sendJson(res, req, 403, { error: "Forbidden" }, start);
    }
    const stats = await getSearchStats();
    return sendJson(res, req, 200, { ...stats, serverMetrics: metrics }, start);
  }

  // ---- Admin Refresh ----
  if (pathname === "/admin/refresh") {
    const rl = checkRateLimit(ip, "admin");
    if (!rl.allowed) return sendJson(res, req, 429, { error: "Rate limit" }, start);
    const key = url.searchParams.get("key");
    if (key !== ADMIN_KEY) return sendJson(res, req, 403, { error: "Forbidden" }, start);
    log("info", "Manual refresh triggered", { ip });
    fetchAllExternalData().catch(err => log("error", "Refresh error", { error: err.message }));
    return sendJson(res, req, 200, { success: true, message: "Refresh started" }, start);
  }

  // ---- 404 ----
  return sendJson(res, req, 404, { error: "Endpoint not found" }, start);
});

server.timeout = 30000;
server.headersTimeout = 35000;

// ==================== STARTUP ====================
process.on("uncaughtException", err => log("error", "Uncaught exception", { message: err.message, stack: err.stack }));
process.on("unhandledRejection", reason => log("error", "Unhandled rejection", { reason: String(reason) }));

const DASH_PATH = path.join(__dirname, "dashboard.html");
try {
  if (fs.existsSync(DASH_PATH)) {
    dashboardHtml = fs.readFileSync(DASH_PATH, "utf8");
    log("info", "✅ Dashboard HTML loaded");
  } else {
    log("warn", "⚠️ dashboard.html not found – using fallback");
  }
} catch (err) {
  log("warn", "⚠️ Could not read dashboard.html", { error: err.message });
}

(async () => {
  await fetchAllExternalData();
  server.listen(PORT, "0.0.0.0", () => {
    const totalModels = Object.values(searchIndex).reduce((s, c) => s + c.models.length, 0);
    console.log("\n🚀 ════════════════════════════════════════════════");
    console.log("   UNIPARTS PRO  ·  ULTRA PRO MAX FINAL BOSS");
    console.log(`   🌐 Port          : ${PORT}`);
    console.log(`   🌍 Environment   : ${NODE_ENV}`);
    console.log(`   📦 Categories    : ${Object.keys(searchIndex).length}`);
    console.log(`   📱 Models        : ${totalModels.toLocaleString()}`);
    console.log(`   🔄 Auto-refresh  : every ${REFRESH_MS / 3600000} hours`);
    console.log(`   🔐 Admin key     : set via ADMIN_KEY env var`);
    console.log("   ════════════════════════════════════════════════\n");
  });
})();

setInterval(async () => {
  log("info", "🔄 Scheduled data refresh");
  await fetchAllExternalData();
}, REFRESH_MS);

cleanOldLogs();
setInterval(cleanOldLogs, 24 * 60 * 60 * 1000).unref();

function shutdown(sig) {
  console.log(`\n🛑 ${sig} – shutting down gracefully…`);
  server.close(() => {
    log("info", "Server closed", { sig, uptime: formatUptime(process.uptime()) });
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
