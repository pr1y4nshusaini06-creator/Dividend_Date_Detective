// Dividend Detective Pro — dashboard frontend.
//
// Data honesty note for future maintainers: only the "Portfolio Analysis"
// numbers (capital gains / dividend income / per-stock breakdown) come from
// the real backend, which scrapes live sources (see agent/scraper.js). The
// "Market Watch" ticker and each stock card's sparkline are cosmetic —
// simulated client-side so the dashboard never looks static — and are
// labeled SIMULATED in the UI. Never quietly turn that into a real feed
// without also updating/removing that label; a fake number that looks live
// is exactly the kind of thing that misleads someone into a bad trade.

const STORAGE_KEY = 'ddp_portfolio';
const CHART_KEY_STORAGE = 'ddp_finnhub_key';

const SAMPLE_PORTFOLIO = [
  { symbol: 'ITC', quantity: 100, buyPrice: 310.5 },
  { symbol: 'RELIANCE', quantity: 20, buyPrice: 2450 },
  { symbol: 'TCS', quantity: 15, buyPrice: 3450 },
];

const MARKET_WATCH_SEED = [
  { symbol: 'NIFTY 50', price: 24812.35 },
  { symbol: 'SENSEX', price: 81423.1 },
  { symbol: 'RELIANCE', price: 2986.4 },
  { symbol: 'TCS', price: 4102.75 },
  { symbol: 'HDFCBANK', price: 1689.2 },
  { symbol: 'INFY', price: 1875.6 },
];

// ---- State -----------------------------------------------------------------

let portfolio = loadPortfolio();
let latestAnalysis = {}; // symbol -> analysis result from /api/analyze
let selectedSymbol = null;
let chart = null;
let candleSeries = null;
let pollTimer = null;
let marketWatchState = MARKET_WATCH_SEED.map((s) => ({ ...s, prevPrice: s.price, changePct: 0 }));

// ---- DOM refs ---------------------------------------------------------------

const el = (id) => document.getElementById(id);
const portfolioListEl = el('portfolio-list');
const portfolioFootEl = el('portfolio-foot');
const marketWatchListEl = el('market-watch-list');
const totalGainsEl = el('total-capital-gains');
const totalDividendEl = el('total-dividend-income');
const opportunitiesListEl = el('opportunities-list');
const breakdownListEl = el('breakdown-list');
const analysisUpdatedEl = el('analysis-updated');
const chartTitleEl = el('chart-title');
const chartBadgeEl = el('chart-badge');
const priceChartEl = el('price-chart');
const toastEl = el('toast');

// ---- Boot --------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  renderPortfolioList();
  renderMarketWatch();
  setMarketStatus();
  setInterval(setMarketStatus, 60 * 1000);
  setInterval(tickMarketWatch, 2500);

  runAnalysis(); // immediate first load
  pollTimer = setInterval(runAnalysis, 30 * 1000);

  wireModals();
  wireButtons();
});

// ---- Portfolio persistence ---------------------------------------------------

function loadPortfolio() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return SAMPLE_PORTFOLIO.slice();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length ? parsed : SAMPLE_PORTFOLIO.slice();
  } catch (_) {
    return SAMPLE_PORTFOLIO.slice();
  }
}

function savePortfolio() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(portfolio));
}

function isSamplePortfolio() {
  return !localStorage.getItem(STORAGE_KEY);
}

// ---- Analysis polling ---------------------------------------------------------

async function runAnalysis() {
  if (!portfolio.length) return;

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portfolio }),
    });
    const data = await res.json();

    if (!res.ok) {
      // Fall back to demo data so the dashboard never goes blank, but say so.
      showToast(data.error || 'Live data unavailable — showing demo data instead.');
      await runDemoFallback();
      return;
    }

    latestAnalysis = Object.fromEntries((data.results || []).map((r) => [r.symbol, r]));
    applyAnalysis(data.results || []);
  } catch (err) {
    console.error('Analysis request failed:', err);
    showToast('Could not reach the server — showing demo data instead.');
    await runDemoFallback();
  }
}

async function runDemoFallback() {
  try {
    const res = await fetch('/api/demo', { method: 'POST' });
    const data = await res.json();
    latestAnalysis = Object.fromEntries((data.results || []).map((r) => [r.symbol, r]));
    applyAnalysis(data.results || []);
  } catch (_) {
    // Backend is fully unreachable — leave last-known state on screen.
  }
}

function applyAnalysis(results) {
  const totalGains = results.reduce((sum, r) => sum + (r.error ? 0 : r.potentialCapitalGains), 0);
  const totalDividend = results.reduce((sum, r) => sum + (r.error ? 0 : r.potentialDividendIncome), 0);

  fadeUpdate(totalGainsEl, formatCurrency(totalGains));
  totalGainsEl.classList.toggle('gain-color', totalGains >= 0);
  totalGainsEl.classList.toggle('loss-color', totalGains < 0);
  fadeUpdate(totalDividendEl, formatCurrency(totalDividend));

  analysisUpdatedEl.textContent = `Updated ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;

  renderOpportunities(results);
  renderBreakdown(results);
  renderPortfolioList(); // LTP/P&L depend on latestAnalysis
  if (selectedSymbol) renderChartFor(selectedSymbol);
}

function fadeUpdate(node, newText) {
  if (node.textContent === newText) return;
  node.classList.add('fading');
  setTimeout(() => {
    node.textContent = newText;
    node.classList.remove('fading');
  }, 200);
}

function renderOpportunities(results) {
  const withDates = results.filter((r) => !r.error && r.exDate);
  const urgent = withDates.filter((r) => daysUntil(r.exDate) != null && daysUntil(r.exDate) <= 2 && daysUntil(r.exDate) >= 0);
  const rest = withDates
    .filter((r) => !urgent.includes(r))
    .sort((a, b) => (daysUntil(a.exDate) ?? 999) - (daysUntil(b.exDate) ?? 999))
    .slice(0, 3);

  const items = [];

  urgent.forEach((r) => {
    const d = daysUntil(r.exDate);
    const whenText = d === 0 ? 'today' : `in ${d} day${d === 1 ? '' : 's'}`;
    items.push(
      `<li class="opportunity-item urgent">⚠ <strong>${escapeHtml(r.symbol)}</strong> goes ex-dividend ${whenText} ` +
        `(${escapeHtml(r.exDate)}) — last chance to be on record for the ₹${r.dividendAmount.toFixed(2)}/share payout.</li>`
    );
  });

  rest.forEach((r) => {
    items.push(
      `<li class="opportunity-item">${escapeHtml(r.symbol)} goes ex-dividend on ${escapeHtml(r.exDate)} — potential ${formatCurrency(
        r.potentialDividendIncome
      )} in dividend income.</li>`
    );
  });

  if (!items.length) {
    items.push('<li class="opportunity-placeholder">No near-term ex-dividend dates found for your current holdings.</li>');
  }

  opportunitiesListEl.innerHTML = items.join('');
}

function renderBreakdown(results) {
  breakdownListEl.innerHTML = results
    .map((r) => {
      if (r.error) {
        return `<li class="breakdown-row error">${escapeHtml(r.symbol)}: ${escapeHtml(r.error)}</li>`;
      }
      const gains = r.potentialCapitalGains;
      const dividend = r.potentialDividendIncome;
      let sentence;
      if (dividend > 0 && gains > 0) {
        const bigger = gains >= dividend;
        const ratio = bigger ? gains / dividend : dividend / gains;
        const ratioText = Math.abs(ratio - Math.round(ratio)) < 0.05 ? Math.round(ratio) : ratio.toFixed(1);
        sentence = bigger
          ? `Capital Gains (${formatCurrency(gains)}) are <span class="ratio">${ratioText}x</span> the Dividend Income (${formatCurrency(dividend)})`
          : `Dividend Income (${formatCurrency(dividend)}) is <span class="ratio">${ratioText}x</span> the Capital Gains (${formatCurrency(gains)})`;
      } else {
        sentence = `Capital Gains: ${formatCurrency(gains)} · Dividend Income: ${formatCurrency(dividend)}`;
      }
      return `<li class="breakdown-row"><strong>${escapeHtml(r.symbol)}:</strong> ${sentence}</li>`;
    })
    .join('');
}

function daysUntil(dateStr) {
  const ts = parseFlexibleDate(dateStr);
  if (ts == null) return null;
  const diffMs = ts - Date.now();
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function parseFlexibleDate(s) {
  if (!s) return null;
  let m = String(s).match(/(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2,4})/);
  if (m) {
    const day = parseInt(m[1], 10);
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()];
    let year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
    if (month != null) return Date.UTC(year, month, day);
  }
  m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    let year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
    return Date.UTC(year, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
  }
  return null;
}

// ---- Left sidebar: portfolio cards --------------------------------------------

function renderPortfolioList() {
  if (!portfolio.length) {
    portfolioListEl.innerHTML = '<p class="opportunity-placeholder">No holdings yet — click + to add one.</p>';
    portfolioFootEl.textContent = 'Portfolio is empty';
    return;
  }

  portfolioFootEl.textContent = isSamplePortfolio()
    ? `Showing a sample portfolio (${portfolio.length} stocks) — import yours to replace it.`
    : `${portfolio.length} holding${portfolio.length === 1 ? '' : 's'}`;

  portfolioListEl.innerHTML = portfolio
    .map((h) => {
      const a = latestAnalysis[h.symbol];
      const ltp = a && !a.error ? a.marketPrice : h.buyPrice;
      const pnl = a && !a.error ? a.potentialCapitalGains : 0;
      const pnlClass = pnl >= 0 ? 'gain-color' : 'loss-color';
      const pnlBg = pnl >= 0 ? 'green-soft' : 'red-soft';
      const active = h.symbol === selectedSymbol ? 'active' : '';
      return `
        <div class="stock-card ${active}" data-symbol="${escapeHtml(h.symbol)}" tabindex="0" role="button">
          <div class="stock-card-top">
            <div>
              <span class="stock-name">${escapeHtml(h.symbol)}</span>
              <span class="stock-symbol">NSE · EQ</span>
            </div>
            ${sparklineSvg(h.symbol, pnl >= 0)}
          </div>
          <div class="stock-card-mid">
            <span>Qty <span class="mono">${h.quantity}</span></span>
            <span>Avg <span class="mono">₹${h.buyPrice.toFixed(2)}</span></span>
          </div>
          <div class="stock-card-bottom">
            <span class="stock-ltp">₹${ltp.toFixed(2)}</span>
            <span class="stock-pnl ${pnlClass}" style="background: var(--${pnlBg})">${pnl >= 0 ? '+' : ''}${formatCurrency(pnl)}</span>
          </div>
        </div>
      `;
    })
    .join('');

  portfolioListEl.querySelectorAll('.stock-card').forEach((card) => {
    card.addEventListener('click', () => selectStock(card.dataset.symbol));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectStock(card.dataset.symbol); }
    });
  });
}

/** Tiny deterministic sparkline so it doesn't jump around every re-render. */
function sparklineSvg(symbol, up) {
  const points = deterministicSeries(symbol, 12);
  const w = 56, h = 24;
  const min = Math.min(...points), max = Math.max(...points);
  const range = max - min || 1;
  const path = points
    .map((v, i) => `${(i / (points.length - 1)) * w},${h - ((v - min) / range) * h}`)
    .join(' ');
  const color = up ? '#21c17c' : '#ef5a5a';
  return `<svg class="stock-sparkline" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <polyline points="${path}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />
  </svg>`;
}

function deterministicSeries(seed, n) {
  let x = hashString(seed);
  const out = [];
  let v = 50;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    v += (x % 100) / 100 - 0.5;
    out.push(v);
  }
  return out;
}

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff;
  return h || 1;
}

function selectStock(symbol) {
  selectedSymbol = symbol;
  renderPortfolioList();
  renderChartFor(symbol);
}

// ---- Right sidebar: simulated market watch ------------------------------------

function renderMarketWatch() {
  marketWatchListEl.innerHTML = marketWatchState
    .map(
      (s) => `
      <div class="ticker-row" data-symbol="${escapeHtml(s.symbol)}">
        <span class="ticker-name">${escapeHtml(s.symbol)}</span>
        <span class="ticker-right">
          <span class="ticker-price mono">${s.price.toFixed(2)}</span>
          <span class="ticker-change ${s.changePct >= 0 ? 'gain-color' : 'loss-color'}">${s.changePct >= 0 ? '+' : ''}${s.changePct.toFixed(2)}%</span>
        </span>
      </div>`
    )
    .join('');
}

function tickMarketWatch() {
  marketWatchState = marketWatchState.map((s) => {
    const prevPrice = s.price;
    const drift = (Math.random() - 0.5) * (s.price * 0.0015);
    const newPrice = Math.max(0.5, s.price + drift);
    const changePct = ((newPrice - (s.basePrice || s.prevPrice || newPrice)) / (s.basePrice || s.prevPrice || newPrice)) * 100;
    return { ...s, prevPrice, price: newPrice, changePct: s.changePct * 0.7 + changePct * 0.3, basePrice: s.basePrice || prevPrice };
  });

  renderMarketWatch();

  marketWatchListEl.querySelectorAll('.ticker-row').forEach((row) => {
    const state = marketWatchState.find((s) => s.symbol === row.dataset.symbol);
    if (!state) return;
    const up = state.price >= state.prevPrice;
    row.classList.add(up ? 'flash-up' : 'flash-down');
    setTimeout(() => row.classList.remove('flash-up', 'flash-down'), 500);
  });
}

// ---- Market status pill ---------------------------------------------------------

function setMarketStatus() {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  const isWeekday = day >= 1 && day <= 5;
  const isOpen = isWeekday && minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;

  const pill = el('market-status');
  pill.classList.toggle('open', isOpen);
  pill.classList.toggle('closed', !isOpen);
  el('market-status-text').textContent = isOpen ? 'NSE Market Open' : 'NSE Market Closed';
}

// ---- Chart (Lightweight Charts) ----------------------------------------------

function renderChartFor(symbol) {
  chartTitleEl.textContent = `${symbol} — Price History`;
  priceChartEl.innerHTML = '';

  const finnhubKey = localStorage.getItem(CHART_KEY_STORAGE);

  if (window.LightweightCharts) {
    chart = LightweightCharts.createChart(priceChartEl, {
      layout: { background: { color: 'transparent' }, textColor: '#9aa0a6', fontFamily: 'Inter' },
      grid: { vertLines: { color: '#232527' }, horzLines: { color: '#232527' } },
      rightPriceScale: { borderColor: '#2c2e30' },
      timeScale: { borderColor: '#2c2e30' },
      width: priceChartEl.clientWidth,
      height: 320,
    });
    candleSeries = chart.addCandlestickSeries({
      upColor: '#21c17c', downColor: '#ef5a5a',
      borderVisible: false,
      wickUpColor: '#21c17c', wickDownColor: '#ef5a5a',
    });

    if (finnhubKey) {
      chartBadgeEl.textContent = 'Live — Finnhub';
      fetchFinnhubCandles(symbol, finnhubKey)
        .then((data) => {
          if (!data || !data.length) throw new Error('no data');
          candleSeries.setData(data);
        })
        .catch(() => {
          chartBadgeEl.textContent = 'Illustrative — not live data';
          candleSeries.setData(syntheticCandles(symbol, latestAnalysis[symbol]));
        });
    } else {
      chartBadgeEl.textContent = 'Illustrative — not live data';
      candleSeries.setData(syntheticCandles(symbol, latestAnalysis[symbol]));
    }

    window.addEventListener('resize', () => {
      if (chart) chart.applyOptions({ width: priceChartEl.clientWidth });
    });
  } else {
    priceChartEl.innerHTML = '<div class="chart-empty">Chart library did not load.</div>';
  }
}

/** Deterministic, clearly-fake OHLC series anchored near the stock's known price, for visual purposes only. */
function syntheticCandles(symbol, analysis) {
  const anchor = analysis && !analysis.error ? analysis.marketPrice : 100 + hashString(symbol) % 900;
  const series = deterministicSeries(symbol + 'candles', 90);
  const min = Math.min(...series), max = Math.max(...series);
  const scale = anchor * 0.15;
  const now = Math.floor(Date.now() / 1000);
  const dayMs = 24 * 60 * 60;

  let prevClose = anchor - ((series[0] - min) / (max - min || 1) - 0.5) * scale;
  return series.map((v, i) => {
    const norm = (v - min) / (max - min || 1) - 0.5;
    const close = anchor + norm * scale;
    const open = prevClose;
    const high = Math.max(open, close) + Math.abs(scale) * 0.08;
    const low = Math.min(open, close) - Math.abs(scale) * 0.08;
    prevClose = close;
    return {
      time: now - (series.length - i) * dayMs,
      open: round2(open), high: round2(high), low: round2(low), close: round2(close),
    };
  });
}

function round2(n) { return Math.round(n * 100) / 100; }

async function fetchFinnhubCandles(symbol, apiKey) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - 90 * 24 * 60 * 60;
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=D&from=${from}&to=${to}&token=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.s !== 'ok') return null;
  return data.t.map((t, i) => ({
    time: t, open: data.o[i], high: data.h[i], low: data.l[i], close: data.c[i],
  }));
}

// ---- Modals & buttons ----------------------------------------------------------

function wireButtons() {
  el('connect-btn').addEventListener('click', () => toggleModal('import-modal', true));
  el('sync-btn').addEventListener('click', () => toggleModal('sync-modal', true));
  el('add-holding-btn').addEventListener('click', () => toggleModal('import-modal', true));
  el('chart-key-btn').addEventListener('click', promptForChartKey);
  el('sync-run-btn').addEventListener('click', async () => {
    toggleModal('sync-modal', false);
    showToast('Re-analyzing your portfolio…');
    await runAnalysis();
  });
}

function wireModals() {
  el('import-modal-close').addEventListener('click', () => toggleModal('import-modal', false));
  el('sync-modal-close').addEventListener('click', () => toggleModal('sync-modal', false));
  [el('import-modal'), el('sync-modal')].forEach((overlay) => {
    overlay.addEventListener('click', (e) => { if (e.target === overlay) toggleModal(overlay.id, false); });
  });

  document.querySelectorAll('.modal-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.modal-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.modal-panel').forEach((p) => {
        p.hidden = p.dataset.panel !== tab.dataset.tab;
      });
      clearImportError();
    });
  });

  el('manual-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const symbol = el('m-symbol').value.trim().toUpperCase();
    const quantity = parseInt(el('m-qty').value, 10);
    const buyPrice = parseFloat(el('m-price').value);

    if (!symbol) return showImportError('Enter a stock symbol.');
    if (!Number.isFinite(quantity) || quantity <= 0) return showImportError('Quantity must be a positive number.');
    if (!Number.isFinite(buyPrice) || buyPrice <= 0) return showImportError('Avg. buy price must be a positive number.');

    addHolding({ symbol, quantity, buyPrice });
    el('manual-form').reset();
    toggleModal('import-modal', false);
    showToast(`Added ${symbol} to your portfolio.`);
    runAnalysis();
  });

  el('csv-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    el('csv-text').value = await file.text();
  });

  el('csv-import-btn').addEventListener('click', async () => {
    const text = el('csv-text').value.trim();
    if (!text) return showImportError('Paste some CSV text or choose a file first.');

    try {
      const res = await fetch('/api/portfolio/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: text }),
      });
      const data = await res.json();
      if (!res.ok) return showImportError(data.error || 'Could not parse that CSV.');
      if (!data.holdings || !data.holdings.length) return showImportError('No valid holdings found in that CSV.');

      data.holdings.forEach(addHolding);
      el('csv-text').value = '';
      toggleModal('import-modal', false);
      showToast(`Imported ${data.holdings.length} holding${data.holdings.length === 1 ? '' : 's'}.`);
      runAnalysis();
    } catch (err) {
      showImportError('Could not reach the server to import this CSV.');
    }
  });
}

function addHolding(holding) {
  const existingIdx = portfolio.findIndex((h) => h.symbol === holding.symbol);
  if (existingIdx >= 0) portfolio[existingIdx] = holding;
  else portfolio.push(holding);
  savePortfolio();
  renderPortfolioList();
}

function toggleModal(id, show) {
  el(id).hidden = !show;
  if (show) clearImportError();
}

function showImportError(msg) {
  const box = el('import-error');
  box.textContent = msg;
  box.hidden = false;
}

function clearImportError() {
  el('import-error').hidden = true;
}

function promptForChartKey() {
  const current = localStorage.getItem(CHART_KEY_STORAGE) || '';
  const key = window.prompt(
    'Optional: paste a free Finnhub.io API key to show real historical candles.\n' +
      'This is stored only in your browser and sent directly to Finnhub — never to this app\'s server.\n' +
      'Leave blank and press OK to clear it and use illustrative data instead.',
    current
  );
  if (key === null) return;
  if (key.trim()) localStorage.setItem(CHART_KEY_STORAGE, key.trim());
  else localStorage.removeItem(CHART_KEY_STORAGE);
  if (selectedSymbol) renderChartFor(selectedSymbol);
}

// ---- Toast --------------------------------------------------------------------

let toastTimer = null;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3500);
}

// ---- Formatting helpers ---------------------------------------------------------

function formatCurrency(amount) {
  const sign = amount < 0 ? '-' : '';
  return `${sign}₹${Math.abs(amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
