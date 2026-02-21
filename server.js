const express = require("express");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

const data = JSON.parse(fs.readFileSync("./data.json", "utf8"));

// Normalize text
function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

// Build fast index at startup
const index = {};

data.categories.forEach(category => {
  index[category.key] = [];

  category.brands.forEach(brand => {
    brand.models.forEach(line => {
      index[category.key].push(line);
    });
  });
});

// Smart search (includes typo tolerance)
function smartMatch(model, line) {
  const cleanModel = normalize(model);
  const cleanLine = normalize(line);

  if (cleanLine.includes(cleanModel)) return true;

  // Partial fallback match (first 70%)
  const partial = cleanModel.slice(0, Math.floor(cleanModel.length * 0.7));
  return cleanLine.includes(partial);
}

app.get("/search", (req, res) => {
  const { part, model } = req.query;

  if (!part || !model) {
    return res.json({ error: "part and model required" });
  }

  const categoryData = index[part];

  if (!categoryData) {
    return res.json({ error: "Invalid part category" });
  }

  const results = categoryData.filter(line =>
    smartMatch(model, line)
  );

  if (results.length === 0) {
    return res.json({ message: "No universal match found" });
  }

  res.json({
    part,
    model,
    results
  });
});

app.get("/", (req, res) => {
  res.send("Universal Parts API Production Ready 🚀");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
