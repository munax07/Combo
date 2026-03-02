const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8000;
const SECRET_KEY = "munax_admin_2026"; // 🔐 Change this!

// Load and parse the JSON data
let rawData = { categories: [] };
const dataPath = path.join(__dirname, "data.json");

try {
  if (fs.existsSync(dataPath)) {
    const fileContent = fs.readFileSync(dataPath, "utf8");
    rawData = JSON.parse(fileContent);
    console.log(`✅ Successfully loaded data.json`);
    console.log(`📊 Found ${rawData.categories?.length || 0} categories`);
  } else {
    console.error("❌ data.json file not found!");
  }
} catch (err) {
  console.error("❌ Failed to parse data.json:", err.message);
}

// Create a comprehensive search index
const searchIndex = {};

// Helper function to normalize text for searching
function normalize(text) {
  if (!text) return "";
  return text.toString().toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Helper function to create URL-friendly keys from category names
function createCategoryKey(categoryName) {
  if (!categoryName) return "";
  return categoryName
    .toLowerCase()
    .replace(/^\d+\.\s*/, '')
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

// Build the search index
if (rawData.categories && Array.isArray(rawData.categories)) {
  rawData.categories.forEach(category => {
    if (!category || !category.name) return;
    
    const categoryKey = createCategoryKey(category.name);
    console.log(`🔧 Indexing category: ${category.name} -> ${categoryKey}`);
    
    searchIndex[categoryKey] = {
      name: category.name,
      brands: [],
      models: [], // Store individual phone models
      originalLines: []
    };

    if (category.brands && Array.isArray(category.brands)) {
      category.brands.forEach(brand => {
        if (!brand || !brand.name) return;
        
        const brandInfo = {
          name: brand.name,
          compatibilityGroups: []
        };

        if (brand.models && Array.isArray(brand.models)) {
          brand.models.forEach(modelLine => {
            if (!modelLine) return;
            
            // Skip placeholder entries
            const isPlaceholder = modelLine.toLowerCase().includes('coming soon') || 
                                  modelLine.toLowerCase().includes('new list') ||
                                  modelLine.toLowerCase().includes('universal') ||
                                  modelLine === '' ||
                                  modelLine === ' ';
            
            if (isPlaceholder) return;
            
            // Store original line for reference
            searchIndex[categoryKey].originalLines.push({
              brand: brand.name,
              text: modelLine,
              normalized: normalize(modelLine)
            });
            
            // Parse the line to extract individual models
            if (modelLine.includes('=')) {
              let processedLine = modelLine;
              const listNumberMatch = processedLine.match(/^\d+\.\s*(.+)/);
              if (listNumberMatch) {
                processedLine = listNumberMatch[1];
              }
              
              const models = processedLine.split('=').map(m => {
                let model = m.trim();
                const numMatch = model.match(/^\d+\.\s*(.+)/);
                if (numMatch) {
                  model = numMatch[1];
                }
                return model;
              }).filter(m => m && !m.toLowerCase().includes('coming') && !m.toLowerCase().includes('new list'));
              
              if (models.length > 0) {
                brandInfo.compatibilityGroups.push({
                  originalLine: modelLine,
                  models: models
                });
                
                models.forEach(modelName => {
                  if (modelName && !modelName.toLowerCase().includes('coming')) {
                    const normalizedModel = normalize(modelName);
                    searchIndex[categoryKey].models.push({
                      brand: brand.name,
                      original: modelName,
                      normalized: normalizedModel,
                      groupLine: modelLine,
                      identifiers: extractModelIdentifiers(normalizedModel)
                    });
                  }
                });
              }
            } else {
              const modelName = modelLine.trim();
              if (modelName && !modelName.toLowerCase().includes('coming')) {
                const normalizedModel = normalize(modelName);
                searchIndex[categoryKey].models.push({
                  brand: brand.name,
                  original: modelName,
                  normalized: normalizedModel,
                  groupLine: modelName,
                  identifiers: extractModelIdentifiers(normalizedModel)
                });
              }
            }
          });
        }
        
        if (brandInfo.compatibilityGroups.length > 0) {
          searchIndex[categoryKey].brands.push(brandInfo);
        }
      });
    }
    
    console.log(`   📝 Indexed ${searchIndex[categoryKey].models.length} individual models`);
  });
}

// Helper function to extract model identifiers
function extractModelIdentifiers(model) {
  if (!model) return [];
  
  const identifiers = [];
  
  const brandPatterns = [
    /(redmi|mi|poco)\s*(note)?\s*(\d+[a-z]*)/i,
    /(samsung|galaxy)\s*([a-z]\d+)/i,
    /(oppo|realme|oneplus)\s*([a-z]+\d+)/i,
    /(vivo|iqoo)\s*([a-z]+\d+)/i,
    /(infinix|tecno|itel)\s*([a-z]+\d+)/i,
    /(moto|motorola|lava)\s*([a-z]+\d+)/i
  ];
  
  brandPatterns.forEach(pattern => {
    const match = model.match(pattern);
    if (match) {
      identifiers.push(match[0].replace(/\s+/g, '').toLowerCase());
    }
  });
  
  const numberMatches = model.match(/[a-z]+\d+[a-z]*|\d+[a-z]+/g) || [];
  numberMatches.forEach(m => identifiers.push(m.toLowerCase()));
  
  return [...new Set(identifiers)];
}

// Precise matching function
function preciseMatch(searchModel, modelEntry) {
  if (!searchModel || !modelEntry) return { match: false, score: 0 };
  
  const cleanSearch = normalize(searchModel);
  const cleanLine = modelEntry.normalized;
  const models = cleanLine.split('=').map(m => m.trim()).filter(m => m);
  
  for (const model of models) {
    const cleanModel = normalize(model);
    
    if (cleanModel === cleanSearch) {
      return { match: true, score: 100, type: 'exact' };
    }
    
    const searchWithoutSpaces = cleanSearch.replace(/\s+/g, '');
    const modelWithoutSpaces = cleanModel.replace(/\s+/g, '');
    
    if (modelWithoutSpaces === searchWithoutSpaces) {
      return { match: true, score: 95, type: 'exact_normalized' };
    }
    
    // Redmi Note matching logic
    if (cleanSearch.includes('note') && cleanModel.includes('note')) {
      const searchNoteMatch = cleanSearch.match(/note[\s-]*(\d+)(?:\s*(pro|plus|max|ultra|lite|se|prime|pro\+|pro plus|pro max))?/i);
      const modelNoteMatch = cleanModel.match(/note[\s-]*(\d+)(?:\s*(pro|plus|max|ultra|lite|se|prime|pro\+|pro plus|pro max))?/i);
      
      if (searchNoteMatch && modelNoteMatch) {
        if (searchNoteMatch[1] !== modelNoteMatch[1]) continue;
        
        if (searchNoteMatch[2] && modelNoteMatch[2]) {
          const searchVariant = searchNoteMatch[2].replace(/\s+/g, '').toLowerCase();
          const modelVariant = modelNoteMatch[2].replace(/\s+/g, '').toLowerCase();
          
          const variantMap = {
            'pro': ['pro'],
            'proplus': ['proplus', 'proplus', 'pro+'],
            'promax': ['promax', 'promax'],
            'ultra': ['ultra'],
            'lite': ['lite'],
            'se': ['se'],
            'prime': ['prime']
          };
          
          let variantMatch = false;
          for (const [key, values] of Object.entries(variantMap)) {
            if (values.includes(searchVariant) && values.includes(modelVariant)) {
              variantMatch = true;
              break;
            }
          }
          
          if (variantMatch) return { match: true, score: 90, type: 'note_exact_variant' };
        } else if (searchNoteMatch[2] && !modelNoteMatch[2]) {
          continue;
        } else if (!searchNoteMatch[2] && modelNoteMatch[2]) {
          continue;
        }
        
        return { match: true, score: 85, type: 'note_series' };
      }
    }
    
    // Samsung models
    if (cleanSearch.match(/[a-z]\d+/i)) {
      const searchModelNum = cleanSearch.match(/[a-z]\d+/i)?.[0];
      const modelNumMatch = cleanModel.match(/[a-z]\d+/i)?.[0];
      
      if (searchModelNum && modelNumMatch && searchModelNum !== modelNumMatch) continue;
    }
    
    const listItemMatch = model.match(/^\d+\.\s*(.+)/);
    if (listItemMatch) {
      const listItemModel = normalize(listItemMatch[1]);
      if (listItemModel === cleanSearch || listItemModel.replace(/\s+/g, '') === searchWithoutSpaces) {
        return { match: true, score: 90, type: 'list_item' };
      }
    }
    
    const searchIdentifiers = extractModelIdentifiers(cleanSearch);
    const modelIdentifiers = extractModelIdentifiers(cleanModel);
    
    for (const searchId of searchIdentifiers) {
      for (const modelId of modelIdentifiers) {
        if (searchId === modelId) {
          if (cleanModel.includes(cleanSearch) || cleanSearch.includes(cleanModel)) {
            return { match: true, score: 80, type: 'identifier_match' };
          }
        }
      }
    }
  }
  
  return { match: false, score: 0 };
}

// ========== DAILY LOGGING SYSTEM ==========
const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

function logSearch(part, model, resultCount, ip, userAgent) {
  const today = new Date().toISOString().split('T')[0];
  const todayLogFile = path.join(LOG_DIR, `logs_${today}.jsonl`);
  
  const entry = {
    timestamp: new Date().toISOString(),
    part,
    model,
    resultCount,
    ip: ip || "unknown",
    userAgent: userAgent || "unknown"
  };
  
  fs.appendFile(todayLogFile, JSON.stringify(entry) + "\n", (err) => {
    if (err) console.error("Failed to write log:", err);
  });
  
  // Auto-delete yesterday's log
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const yesterdayLogFile = path.join(LOG_DIR, `logs_${yesterday}.jsonl`);
  if (fs.existsSync(yesterdayLogFile)) {
    fs.unlink(yesterdayLogFile, (err) => {
      if (err) console.error("Failed to delete yesterday's log:", err);
    });
  }
}

function getStats() {
  const today = new Date().toISOString().split('T')[0];
  const todayLogFile = path.join(LOG_DIR, `logs_${today}.jsonl`);
  
  if (!fs.existsSync(todayLogFile)) {
    return { total: 0, byModel: {}, byPart: {}, recent: [] };
  }
  
  const logs = fs.readFileSync(todayLogFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
  
  const stats = {
    total: logs.length,
    byModel: {},
    byPart: {},
    recent: logs.slice(-50).reverse()
  };
  
  logs.forEach(log => {
    stats.byModel[log.model] = (stats.byModel[log.model] || 0) + 1;
    stats.byPart[log.part] = (stats.byPart[log.part] || 0) + 1;
  });
  
  return stats;
}

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Create HTTP server
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    return res.end();
  }

  // Secret stats endpoint
  if (url.pathname === "/admin/stats") {
    const key = url.searchParams.get("key");
    if (key !== SECRET_KEY) {
      res.writeHead(403, { "Content-Type": "application/json", ...corsHeaders });
      return res.end(JSON.stringify({ error: "Forbidden" }));
    }
    try {
      const stats = getStats();
      res.writeHead(200, { "Content-Type": "application/json", ...corsHeaders });
      return res.end(JSON.stringify(stats, null, 2));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json", ...corsHeaders });
      return res.end(JSON.stringify({ error: "Internal error" }));
    }
  }
  
  // Dashboard route
  if (url.pathname === "/" || url.pathname === "/dashboard") {
    const dashboardPath = path.join(__dirname, 'dashboard.html');
    if (fs.existsSync(dashboardPath)) {
      try {
        const dashboardHtml = fs.readFileSync(dashboardPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(dashboardHtml);
      } catch (err) {
        console.error("Error reading dashboard.html:", err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('Dashboard file error');
      }
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`
        <!DOCTYPE html>
        <html>
          <head><title>Universal Parts API</title></head>
          <body style="font-family: sans-serif; padding: 40px; text-align: center;">
            <h1>🔧 Universal Parts API</h1>
            <p>API is running. Dashboard file not found.</p>
            <p>Please create <code>dashboard.html</code> in the same directory.</p>
            <hr>
            <p><a href="/categories">View Categories (JSON)</a> | <a href="/health">Health Check</a></p>
            <p style="margin-top: 40px; color: #666;">Created by Munax</p>
          </body>
        </html>
      `);
    }
  }
  
  // API Routes
  if (url.pathname === "/api" || url.pathname === "/api/") {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    return res.end(JSON.stringify({
      name: "Universal Parts API",
      version: "3.0.0",
      status: "running",
      watermark: "Created by Munax",
      features: {
        exactMatching: true,
        noteValidation: true,
        variantAware: true,
        brandSeparation: true
      },
      endpoints: {
        "/": "Technician Dashboard (HTML)",
        "/api": "This API information",
        "/search?part={category}&model={model}": "Search for compatible parts",
        "/categories": "List all available part categories",
        "/health": "Health check endpoint"
      }
    }, null, 2));
  }
  
  if (url.pathname === "/health") {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    return res.end(JSON.stringify({ 
      status: "healthy", 
      timestamp: new Date().toISOString(),
      watermark: "Created by Munax"
    }));
  }
  
  if (url.pathname === "/categories") {
    const categories = Object.keys(searchIndex).map(key => ({
      key,
      name: searchIndex[key].name,
      brands: searchIndex[key].brands.map(b => b.name),
      modelCount: searchIndex[key].models.length
    }));
    
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    return res.end(JSON.stringify({ 
      categories,
      watermark: "Created by Munax"
    }, null, 2));
  }
  
  if (url.pathname === "/search") {
    const part = url.searchParams.get("part");
    const model = url.searchParams.get("model");
    
    if (!part || !model) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
      return res.end(JSON.stringify({ 
        error: "Missing parameters",
        message: "Both 'part' and 'model' parameters are required",
        watermark: "Created by Munax"
      }));
    }
    
    const categoryKey = Object.keys(searchIndex).find(key => 
      key.includes(part.toLowerCase().replace(/[^a-z0-9]/g, '_')) ||
      searchIndex[key]?.name.toLowerCase().includes(part.toLowerCase())
    );
    
    if (!categoryKey || !searchIndex[categoryKey]) {
      res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
      return res.end(JSON.stringify({ 
        error: "Category not found",
        availableCategories: Object.keys(searchIndex).map(key => ({
          key,
          name: searchIndex[key].name
        })),
        watermark: "Created by Munax"
      }));
    }
    
    const categoryData = searchIndex[categoryKey];
    const matches = [];
    const seenGroups = new Set();
    
    categoryData.models.forEach(modelEntry => {
      const result = preciseMatch(model, modelEntry);
      
      if (result.match) {
        if (!seenGroups.has(modelEntry.groupLine)) {
          seenGroups.add(modelEntry.groupLine);
          
          matches.push({
            brand: modelEntry.brand,
            compatibility: modelEntry.groupLine,
            matchType: result.type,
            score: result.score,
            matchedModel: modelEntry.original
          });
        }
      }
    });
    
    matches.sort((a, b) => b.score - a.score);
    
    const response = {
      success: true,
      part: {
        key: categoryKey,
        name: categoryData.name
      },
      searchModel: model,
      totalMatches: matches.length,
      exactMatches: matches.filter(m => m.score >= 95).length,
      results: matches.slice(0, 20),
      summary: matches.length > 0 
        ? `Found ${matches.length} compatible listings for ${model}`
        : `No exact matches found for ${model}. Try a more specific model name.`,
      watermark: "Created by Munax"
    };

    // Log this search
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const ua = req.headers['user-agent'];
    logSearch(part, model, matches.length, ip, ua);
    
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    return res.end(JSON.stringify(response, null, 2));
  }
  
  res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
  res.end(JSON.stringify({ 
    error: "Endpoint not found",
    watermark: "Created by Munax"
  }));
});

// Start server
server.listen(PORT, "0.0.0.0", () => {
  console.log("\n🚀 ==================================");
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🔐 Stats endpoint: /admin/stats?key=${SECRET_KEY}`);
  console.log(`📁 Logs stored in: /logs/ folder (auto-clears daily)`);
  console.log("✅ Precise matching enabled - No false positives!");
  console.log(`✅ Indexed ${Object.keys(searchIndex).length} categories`);
  
  let totalModels = 0;
  Object.keys(searchIndex).forEach(key => {
    totalModels += searchIndex[key].models.length;
  });
  console.log(`✅ Total models indexed: ${totalModels}`);
  console.log("=================================\n");
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
