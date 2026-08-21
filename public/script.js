// Frontend logic for Dividend Date Detective.
// Collects a stock + buy price + quantity, sends it to the backend as a
// one-holding "portfolio", and renders the capital-gains-vs-dividend-income
// comparison (plus the tax-treatment take) that comes back.

const form = document.getElementById('analyze-form');
const symbolInput = document.getElementById('stock-symbol');
const buyPriceInput = document.getElementById('buy-price');
const quantityInput = document.getElementById('quantity');
const button = document.getElementById('analyze-btn');
const demoButton = document.getElementById('demo-btn');
const resultsEl = document.getElementById('results');
const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('status-text');

// Rotating status messages shown while a real analysis request is in
// flight — the scrape + analysis can take several seconds, so these keep
// the user oriented instead of staring at a blank/frozen button.
const LOADING_MESSAGES = [
  'Searching for dividend data...',
  'Cross-checking against a second source...',
  'Fetching the latest market price...',
  'Analyzing profits...',
  'Almost there...',
];

let loadingInterval = null;

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const stockSymbol = symbolInput.value.trim();
  const buyPrice = parseFloat(buyPriceInput.value);
  const quantity = parseInt(quantityInput.value, 10);

  if (!stockSymbol) return;
  if (!Number.isFinite(buyPrice) || buyPrice <= 0) {
    renderError('Please enter a valid buy price greater than 0.');
    return;
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    renderError('Please enter a valid quantity of at least 1.');
    return;
  }

  const portfolio = [{ symbol: stockSymbol.toUpperCase(), buyPrice, quantity }];

  await runAnalysis('/api/analyze', { portfolio }, { isDemo: false });
});

demoButton.addEventListener('click', async () => {
  await runAnalysis('/api/demo', {}, { isDemo: true });
});

/**
 * Shared request/render flow for both the real analyze endpoint and demo
 * mode, so loading states and error handling behave identically either way.
 */
async function runAnalysis(url, body, { isDemo }) {
  setLoading(true, isDemo);
  resultsEl.innerHTML = '';

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    let data;
    try {
      data = await response.json();
    } catch (parseErr) {
      // Server returned something that wasn't valid JSON (e.g. a raw HTML
      // error page) — never show that to the user.
      renderError('The server sent back something unexpected. Please try again.');
      return;
    }

    if (!response.ok) {
      renderError(data.error || 'Something went wrong. Please try again.');
      return;
    }

    renderResults(data.results || []);
  } catch (err) {
    // Network failure, server down, CORS issue, etc. — never show err.message
    // or a stack trace, just a plain-language explanation.
    console.error('Failed to fetch analysis:', err);
    renderError(
      isDemo
        ? 'Could not load demo data. Please try again.'
        : "Could not reach the server, or a data source didn't respond in time. Please try again in a moment."
    );
  } finally {
    setLoading(false, isDemo);
  }
}

function setLoading(isLoading, isDemo) {
  button.disabled = isLoading;
  demoButton.disabled = isLoading;

  if (isLoading) {
    button.textContent = isDemo ? 'Analyze' : 'Analyzing...';
    statusEl.hidden = false;

    if (isDemo) {
      statusTextEl.textContent = 'Loading demo data...';
    } else {
      let i = 0;
      statusTextEl.textContent = LOADING_MESSAGES[0];
      loadingInterval = setInterval(() => {
        i = (i + 1) % LOADING_MESSAGES.length;
        statusTextEl.textContent = LOADING_MESSAGES[i];
      }, 1800);
    }
  } else {
    button.textContent = 'Analyze';
    statusEl.hidden = true;
    if (loadingInterval) {
      clearInterval(loadingInterval);
      loadingInterval = null;
    }
  }
}

function renderResults(results) {
  if (!results.length) {
    renderError('No results came back for that holding.');
    return;
  }
  resultsEl.innerHTML = results.map(renderStockCard).join('');
}

function renderStockCard(result) {
  if (result.error) {
    return `
      <div class="result-card error">
        <p><strong>${escapeHtml(result.symbol)}:</strong> ${escapeHtml(result.error)}</p>
      </div>
    `;
  }

  const gainClass = result.potentialCapitalGains >= 0 ? 'gain' : 'loss';
  const dividendClass = result.potentialDividendIncome >= 0 ? 'gain' : 'loss';

  const taxNote = renderTaxNote(result.taxAnalysis);
  const verificationBadge = renderVerificationBadge(result);

  return `
    <div class="analysis-card">
      <h3 class="analysis-heading">Analysis for ${escapeHtml(result.symbol)} ${verificationBadge}</h3>
      <ul class="analysis-list">
        <li>
          <strong>Potential Capital Gains (if sold today):</strong>
          <span class="${gainClass}">${formatCurrency(result.potentialCapitalGains)}</span>
        </li>
        <li>
          <strong>Potential Dividend Income (if held):</strong>
          <span class="${dividendClass}">${formatCurrency(result.potentialDividendIncome)}</span>
        </li>
      </ul>
      <p class="comparison-callout">
        <strong>Comparison:</strong> ${escapeHtml(
          buildComparisonSentence(result.potentialCapitalGains, result.potentialDividendIncome)
        )}
      </p>
      ${taxNote}
    </div>
  `;
}

/**
 * Turns the two headline numbers into one clear, spoken-language sentence —
 * this is the "so what" of the whole analysis, meant to be readable at a
 * glance during a demo.
 */
function buildComparisonSentence(capitalGains, dividendIncome) {
  const bothPositive = capitalGains > 0 && dividendIncome > 0;

  if (bothPositive) {
    const ratio =
      capitalGains >= dividendIncome ? capitalGains / dividendIncome : dividendIncome / capitalGains;

    // Within 5% of each other — call it a wash rather than forcing a "1x".
    if (Math.abs(capitalGains - dividendIncome) / Math.max(capitalGains, dividendIncome) < 0.05) {
      return 'The profit from selling today and the dividend income you would receive are roughly equal.';
    }

    const ratioText = formatRatio(ratio);
    return capitalGains > dividendIncome
      ? `The profit from selling today is approximately ${ratioText}x greater than the dividend income you would receive.`
      : `The dividend income you would receive is approximately ${ratioText}x greater than the profit from selling today.`;
  }

  if (capitalGains <= 0 && dividendIncome > 0) {
    return `Selling today would lock in a loss of ${formatCurrency(
      Math.abs(capitalGains)
    )}, so the ${formatCurrency(dividendIncome)} in dividend income from holding looks like the better option.`;
  }

  if (capitalGains > 0 && dividendIncome <= 0) {
    return `No meaningful dividend income is expected, so the ${formatCurrency(
      capitalGains
    )} profit from selling today stands out as the clear opportunity.`;
  }

  // Neither is positive — rare, but handle it rather than showing nonsense.
  return `Neither option looks profitable right now: selling today would lock in a loss of ${formatCurrency(
    Math.abs(capitalGains)
  )}, and holding wouldn't add meaningful dividend income either.`;
}

/** Formats a ratio like 5, 1.2, or 3.7 — whole numbers stay clean, others get one decimal. */
function formatRatio(ratio) {
  return Math.abs(ratio - Math.round(ratio)) < 0.05 ? String(Math.round(ratio)) : ratio.toFixed(1);
}

function formatCurrency(amount) {
  const sign = amount < 0 ? '-' : '';
  return `${sign}₹${Math.abs(amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function renderTaxNote(taxAnalysis) {
  if (!taxAnalysis || taxAnalysis.error) return '';

  const label =
    taxAnalysis.betterStrategy === 'hold'
      ? 'Holding through the ex-date'
      : taxAnalysis.betterStrategy === 'sell'
      ? 'Selling before the ex-date'
      : 'Holding or selling';

  const advantageText =
    taxAnalysis.betterStrategy === 'roughly equal'
      ? 'comes out about the same after tax.'
      : `comes out ahead by about ₹${taxAnalysis.afterTaxAdvantage.toFixed(
          2
        )} per share after tax (based on the default tax assumptions).`;

  return `<p class="tax-note">Tax-aware take: ${escapeHtml(label)} ${escapeHtml(advantageText)}</p>`;
}

/**
 * Small badge showing whether the ex-dividend date was cross-checked
 * against a second source (see getDividendDataCrossReferenced in
 * agent/scraper.js), so the demo can visibly demonstrate the reliability
 * check rather than just asserting it in a tooltip.
 */
function renderVerificationBadge(result) {
  if (result.dividendVerified == null) return '';

  if (result.dividendVerified) {
    const sources = (result.dividendSources || []).join(' & ') || 'a second source';
    return `<span class="badge badge-verified" title="Ex-dividend date matched across ${escapeHtml(
      sources
    )}">✔ Verified</span>`;
  }

  const note = result.dividendVerificationNote || 'Could not cross-check this date against a second source.';
  return `<span class="badge badge-unverified" title="${escapeHtml(note)}">⚠ Unverified</span>`;
}

function renderError(message, stockSymbol) {
  const context = stockSymbol ? ` for <strong>${escapeHtml(stockSymbol)}</strong>` : '';
  resultsEl.innerHTML = `
    <div class="result-card error">
      <p>Could not analyze this holding${context}. ${escapeHtml(message)}</p>
    </div>
  `;
}

// Minimal HTML escaping since we're injecting server-derived strings via innerHTML.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
