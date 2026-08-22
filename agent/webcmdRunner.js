// Runs our webcmd adapters (webcmd-plugin/dividend-india/*.js) as child
// processes via the `webcmd` CLI, instead of driving Playwright directly
// from this codebase. This is the "Option A" rebuild: dividend lookups are
// now real webcmd commands — `webcmd dividend-india moneycontrol-dividend
// <symbol>` and `webcmd dividend-india tickertape-dividend <symbol>` — so
// the "explore once, learn the workflow, reuse the command" behavior comes
// from webcmd itself (site memory, adapter verification) rather than a
// hand-rolled cache.
//
// Prerequisite: `npm install @agentrhq/webcmd` in this project, and the
// dividend-india plugin installed once via:
//   npx webcmd plugin install file://$PWD/webcmd-plugin/dividend-india
// (see README / SLAB_HACKATHON_NOTES.md for the full one-time setup.)

const { execFile } = require('child_process');
const path = require('path');

const WEBCMD_BIN = path.join(__dirname, '..', 'node_modules', '.bin', 'webcmd');
const EXEC_TIMEOUT_MS = 45000; // dividend lookups involve a real page load; give it room

/**
 * Runs `webcmd dividend-india <command> <symbol> -f json` and parses the
 * JSON result. Never throws — always resolves to either the parsed row or
 * an { error } object, matching the shape server.js/analyzer.js expect
 * from the old scraper functions.
 *
 * @param {string} command 'moneycontrol-dividend' | 'tickertape-dividend'
 * @param {string} stockSymbol
 * @returns {Promise<{ exDate: string, dividendAmount: number, quoteUrl: string } | { error: string }>}
 */
function runDividendCommand(command, stockSymbol) {
  return new Promise((resolve) => {
    execFile(
      WEBCMD_BIN,
      ['dividend-india', command, stockSymbol, '-f', 'json'],
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          // CLI exits non-zero on a typed adapter error (e.g.
          // CommandExecutionError) — stderr/stdout usually still has the
          // useful message; fall back to err.message if not.
          const message = (stderr || stdout || err.message || 'unknown webcmd error').trim();
          resolve({ error: message.slice(0, 300) });
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          const row = Array.isArray(parsed) ? parsed[0] : parsed;
          if (!row || row.error) {
            resolve({ error: row?.error || 'No data returned' });
            return;
          }
          resolve(row);
        } catch (parseErr) {
          resolve({ error: `Could not parse webcmd output: ${parseErr.message}` });
        }
      }
    );
  });
}

/**
 * Cross-references Moneycontrol and Tickertape dividend data for a symbol,
 * running both webcmd commands in parallel. Same output shape as the old
 * getDividendDataCrossReferenced() in agent/scraper.js, so server.js and
 * agent/analyzer.js need no changes.
 *
 * @param {string} stockSymbol
 */
async function getDividendDataCrossReferenced(stockSymbol) {
  const [primary, secondary] = await Promise.all([
    runDividendCommand('moneycontrol-dividend', stockSymbol),
    runDividendCommand('tickertape-dividend', stockSymbol),
  ]);

  const primaryOk = primary && !primary.error;
  const secondaryOk = secondary && !secondary.error;

  if (!primaryOk && !secondaryOk) {
    return { error: primary.error || secondary.error || 'Data not found' };
  }
  if (primaryOk && !secondaryOk) {
    return { ...primary, verified: false, sources: ['Moneycontrol'], note: 'Only one source responded — could not cross-check.' };
  }
  if (!primaryOk && secondaryOk) {
    return { ...secondary, verified: false, sources: ['Tickertape'], note: 'Only one source responded — could not cross-check.' };
  }

  const datesMatch = normalizeDateForComparison(primary.exDate) === normalizeDateForComparison(secondary.exDate)
    && normalizeDateForComparison(primary.exDate) != null;

  if (datesMatch) {
    return {
      exDate: primary.exDate,
      dividendAmount: primary.dividendAmount,
      verified: true,
      sources: ['Moneycontrol', 'Tickertape'],
    };
  }

  return {
    exDate: primary.exDate,
    dividendAmount: primary.dividendAmount,
    verified: false,
    sources: ['Moneycontrol'],
    note: `Sources disagree (Tickertape reported ${secondary.exDate}) — showing Moneycontrol's date, unverified.`,
  };
}

const MONTH_NAMES = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function normalizeDateForComparison(dateStr) {
  if (!dateStr) return null;
  const s = dateStr.trim();
  let m = s.match(/(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2,4})/);
  if (m) {
    const day = parseInt(m[1], 10);
    const monthKey = m[2].slice(0, 3).toLowerCase();
    const month = MONTH_NAMES[monthKey];
    let year = parseInt(m[3], 10);
    if (year < 100) year += 2000;
    if (month != null) return Date.UTC(year, month, day);
  }
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

module.exports = { getDividendDataCrossReferenced, runDividendCommand, getMarketPrice };

/**
 * Wraps `webcmd dividend-india market-price <symbol>`. Same output shape
 * as the old getMarketPrice() in agent/scraper.js: { price } | { error }.
 *
 * @param {string} stockSymbol
 */
async function getMarketPrice(stockSymbol) {
  const row = await runDividendCommand('market-price', stockSymbol);
  if (row.error) return { error: row.error };
  return { price: row.price };
}
