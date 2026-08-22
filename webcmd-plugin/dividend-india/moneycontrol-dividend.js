/**
 * Moneycontrol dividend history — ex-dividend date + amount for an Indian
 * stock symbol.
 *
 * Strategy: UI_SELECTOR (with a PUBLIC_API-backed symbol resolution step).
 *
 * Evidence / reasoning:
 *   - Moneycontrol's autosuggest endpoint
 *     (mccode/common/autosuggesion.php) is a genuine PUBLIC_API: it's a
 *     plain unauthenticated JSON GET that returns candidate quote-page URLs
 *     for a typed symbol. We use it to resolve "ITC" -> the real quote page
 *     URL, since moneycontrol quote URLs embed a sector/company slug + code
 *     that can't be constructed from the ticker alone.
 *   - The dividend history itself is rendered as an HTML table inside a
 *     "Dividend" tab/section on the resolved quote page. No stable JSON
 *     endpoint for this was confirmed, so we fall back to UI_SELECTOR:
 *     open the Dividend tab, read the table rows as visible text. This
 *     matches the "visible UI is the stable contract" reasoning in the
 *     adapter-authoring strategy ladder — moneycontrol restructures its
 *     internal endpoints far more often than it removes a labeled
 *     "Dividend" section from a stock page.
 *
 * TODO before hackathon demo: re-run `webcmd browser verify
 * dividend-india/moneycontrol-dividend` against the live site and adjust
 * the selector candidates below if devtools shows different markup. The
 * candidate-list-with-fallback approach (try several selectors, first
 * match wins) is intentional — it buys resilience against small markup
 * changes without needing a rewrite.
 */
import { cli, Strategy } from '@agentrhq/webcmd/registry';
import { CommandExecutionError, EmptyResultError } from '@agentrhq/webcmd/errors';

cli({
  site: 'dividend-india',
  name: 'moneycontrol-dividend',
  description: 'Ex-dividend date and per-share amount for an Indian stock, from Moneycontrol',
  access: 'read',
  example: 'webcmd dividend-india moneycontrol-dividend ITC',
  domain: 'www.moneycontrol.com',
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

    // Step 1 (PUBLIC_API evidence): resolve the real quote-page URL via
    // Moneycontrol's own autosuggest endpoint rather than guessing the
    // sector-slug/company-slug/code pattern.
    const resolved = await page.evaluate(`
      (async () => {
        const sym = ${JSON.stringify(symbol)};
        try {
          const url = 'https://www.moneycontrol.com/mccode/common/autosuggesion.php?query=' +
            encodeURIComponent(sym) + '&type=1&format=json';
          const resp = await fetch(url);
          if (!resp.ok) return { error: 'autosuggest HTTP ' + resp.status };
          const data = await resp.json();
          const candidates = Array.isArray(data) ? data : (data?.results || []);
          const match = candidates.find((item) => {
            const s = (item.symbol || item.nse_symbol || item.bse_symbol || '').toUpperCase();
            return s === sym;
          }) || candidates[0];
          const link = match?.link_src || match?.url || match?.link;
          if (!link) return { error: 'no match for symbol' };
          return { quoteUrl: link.startsWith('http') ? link : ('https://www.moneycontrol.com' + link) };
        } catch (e) {
          return { error: 'autosuggest failed: ' + e.message };
        }
      })()
    `);

    if (!resolved || resolved.error || !resolved.quoteUrl) {
      throw new CommandExecutionError(
        `Could not resolve Moneycontrol quote page for ${symbol}: ${resolved?.error || 'unknown error'}`
      );
    }
    const quoteUrl = resolved.quoteUrl;

    // Step 2 (UI_SELECTOR): navigate to the resolved quote page, open the
    // Dividend tab if present, and read the dividend table.
    await page.goto(quoteUrl);
    await page.wait(1);

    const dividendTabSelectors = [
      'a:has-text("Dividend")',
      'a:has-text("Dividends")',
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
        const sectionSelectors = ['#dividend_table', '#dividends', '[id*="dividend" i]'];
        const rowSelectors = [
          '#dividend_table table tbody tr',
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

    // Parse the first row that yields a usable ex-date. A dividend table
    // with zero parseable rows for a real, resolved stock page is a parse
    // failure, not a legitimate "no dividends" result — moneycontrol pages
    // list historical dividends for virtually every listed stock, so an
    // empty parse almost always means our row format assumption broke.
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
