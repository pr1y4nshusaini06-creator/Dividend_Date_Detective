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
  try {
    const response = await page.request.get(SEARCH_AUTOSUGGEST_URL(stockSymbol));
    if (response.ok()) {
      const data = await response.json().catch(() => null);
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
    // Swallow — we'll fall back below.
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

    // Step 1: Resolve the actual quote page URL for this symbol.
    let quoteUrl = await resolveQuoteUrl(page, stockSymbol);

    if (!quoteUrl) {
      // Fallback: go to moneycontrol's search page and let it redirect us.
      await page.goto('https://www.moneycontrol.com/india/stockpricequote/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      const searchBox = await firstMatchingLocator(
        page,
        ['#search_str', 'input[type="search"]', 'input[placeholder*="search" i]'],
        8000
      );

      if (!searchBox) {
        return { error: 'Data not found' };
      }

      await searchBox.fill(stockSymbol);
      await page.waitForTimeout(1000); // allow autosuggest dropdown to populate

      const firstSuggestion = await firstMatchingLocator(
        page,
        ['.autosuggest-wrap li a', '#search_result li a', 'ul[id*="suggest" i] li a'],
        5000
      );

      if (!firstSuggestion) {
        return { error: 'Data not found' };
      }

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
        firstSuggestion.click(),
      ]);

      quoteUrl = page.url();
    } else {
      await page.goto(quoteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    // Step 2: Find and open the Dividends section/tab if it's not already visible.
    const dividendTabSelectors = [
      'a:has-text("Dividend")',
      'a:has-text("Dividends")',
      'button:has-text("Dividend")',
      '[role="tab"]:has-text("Dividend")',
    ];
    const dividendTab = await firstMatchingLocator(page, dividendTabSelectors, 8000);
    if (dividendTab) {
      await dividendTab.click().catch(() => {});
      await page.waitForTimeout(1000);
    }

    // Step 3: Wait for the dividend section itself to load, then grab rows.
    const dividendSection = await firstMatchingLocator(page, DIVIDEND_SECTION_SELECTORS, 10000);
    if (!dividendSection) {
      return { error: 'Data not found' };
    }

    let rowTexts = [];
    for (const selector of DIVIDEND_ROW_SELECTORS) {
      const count = await page.locator(selector).count();
      if (count > 0) {
        rowTexts = await page.locator(selector).allTextContents();
        break;
      }
    }

    if (rowTexts.length === 0) {
      return { error: 'Data not found' };
    }

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

module.exports = { getDividendData };
