/**
 * IKEA TH stock monitor.
 *
 * Watches a single product page for availability and pushes a LINE message
 * the first time it goes from "Coming soon" / out-of-stock to in-stock.
 *
 * Uses a simple file-based sentinel (`.notified`) to avoid spamming you on
 * every subsequent run. Delete the file (or this whole monitor) when done.
 *
 * Secrets (env vars only — never hardcoded):
 *   LINE_CHANNEL_TOKEN  - LINE Messaging API channel access token
 *   LINE_USER_ID        - your LINE user ID (recipient)
 */

const fs = require('fs');
const path = require('path');

// ---- CONFIG ---------------------------------------------------------------

const CONFIG = {
  productUrl:
    'https://www.ikea.com/th/en/p/ikea-ps-2026-floor-uplighter-dark-red-40608505/',
  productName: 'IKEA PS 2026 Floor uplighter, dark red',
  articleNumber: '406.085.05',
  priceTHB: 1290,

  // Anti-spam: once we send the "in stock" alert we touch this file. The
  // GitHub Actions workflow commits it back to the repo so future runs see
  // it and stay quiet. Delete it in the repo to re-arm the alert.
  sentinelPath: path.join(__dirname, '..', '.notified'),

  // Allowlist: the script will refuse to fetch anything else.
  allowedHosts: ['www.ikea.com'],

  fetchTimeoutMs: 20000,
};

// ---- UTIL -----------------------------------------------------------------

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function assertAllowedUrl(url) {
  const host = new URL(url).host;
  if (!CONFIG.allowedHosts.includes(host)) {
    throw new Error(`Refusing to fetch non-allowlisted host: ${host}`);
  }
}

// ---- FETCH & DETECT -------------------------------------------------------

async function fetchPage(url) {
  assertAllowedUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.fetchTimeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // A plausible browser UA. IKEA's product pages are publicly readable
        // and don't require auth; this is just to avoid being treated as a
        // headless/bot client.
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'en-TH,en;q=0.9,th;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decide availability from page HTML. Returns one of:
 *   'available' | 'coming_soon' | 'out_of_stock' | 'unknown'
 *
 * Multiple signals are checked because IKEA's markup varies by state. An
 * "unknown" result is treated as not-available (we'd rather miss a false
 * positive than send a wrong alert).
 */
function detectAvailability(html) {
  // 1) Strongest signal: schema.org structured data is per-product, not
  //    affected by sidebars/recommendations. Check this first.
  if (/"availability"\s*:\s*"(https?:\/\/schema\.org\/)?InStock"/i.test(html)) {
    return 'available';
  }
  if (/"availability"\s*:\s*"(https?:\/\/schema\.org\/)?(OutOfStock|SoldOut)"/i.test(html)) {
    return 'out_of_stock';
  }
  if (/"availability"\s*:\s*"(https?:\/\/schema\.org\/)?PreOrder"/i.test(html)) {
    return 'coming_soon';
  }

  // 2) Negative text signals — only trusted when structured data is absent.
  if (/\bcoming soon\b/i.test(html)) return 'coming_soon';

  const oosPatterns = [
    /\bout of stock\b/i,
    /\bsold out\b/i,
    /\bnot available\b/i,
    /สินค้าหมด/, // Thai "out of stock"
    /หมดชั่วคราว/, // Thai "temporarily out"
  ];
  if (oosPatterns.some((p) => p.test(html))) return 'out_of_stock';

  // 3) Positive text signals as a fallback.
  const inStockPatterns = [
    /add to (bag|cart)/i,
    /buy now/i,
  ];
  if (inStockPatterns.some((p) => p.test(html))) return 'available';

  return 'unknown';
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
  // If we've already alerted, stay quiet. (Workflow commits this file back.)
  if (fs.existsSync(CONFIG.sentinelPath)) {
    log('Sentinel exists — already notified. Exiting.');
    log('Delete .notified in the repo to re-arm.');
    return;
  }

  log('Fetching', CONFIG.productUrl);
  let html;
  try {
    html = await fetchPage(CONFIG.productUrl);
  } catch (err) {
    log('Fetch failed:', err.message);
    process.exitCode = 1;
    return;
  }

  const status = detectAvailability(html);
  log('Detected status:', status);

  if (status !== 'available') {
    log('Not available yet. No notification sent.');
    return;
  }

  const message =
    '🛋️ IKEA stock alert!\n' +
    `${CONFIG.productName} is AVAILABLE.\n` +
    `Price: THB ${CONFIG.priceTHB.toLocaleString()}\n` +
    `Article: ${CONFIG.articleNumber}\n` +
    `Buy: ${CONFIG.productUrl}\n\n` +
    'You won\'t get another alert. Disable the GitHub workflow when you\'re done.';

  await notifyLine(message);

  // Mark as notified so future runs stay quiet. The workflow commits this.
  fs.writeFileSync(
    CONFIG.sentinelPath,
    `notified_at=${new Date().toISOString()}\n`
  );
  log('Sentinel written:', CONFIG.sentinelPath);
}

run().catch((err) => {
  log('Fatal error:', err.message);
  process.exitCode = 1;
});
