const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static frontend files from the "public" folder
app.use(express.static(path.join(__dirname, 'public')));

// Parse JSON bodies for future API routes (e.g. POST /api/scrape)
app.use(express.json());

// Placeholder API route — wire this up to agent/scraper.js + agent/analyzer.js later
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Dividend Date Detective backend is running' });
});

app.listen(PORT, () => {
  console.log(`Dividend Date Detective server running at http://localhost:${PORT}`);
});
