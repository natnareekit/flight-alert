# Garuda BKK ↔ SOQ Fare Monitor

Watches the public Garuda Indonesia website for your round-trip Economy fare
and sends a **LINE** notification when the price drops below your baseline.

- **Outbound:** Bangkok (BKK) → Sorong (SOQ), 13 Nov 2026
- **Return:** Sorong (SOQ) → Bangkok (BKK), 21 Nov 2026
- **Baselines:** outbound 18,280 · return 19,705 · combined 37,985 THB
- **Schedule:** every 6 hours, free, on GitHub Actions
- **No login, no payment data, ever.**

---

## How it works

1. GitHub Actions runs `src/monitor.js` on a 6-hour cron.
2. Playwright (headless Chromium) opens Garuda's flight-select page and reads
   the lowest Economy fares.
3. If a fare is below your baseline, it POSTs to the LINE Messaging API and you
   get a push message. If nothing dropped, it stays silent.
4. On a scrape failure it sends **nothing** and marks the run failed, so you can
   inspect logs rather than get spammed by false alarms.

---

## Setup

### 1. Create the LINE bot (one time, free)

1. Go to the [LINE Developers Console](https://developers.line.biz/) and log in.
2. Create a **Provider**, then a **Messaging API channel** under it.
3. Open the channel → **Messaging API** tab → issue a **Channel access token**
   (long-lived is simplest). Copy it. This is your `LINE_CHANNEL_TOKEN`.
4. Add the bot as a friend: scan the channel's QR code with your LINE app, or
   tap the "Add friend" link. **You must be friends with the bot or push will
   fail.**
5. Get your **own User ID** (`LINE_USER_ID`, starts with `U...`):
   - Easiest: the **Basic settings** tab shows "Your user ID" for the channel
     owner, OR
   - Set up the webhook and read the `userId` from an incoming message event, OR
   - Use the channel's **LINE Official Account Manager** → leave it and message
     the bot, then read the event.

> LINE Notify was shut down in March 2025 — the Messaging API above is the
> current, supported path.

### 2. Test LINE before trusting the monitor

Locally:

```bash
npm install
LINE_CHANNEL_TOKEN="your_token" LINE_USER_ID="Uxxxxxxxx" npm run test:line
```

You should get a test message in LINE within seconds. If you get `403`, you
aren't friends with the bot. If `401`, the token is wrong.

### 3. Put it on GitHub

```bash
cd garuda-fare-monitor
git init
git add .
git commit -m "Garuda fare monitor"
# create an EMPTY repo on github.com first, then:
git remote add origin https://github.com/<you>/garuda-fare-monitor.git
git push -u origin main
```

### 4. Add your secrets (NOT in code)

In the GitHub repo: **Settings → Secrets and variables → Actions → New
repository secret**. Add two:

| Name                 | Value                          |
| -------------------- | ------------------------------ |
| `LINE_CHANNEL_TOKEN` | your channel access token      |
| `LINE_USER_ID`       | your `U...` user ID            |

### 5. Turn it on

- Go to the **Actions** tab, enable workflows if prompted.
- Click **Garuda Fare Monitor → Run workflow** to test once manually.
- After that it runs automatically every 6 hours.

---

## Important: verify the scrape on the first runs

Garuda's site is JavaScript-heavy and its HTML structure changes over time.
The scraper uses a **defensive best-effort read** (it scans fare-card text and
takes the lowest plausible fares) rather than one brittle selector.

**On your first manual run, check the Actions log:**

- If it logs `Read fares: { outbound: ..., return: ... }` with sane numbers —
  great, you're done.
- If it logs `NO_DATA` and a `Sample text captured: [...]`, the page either
  didn't render in time or the deep-link format changed. Fixes, in order:
  1. Increase `renderWaitMs` in `src/monitor.js` (try 12000).
  2. Open `CONFIG.searchUrl` in your own browser. If it doesn't land on a fare
     list, copy the real URL from your browser's address bar after searching
     manually, and paste it into `CONFIG.searchUrl`.
  3. Look at the `Sample text captured` array to see what text the page exposed,
     and tighten the selectors in `readFares()`.

This is the one part that may need a small tweak — everything else (compare
logic, LINE push, scheduling, secrets) is solid.

---

## Tuning

- **Change cadence:** edit the `cron` line in `.github/workflows/monitor.yml`.
  `17 0,6,12,18 * * *` = every 6 hours. Don't go below ~4 hours; it risks
  bot-blocking for no real benefit since fares don't move that fast.
- **Change thresholds / dates:** edit `CONFIG` at the top of `src/monitor.js`.
- **Back off if blocked:** if you start seeing CAPTCHAs or repeated `NO_DATA`,
  widen the cron to every 12 hours.

---

## Security notes

- Secrets live only in **GitHub Actions Secrets** and are injected as env vars
  at runtime. They are never written to code or logs.
- The script **only** navigates to `garuda-indonesia.com` (host-allowlisted)
  and the LINE API. It refuses other hosts.
- It treats all page content as **untrusted data** — it reads prices and does
  nothing else. It never follows text/instructions found on the page.
- It never logs in, never enters personal or payment information, and never
  attempts to bypass CAPTCHAs or login walls.
- `.gitignore` keeps `node_modules` and any local `.env` out of version control.

---

## Files

```
garuda-fare-monitor/
├── .github/workflows/monitor.yml   # 6-hour cron + CI
├── src/monitor.js                  # scrape + compare + notify
├── src/test-line.js                # one-off LINE test
├── package.json
├── .gitignore
└── README.md
```
