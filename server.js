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
    console.log("Please ensure data.json is in the same directory as server.js");
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
    .replace(/[^\w\s]/g, ' ')  // Replace special chars with space
    .replace(/\s+/g, ' ')       // Collapse multiple spaces
    .trim();
}

// Helper function to create URL-friendly keys from category names
function createCategoryKey(categoryName) {
  if (!categoryName) return "";
  return categoryName
    .toLowerCase()
    .replace(/^\d+\.\s*/, '')           // Remove numbering like "1. "
    .replace(/[^a-z0-9]/g, '_')          // Replace special chars with underscore
    .replace(/_+/g, '_')                 // Collapse multiple underscores
    .replace(/^_|_$/g, '');              // Remove leading/trailing underscores
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
      allLines: []
    };

    if (category.brands && Array.isArray(category.brands)) {
      category.brands.forEach(brand => {
        if (!brand || !brand.name) return;
        
        const brandInfo = {
          name: brand.name,
          models: []
        };

        if (brand.models && Array.isArray(brand.models)) {
          brand.models.forEach(modelLine => {
            if (!modelLine) return;
            
            // Skip placeholder entries but keep them for reference
            const isPlaceholder = modelLine.toLowerCase().includes('coming soon') || 
                                  modelLine.toLowerCase().includes('new list');
            
            brandInfo.models.push({
              original: modelLine,
              normalized: normalize(modelLine),
              isPlaceholder
            });
            
            searchIndex[categoryKey].allLines.push({
              brand: brand.name,
              text: modelLine,
              normalized: normalize(modelLine),
              isPlaceholder
            });
          });
        }
        
        searchIndex[categoryKey].brands.push(brandInfo);
      });
    }
    
    console.log(`   📝 Indexed ${searchIndex[categoryKey].allLines.length} model lines`);
  });
}

// Advanced matching function
function smartMatch(searchModel, line) {
  if (!searchModel || !line) return false;
  
  const cleanSearch = normalize(searchModel);
  const cleanLine = normalize(line);
  
  if (cleanLine.includes(cleanSearch)) return true;
  
  // Split the line by common separators
  const separators = ['=', ',', ';', '\\+', '\\|', '/'];
  const separatorRegex = new RegExp(`[${separators.join('')}]`);
  
  if (separatorRegex.test(line)) {
    const parts = line.split(separatorRegex).map(p => normalize(p));
    return parts.some(part => 
      part.includes(cleanSearch) || 
      cleanSearch.includes(part) ||
      levenshteinSimilarity(part, cleanSearch) > 0.8
    );
  }
  
  // Extract model numbers (like "A15", "Note 10", etc.)
  const modelNumbers = cleanSearch.match(/[a-z]+[\d]+|[\d]+[a-z]+|\d+/g) || [];
  const lineNumbers = cleanLine.match(/[a-z]+[\d]+|[\d]+[a-z]+|\d+/g) || [];
  
  return modelNumbers.some(num => 
    lineNumbers.some(lineNum => lineNum.includes(num) || num.includes(lineNum))
  );
}

// Levenshtein similarity for fuzzy matching
function levenshteinSimilarity(a, b) {
  if (a.length === 0) return b.length === 0 ? 1 : 0;
  if (b.length === 0) return 0;
  
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i-1) === a.charAt(j-1)) {
        matrix[i][j] = matrix[i-1][j-1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i-1][j-1] + 1,
          matrix[i][j-1] + 1,
          matrix[i-1][j] + 1
        );
      }
    }
  }
  
  const maxLen = Math.max(a.length, b.length);
  return 1 - matrix[b.length][a.length] / maxLen;
}

// CORS headers for browser access
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
    // Home route with API info
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    return res.end(JSON.stringify({
      name: "Universal Parts API",
      version: "1.0.0",
      status: "running",
      endpoints: {
        "/": "This information",
        "/search?part={category}&model={model}": "Search for compatible parts",
        "/categories": "List all available part categories",
        "/health": "Health check endpoint"
      },
      categories: Object.keys(searchIndex).map(key => ({
        key,
        name: searchIndex[key].name,
        brands: searchIndex[key].brands.map(b => b.name)
      }))
    }, null, 2));
  }
  
  if (url.pathname === "/health") {
    // Health check endpoint for Koyeb
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    return res.end(JSON.stringify({ 
      status: "healthy", 
      timestamp: new Date().toISOString(),
      dataLoaded: Object.keys(searchIndex).length > 0
    }));
  }
  
  if (url.pathname === "/categories") {
    // List all available categories
    const categories = Object.keys(searchIndex).map(key => ({
      key,
      name: searchIndex[key].name,
      brands: searchIndex[key].brands.map(b => b.name),
      totalModels: searchIndex[key].allLines.filter(l => !l.isPlaceholder).length
    }));
    
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    return res.end(JSON.stringify({ categories }, null, 2));
  }
  
  if (url.pathname === "/search") {
    // Search endpoint
    const part = url.searchParams.get("part");
    const model = url.searchParams.get("model");
    
    // Validate parameters
    if (!part) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
      return res.end(JSON.stringify({ 
        error: "Missing 'part' parameter",
        message: "Please specify a part category"
      }));
    }
    
    if (!model) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders });
      return res.end(JSON.stringify({ 
        error: "Missing 'model' parameter",
        message: "Please specify a phone model"
      }));
    }
    
    // Find matching category (case-insensitive)
    const categoryKey = Object.keys(searchIndex).find(key => 
      key.includes(part.toLowerCase()) || 
      part.toLowerCase().includes(key)
    ) || part;
    
    const categoryData = searchIndex[categoryKey];
    
    if (!categoryData) {
      // Try to find by partial match
      const possibleCategories = Object.keys(searchIndex).filter(key => 
        key.includes(part.toLowerCase().replace(/[^a-z0-9]/g, '_')) ||
        searchIndex[key].name.toLowerCase().includes(part.toLowerCase())
      );
      
      if (possibleCategories.length > 0) {
        res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
        return res.end(JSON.stringify({
          error: "Category not found",
          message: `Did you mean one of these?`,
          suggestions: possibleCategories.map(key => ({
            key,
            name: searchIndex[key].name
          }))
        }));
      }
      
      res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
      return res.end(JSON.stringify({ 
        error: "Invalid part category",
        message: `Category '${part}' not found. Use /categories to see available categories.`,
        availableCategories: Object.keys(searchIndex).map(key => ({
          key,
          name: searchIndex[key].name
        }))
      }));
    }
    
    // Search for matching models
    const results = categoryData.allLines.filter(item => 
      !item.isPlaceholder && smartMatch(model, item.text)
    );
    
    // Format results
    const formattedResults = results.map(r => ({
      brand: r.brand,
      compatibility: r.text,
      matchScore: levenshteinSimilarity(normalize(model), r.normalized)
    })).sort((a, b) => b.matchScore - a.matchScore);
    
    // Group results by brand
    const byBrand = {};
    formattedResults.forEach(r => {
      if (!byBrand[r.brand]) byBrand[r.brand] = [];
      byBrand[r.brand].push(r.compatibility);
    });
    
    res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders });
    return res.end(JSON.stringify({
      success: true,
      part: {
        key: categoryKey,
        name: categoryData.name
      },
      searchModel: model,
      totalMatches: formattedResults.length,
      results: formattedResults.slice(0, 50), // Limit to 50 results
      groupedByBrand: byBrand,
      summary: formattedResults.length > 0 
        ? `Found ${formattedResults.length} compatible listings for ${model} in ${categoryData.name}`
        : `No exact matches found for ${model} in ${categoryData.name}. Try a different model or check the full list.`
    }, null, 2));
  }
  
  // 404 for unknown routes
  res.writeHead(404, { 'Content-Type': 'application/json', ...corsHeaders });
  res.end(JSON.stringify({ 
    error: "Not found",
    message: "The requested endpoint does not exist",
    availableEndpoints: ["/", "/health", "/categories", "/search?part={category}&model={model}"]
  }));
});

// Start server
server.listen(PORT, "0.0.0.0", () => {
  console.log("\n🚀 ==================================");
  console.log(`✅ Server is running on port ${PORT}`);
  console.log(`🌍 http://localhost:${PORT}`);
  console.log("\n📚 Available endpoints:");
  console.log(`   • GET /`);
  console.log(`   • GET /health`);
  console.log(`   • GET /categories`);
  console.log(`   • GET /search?part={category}&model={model}`);
  console.log("\n📊 Indexed categories:");
  Object.keys(searchIndex).forEach(key => {
    console.log(`   • ${key}: ${searchIndex[key].name} (${searchIndex[key].allLines.filter(l => !l.isPlaceholder).length} models)`);
  });
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
