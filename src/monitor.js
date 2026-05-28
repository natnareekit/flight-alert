/**
 * Garuda BKK <-> SOQ round-trip fare monitor.
 *
 * Reads public Economy fares from the Garuda Indonesia website, compares them
 * to baseline thresholds, and pushes a LINE notification when a price drops.
 *
 * It NEVER logs in, never enters personal/payment data, and treats all page
 * content as untrusted data (never as instructions).
 *
 * Secrets are read from environment variables only:
 *   LINE_CHANNEL_TOKEN  - LINE Messaging API channel access token
 *   LINE_USER_ID        - your own LINE user ID (the recipient)
 */

const { chromium } = require('playwright');

// ---- CONFIG ---------------------------------------------------------------

const CONFIG = {
  // Trip definition
  origin: 'BKK',
  destination: 'SOQ',
  outboundDate: '2026-11-13',
  returnDate: '2026-11-21',
  adults: 1,
  cabin: 'Economy',

  // Baseline prices in THB. Alert only when CURRENT price is BELOW these.
  baseline: {
    outbound: 18280,
    return: 19705,
    combined: 37985,
  },

  // Adjacent return dates that were notably cheaper - flag if <= this value.
  cheapReturnWatch: {
    threshold: 12675,
    dates: ['2026-11-20', '2026-11-22'],
  },

  // Direct deep-link into the Garuda booking flow. This is the most reliable
  // entry point; the homepage form is JS-heavy and changes often.
  // Format mirrors Garuda's IBE flight-select URL. Adjust if Garuda changes it.
  searchUrl:
    'https://www.garuda-indonesia.com/th/th/booking/flight-select' +
    '?tripType=RT' +
    '&origin=BKK&destination=SOQ' +
    '&departureDate=2026-11-13&returnDate=2026-11-21' +
    '&adult=1&child=0&infant=0&cabinClass=Economy',

  homeUrl: 'https://www.garuda-indonesia.com/th/th/',

  // Safety: only these hosts may ever be navigated to.
  allowedHosts: ['www.garuda-indonesia.com', 'garuda-indonesia.com'],

  maxAttempts: 2,
  navTimeoutMs: 60000,
  renderWaitMs: 8000,
};

// ---- UTIL -----------------------------------------------------------------

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/**
 * Parse a THB price out of arbitrary text, e.g. "THB 18,280.00" -> 18280.
 * Returns null if nothing sane is found.
 */
function parseThb(text) {
  if (!text) return null;
  // Look for "THB" followed by a number, or just a number with thousands sep.
  const m = text.replace(/\u00a0/g, ' ').match(/(?:THB|฿)?\s*([\d,]{3,})(?:\.\d{2})?/);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

function assertAllowedUrl(url) {
  const host = new URL(url).host;
  if (!CONFIG.allowedHosts.includes(host)) {
    throw new Error(`Refusing to navigate to non-allowlisted host: ${host}`);
  }
}

// ---- SCRAPE ---------------------------------------------------------------

/**
 * Returns { outbound, return: <num|null> } in THB, or throws on hard failure.
 * Selectors are intentionally defensive: Garuda's DOM changes, so we fall back
 * to scanning fare-card text rather than relying on one brittle selector.
 */
async function readFares(page) {
  assertAllowedUrl(CONFIG.searchUrl);
  await page.goto(CONFIG.searchUrl, {
    waitUntil: 'domcontentloaded',
    timeout: CONFIG.navTimeoutMs,
  });

  // Dismiss cookie/consent banners with the most privacy-preserving choice.
  await dismissConsent(page);

  // Give the JS fare results time to render.
  await page.waitForTimeout(CONFIG.renderWaitMs);

  // Strategy: collect text from elements that look like fare cards, then pick
  // the lowest Economy price for each leg. Garuda groups outbound and return
  // into separate panels; we read them in document order (outbound first).
  const prices = await page.evaluate(() => {
    const texts = [];
    // Candidate fare containers - broad net, filtered in Node below.
    const nodes = document.querySelectorAll(
      '[class*="fare" i], [class*="price" i], [class*="amount" i], [data-testid*="price" i]'
    );
    nodes.forEach((n) => {
      const t = (n.textContent || '').trim();
      // Exclude loyalty/miles strings so "Earn 1757 miles" never reads as a fare.
      if (/mile|point|คะแนน|ไมล์/i.test(t)) return;
      if (t && /\d{3,}/.test(t) && t.length < 120) texts.push(t);
    });
    return texts;
  });

  const numbers = prices
    .map(parseThb)
    // Real BKK<->SOQ fares are well above THB 5,000; this excludes stray
    // small numbers (miles, counts) that slip through the text filter.
    .filter((n) => n !== null && n > 5000 && n < 500000);

  if (numbers.length === 0) {
    return { outbound: null, return: null, raw: prices };
  }

  // Heuristic: the page renders outbound options first, then return options.
  // Without a reliable structural anchor we take the two lowest distinct
  // plausible fares. This is a best-effort read; verify against the live site
  // the first few runs and tighten selectors if needed.
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  return {
    outbound: sorted[0] ?? null,
    return: sorted[1] ?? sorted[0] ?? null,
    raw: prices,
  };
}

async function dismissConsent(page) {
  const rejectSelectors = [
    'button:has-text("Reject")',
    'button:has-text("Decline")',
    'button:has-text("ปฏิเสธ")', // Thai "reject"
    'button:has-text("Only necessary")',
    '[aria-label*="reject" i]',
  ];
  for (const sel of rejectSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click({ timeout: 2000 });
        log('Dismissed consent via', sel);
        return;
      }
    } catch (_) {
      /* keep trying */
    }
  }
  // If no reject option, accept-only banners are left untouched; do not
  // auto-accept tracking unless absolutely required to proceed.
}

// ---- DECISION -------------------------------------------------------------

function evaluate(fares) {
  const reasons = [];
  const { outbound, return: ret } = fares;
  const b = CONFIG.baseline;

  if (outbound != null && outbound < b.outbound) {
    reasons.push(`Outbound BKK→SOQ dropped to THB ${outbound.toLocaleString()} (was ${b.outbound.toLocaleString()})`);
  }
  if (ret != null && ret < b.return) {
    reasons.push(`Return SOQ→BKK dropped to THB ${ret.toLocaleString()} (was ${b.return.toLocaleString()})`);
  }
  if (outbound != null && ret != null) {
    const combined = outbound + ret;
    if (combined < b.combined) {
      reasons.push(`Combined dropped to THB ${combined.toLocaleString()} (was ${b.combined.toLocaleString()})`);
    }
  }
  return reasons;
}

// ---- NOTIFY ---------------------------------------------------------------

async function notifyLine(message) {
  const token = process.env.LINE_CHANNEL_TOKEN;
  const userId = process.env.LINE_USER_ID;
  if (!token || !userId) {
    throw new Error('Missing LINE_CHANNEL_TOKEN or LINE_USER_ID env vars.');
  }

  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      to: userId,
      messages: [{ type: 'text', text: message }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LINE push failed: ${res.status} ${body}`);
  }
  log('LINE notification sent.');
}

// ---- MAIN -----------------------------------------------------------------

async function run() {
  let fares = null;
  let lastErr = null;

  for (let attempt = 1; attempt <= CONFIG.maxAttempts; attempt++) {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({
        locale: 'th-TH',
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        viewport: { width: 1280, height: 1800 },
      });
      const page = await context.newPage();
      log(`Attempt ${attempt}: reading fares...`);
      fares = await readFares(page);
      await browser.close();
      if (fares.outbound != null) break;
    } catch (err) {
      lastErr = err;
      log(`Attempt ${attempt} failed:`, err.message);
      try { await browser.close(); } catch (_) {}
    }
  }

  if (!fares || fares.outbound == null) {
    log('NO_DATA - could not read fares.', lastErr ? lastErr.message : '');
    log('Sample text captured:', JSON.stringify((fares && fares.raw || []).slice(0, 10)));
    // Do NOT spam LINE on scrape failures. Exit non-zero so the CI run is
    // marked failed and you can inspect logs.
    process.exitCode = 1;
    return;
  }

  log('Read fares:', { outbound: fares.outbound, return: fares.return });

  const reasons = evaluate(fares);
  if (reasons.length === 0) {
    log('No drop below baseline. Nothing to send.');
    return;
  }

  const msg =
    '✈️ Garuda fare drop!\n' +
    reasons.join('\n') +
    `\n\nBKK→SOQ ${CONFIG.outboundDate}, SOQ→BKK ${CONFIG.returnDate}` +
    `\nCheck: ${CONFIG.homeUrl}`;

  await notifyLine(msg);
}

run().catch((err) => {
  log('Fatal error:', err.message);
  process.exitCode = 1;
});
