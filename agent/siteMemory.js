// "Site memory" — a small persistent cache that mirrors the core idea behind
// webcmd (the hackathon's theme): explore a site once, remember what worked,
// and reuse that knowledge on future lookups instead of rediscovering it
// from scratch every time.
//
// What we remember per (source, stockSymbol):
//   - the resolved quote-page URL (so we skip the autosuggest/search step)
//   - which selector (from the candidate arrays in scraper.js) actually
//     matched last time, so we try it first
//   - when it was learned, so we can treat old entries as stale and
//     re-discover rather than trusting a memory that may no longer match
//     the live site
//
// This is intentionally simple (a JSON file, not a database) — the goal is
// to make the "learn once, reuse" behavior visible and demoable, not to
// build a production caching layer.

const fs = require('fs');
const path = require('path');

const MEMORY_FILE = path.join(__dirname, '..', '.site-memory.json');

// How long a learned entry stays trusted before we treat it as stale and
// re-run full discovery. Kept short (7 days) because these are scraper
// selectors against sites we don't control — they can change without notice.
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function loadMemory() {
  try {
    const raw = fs.readFileSync(MEMORY_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    // No file yet, or corrupt — start fresh rather than throwing.
    return {};
  }
}

function saveMemory(memory) {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2), 'utf8');
  } catch (err) {
    // Memory is a nice-to-have, not critical path — never let a write
    // failure (e.g. read-only filesystem) break the actual scrape.
    console.error('[siteMemory] Failed to persist site memory:', err.message);
  }
}

/**
 * Looks up what we remember for a given source ("moneycontrol" | "tickertape")
 * and stock symbol. Returns null if there's nothing remembered, or if what's
 * remembered is older than STALE_AFTER_MS.
 *
 * @param {string} source
 * @param {string} stockSymbol
 * @returns {{ quoteUrl: string, workingSelector: string, learnedAt: number } | null}
 */
function recall(source, stockSymbol) {
  const memory = loadMemory();
  const key = `${source}:${stockSymbol.toUpperCase()}`;
  const entry = memory[key];
  if (!entry) return null;

  const age = Date.now() - entry.learnedAt;
  if (age > STALE_AFTER_MS) {
    return null; // treat as stale — caller will re-discover and re-learn
  }
  return entry;
}

/**
 * Records what worked for a given source + stock symbol, so future lookups
 * can skip straight to it instead of re-running discovery.
 *
 * @param {string} source
 * @param {string} stockSymbol
 * @param {{ quoteUrl?: string, workingSelector?: string }} learned
 */
function remember(source, stockSymbol, learned) {
  const memory = loadMemory();
  const key = `${source}:${stockSymbol.toUpperCase()}`;
  memory[key] = {
    ...memory[key],
    ...learned,
    learnedAt: Date.now(),
  };
  saveMemory(memory);
}

/**
 * Explicitly marks a remembered entry as stale (e.g. because a live scrape
 * using it just failed) so the next lookup re-discovers instead of trusting
 * possibly-outdated memory. Mirrors webcmd's `site endpoint stale` command.
 *
 * @param {string} source
 * @param {string} stockSymbol
 */
function forget(source, stockSymbol) {
  const memory = loadMemory();
  const key = `${source}:${stockSymbol.toUpperCase()}`;
  delete memory[key];
  saveMemory(memory);
}

/**
 * Returns everything currently remembered, for a debug/demo endpoint
 * (e.g. "GET /api/memory") so you can literally show judges the learned
 * cache filling up as they watch.
 */
function dump() {
  return loadMemory();
}

module.exports = { recall, remember, forget, dump };
