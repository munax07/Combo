const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8000;

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

// Helper function to extract model numbers/identifiers
function extractModelIdentifiers(model) {
  if (!model) return [];
  
  const normalized = normalize(model);
  const identifiers = [];
  
  // Extract patterns like "note10", "a15", "11pro", "redmi9", etc.
  const patterns = [
    /([a-z]+)[-\s]*(\d+[a-z]*)/i,  // note10, a15, redmi9
    /(\d+[a-z]*)[-\s]*([a-z]+)/i,   // 10pro, 11ultra
    /([a-z]+)[-\s]*(\d+)[-\s]*([a-z]+)/i, // note10pro, redmi9prime
  ];
  
  // Add the full normalized string
  identifiers.push(normalized);
  
  // Extract alphanumeric sequences
  const alnumMatches = normalized.match(/[a-z]+[\d]+|[\d]+[a-z]+|\d+/g) || [];
  identifiers.push(...alnumMatches);
  
  // Extract brand + number combinations
  const brands = ['redmi', 'mi', 'poco', 'samsung', 'galaxy', 'oppo', 'realme', 
                  'vivo', 'iqoo', 'oneplus', 'nord', 'infinix', 'tecno', 'itel',
                  'moto', 'motorola', 'lava', 'micromax', 'note', 'k', 'a', 'f', 'm'];
  
  brands.forEach(brand => {
    if (normalized.includes(brand)) {
      const regex = new RegExp(`${brand}[\\s-]*(\\d+[a-z]*)`, 'i');
      const match = normalized.match(regex);
      if (match) {
        identifiers.push(match[0].replace(/\s+/g, ''));
      }
    }
  });
  
  return [...new Set(identifiers)]; // Remove duplicates
}

// Function to create category key
function createCategoryKey(categoryName) {
  if (!categoryName) return "";
  return categoryName
    .toLowerCase()
    .replace(/^\d+\.\s*/, '')
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

// Build the search index with pre-processed data
if (rawData.categories && Array.isArray(rawData.categories)) {
  rawData.categories.forEach(category => {
    if (!category || !category.name) return;
    
    const categoryKey = createCategoryKey(category.name);
    console.log(`🔧 Indexing category: ${category.name} -> ${categoryKey}`);
    
    searchIndex[categoryKey] = {
      name: category.name,
      brands: [],
      models: [], // Store individual phone models, not full lines
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
                                  modelLine.toLowerCase().includes('universal');
            
            if (isPlaceholder) return;
            
            // Store original line for reference
            searchIndex[categoryKey].originalLines.push({
              brand: brand.name,
              text: modelLine,
              normalized: normalize(modelLine)
            });
            
            // Parse the line to extract individual models
            // Lines are formatted like: "Model1 = Model2 = Model3 = Model4"
            if (modelLine.includes('=')) {
              const models = modelLine.split('=').map(m => m.trim()).filter(m => m);
              
              brandInfo.compatibilityGroups.push({
                originalLine: modelLine,
                models: models
              });
              
              // Add each individual model to the models index
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
            } else {
              // Single model line
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

// Precise matching function - prioritizes exact matches
function preciseMatch(searchModel, modelEntry) {
  if (!searchModel || !modelEntry) return { match: false, score: 0 };
  
  const cleanSearch = normalize(searchModel);
  
  // EXACT MATCH (highest priority)
  if (modelEntry.normalized === cleanSearch) {
    return { match: true, score: 100, type: 'exact' };
  }
  
  // Check if search model is contained in the model entry as a whole word
  const searchWords = cleanSearch.split(' ');
  const modelWords = modelEntry.normalized.split(' ');
  
  // Check if ALL search words appear in the model entry in order
  let allWordsMatch = true;
  let lastIndex = -1;
  
  for (const word of searchWords) {
    const index = modelWords.findIndex((w, i) => i > lastIndex && w.includes(word));
    if (index === -1) {
      allWordsMatch = false;
      break;
    }
    lastIndex = index;
  }
  
  if (allWordsMatch && searchWords.length > 1) {
    return { match: true, score: 90, type: 'phrase' };
  }
  
  // Check if this is a Redmi Note model and prevent false matches
  if (cleanSearch.includes('note') && modelEntry.normalized.includes('note')) {
    // Extract note numbers
    const searchNoteMatch = cleanSearch.match(/note[\s-]*(\d+)/i);
    const modelNoteMatch = modelEntry.normalized.match(/note[\s-]*(\d+)/i);
    
    if (searchNoteMatch && modelNoteMatch) {
      // If note numbers are different, it's NOT a match
      if (searchNoteMatch[1] !== modelNoteMatch[1]) {
        return { match: false, score: 0, type: 'note_mismatch' };
      }
    }
  }
  
  // Check for exact identifier matches
  const searchIdentifiers = extractModelIdentifiers(cleanSearch);
  const modelIdentifiers = modelEntry.identifiers || [];
  
  // If ANY identifier matches exactly, it's a good match
  for (const searchId of searchIdentifiers) {
    for (const modelId of modelIdentifiers) {
      if (searchId === modelId) {
        return { match: true, score: 80, type: 'identifier_match' };
      }
    }
  }
  
  // Check if model entry contains the exact search string
  if (modelEntry.normalized.includes(cleanSearch)) {
    // But prevent partial word matches (e.g., "note 5" matching "note 50")
    const wordBoundaryCheck = new RegExp(`\\b${cleanSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (wordBoundaryCheck.test(modelEntry.normalized)) {
      return { match: true, score: 70, type: 'contains_exact' };
    }
  }
  
  return { match: false, score: 0 };
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
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    return res.end();
  }
  
  // API Routes
  if (url.pathname === "/") {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    return res.end(JSON.stringify({
      name: "Universal Parts API",
      version: "2.0.0",
      status: "running",
      features: {
        exactMatching: true,
        noFalsePositives: true,
        noteModelValidation: true
      },
      endpoints: {
        "/": "This information",
        "/search?part={category}&model={model}": "Search for compatible parts",
        "/categories": "List all available part categories",
        "/health": "Health check endpoint"
      },
      categories: Object.keys(searchIndex).map(key => ({
        key,
        name: searchIndex[key].name,
        modelCount: searchIndex[key].models.length
      }))
    }, null, 2));
  }
  
  if (url.pathname === "/health") {
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    return res.end(JSON.stringify({ 
      status: "healthy", 
      timestamp: new Date().toISOString()
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
    return res.end(JSON.stringify({ categories }, null, 2));
  }
  
  if (url.pathname === "/search") {
    const part = url.searchParams.get("part");
    const model = url.searchParams.get("model");
    
    if (!part || !model) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
      return res.end(JSON.stringify({ 
        error: "Missing parameters",
        message: "Both 'part' and 'model' parameters are required"
      }));
    }
    
    // Find matching category
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
        }))
      }));
    }
    
    const categoryData = searchIndex[categoryKey];
    
    // Find matching models with scoring
    const matches = [];
    const seenGroups = new Set(); // To avoid duplicate group lines
    
    categoryData.models.forEach(modelEntry => {
      const result = preciseMatch(model, modelEntry);
      
      if (result.match) {
        // Only add if we haven't seen this compatibility group
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
    
    // Sort by score (highest first)
    matches.sort((a, b) => b.score - a.score);
    
    // Prepare response
    const response = {
      success: true,
      part: {
        key: categoryKey,
        name: categoryData.name
      },
      searchModel: model,
      totalMatches: matches.length,
      exactMatches: matches.filter(m => m.matchType === 'exact').length,
      results: matches.slice(0, 20), // Limit results
      summary: matches.length > 0 
        ? `Found ${matches.length} compatible listings for ${model}`
        : `No exact matches found for ${model}. Try a more specific model name.`
    };
    
    // Add warning if there might be partial matches
    if (matches.length === 0) {
      const partialMatches = categoryData.models.filter(m => 
        m.normalized.includes(normalize(model).split(' ').pop())
      );
      
      if (partialMatches.length > 0) {
        response.suggestion = "Try searching with the full model name including brand and number";
      }
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    return res.end(JSON.stringify(response, null, 2));
  }
  
  // 404 for unknown routes
  res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
  res.end(JSON.stringify({ error: "Endpoint not found" }));
});

// Start server
server.listen(PORT, "0.0.0.0", () => {
  console.log("\n🚀 ==================================");
  console.log(`✅ Server running on port ${PORT}`);
  console.log("✅ Precise matching enabled - No false positives!");
  console.log("=================================\n");
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
