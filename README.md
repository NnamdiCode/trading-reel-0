# TRADING-REEL-NEW

A 9:16 vertical futures replay simulator. Every ticker is locked to its **past
48 hours of completed 15-minute candles** — **192 candles**. That real OHLC
pool feeds the record chart, fills the left-side home area, and creates a unique
chart pattern for each ticker and refresh.

> **Simulation disclosure:** the loaded 15-minute OHLC is real Binance market
> data. The entry and every Studio value are manual. The replay price path, PNL,
> and chart rendering are a simulation shown under the **SIM** badge. This is
> not a live account, a record of real trading, or financial advice. Keep the SIM
> badge and disclosure in every published clip.

**Build:** `2026-11-27C`  
**Cache query:** `v=20261127c`  
**Recording length:** 10–600 seconds  
**Source data:** 192 completed 15-minute candles (48 hours)  
**Chart source pool:** the full 192-candle 48h series  
**Visible chart window:** 96 candles at a time

---

## What this build implements

- **48h / 15m locked source.** Selecting any ticker loads exactly its past 48
  hours of 15-minute candles: **192 completed candles**. The Studio interval is
  locked to 15m, the other timeframe tabs are disabled, and the loader makes
  only `interval=15m` kline requests.
- **Left home area filled.** The full 192-candle pool provides a deep history
  seed (120–156 candles for the selected playback count). The chart's visible
  window is always filled from its left edge; there is no empty “home” gap
  behind the candle strip.
- **Real candle structure.** Every playback candle uses the corresponding real
  15m OHLC: direction, body/wick proportions, high and low. The candle sequence
  changes with the ticker and with each refreshed 48h window.
- **Unique pattern selection.** The planner selects the playback window,
  orientation and turn boundary from the real 192-candle pool. New Pattern and
  each record advance the seed, so the window and candle sequence change.
- **Take length controls playback.** Playback candles are a real slice of the
  selected pattern, not invented. Short takes play them faster; 600-second takes
  play them slower. The chart always completes inside the selected take.
- **Exact turn.** The take clock maps the selected real candle boundary onto the
  exact requested turn second.
- **Per-candle directional movement.** A green candle is animated through
  **high → low → final close**. A red candle is animated through
  **low → high → final close**, inside its real high/low envelope. The live
  close ends on the mapped real close.
- **Fixed reference geometry.** The chart uses 214 slots with a 55% future gap,
  giving 96 on-screen candles; the live candle stays at the 45% boundary. The
  neutral white live line and right-side candle-time tag stay in place.
- **Exact trade anchors.** Playback starts at the manual entry with `PNL 0`. The
  configured max drawdown is the exact minimum. The first positive frame is at
  the requested turn. The final PNL is exactly the manual target.
- **Direction-aware UI.** Long is green `Buy/Long`; short is red `Sell/Short`.
  The short chart is oriented to the short payoff direction.
- **15-language UI.** Arabic RTL remains supported while the chart keeps LTR
  geometry. Korean, Malay and the locked-source labels are included.
- **Hourly verified movers.** The Studio still shows verified top-25 Binance
  USDT gainers/losers, refreshed hourly.

---

## Source and chart planning

```
Ticker selected
  → Binance /api/v3/klines?interval=15m
  → keep only completed candles
  → latest 192 completed candles = past 48 hours
  → select the real playback window whose turn boundary fits the take
  → use the full 192 candles as the chart pool
  → map the real OHLC shapes into:
       manual entry → exact drawdown floor → entry at turn → target
  → play the selected pattern across the chosen takeSeconds
```

The mapping preserves each real candle's **direction and wick/body
proportions**. Price levels are normalized into the Studio's manual entry and
PNL target so the card, chart and values remain synchronized. Source timestamps
stay on the real 15-minute grid.

### Timing

```
source interval       15 minutes
source candles        192 (48 hours)
chart pool            192 candles
chart viewport        214 slots
future gap            55%
on-screen candles     96
active candle         45% boundary
visible history       deep seed: 120–156 candles
turn boundary         exact requested second via two-phase take mapping
playback              selected real slice, completed inside takeSeconds
```

### Candle motion

- **Green final close:** lives through high, then low, then the mapped close.
- **Red final close:** lives through low, then high, then the mapped close.
- The live close, PNL, ROI, mark tag and white line all use the same mark.
- The configured drawdown floor, pre-turn entry limit and post-turn direction
  are enforced in the live mark.

---

## Quick start

```bash
cd "TRADING-REEL-NEW"
python3 -m http.server 8100
```

Open:

- Studio: <http://127.0.0.1:8100/?studio=1&account=4&v=20261127c>
- Clean recording screen: <http://127.0.0.1:8100/?clean=1&account=4&v=20261127c>

For a phone on the same Wi-Fi, replace `127.0.0.1` with the computer's LAN IP.

### Useful URLs

| URL | Result |
|---|---|
| `/?studio=1&account=4` | Studio for profile 4 |
| `/?studio=0&account=4` | Trading UI without Studio |
| `/?clean=1&account=4` | Recording mode, no Studio |
| `?v=20261127c` | Current cache-busted build |

---

## Daily workflow

1. Open the Studio and type or select a ticker.
2. The app loads that ticker's latest 48 hours of 15m candles (192 candles).
3. Set direction, margin mode, leverage, margin and the required manual entry.
4. Set Take length (10–600 s), final PNL target, adverse drawdown, requested
   turn and countdown.
5. Check the preview: 48h data range, pattern, playback/history counts, seconds
   per candle, exact turn, max drawdown, final mark and ROI.
6. Start Android's screen recorder, then press **Start recording**.
7. Record through the target, then stop. Reload to return to the Studio.

The pattern seed advances after a record/apply, giving the next take another real
window/orientation while keeping the entered values.

---

## Numbers

```
size       = margin × leverage ÷ manual entry
notional   = size × manual entry
long PNL   = size × (mark − entry)
short PNL  = size × (entry − mark)
ROI        = PNL ÷ margin × 100

maxLossPnl  = −(drawdownPct/100) × margin
maxLossMark = entry − drawdownPct/100 × margin/size       (long)
endMark     = entry + targetPnl / size                    (long)
```

The entered margin is exact. Editing Size recalculates margin so the equation
stays true. The target changes only the exit mark; entry and size do not move.

### Exact anchors

- **Start:** manual entry, PNL `0`.
- **Minimum:** exact configured drawdown value; never below.
- **Turn:** exact requested second; first positive frame follows.
- **End:** exact entered PNL and calculated ROI.

The chart can display a higher unrealized PNL earlier in the take, just like a
real chart; the **final** value is the specified target.

---

## Data

- `GET https://api.binance.com/api/v3/klines?symbol=…&interval=15m`
- Only completed 15-minute candles are kept.
- The latest **192** completed candles are used (48 hours).
- “Loaded candle range” and the Studio window show the real 48h range.
- Selecting another ticker immediately replaces the source with that ticker's
  own 48h 15m series.
- Top movers use Binance's 24h ticker, exchange-info and product catalog,
  filtered for active spot USDT pairs, at least $1M quote volume, at least
  1,000 trades, and no bStocks/ETF products. The ranking refreshes hourly.
- No account balance, position price, entry, target, margin, drawdown or turn
  is read from the API.

---

## Files

```
TRADING-REEL-NEW/
├── index.html
├── styles.css
├── preview.png
├── check-studio-48h.png
├── check-long-48h.png
├── check-short-48h.png
├── check-600-48h.png
├── README.md
├── assets/
│   ├── logo.png
│   └── trade-icon-mask.png
└── js/
    ├── config.js        daily profiles, viewport and defaults
    ├── data.js          48h/15m Binance loader, CSV fallback, movers
    ├── candle-engine.js fallback OHLC engine
    ├── chart.js         fixed-viewport chart, live tag and white line
    ├── i18n.js          15-language UI dictionary
    └── app.js           48h planner, candle mapping, PNL, Studio, replay
```

The four `check-*-48h.png` files are current build screenshots. `preview.png`
is the final 26-second long screenshot.

---

## Verified checks

- **Source check:** Binance returned 192 completed candles for a ticker; every
  timestamp gap is `900000 ms` (15m); all kline requests use `interval=15m`.
- **Home-area check:** chart pool length **192**, seed **127**, playback **65**,
  viewport **214** slots, **96** visible candles — the left home area is filled.
- **Long 26s SENTUSDT:** exact minimum `−720.00`, first positive at `10.000 s`,
  final `+5,000.00`, ROI `+27.78%`.
- **Short 26s SENTUSDT:** exact minimum `−720.00`, first positive at `10.000 s`,
  final `+5,000.00`, red Sell/Short interface.
- **600s SENTUSDT:** 192-candle source, real-pattern playback, final
  `+5,000.00`, exact turn `300.0 s`, all visible slots filled.
- **Direction audit:** 38/38 tested green candles reached their high before
  their low; 27/27 tested red candles reached their low before their high.
- **Pattern variety:** New Pattern changes the real playback window; different
  tickers produce different source sequences.
- **Studio checks:** interval locked to 15m, source count 192, auto playback
  count, empty debug globals, no console or page errors.

---

## Notes and limits

- Entry must lie inside the loaded 48h candle range. An entry outside it blocks
  recording instead of silently substituting a price.
- The source and playback count fields are read-only because the real 48h data
  and requested turn determine them. Margin, leverage, entry, target, drawdown,
  turn, take, direction, language, branding and the remaining controls stay
  editable.
- A take can be blocked if the drawdown floor crosses Liq. Price or the target
  produces a non-positive exit price.
- Use a local HTTP/HTTPS server for Binance requests; `file://` will not work
  reliably.
- Keep **SIM** visible. Include “simulated historical replay, not financial
  advice” in captions, and do not present the replay as verified live
  performance.
