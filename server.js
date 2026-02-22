const http = require("http");
const fs = require("fs");

const PORT = process.env.PORT || 3000;

const data = JSON.parse(fs.readFileSync("./data.json", "utf8"));

// Normalize text
function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

// Build fast index
const index = {};

data.categories.forEach(category => {
  index[category.key] = [];

  category.brands.forEach(brand => {
    brand.models.forEach(line => {
      index[category.key].push(line);
    });
  });
});

function smartMatch(model, line) {
  const cleanModel = normalize(model);
  const cleanLine = normalize(line);

  if (cleanLine.includes(cleanModel)) return true;

  const partial = cleanModel.slice(0, Math.floor(cleanModel.length * 0.7));
  return cleanLine.includes(partial);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/search") {
    const part = url.searchParams.get("part");
    const model = url.searchParams.get("model");

    if (!part || !model) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "part and model required" }));
    }

    const categoryData = index[part];

    if (!categoryData) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Invalid part category" }));
    }

    const results = categoryData.filter(line =>
      smartMatch(model, line)
    );

    res.writeHead(200, { "Content-Type": "application/json" });

    if (results.length === 0) {
      return res.end(JSON.stringify({ message: "No universal match found" }));
    }

    return res.end(JSON.stringify({
      part,
      model,
      results
    }));
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Universal Parts API Production Ready 🚀");
});

server.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
