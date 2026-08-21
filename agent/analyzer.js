// Financial analysis logic: compares the profit from holding a stock through
// its ex-dividend date (and receiving the dividend) against selling before
// the ex-date and taking a capital gain instead.
//
// THE CORE INSIGHT (and the one simplifying assumption this whole module
// rests on): on the ex-dividend date, a stock's price mechanically drops by
// roughly the dividend amount, because the company is paying that value out
// to shareholders rather than keeping it in the business. So, pre-tax, there
// is ~no difference between holding through the ex-date (dividend + smaller
// capital gain) and selling right before it (all capital gain, no dividend) —
// you get the same rupee amount of value either way. This is a rule of
// thumb, not a law of physics: real-world price moves on the ex-date are
// also driven by ordinary market volatility, so the actual drop can be more
// or less than the dividend amount.
//
// Given that, the decision of whether to sell before or hold through the
// ex-date comes down almost entirely to TAX TREATMENT:
//   - Dividend income is taxed at the investor's income-tax slab rate
//     (added to total income, no special/flat rate, no exemption threshold).
//   - Capital gains on listed equity get favourable, flat rates instead:
//     20% STCG (held <= 12 months) or 12.5% LTCG (held > 12 months, with a
//     ₹1.25 lakh/year exemption) as of FY 2025-26 / AY 2026-27 rates
//     (effective since the July 2024 Union Budget; unchanged by Budgets
//     2025 and 2026). These rates exclude surcharge and the 4% health &
//     education cess, which apply on top in real filings.
//
// So this module isolates the marginal rupee-amount equal to the dividend
// and asks: "if this same value were realized as a dividend vs. as part of
// a capital gain, which is taxed less?" — and reports the after-tax
// difference. It intentionally does NOT need the user's purchase price,
// because it's comparing the tax treatment of that one slice of value, not
// computing their total gain/loss on the position.

// ---- Configurable tax assumptions (India, FY 2025-26 rates) ----------------
// Override any of these via the `options` argument to analyzeDividendData.
const DEFAULT_ASSUMPTIONS = {
  // Investor's marginal income-tax slab rate, applied to dividend income.
  // 30% is the top slab under the old regime (excl. surcharge/cess) — a
  // reasonably conservative "worst case" default. Pass your real slab rate
  // for an accurate answer.
  dividendTaxRate: 0.30,
  // Whether the holding period (if the user sold instead) would be long-term
  // (> 12 months) or short-term (<= 12 months) for listed equity.
  isLongTermHolding: false,
  stcgRate: 0.20, // Section 111A, flat, no exemption
  ltcgRate: 0.125, // Section 112A, on gains above the annual exemption
  // Simplifying assumption: treats the marginal dividend-sized slice of
  // gain as fully taxable, i.e. assumes the investor has already used up
  // their ₹1.25 lakh/year LTCG exemption on other gains. If that's not
  // true for them, their real LTCG tax on this slice could be lower (or
  // zero).
  ltcgExemptionAlreadyUsed: true,
};

/**
 * Compares the after-tax outcome of:
 *   (a) holding the stock through the ex-dividend date and receiving the
 *       dividend, vs.
 *   (b) selling the stock before the ex-date and instead realizing that
 *       same rupee amount as part of a capital gain.
 *
 * @param {{stockSymbol?: string, exDate?: string, dividendAmount?: number,
 *          marketPrice?: number, error?: string, marketPriceError?: string}} rawData
 *   The merged output of getDividendData() + getMarketPrice() (see server.js).
 * @param {Partial<typeof DEFAULT_ASSUMPTIONS>} [options] Overrides for the
 *   tax-rate assumptions above (e.g. { dividendTaxRate: 0.05, isLongTermHolding: true }).
 * @returns {{
 *   dividendYieldPercent: number,
 *   estimatedExDatePrice: number,
 *   afterTaxDividendValue: number,
 *   afterTaxCapitalGainValue: number,
 *   betterStrategy: 'hold' | 'sell' | 'roughly equal',
 *   afterTaxAdvantage: number,
 *   assumptions: typeof DEFAULT_ASSUMPTIONS,
 *   notes: string[],
 * } | { error: string }}
 */
function analyzeDividendData(rawData, options = {}) {
  if (!rawData || typeof rawData !== 'object') {
    return { error: 'No data provided to analyze' };
  }

  // Bail out clearly if either upstream scrape failed — there's nothing
  // meaningful to compare without both numbers.
  if (rawData.error) {
    return { error: `Cannot analyze: dividend data unavailable (${rawData.error})` };
  }
  const marketPrice = rawData.marketPrice;
  if (marketPrice == null || rawData.marketPriceError) {
    return {
      error: `Cannot analyze: market price unavailable (${
        rawData.marketPriceError || 'missing marketPrice'
      })`,
    };
  }

  const dividendAmount = Number(rawData.dividendAmount);
  const price = Number(marketPrice);

  if (!Number.isFinite(dividendAmount) || !Number.isFinite(price) || price <= 0) {
    return { error: 'Invalid dividendAmount or marketPrice — cannot analyze' };
  }

  const assumptions = { ...DEFAULT_ASSUMPTIONS, ...options };
  const notes = [];

  // --- Dividend yield, for context -----------------------------------------
  const dividendYieldPercent = (dividendAmount / price) * 100;

  // --- Rule-of-thumb ex-date price -----------------------------------------
  const estimatedExDatePrice = Math.max(price - dividendAmount, 0);
  notes.push(
    'Assumes the stock price drops by roughly the dividend amount on the ex-date — a common rule of thumb, not a guarantee. Actual price moves are also affected by ordinary market volatility.'
  );

  // --- Tax comparison on the marginal dividend-sized slice of value --------
  const afterTaxDividendValue = dividendAmount * (1 - assumptions.dividendTaxRate);

  let capitalGainsTaxRate;
  if (assumptions.isLongTermHolding) {
    capitalGainsTaxRate = assumptions.ltcgExemptionAlreadyUsed ? assumptions.ltcgRate : 0;
    if (!assumptions.ltcgExemptionAlreadyUsed) {
      notes.push(
        "Assumed this gain falls within your unused ₹1.25 lakh/year LTCG exemption, so 0% capital-gains tax applied to it. If you've already used that exemption elsewhere this year, the real LTCG rate (12.5%) would apply instead."
      );
    }
  } else {
    capitalGainsTaxRate = assumptions.stcgRate;
  }
  const afterTaxCapitalGainValue = dividendAmount * (1 - capitalGainsTaxRate);

  notes.push(
    `Dividend income is taxed at your income-tax slab rate (assumed ${(
      assumptions.dividendTaxRate * 100
    ).toFixed(0)}% here) with no special rate or exemption. Capital gains on listed equity get a flat rate instead — ${
      assumptions.isLongTermHolding
        ? '12.5% LTCG (above the ₹1.25 lakh/year exemption)'
        : '20% STCG'
    } — plus surcharge and 4% cess are not included in these numbers.`
  );

  const afterTaxAdvantage = afterTaxCapitalGainValue - afterTaxDividendValue;
  const ADVANTAGE_THRESHOLD = 0.01; // rupees; avoid calling a fraction-of-a-paisa gap "better"

  let betterStrategy;
  if (Math.abs(afterTaxAdvantage) < ADVANTAGE_THRESHOLD) {
    betterStrategy = 'roughly equal';
  } else if (afterTaxAdvantage > 0) {
    betterStrategy = 'sell'; // selling before ex-date (capital gains) wins
  } else {
    betterStrategy = 'hold'; // holding through ex-date (dividend) wins
  }

  return {
    dividendYieldPercent: Number(dividendYieldPercent.toFixed(3)),
    estimatedExDatePrice: Number(estimatedExDatePrice.toFixed(2)),
    afterTaxDividendValue: Number(afterTaxDividendValue.toFixed(2)),
    afterTaxCapitalGainValue: Number(afterTaxCapitalGainValue.toFixed(2)),
    betterStrategy,
    afterTaxAdvantage: Number(Math.abs(afterTaxAdvantage).toFixed(2)),
    assumptions,
    notes,
  };
}

// ---------------------------------------------------------------------------
// generateAnalysis
// ---------------------------------------------------------------------------
// The portfolio-level version of the comparison above. Where
// analyzeDividendData() looks at the tax treatment of one dividend-sized
// slice of value, generateAnalysis() looks at the investor's actual
// position: given what they paid for their shares and how many they hold,
// how much unrealized capital gain do they have, and how much extra would
// holding through the ex-dividend date add in dividend income?
//
// Note this is a different (complementary) lens from analyzeDividendData:
// that function isolates the marginal dividend rupee and asks "dividend or
// capital-gains tax, which is cheaper on this slice?" — it deliberately
// ignores the investor's buy price. This function instead answers "given
// what I actually paid, what's my total position worth right now, and how
// much of that total comes from price appreciation vs. the dividend?" Both
// get merged together per-stock in the API layer (see server.js).

function formatRupees(amount) {
  const abs = Math.abs(amount);
  return `₹${abs.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/**
 * Builds a per-stock capital-gains vs. dividend-income comparison for a
 * portfolio of holdings.
 *
 * @param {Array<{symbol: string, buyPrice: number, quantity: number}>} portfolio
 * @param {Object.<string, {exDate?: string, dividendAmount?: number,
 *   marketPrice?: number, error?: string, marketPriceError?: string}>} marketData
 *   Keyed by (uppercased) stock symbol — typically the merged output of
 *   getDividendData() + getMarketPrice() for each symbol, as assembled by
 *   the /api/analyze route in server.js.
 * @returns {Array<{
 *   symbol: string,
 *   buyPrice?: number,
 *   quantity?: number,
 *   marketPrice?: number,
 *   dividendAmount?: number,
 *   exDate?: string | null,
 *   potentialCapitalGains?: number,
 *   potentialDividendIncome?: number,
 *   totalPotentialProfit?: number,
 *   comparison?: string,
 *   error?: string,
 * }>}
 */
function generateAnalysis(portfolio, marketData) {
  if (!Array.isArray(portfolio)) return [];
  const data = marketData && typeof marketData === 'object' ? marketData : {};

  return portfolio.map((holding) => {
    const symbol = String(holding?.symbol || holding?.stockSymbol || '')
      .trim()
      .toUpperCase();

    if (!symbol) {
      return { symbol: symbol || '(unknown)', error: 'Missing stock symbol in portfolio entry' };
    }

    const buyPrice = Number(holding?.buyPrice);
    const quantity = Number(holding?.quantity);

    if (!Number.isFinite(buyPrice) || buyPrice <= 0) {
      return { symbol, error: 'Invalid or missing buyPrice for this holding' };
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { symbol, error: 'Invalid or missing quantity for this holding' };
    }

    const stockData = data[symbol];
    if (!stockData) {
      return { symbol, error: 'No market data available for this symbol' };
    }
    if (stockData.error) {
      return { symbol, error: `Dividend data unavailable: ${stockData.error}` };
    }
    if (stockData.marketPrice == null || stockData.marketPriceError) {
      return {
        symbol,
        error: `Market price unavailable: ${stockData.marketPriceError || 'missing marketPrice'}`,
      };
    }

    const marketPrice = Number(stockData.marketPrice);
    const dividendAmount = Number(stockData.dividendAmount) || 0;
    if (!Number.isFinite(marketPrice)) {
      return { symbol, error: 'Invalid marketPrice in market data for this symbol' };
    }

    // --- The two core calculations, exactly as specified -------------------
    const potentialCapitalGains = (marketPrice - buyPrice) * quantity;
    const potentialDividendIncome = dividendAmount * quantity;
    const totalPotentialProfit = potentialCapitalGains + potentialDividendIncome;

    const gainPerShare = marketPrice - buyPrice;
    const isGain = potentialCapitalGains >= 0;

    // --- Build a clear, plain-English comparison ----------------------------
    let comparison =
      `You hold ${quantity} share${quantity === 1 ? '' : 's'} of ${symbol}, bought at ₹${buyPrice.toFixed(
        2
      )}. At the current market price of ₹${marketPrice.toFixed(2)}, that's ` +
      `${isGain ? 'an unrealized capital gain' : 'an unrealized capital loss'} of ${formatRupees(
        potentialCapitalGains
      )} (${gainPerShare >= 0 ? '+' : '-'}₹${Math.abs(gainPerShare).toFixed(2)}/share).`;

    if (stockData.exDate && dividendAmount > 0) {
      comparison +=
        ` Holding through the ${stockData.exDate} ex-dividend date would add ` +
        `${formatRupees(potentialDividendIncome)} in dividend income (₹${dividendAmount.toFixed(
          2
        )}/share × ${quantity}).`;
    } else {
      comparison += ' No upcoming ex-dividend date/amount was found, so no dividend income is expected on top of this.';
    }

    comparison += ` Combined potential profit: ${formatRupees(totalPotentialProfit)}${
      totalPotentialProfit < 0 ? ' (a net loss overall)' : ''
    }.`;

    if (potentialDividendIncome > 0 && totalPotentialProfit > 0) {
      const dividendSharePercent = (potentialDividendIncome / totalPotentialProfit) * 100;
      comparison += ` The dividend makes up about ${dividendSharePercent.toFixed(
        0
      )}% of that total, with the rest coming from price appreciation.`;
    }

    return {
      symbol,
      buyPrice,
      quantity,
      marketPrice,
      dividendAmount,
      exDate: stockData.exDate || null,
      potentialCapitalGains: Number(potentialCapitalGains.toFixed(2)),
      potentialDividendIncome: Number(potentialDividendIncome.toFixed(2)),
      totalPotentialProfit: Number(totalPotentialProfit.toFixed(2)),
      comparison,
      // Cross-reference metadata from the scraper (see
      // getDividendDataCrossReferenced in agent/scraper.js) — lets the UI
      // show a "verified against 2 sources" badge or an honest caveat.
      dividendVerified: stockData.verified ?? null,
      dividendSources: stockData.sources || [],
      dividendVerificationNote: stockData.note || null,
    };
  });
}

module.exports = { analyzeDividendData, DEFAULT_ASSUMPTIONS, generateAnalysis };
