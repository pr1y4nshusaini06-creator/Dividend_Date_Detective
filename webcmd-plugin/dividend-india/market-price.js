/**
 * Current/last-traded market price for an Indian stock symbol.
 *
 * Strategy: COOKIE_API (NSE) with a PUBLIC_API fallback (Yahoo Finance).
 *
 * Evidence / reasoning:
 *   - NSE's own quote-equity JSON API is the source-of-truth for
 *     NSE-listed prices, but nseindia.com's WAF blocks requests that don't
 *     look like they came from a real browser session — visiting the
 *     homepage first (as this adapter does) picks up the cookies/headers
 *     their WAF expects, which is exactly the COOKIE_API contract: a
 *     stable endpoint plus page-sourced auth.
 *   - Yahoo Finance's v8 chart API (query1.finance.yahoo.com/v8/finance/chart)
 *     is a genuine PUBLIC_API — no auth, plain JSON, and it carries
 *     NSE-listed tickers under the ".NS" suffix (e.g. "ITC.NS"). Used only
 *     as a fallback when NSE's WAF blocks us, since NSE is the more
 *     authoritative source for an NSE-listed price.
 */
import { cli, Strategy } from '@agentrhq/webcmd/registry';
import { CommandExecutionError } from '@agentrhq/webcmd/errors';

cli({
  site: 'dividend-india',
  name: 'market-price',
  description: 'Current/last-traded market price for an Indian (NSE-listed) stock',
  access: 'read',
  example: 'webcmd dividend-india market-price ITC',
  domain: 'www.nseindia.com',
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    { name: 'symbol', required: true, positional: true, help: 'Stock ticker (e.g. ITC, RELIANCE)' },
  ],
  columns: ['symbol', 'price', 'source'],
  func: async (page, kwargs) => {
    const symbol = String(kwargs.symbol || '').toUpperCase().trim();
    if (!symbol) {
      throw new CommandExecutionError('symbol is required');
    }

    // Step 1 (COOKIE_API): visit nseindia.com to pick up the session
    // cookies their WAF expects, then hit the quote-equity API directly.
    await page.goto('https://www.nseindia.com');
    await page.wait(1);

    const nseResult = await page.evaluate(`
      (async () => {
        const sym = ${JSON.stringify(symbol)};
        try {
          const url = 'https://www.nseindia.com/api/quote-equity?symbol=' + encodeURIComponent(sym);
          const resp = await fetch(url, {
            headers: {
              'Accept': 'application/json',
              'Referer': 'https://www.nseindia.com/get-quotes/equity?symbol=' + encodeURIComponent(sym),
            },
          });
          if (!resp.ok) return { error: 'NSE HTTP ' + resp.status };
          const data = await resp.json();
          const price = data?.priceInfo?.lastPrice ?? data?.priceInfo?.close ?? data?.lastPrice ?? null;
          if (typeof price !== 'number') return { error: 'NSE response had no numeric price' };
          return { price };
        } catch (e) {
          return { error: 'NSE fetch failed: ' + e.message };
        }
      })()
    `);

    if (nseResult && !nseResult.error && typeof nseResult.price === 'number') {
      return [{ symbol, price: nseResult.price, source: 'NSE' }];
    }

    // Step 2 (PUBLIC_API fallback): Yahoo Finance chart API, NSE ticker
    // suffix ".NS".
    const yahooResult = await page.evaluate(`
      (async () => {
        const sym = ${JSON.stringify(symbol)} + '.NS';
        try {
          const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=1d&range=1d';
          const resp = await fetch(url);
          if (!resp.ok) return { error: 'Yahoo HTTP ' + resp.status };
          const data = await resp.json();
          const meta = data?.chart?.result?.[0]?.meta;
          const price = meta?.regularMarketPrice;
          if (typeof price !== 'number') return { error: 'Yahoo response had no numeric price' };
          return { price };
        } catch (e) {
          return { error: 'Yahoo fetch failed: ' + e.message };
        }
      })()
    `);

    if (yahooResult && !yahooResult.error && typeof yahooResult.price === 'number') {
      return [{ symbol, price: yahooResult.price, source: 'Yahoo Finance' }];
    }

    throw new CommandExecutionError(
      `Could not fetch market price for ${symbol} — NSE: ${nseResult?.error || 'unknown'}; Yahoo: ${yahooResult?.error || 'unknown'}`
    );
  },
});
