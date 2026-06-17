# IKEA Stock Monitor

Watches a single IKEA Thailand product page and sends a **LINE** push the
first time it goes in stock. Re-uses the LINE bot + GitHub Actions setup
from the previous (Garuda) project.

- **Product:** IKEA PS 2026 Floor uplighter, dark red (article 406.085.05)
- **URL:** https://www.ikea.com/th/en/p/ikea-ps-2026-floor-uplighter-dark-red-40608505/
- **Schedule:** every 6 hours, free, on GitHub Actions
- **Sends exactly one alert**, then stays quiet (sentinel file commits back to the repo).

---

## How it works

1. GitHub Actions runs `src/monitor.js` on a 6-hour cron.
2. The script does a single HTTP fetch of the product page (no Playwright,
   no headless browser — IKEA serves stock info in plain HTML).
3. It checks the page in priority order:
   - **schema.org structured data** (most reliable, per-product)
   - **"Coming soon" / "Out of stock" / Thai equivalents** (negative signals)
   - **"Add to bag" / "Buy now"** (positive fallback)
4. If `available`, it pushes a LINE message and writes a `.notified` file.
5. The workflow commits `.notified` back to the repo so future runs see it
   and stay quiet — you get exactly one alert.

---

## Migrating from the Garuda monitor

If you still have the Garuda repo locally, the simplest path is to **replace
the project files in your existing repo** and reuse the same LINE secrets.
Everything carries over: the GitHub repo, the secrets, even the LINE bot.

1. Replace these files in your existing repo with the new versions:
   - `src/monitor.js`
   - `src/test-line.js` (only the message text changed)
   - `package.json` (Playwright dependency removed)
   - `.github/workflows/monitor.yml`
   - `README.md`
2. Delete `node_modules/` and `package-lock.json` since Playwright is gone:
   ```bash
   rm -rf node_modules package-lock.json
   ```
3. Optionally rename the repo on GitHub (Settings → rename to
   `ikea-stock-monitor`). Not required.
4. Commit and push:
   ```bash
   git add .
   git rm -f src/monitor.js   # if old file isn't replaced cleanly
   git commit -m "Repurpose: IKEA stock monitor"
   git push
   ```
5. The workflow re-enables automatically on the next cron tick. To verify
   immediately, trigger it manually: **Actions → IKEA Stock Monitor → Run workflow**.

If you'd rather start fresh, just create a new repo and add the same two
secrets (`LINE_CHANNEL_TOKEN`, `LINE_USER_ID`) you already have.

---

## Watching a different product

Edit `CONFIG` at the top of `src/monitor.js`:

```js
const CONFIG = {
  productUrl: 'https://www.ikea.com/th/en/p/your-product-here/',
  productName: 'Your product name',
  articleNumber: '000.000.00',
  priceTHB: 0,
  ...
};
```

The detection logic is generic — it works for any IKEA TH product page.

---

## Resetting the alert

To re-arm the alert (e.g. you want to be notified again, or you're testing):

- **Easy way:** delete `.notified` in the repo (via GitHub UI: open the file,
  click 🗑️). Next run will alert again.
- Or locally: `rm .notified && git commit -am "reset" && git push`.

---

## Tuning

- **Cadence:** edit the cron in `.github/workflows/monitor.yml`. Every 6 hours
  is fine for IKEA — they don't restock that frequently.
- **Detection rules:** edit `detectAvailability()` in `src/monitor.js`. If you
  see odd results, add `console.log(html.slice(0, 2000))` temporarily and
  check the Actions log to see what IKEA actually returns.

---

## Security notes

- Secrets live only in **GitHub Actions Secrets** and are injected as env vars.
- The script's network access is **host-allowlisted** to `www.ikea.com` and
  the LINE API; it refuses other hosts.
- It treats page content as **data, not instructions**.
- It doesn't log in, doesn't enter personal/payment info, and uses no
  user-specific cookies.

---

## Files

```
ikea-stock-monitor/
├── .github/workflows/monitor.yml   # 6-hour cron + sentinel commit-back
├── src/monitor.js                  # fetch + detect + notify
├── src/test-line.js                # one-off LINE test
├── package.json                    # no dependencies (uses built-in fetch)
├── .gitignore
└── README.md
```
