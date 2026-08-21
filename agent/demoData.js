// Hardcoded sample data for "Demo Mode".
//
// Purpose: guarantee the demo works even if moneycontrol.com, tickertape.in,
// or NSE are down, slow, rate-limiting us, or have changed their page
// structure. This data never touches the network — it's fed straight into
// the same analyzer functions the live path uses, so the rendering logic on
// screen is identical either way; only the input is canned.
//
// Numbers are illustrative, not live market data.

const DEMO_PORTFOLIO = [
  { symbol: 'ITC', buyPrice: 310.5, quantity: 100 },
  { symbol: 'RELIANCE', buyPrice: 2450, quantity: 20 },
];

const DEMO_MARKET_DATA = {
  ITC: {
    exDate: '15-May-2026',
    dividendAmount: 7.5,
    marketPrice: 412.35,
    verified: true,
    sources: ['Moneycontrol', 'Tickertape'],
  },
  RELIANCE: {
    exDate: '28-Aug-2026',
    dividendAmount: 9.0,
    marketPrice: 2986.4,
    verified: false,
    sources: ['Moneycontrol'],
    note: 'Only one source responded — could not cross-check. (Demo data)',
  },
};

module.exports = { DEMO_PORTFOLIO, DEMO_MARKET_DATA };
