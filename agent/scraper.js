// Playwright-based scraper for fetching dividend data (ex-dividend date + amount)
// for a given Indian stock symbol from moneycontrol.com.
//
// IMPORTANT — read before relying on this in a demo:
// moneycontrol stock URLs are NOT simply
//   moneycontrol.com/india/stockpricequote/<SYMBOL>
// They follow a pattern like
//   moneycontrol.com/india/stockpricequote/<sector-slug>/<company-slug>/<CODE>
// which you can't construct from a ticker alone. So this scraper first uses
// moneycontrol's own search to find the real quote page, then scrapes it.
//
// Because we couldn't inspect moneycontrol's live DOM while writing this
// (no network access to that domain from this environment), the selectors
// below are best-effort guesses based on how moneycontrol has historically
// structured this page (a "Dividend" section/tab with a table of dates and
// amounts). Treat these as a starting point: open devtools on a real stock
// page, confirm/adjust the selectors, and update the arrays below.

const { chromium } = require('playwright');

const SEARCH_AUTOSUGGEST_URL = (query) =>
  `https://www.moneycontrol.com/mccode/common/autosuggesion.php?query=${encodeURIComponent(
    query
  )}&type=1&format=json`;

// Candidate selectors for the dividend section — tried in order, first match wins.
const DIVIDEND_SECTION_SELECTORS = [
  '#dividend_table',
  '#dividends',
  '[id*="dividend" i]',
  'text=/dividend/i',
];

// Candidate selectors/patterns for individual dividend rows within that section.
const DIVIDEND_ROW_SELECTORS = [
  '#dividend_table table tbody tr',
  '#dividends table tbody tr',
  'table:has-text("Ex-Date") tbody tr',
  'table:has-text("Announcement Date") tbody tr',
];

/**
 * Attempts to find the moneycontrol quote page URL for a given stock symbol
 * by using moneycontrol's autosuggest/search endpoint.
 */
async function resolveQuoteUrl(page, stockSymbol) {
  const debug = process.env.SCRAPER_DEBUG === '1';
  try {
    const response = await page.request.get(SEARCH_AUTOSUGGEST_URL(stockSymbol));
    if (debug) console.log('[scraper] autosuggest status:', response.status());
    if (response.ok()) {
      const rawText = await response.text();
      if (debug) console.log('[scraper] autosuggest raw response:', rawText.slice(0, 500));
      const data = JSON.parse(rawText || 'null');
      const candidates = Array.isArray(data) ? data : data?.results || [];
      const match =
        candidates.find((item) => {
          const symbol = (item.symbol || item.nse_symbol || item.bse_symbol || '').toUpperCase();
          return symbol === stockSymbol.toUpperCase();
        }) || candidates[0];

      const link = match?.link_src || match?.url || match?.link;
      if (link) {
        return link.startsWith('http') ? link : `https://www.moneycontrol.com${link}`;
      }
    }
  } catch (err) {
    if (debug) console.log('[scraper] autosuggest failed:', err.message);
  }
  return null;
}

/**
 * Tries each selector in `selectors` against `page` until one matches at
 * least one visible element, returning that Locator (or null if none match).
 */
async function firstMatchingLocator(page, selectors, timeoutMs = 5000) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: 'visible', timeout: timeoutMs });
      return locator;
    } catch (_) {
      // try next candidate
    }
  }
  return null;
}

/**
 * Parses a dividend table row's text into { exDate, dividendAmount } if it
 * looks like a valid row, otherwise returns null.
 */
function parseDividendRowText(rowText) {
  if (!rowText) return null;

  // Look for a date like "12-May-2026", "12 May 2026", or "12/05/2026"
  const dateMatch = rowText.match(
    /(\d{1,2}[-\/\s][A-Za-z]{3,9}[-\/\s]\d{2,4})|(\d{1,2}\/\d{1,2}\/\d{2,4})/
  );
  // Look for a rupee amount like "8.00", "₹14.50"
  const amountMatch = rowText.match(/₹?\s?(\d+(\.\d{1,2})?)/);

  if (!dateMatch) return null;

  return {
    exDate: dateMatch[0].trim(),
    dividendAmount: amountMatch ? parseFloat(amountMatch[1]) : null,
  };
}

/**
 * Main export. Launches Playwright, navigates to the stock's moneycontrol
 * page, and scrapes the most recent/upcoming ex-dividend date and amount.
 *
 * @param {string} stockSymbol e.g. "ITC", "RELIANCE"
 * @returns {Promise<{exDate: string, dividendAmount: number} | {error: string}>}
 */
async function getDividendData(stockSymbol) {
  if (!stockSymbol || typeof stockSymbol !== 'string') {
    return { error: 'Invalid stock symbol provided' };
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    });
    const page = await context.newPage();

    const debug = process.env.SCRAPER_DEBUG === '1';
    const log = (...args) => { if (debug) console.log('[scraper]', ...args); };

    // Step 1: Resolve the actual quote page URL for this symbol.
    let quoteUrl = await resolveQuoteUrl(page, stockSymbol);
    log('resolveQuoteUrl ->', quoteUrl);

    if (!quoteUrl) {
      // Fallback: go to moneycontrol's search page and let it redirect us.
      await page.goto('https://www.moneycontrol.com/india/stockpricequote/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      log('loaded fallback search page');

      const searchBox = await firstMatchingLocator(
        page,
        ['#search_str', 'input[type="search"]', 'input[placeholder*="search" i]'],
        8000
      );
      log('searchBox found?', !!searchBox);

      if (!searchBox) {
        if (debug) await page.screenshot({ path: 'debug-1-no-searchbox.png', fullPage: true });
        return { error: 'Data not found' };
      }

      await searchBox.fill(stockSymbol);
      await page.waitForTimeout(1000); // allow autosuggest dropdown to populate

      const firstSuggestion = await firstMatchingLocator(
        page,
        ['.autosuggest-wrap li a', '#search_result li a', 'ul[id*="suggest" i] li a'],
        5000
      );
      log('firstSuggestion found?', !!firstSuggestion);

      if (!firstSuggestion) {
        if (debug) await page.screenshot({ path: 'debug-2-no-suggestion.png', fullPage: true });
        return { error: 'Data not found' };
      }

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        firstSuggestion.click(),
      ]);

      quoteUrl = page.url();
      log('navigated to quote page via search ->', quoteUrl);
    } else {
      await page.goto(quoteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      log('navigated directly to resolved quoteUrl');
    }

    // Step 2: Find and open the Dividends section/tab if it's not already visible.
    const dividendTabSelectors = [
      'a:has-text("Dividend")',
      'a:has-text("Dividends")',
      'button:has-text("Dividend")',
      '[role="tab"]:has-text("Dividend")',
    ];
    const dividendTab = await firstMatchingLocator(page, dividendTabSelectors, 8000);
    log('dividendTab found?', !!dividendTab);
    if (dividendTab) {
      await dividendTab.click().catch(() => {});
      await page.waitForTimeout(1000);
    }

    // Step 3: Wait for the dividend section itself to load, then grab rows.
    const dividendSection = await firstMatchingLocator(page, DIVIDEND_SECTION_SELECTORS, 10000);
    log('dividendSection found?', !!dividendSection);
    if (!dividendSection) {
      if (debug) await page.screenshot({ path: 'debug-3-no-dividend-section.png', fullPage: true });
      return { error: 'Data not found' };
    }

    let rowTexts = [];
    for (const selector of DIVIDEND_ROW_SELECTORS) {
      const count = await page.locator(selector).count();
      log(`row selector "${selector}" matched`, count, 'elements');
      if (count > 0) {
        rowTexts = await page.locator(selector).allTextContents();
        break;
      }
    }

    if (rowTexts.length === 0) {
      log('no row texts extracted from any selector');
      if (debug) await page.screenshot({ path: 'debug-4-no-rows.png', fullPage: true });
      return { error: 'Data not found' };
    }

    log('rowTexts:', rowTexts);

    // Parse rows and take the first one that yields a usable date.
    for (const rowText of rowTexts) {
      const parsed = parseDividendRowText(rowText);
      if (parsed && parsed.exDate) {
        return {
          exDate: parsed.exDate,
          dividendAmount: parsed.dividendAmount ?? 0.0,
        };
      }
    }

    return { error: 'Data not found' };
  } catch (err) {
    // Never let a page-structure change or network hiccup crash the caller.
    console.error(`[scraper] Error fetching dividend data for ${stockSymbol}:`, err.message);
    return { error: 'Data not found' };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// ---------------------------------------------------------------------------
// getMarketPrice
// ---------------------------------------------------------------------------
// Fetches the current/last-traded market price for a stock symbol.
//
// Strategy (tried in order, first success wins):
//   1. NSE's own quote-equity JSON API — this is the "source of truth" for
//      NSE-listed prices, but nseindia.com actively blocks non-browser-like
//      requests. We visit the homepage first to pick up the cookies/session
//      their WAF expects, then hit the API with browser-like headers.
//   2. Fallback: scrape the LTP off moneycontrol's quote page (reusing the
//      same resolveQuoteUrl search flow as getDividendData), trying several
//      candidate selectors moneycontrol has historically used for the price.
//
// As with getDividendData, the moneycontrol selectors below are best-effort
// guesses — I don't have live network access to either nseindia.com or
// moneycontrol.com from this sandbox, so neither path has been confirmed
// against the real DOM/API response shape. Expect to need to adjust them
// once you test against the live sites.

const NSE_QUOTE_API_URL = (symbol) =>
  `https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(symbol)}`;

// Candidate selectors for the last-traded-price element on moneycontrol's
// quote page — tried in order, first match wins.
const PRICE_SELECTORS = [
  '#Nse_Prc_tick',
  '#Bse_Prc_tick',
  '#nsecp',
  '#bsecp',
  'span[id*="Prc_tick" i]',
  '.pcstkspr',
  '[class*="stprice" i]',
  '[class*="span_price" i] span',
];

/**
 * Parses a price string like "₹412.35", "1,234.50", "INR 88.10" into a
 * plain float. Returns null if no number-like substring is found.
 */
function parsePriceText(text) {
  if (!text) return null;
  const cleaned = text.replace(/,/g, '');
  const match = cleaned.match(/(\d+(\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

/**
 * Attempt 1: NSE's quote-equity API. Requires first loading the NSE
 * homepage in the same browser context so cookies get set — hitting the
 * API cold almost always returns a 401/403.
 */
async function tryNseApi(context, stockSymbol, log) {
  try {
    const page = await context.newPage();
    await page.goto('https://www.nseindia.com', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });

    const response = await page.request.get(NSE_QUOTE_API_URL(stockSymbol), {
      headers: {
        Accept: 'application/json',
        Referer: `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(
          stockSymbol
        )}`,
      },
    });
    log('NSE quote-equity status:', response.status());

    await page.close();

    if (!response.ok()) return null;

    const data = await response.json();
    const price =
      data?.priceInfo?.lastPrice ??
      data?.priceInfo?.close ??
      data?.lastPrice ??
      null;

    return typeof price === 'number' ? price : parsePriceText(String(price ?? ''));
  } catch (err) {
    log('NSE API attempt failed:', err.message);
    return null;
  }
}

/**
 * Attempt 2: scrape the price off moneycontrol's quote page, reusing the
 * same URL-resolution flow getDividendData uses.
 */
async function tryMoneycontrolScrape(context, stockSymbol, log) {
  let page;
  try {
    page = await context.newPage();

    let quoteUrl = await resolveQuoteUrl(page, stockSymbol);
    if (quoteUrl) {
      await page.goto(quoteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } else {
      await page.goto('https://www.moneycontrol.com/india/stockpricequote/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      const searchBox = await firstMatchingLocator(
        page,
        ['#search_str', 'input[type="search"]', 'input[placeholder*="search" i]'],
        8000
      );
      if (!searchBox) return null;

      await searchBox.fill(stockSymbol);
      await page.waitForTimeout(1000);

      const firstSuggestion = await firstMatchingLocator(
        page,
        ['.autosuggest-wrap li a', '#search_result li a', 'ul[id*="suggest" i] li a'],
        5000
      );
      if (!firstSuggestion) return null;

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        firstSuggestion.click(),
      ]);
    }

    const priceLocator = await firstMatchingLocator(page, PRICE_SELECTORS, 8000);
    log('moneycontrol priceLocator found?', !!priceLocator);
    if (!priceLocator) {
      if (process.env.SCRAPER_DEBUG === '1') {
        await page.screenshot({ path: 'debug-price-no-element.png', fullPage: true });
      }
      return null;
    }

    const text = await priceLocator.textContent();
    return parsePriceText(text);
  } catch (err) {
    log('moneycontrol price scrape failed:', err.message);
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * Main export. Returns the current/last-traded market price for a stock
 * symbol as a plain number, trying NSE's API first and falling back to
 * scraping moneycontrol's quote page.
 *
 * @param {string} stockSymbol e.g. "ITC", "RELIANCE"
 * @returns {Promise<{price: number} | {error: string}>}
 */
async function getMarketPrice(stockSymbol) {
  if (!stockSymbol || typeof stockSymbol !== 'string') {
    return { error: 'Invalid stock symbol provided' };
  }

  const debug = process.env.SCRAPER_DEBUG === '1';
  const log = (...args) => { if (debug) console.log('[scraper:price]', ...args); };

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    });

    let price = await tryNseApi(context, stockSymbol, log);
    log('NSE API price ->', price);

    if (price == null) {
      price = await tryMoneycontrolScrape(context, stockSymbol, log);
      log('moneycontrol fallback price ->', price);
    }

    if (price == null || Number.isNaN(price)) {
      return { error: 'Data not found' };
    }

    return { price };
  } catch (err) {
    // Never let a page-structure change, anti-bot block, or network hiccup
    // crash the caller.
    console.error(`[scraper] Error fetching market price for ${stockSymbol}:`, err.message);
    return { error: 'Data not found' };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// ---------------------------------------------------------------------------
// Cross-referencing dividend data across two independent sources
// ---------------------------------------------------------------------------
// For the demo we want more confidence than a single scrape can offer: if
// Moneycontrol and a second, independent site agree on the ex-date (and
// ideally the amount), we can label the result "verified" in the UI. If they
// disagree, or only one source responds, we say so honestly rather than
// silently picking one.
//
// Second source: Tickertape (tickertape.in), which also publishes a
// dividend-history table per stock. As with the Moneycontrol selectors
// above, these selectors are best-effort guesses — this sandbox has no live
// network access to tickertape.in either, so treat them as a starting point
// to confirm/adjust against the real DOM before relying on them.

const TICKERTAPE_SEARCH_URL = (query) =>
  `https://api.tickertape.in/search?text=${encodeURIComponent(query)}&types=stock&limit=5`;

const TICKERTAPE_DIVIDEND_ROW_SELECTORS = [
  '[data-testid*="dividend" i] table tbody tr',
  '#dividends table tbody tr',
  'table:has-text("Ex Date") tbody tr',
  'table:has-text("Ex-Date") tbody tr',
];

/**
 * Resolves a stock's tickertape.in quote page URL via their search API.
 * Mirrors resolveQuoteUrl()'s approach for Moneycontrol.
 */
async function resolveTickertapeUrl(page, stockSymbol) {
  const debug = process.env.SCRAPER_DEBUG === '1';
  try {
    const response = await page.request.get(TICKERTAPE_SEARCH_URL(stockSymbol));
    if (debug) console.log('[scraper:secondary] search status:', response.status());
    if (response.ok()) {
      const rawText = await response.text();
      const data = JSON.parse(rawText || 'null');
      const candidates = data?.data || data?.results || [];
      const match =
        candidates.find((item) => {
          const symbol = (item.ticker || item.symbol || '').toUpperCase();
          return symbol === stockSymbol.toUpperCase();
        }) || candidates[0];

      const slug = match?.slug || match?.sid;
      if (slug) return `https://www.tickertape.in/stocks/${slug}`;
    }
  } catch (err) {
    if (debug) console.log('[scraper:secondary] search failed:', err.message);
  }
  return null;
}

/**
 * Secondary-source scrape of a stock's ex-dividend date/amount, independent
 * of the Moneycontrol path above. Same defensive shape: never throws,
 * returns { error } on any failure.
 */
async function getDividendDataSecondary(stockSymbol) {
  if (!stockSymbol || typeof stockSymbol !== 'string') {
    return { error: 'Invalid stock symbol provided' };
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    });
    const page = await context.newPage();
    const debug = process.env.SCRAPER_DEBUG === '1';
    const log = (...args) => { if (debug) console.log('[scraper:secondary]', ...args); };

    const quoteUrl = await resolveTickertapeUrl(page, stockSymbol);
    log('resolveTickertapeUrl ->', quoteUrl);
    if (!quoteUrl) return { error: 'Data not found' };

    await page.goto(quoteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const dividendTab = await firstMatchingLocator(
      page,
      ['a:has-text("Dividend")', 'button:has-text("Dividend")', '[role="tab"]:has-text("Dividend")'],
      8000
    );
    if (dividendTab) {
      await dividendTab.click().catch(() => {});
      await page.waitForTimeout(1000);
    }

    let rowTexts = [];
    for (const selector of TICKERTAPE_DIVIDEND_ROW_SELECTORS) {
      const count = await page.locator(selector).count();
      log(`row selector "${selector}" matched`, count, 'elements');
      if (count > 0) {
        rowTexts = await page.locator(selector).allTextContents();
        break;
      }
    }

    if (rowTexts.length === 0) {
      if (debug) await page.screenshot({ path: 'debug-secondary-no-rows.png', fullPage: true });
      return { error: 'Data not found' };
    }

    for (const rowText of rowTexts) {
      const parsed = parseDividendRowText(rowText);
      if (parsed && parsed.exDate) {
        return { exDate: parsed.exDate, dividendAmount: parsed.dividendAmount ?? 0.0 };
      }
    }

    return { error: 'Data not found' };
  } catch (err) {
    console.error(`[scraper:secondary] Error fetching dividend data for ${stockSymbol}:`, err.message);
    return { error: 'Data not found' };
  } finally {
    if (browser) await browser.close();
  }
}

// Month-name lookup used to normalize the several date spellings the two
// sites might use ("12-May-2026", "12 May 2026", "12/05/2026") so they can
// be compared for equality rather than compared as raw strings.
const MONTH_NAMES = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Best-effort parse of a scraped date string into a UTC timestamp (ms), or
 * null if it can't be confidently parsed. Used only to compare two dates
 * for equality — never shown to the user directly.
 */
function normalizeDateForComparison(dateStr) {
  if (!dateStr) return null;
  const s = dateStr.trim();

  // "12-May-2026" / "12 May 2026"
  let m = s.match(/(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2,4})/);
  if (m) {
    const day = parseInt(m[1], 10);
    const monthKey = m[2].slice(0, 3).toLowerCase();
    const month = MONTH_NAMES[monthKey];
    let year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
    if (month != null) return Date.UTC(year, month, day);
  }

  // "12/05/2026" — assume DD/MM/YYYY (Indian convention)
  m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1;
    let year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
    return Date.UTC(year, month, day);
  }

  return null;
}

/**
 * Fetches dividend data from Moneycontrol and Tickertape in parallel and
 * cross-references the results. This is the function server.js should call
 * instead of getDividendData() directly when a "verified" flag is wanted.
 *
 * @param {string} stockSymbol
 * @returns {Promise<{
 *   exDate: string, dividendAmount: number,
 *   verified: boolean,
 *   sources: string[],
 *   note?: string,
 * } | { error: string }>}
 */
async function getDividendDataCrossReferenced(stockSymbol) {
  const [primary, secondary] = await Promise.all([
    getDividendData(stockSymbol),
    getDividendDataSecondary(stockSymbol),
  ]);

  const primaryOk = primary && !primary.error;
  const secondaryOk = secondary && !secondary.error;

  if (!primaryOk && !secondaryOk) {
    return { error: 'Data not found' };
  }

  if (primaryOk && !secondaryOk) {
    return { ...primary, verified: false, sources: ['Moneycontrol'], note: 'Only one source responded — could not cross-check.' };
  }

  if (!primaryOk && secondaryOk) {
    return { ...secondary, verified: false, sources: ['Tickertape'], note: 'Only one source responded — could not cross-check.' };
  }

  // Both sources returned data — compare them.
  const primaryTs = normalizeDateForComparison(primary.exDate);
  const secondaryTs = normalizeDateForComparison(secondary.exDate);
  const datesMatch = primaryTs != null && primaryTs === secondaryTs;

  if (datesMatch) {
    return {
      exDate: primary.exDate,
      dividendAmount: primary.dividendAmount,
      verified: true,
      sources: ['Moneycontrol', 'Tickertape'],
    };
  }

  // Sources disagree — report the primary source's data but flag it clearly
  // rather than silently trusting one over the other.
  return {
    exDate: primary.exDate,
    dividendAmount: primary.dividendAmount,
    verified: false,
    sources: ['Moneycontrol'],
    note: `Sources disagree (Tickertape reported ${secondary.exDate}) — showing Moneycontrol's date, unverified.`,
  };
}

module.exports = {
  getDividendData,
  getMarketPrice,
  getDividendDataSecondary,
  getDividendDataCrossReferenced,
};
