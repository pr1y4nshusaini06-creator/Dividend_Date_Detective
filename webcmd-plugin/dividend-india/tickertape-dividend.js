/**
 * Tickertape dividend history — second, independent source used to
 * cross-reference Moneycontrol's ex-dividend date/amount for the same
 * symbol (see dividend-india/cross-check.js).
 *
 * Strategy: UI_SELECTOR (with a PUBLIC_API-backed symbol resolution step),
 * same reasoning as moneycontrol-dividend.js — see that file's header for
 * the full strategy note. Tickertape's public search API
 * (api.tickertape.in/search) resolves a ticker to its stock-page slug;
 * the dividend table itself is read as visible UI.
 *
 * TODO before hackathon demo: re-run `webcmd browser verify
 * dividend-india/tickertape-dividend` against the live site and adjust
 * selectors from real devtools inspection.
 */
import { cli, Strategy } from '@agentrhq/webcmd/registry';
import { CommandExecutionError } from '@agentrhq/webcmd/errors';

cli({
  site: 'dividend-india',
  name: 'tickertape-dividend',
  description: 'Ex-dividend date and per-share amount for an Indian stock, from Tickertape',
  access: 'read',
  example: 'webcmd dividend-india tickertape-dividend ITC',
  domain: 'www.tickertape.in',
  strategy: Strategy.UI,
  browser: true,
  args: [
    { name: 'symbol', required: true, positional: true, help: 'Stock ticker (e.g. ITC, RELIANCE)' },
  ],
  columns: ['symbol', 'exDate', 'dividendAmount', 'quoteUrl'],
  func: async (page, kwargs) => {
    const symbol = String(kwargs.symbol || '').toUpperCase().trim();
    if (!symbol) {
      throw new CommandExecutionError('symbol is required');
    }

    // Step 1 (PUBLIC_API evidence): resolve the stock-page slug via
    // Tickertape's own search API.
    const resolved = await page.evaluate(`
      (async () => {
        const sym = ${JSON.stringify(symbol)};
        try {
          const url = 'https://api.tickertape.in/search?text=' + encodeURIComponent(sym) +
            '&types=stock';
          const resp = await fetch(url);
          if (!resp.ok) return { error: 'search HTTP ' + resp.status };
          const data = await resp.json();
          const candidates = data?.data?.stocks || data?.data || data?.results || [];
          const match = candidates.find((item) => {
            const s = (item.ticker || item.symbol || '').toUpperCase();
            return s === sym;
          }) || candidates[0];
          const slug = match?.slug;
          if (!slug) return { error: 'no match for symbol' };
          // slug from the API already looks like "/stocks/itc-ITC" — don't
          // prepend "/stocks/" again, just qualify it with the host.
          const quoteUrl = slug.startsWith('http')
            ? slug
            : 'https://www.tickertape.in' + (slug.startsWith('/') ? '' : '/') + slug;
          return { quoteUrl };
        } catch (e) {
          return { error: 'search failed: ' + e.message };
        }
      })()
    `);

    if (!resolved || resolved.error || !resolved.quoteUrl) {
      throw new CommandExecutionError(
        `Could not resolve Tickertape quote page for ${symbol}: ${resolved?.error || 'unknown error'}`
      );
    }
    const quoteUrl = resolved.quoteUrl;

    // Step 2 (UI_SELECTOR): navigate, open the Dividend tab if present, read
    // the dividend table.
    await page.goto(quoteUrl);
    await page.wait(1);

    const dividendTabSelectors = [
      'a:has-text("Dividend")',
      'button:has-text("Dividend")',
      '[role="tab"]:has-text("Dividend")',
    ];
    for (const sel of dividendTabSelectors) {
      const clicked = await page.evaluate(`
        (() => {
          const el = document.querySelector(${JSON.stringify(sel)});
          if (el) { el.click(); return true; }
          return false;
        })()
      `).catch(() => false);
      if (clicked) {
        await page.wait(1);
        break;
      }
    }

    const rowData = await page.evaluate(`
      (() => {
        const sectionSelectors = ['[data-testid*="dividend" i]', '#dividends'];
        const rowSelectors = [
          '[data-testid*="dividend" i] table tbody tr',
          '#dividends table tbody tr',
          'table tbody tr',
        ];

        let sectionFound = false;
        for (const sel of sectionSelectors) {
          if (document.querySelector(sel)) { sectionFound = true; break; }
        }
        if (!sectionFound) return { error: 'no dividend section found on page' };

        for (const sel of rowSelectors) {
          const rows = [...document.querySelectorAll(sel)];
          if (rows.length > 0) {
            return { rows: rows.map((r) => r.textContent.trim()).filter(Boolean) };
          }
        }
        return { error: 'dividend section found but no table rows matched' };
      })()
    `);

    if (!rowData || rowData.error) {
      throw new CommandExecutionError(
        `Dividend section not found or empty for ${symbol} at ${quoteUrl}: ${rowData?.error || 'unknown'}`
      );
    }

    for (const rowText of rowData.rows) {
      const dateMatch = rowText.match(/(\d{1,2}[-\/\s][A-Za-z]{3,9}[-\/\s]\d{2,4})|(\d{1,2}\/\d{1,2}\/\d{2,4})/);
      if (!dateMatch) continue;
      const amountMatch = rowText.match(/₹?\s?(\d+(\.\d{1,2})?)/);
      return [{
        symbol,
        exDate: dateMatch[0].trim(),
        dividendAmount: amountMatch ? parseFloat(amountMatch[1]) : null,
        quoteUrl,
      }];
    }

    throw new CommandExecutionError(
      `Found a dividend table for ${symbol} but could not parse any row into a date — row format may have changed`
    );
  },
});
