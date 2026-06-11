import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import YahooFinance from 'yahoo-finance2';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3001;
const yf   = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

app.use(express.static(join(__dirname, 'public')));
app.use(express.json());

/* ── EDGAR helpers ─────────────────────────────────────────── */

// SEC requires a User-Agent header identifying the app
const SEC_HEADERS = {
  'User-Agent': 'DCF-Builder/1.0 rishipatari@gmail.com',
  'Accept':     'application/json',
};

async function secGet(url) {
  const r = await fetch(url, { headers: SEC_HEADERS });
  if (!r.ok) throw new Error(`SEC EDGAR ${r.status} — ${url}`);
  return r.json();
}

// Cache the ticker→CIK map in memory (it's ~2 MB, fetched once)
let tickerMap = null;
async function lookupCIK(ticker) {
  if (!tickerMap) {
    const raw = await secGet('https://www.sec.gov/files/company_tickers.json');
    tickerMap = {};
    for (const entry of Object.values(raw)) {
      tickerMap[entry.ticker.toUpperCase()] = String(entry.cik_str).padStart(10, '0');
    }
  }
  const cik = tickerMap[ticker.toUpperCase()];
  if (!cik) throw new Error(`"${ticker}" not found in SEC EDGAR`);
  return cik;
}

/*
 * Extract the most recent `limit` annual (10-K) values for a concept.
 * EDGAR returns every amendment; we keep the last-filed value per fiscal year.
 * Returns [{year, date, value}] sorted newest-first.
 */
function extractAnnual(concept, limit = 5) {
  if (!concept?.units) return [];
  const vals = concept.units.USD ?? concept.units.shares ?? concept.units.pure ?? [];

  // Keep only 10-K / 10-K/A full-year entries
  const annual = vals.filter(u =>
    (u.form === '10-K' || u.form === '10-K/A') && u.fp === 'FY'
  );

  // Deduplicate by fiscal year, keeping the most-recently filed entry
  const byFY = {};
  for (const u of annual) {
    if (!byFY[u.fy] || u.filed > byFY[u.fy].filed) byFY[u.fy] = u;
  }

  return Object.values(byFY)
    .sort((a, b) => b.fy - a.fy)
    .slice(0, limit)
    .map(u => ({ year: String(u.fy), date: u.end, value: u.val }));
}

// Try a list of XBRL concept names; return data from first one that has ≥1 entry
function pick(gaap, ...names) {
  for (const n of names) {
    if (gaap[n]) {
      const data = extractAnnual(gaap[n]);
      if (data.length) return data;
    }
  }
  return [];
}

function toMap(arr) {
  const m = {};
  for (const { year, value } of arr) m[year] = value;
  return m;
}

/* ── Route ──────────────────────────────────────────────────── */
app.get('/api/financials/:ticker', async (req, res) => {
  const symbol = req.params.ticker.toUpperCase();

  try {
    // ── 1. Resolve CIK ──
    const cik = await lookupCIK(symbol);

    // ── 2. Fetch all XBRL company facts from EDGAR ──
    const facts = await secGet(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`);
    const gaap = facts.facts?.['us-gaap'];
    if (!gaap) throw new Error('No US-GAAP XBRL data found in EDGAR for this ticker');

    // ── 3. Pull each metric (try multiple tag variants) ──
    const revenue = pick(gaap,
      'Revenues',
      'RevenueFromContractWithCustomerExcludingAssessedTax',
      'SalesRevenueNet',
      'RevenuesNetOfInterestExpense',
      'SalesRevenueGoodsNet',
    );
    const grossProfit     = pick(gaap, 'GrossProfit');
    const operatingIncome = pick(gaap, 'OperatingIncomeLoss');
    const netIncome       = pick(gaap, 'NetIncomeLoss', 'ProfitLoss');
    const operatingCF     = pick(gaap, 'NetCashProvidedByUsedInOperatingActivities');
    // CapEx is a payment (positive in EDGAR); we store it positive and negate later
    const capex           = pick(gaap,
      'PaymentsToAcquirePropertyPlantAndEquipment',
      'CapitalExpenditureDiscontinuedOperations',
    );
    const cashEq          = pick(gaap,
      'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
      'CashAndCashEquivalentsAtCarryingValue',
      'CashCashEquivalentsAndShortTermInvestments',
    );
    const longTermDebt    = pick(gaap, 'LongTermDebtNoncurrent', 'LongTermDebt');
    const shortTermDebt   = pick(gaap, 'ShortTermBorrowings', 'DebtCurrent');
    const sharesOut       = pick(gaap, 'CommonStockSharesOutstanding');

    if (operatingCF.length < 2) {
      throw new Error('Fewer than 2 years of operating cash flow on EDGAR — try a different ticker');
    }

    // ── 4. Fetch current price, market cap, beta, sector from Yahoo Finance ──
    //    (Yahoo price module still works reliably even post-Nov 2024)
    let live = { price: 0, mktCap: 0, beta: 1.0, companyName: facts.entityName, sector: '' };
    try {
      const yfResult = await yf.quoteSummary(symbol, {
        modules: ['price', 'defaultKeyStatistics', 'assetProfile'],
      }, { validateResult: false });
      live = {
        price:       yfResult.price?.regularMarketPrice  ?? 0,
        mktCap:      yfResult.price?.marketCap            ?? 0,
        beta:        yfResult.defaultKeyStatistics?.beta  ?? 1.0,
        companyName: yfResult.price?.longName ?? yfResult.price?.shortName ?? facts.entityName,
        sector:      yfResult.assetProfile?.sector ?? '',
      };
    } catch (_) { /* use defaults if Yahoo fails */ }

    // ── 5. Align years across all data (use OpCF years as anchor) ──
    const years = operatingCF.map(y => y.year);

    const revM  = toMap(revenue);
    const gpM   = toMap(grossProfit);
    const ebitM = toMap(operatingIncome);
    const niM   = toMap(netIncome);
    const ocfM  = toMap(operatingCF);
    const cxM   = toMap(capex);
    const cashM = toMap(cashEq);
    const ltdM  = toMap(longTermDebt);
    const stdM  = toMap(shortTermDebt);
    const shrM  = toMap(sharesOut);

    // Shares: latest EDGAR data, fall back to Yahoo mktCap/price
    const latestYear  = years[0];
    const sharesValue = shrM[latestYear]
      ?? (live.mktCap && live.price ? live.mktCap / live.price : 1);

    // ── 6. Shape response identical to what the frontend expects ──
    const profile = [{
      symbol,
      companyName:       live.companyName,
      sector:            live.sector,
      price:             live.price,
      mktCap:            live.mktCap,
      beta:              live.beta,
      sharesOutstanding: sharesValue,
    }];

    const income = years.map(yr => ({
      calendarYear:    yr,
      revenue:         revM[yr]  ?? 0,
      grossProfit:     gpM[yr]   ?? 0,
      operatingIncome: ebitM[yr] ?? 0,
      netIncome:       niM[yr]   ?? 0,
    }));

    const cashFlow = years.map(yr => {
      const ocf = ocfM[yr] ?? 0;
      const cx  = cxM[yr]  ?? 0;   // positive in EDGAR
      return {
        calendarYear:      yr,
        operatingCashFlow: ocf,
        capitalExpenditure: -cx,    // make negative (outflow convention)
        freeCashFlow:       ocf - cx,
      };
    });

    const balanceSheet = years.map(yr => ({
      calendarYear:           yr,
      cashAndCashEquivalents: cashM[yr] ?? 0,
      totalDebt:              (ltdM[yr] ?? 0) + (stdM[yr] ?? 0),
    }));

    res.json({ income, balanceSheet, cashFlow, profile });

  } catch (err) {
    const code = err.message?.includes('not found') ? 404 : 500;
    res.status(code).json({ error: err.message });
  }
});

/* ── Recommended comparables via Yahoo Finance ───────────── */
app.get('/api/comps/:ticker', async (req, res) => {
  const symbol = req.params.ticker.toUpperCase();
  const clean = s => s && s !== symbol && !s.includes('.') && /^[A-Z]{1,5}$/.test(s);

  try {
    // Round 1: primary recommendations for the subject
    const primary = await yf.recommendationsBySymbol(symbol, {}, { validateResult: false });
    const primaryRecs = (primary?.recommendedSymbols ?? []).filter(r => clean(r.symbol));

    // Round 2: recommendations for each primary peer (parallel)
    const secondaryResults = await Promise.allSettled(
      primaryRecs.slice(0, 6).map(r =>
        yf.recommendationsBySymbol(r.symbol, {}, { validateResult: false })
      )
    );

    // Score pool: primary recs weighted 3×, secondary weighted 1×
    const scores = {};
    for (const r of primaryRecs) {
      scores[r.symbol] = (scores[r.symbol] ?? 0) + (r.score ?? 0.5) * 3;
    }
    for (const result of secondaryResults) {
      if (result.status !== 'fulfilled') continue;
      for (const r of result.value?.recommendedSymbols ?? []) {
        if (!clean(r.symbol)) continue;
        scores[r.symbol] = (scores[r.symbol] ?? 0) + (r.score ?? 0.5);
      }
    }

    const symbols = Object.entries(scores)
      .sort((a, b) => b[1] - a[1])
      .map(([sym]) => sym)
      .slice(0, 10);

    res.json({ symbols });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Ticker search / autocomplete ───────────────────────── */
app.get('/api/search', async (req, res) => {
  const query = (req.query.q ?? '').trim();
  if (!query) return res.json({ quotes: [] });
  try {
    const result = await yf.search(query, { quotesCount: 10, newsCount: 0 }, { validateResult: false });
    const quotes = (result.quotes ?? [])
      .filter(q => q.quoteType === 'EQUITY' && q.symbol && !q.symbol.includes('.'))
      .slice(0, 8)
      .map(q => ({ symbol: q.symbol, name: q.shortname ?? q.longname ?? q.symbol }));
    res.json({ quotes });
  } catch (err) {
    res.status(500).json({ error: err.message, quotes: [] });
  }
});

/* ── Quick quote for comps ───────────────────────────────── */
app.get('/api/quote/:ticker', async (req, res) => {
  const symbol = req.params.ticker.toUpperCase();
  try {
    const result = await yf.quoteSummary(symbol, {
      modules: ['price', 'defaultKeyStatistics', 'financialData', 'summaryDetail'],
    }, { validateResult: false });

    const p  = result.price                ?? {};
    const ks = result.defaultKeyStatistics ?? {};
    const fd = result.financialData        ?? {};
    const sd = result.summaryDetail        ?? {};

    res.json({
      symbol,
      name:          p.longName ?? p.shortName ?? symbol,
      price:         p.regularMarketPrice     ?? 0,
      mktCap:        p.marketCap              ?? 0,
      ev:            ks.enterpriseValue       ?? 0,
      revenue:       fd.totalRevenue          ?? 0,
      ebitda:        fd.ebitda               ?? 0,
      evEbitda:      ks.enterpriseToEbitda   ?? null,
      evRevenue:     ks.enterpriseToRevenue  ?? null,
      pe:            sd.trailingPE ?? p.trailingPE ?? null,
      forwardPE:     ks.forwardPE            ?? null,
      beta:          ks.beta                 ?? null,
      grossMargin:   fd.grossMargins         ?? null,
      ebitdaMargin:  fd.ebitdaMargins        ?? null,
      fcf:           fd.freeCashflow         ?? 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, symbol });
  }
});

app.listen(PORT, () =>
  console.log(`DCF Builder  →  http://localhost:${PORT}`)
);
