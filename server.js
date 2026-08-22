const express = require('express');
const path = require('path');
const { getDividendDataCrossReferenced, getMarketPrice } = require('./agent/webcmdRunner');
const { analyzeDividendData, generateAnalysis } = require('./agent/analyzer');
const { DEMO_MARKET_DATA, DEMO_PORTFOLIO } = require('./agent/demoData');

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

// Main analysis endpoint: takes a portfolio (one or more
// { symbol, buyPrice, quantity } holdings), scrapes dividend + market-price
// data for each unique symbol, then runs both the tax-treatment comparison
// (analyzeDividendData) and the portfolio-level capital-gains-vs-dividend
// comparison (generateAnalysis) for each holding.
app.post('/api/analyze', async (req, res) => {
  const { portfolio, dividendTaxRate, isLongTermHolding } = req.body || {};

  if (!Array.isArray(portfolio) || portfolio.length === 0) {
    return res.status(400).json({ error: 'portfolio (a non-empty array) is required' });
  }

  // Validate + normalize every entry up front so a bad row gets a clear
  // 400 instead of silently producing a confusing per-stock error later.
  const normalized = [];
  for (const holding of portfolio) {
    const symbol = String(holding?.symbol || holding?.stockSymbol || '')
      .trim()
      .toUpperCase();
    const buyPrice = Number(holding?.buyPrice);
    const quantity = Number(holding?.quantity);

    if (!symbol) {
      return res.status(400).json({ error: 'Each portfolio entry needs a stock symbol' });
    }
    if (!Number.isFinite(buyPrice) || buyPrice <= 0) {
      return res.status(400).json({ error: `Invalid buyPrice for ${symbol}` });
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: `Invalid quantity for ${symbol}` });
    }
    normalized.push({ symbol, buyPrice, quantity });
  }

  // De-dupe so we only scrape each symbol once even if it appears twice
  // in the portfolio (e.g. two separate lots of the same stock).
  const uniqueSymbols = [...new Set(normalized.map((h) => h.symbol))];

  // Only accept caller-supplied tax assumptions if they're sane numbers/
  // booleans — otherwise fall back to analyzer.js's documented defaults.
  const analysisOptions = {};
  if (typeof dividendTaxRate === 'number' && dividendTaxRate >= 0 && dividendTaxRate <= 1) {
    analysisOptions.dividendTaxRate = dividendTaxRate;
  }
  if (typeof isLongTermHolding === 'boolean') {
    analysisOptions.isLongTermHolding = isLongTermHolding;
  }

  try {
    // Scrape dividend data + market price for every unique symbol, in
    // parallel across symbols (each getDividendData/getMarketPrice pair is
    // also internally parallel — see agent/scraper.js).
    const scraped = await Promise.all(
      uniqueSymbols.map(async (symbol) => {
        const [dividendResult, priceResult] = await Promise.all([
          getDividendDataCrossReferenced(symbol),
          getMarketPrice(symbol),
        ]);
        return [
          symbol,
          {
            ...dividendResult,
            marketPrice: 'price' in priceResult ? priceResult.price : null,
            marketPriceError: 'error' in priceResult ? priceResult.error : null,
          },
        ];
      })
    );
    const marketData = Object.fromEntries(scraped);

    // Portfolio-level comparison (buyPrice/quantity aware). Never throws —
    // bad/missing data for a symbol becomes { symbol, error: '...' } in
    // the results array rather than crashing the whole request.
    const results = generateAnalysis(normalized, marketData).map((result) => {
      if (result.error) return result;
      // Layer in the tax-treatment comparison for the same symbol too,
      // so the frontend can show both lenses side by side.
      return {
        ...result,
        taxAnalysis: analyzeDividendData(marketData[result.symbol], analysisOptions),
      };
    });

    res.json({ marketData, results });
  } catch (err) {
    // Log the real error server-side for debugging, but never leak a raw
    // stack trace or error message to the client — just a friendly line.
    console.error('[/api/analyze] Unexpected error:', err);
    res.status(500).json({
      error: "Something went wrong while fetching that data. Please try again in a moment.",
    });
  }
});

// Demo Mode: returns a fixed, hardcoded analysis so the demo can always be
// shown even if moneycontrol/tickertape/NSE are down, slow, or have changed
// their page structure. Runs through the same analyzer logic as the real
// endpoint (no network calls at all), so the rendering code path is
// identical to a live result — only the input data is canned.
app.post('/api/demo', (req, res) => {
  try {
    const results = generateAnalysis(DEMO_PORTFOLIO, DEMO_MARKET_DATA).map((result) => {
      if (result.error) return result;
      return {
        ...result,
        taxAnalysis: analyzeDividendData(DEMO_MARKET_DATA[result.symbol]),
      };
    });
    res.json({ marketData: DEMO_MARKET_DATA, results, demo: true });
  } catch (err) {
    console.error('[/api/demo] Unexpected error:', err);
    res.status(500).json({ error: 'Could not load demo data. Please try again.' });
  }
});

// Debug/demo endpoint: shells out to webcmd's own `site memory show`
// command for the dividend-india site. This is real webcmd site memory —
// not a custom cache — so what you see here is exactly what an agent
// driving `webcmd` would see too. Useful in the live demo: call this
// before and after looking a stock up twice to show memory populate.
app.get('/api/memory', (req, res) => {
  const { execFile } = require('child_process');
  const path = require('path');
  const webcmdBin = path.join(__dirname, 'node_modules', '.bin', 'webcmd');
  execFile(webcmdBin, ['site', 'memory', 'show', 'dividend-india', '-f', 'json'], { timeout: 10000 }, (err, stdout) => {
    if (err) {
      return res.json({ memory: [], note: 'webcmd site memory unavailable (no lookups run yet, or CLI not installed)' });
    }
    try {
      res.json({ memory: JSON.parse(stdout) });
    } catch (_) {
      res.json({ memory: [], raw: stdout });
    }
  });
});

app.listen(PORT, () => {
  console.log(`Dividend Date Detective server running at http://localhost:${PORT}`);
});
