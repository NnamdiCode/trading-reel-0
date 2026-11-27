/**
 * trading-reel-1 — easy-edit configuration
 * ---------------------------------------------------------------------------
 * Everything you normally change is in this file.
 *
 * IMPORTANT
 * PNL is calculated from real historical candles. The entry price is always a
 * required manual input and is never taken from the API. Position size is
 * calculated as marginUsd × leverage ÷ entryPrice and the entered margin is
 * used exactly.
 *
 * The final PNL target is editable: the app solves an exit mark inside a real
 * candle that hits that target. The adverse drawdown is the exact maximum loss
 * of the take: playback starts at the manual entry with PNL 0, reaches that
 * floor once during the loss span and never goes below it. turnSeconds is the
 * exact PNL-0 time on the single take clock, measured from the first recorded
 * frame after the countdown hold. The chart is locked to each ticker's
 * completed past 48 hours of 15m candles. The selected take length and the
 * actual pattern choose how many of those 15m candles play back and how fast;
 * the chart still completes inside the take. The entry and every other Studio
 * value stay manual.
 *
 * The five account profiles below are the five reel profiles. The app loads
 * the single profile selected by ?account=1…5 (or the saved profile) so the
 * ticker can change without adding a new profile. Open the pre-record Studio,
 * check the preview, then use Start recording. The Studio also exposes take
 * length, countdown, margin mode and an optional preferred historical end.
 *
 * Candles come from Binance's public REST API. For a ticker that is not listed
 * on Binance, set source: "csv" and csvUrl/csvText in the profile. CSV columns
 * accepted: time/open_time/timestamp/date, open, high, low, close, volume
 * (optional). The Studio does not upload files.
 */
window.TRADING_REEL_CONFIG = {
  appName: "Trading Reel 1",
  build: "2026-11-27C",

  /* Fallback number locale only. The selected recording-UI language controls
     number formatting: English/Korean/Chinese/Japanese/Thai/Malay use
     1,234.56; most European languages use 1.234,56 (French/Russian use
     spaces). Supported language codes map in js/app.js. */
  locale: "pt-BR",
  timeZone: "UTC",

  stage: {
    width: 576,          // 9:16 logical canvas
    height: 1024,
    appWidth: 492,        // the centered app pane used in the reference
    showNotch: true       // decorative notch, matching the reference framing
  },

  brand: {
    /* Faint watermark inside the chart. This is a custom wordmark, not a
       simulated-performance label. The SIM badge remains the on-screen
       simulation marker. */
    watermark: "TRADING REEL",
    /* Optional logo image placed just before the wordmark, e.g. "assets/logo.png".
       Leave blank for the neutral diamond mark. */
    logoUrl: "assets/logo.png",
    /* Small pill next to "Perp". Keep this visible. */
    simBadge: "SIM",
    disclaimer:
      "Simulated historical replay. Past price movement is not a prediction or a record of real trading."
  },

  /* Coin picker used by the ticker field and the quick-pick datalist.
     Any other Binance symbol can still be typed manually. */
  coins: [
    { symbol: "BTC",  name: "Bitcoin",       ticker: "BTCUSDT" },
    { symbol: "ETH",  name: "Ethereum",      ticker: "ETHUSDT" },
    { symbol: "XRP",  name: "XRP",           ticker: "XRPUSDT" },
    { symbol: "SOL",  name: "Solana",        ticker: "SOLUSDT" },
    { symbol: "POL",  name: "Polygon",       ticker: "POLUSDT" },
    { symbol: "NEAR", name: "NEAR Protocol", ticker: "NEARUSDT" },
    { symbol: "LIT",  name: "Litentry",      ticker: "LITUSDT" },
    { symbol: "ONDO", name: "Ondo",          ticker: "ONDOUSDT" },
    { symbol: "AAVE", name: "Aave",          ticker: "AAVEUSDT" },
    { symbol: "PEPE", name: "Pepe",          ticker: "PEPEUSDT" },
    { symbol: "BNB",  name: "BNB",           ticker: "BNBUSDT" },
    { symbol: "DOGE", name: "Dogecoin",      ticker: "DOGEUSDT" },
    { symbol: "ADA",  name: "Cardano",       ticker: "ADAUSDT" },
    { symbol: "TRX",  name: "TRON",          ticker: "TRXUSDT" },
    { symbol: "LTC",  name: "Litecoin",      ticker: "LTCUSDT" },
    { symbol: "SUI",  name: "Sui",           ticker: "SUIUSDT" },
    { symbol: "APT",  name: "Aptos",         ticker: "APTUSDT" },
    { symbol: "ARB",  name: "Arbitrum",      ticker: "ARBUSDT" },
    { symbol: "OP",   name: "Optimism",      ticker: "OPUSDT" },
    { symbol: "TIA",  name: "Celestia",      ticker: "TIAUSDT" },
    { symbol: "SEI",  name: "Sei",           ticker: "SEIUSDT" },
    { symbol: "JUP",  name: "Jupiter",       ticker: "JUPUSDT" },
    { symbol: "WIF",  name: "dogwifhat",     ticker: "WIFUSDT" },
    { symbol: "BONK", name: "Bonk",          ticker: "BONKUSDT" },
    { symbol: "RENDER", name: "Render",      ticker: "RENDERUSDT" },
    { symbol: "INJ",  name: "Injective",     ticker: "INJUSDT" },
    { symbol: "STX",  name: "Stacks",        ticker: "STXUSDT" },
    { symbol: "IMX",  name: "Immutable",     ticker: "IMXUSDT" },
    { symbol: "ENA",  name: "Ethena",        ticker: "ENAUSDT" },
    { symbol: "TON",  name: "Toncoin",       ticker: "TONUSDT" }
  ],

  playback: {
    startDelayMs: 0,        // begin immediately; no static opening frame
    recordingStartDelayMs: 0, // optional extra hold; countdown pre-rolls the entry frame
    secondsPerCandle: 0.9,  // legacy fallback only; the 48h plan chooses its cadence
    countdown: 3,           // hold the entry frame before playback so recording catches the loss (0 = off)
    autoPlay: true,
    loop: false,
    // Fixed reference viewport. 214 slots plus the 55% future gap gives 96
    // on-screen candles. The 192-candle 48h source supplies a deep history seed,
    // so that visible window is always filled behind the active candle.
    visibleCandles: 214,
    maxTakeSeconds: 600,    // recording length: 10 seconds to 10 minutes
    // The reference has 45% of the pane filled with candles and 55% of the
    // pane reserved for the current-price line/tag. The live candle sits at
    // that boundary and only the history scrolls underneath it.
    leadInCandles: 192,     // the 48-hour source is 192 fifteen-minute candles
    futureGapFraction: 0.55,
    language: "en"          // recording-UI language; changed only in Studio
  },

  ui: {
    defaultOrderSide: "short", // fallback; recorded side follows trade direction
    defaultOrderSize: 0.01,
    marginRatioBase: 1.11,     // matches the reference's 1,11% display
    marginRatioMaxBoost: 0.16
  },

  /* ------------------------------------------------------------------ */
  /* FIVE DAILY ACCOUNT REELS                                            */
  /* ------------------------------------------------------------------ */
  /* entryBackCandles / replayStartBackCandles are initial values only.
     The planner selects a real, turn-aligned playback window from the 192
     fifteen-minute candles. The source count is fixed at 192; the playback
     count and speed always complete inside the selected take. The position is already open in the
     first frame, exactly like the reference video.
     Entry price is always manual: entryPriceOverride is the value shown in the
     Studio and is required for every ticker. Size is calculated:
       size = marginUsd * leverage / entryPrice
     targetPnl is an editable positive target. The matcher solves an exit mark
     inside a real end candle and anchors an exact max-drawdown floor. The
     controlled mark path then returns to the entry at turnSeconds and reaches
     the target at the take end. Entry and size
     never move. If the real candles cannot follow these values exactly, the
     Studio disables Apply and Start recording and lists the reasons instead of
     substituting a different PNL.
  */
  accounts: [
    {
      id: "account-1",
      handle: "@account_1",
      symbol: "BTCUSDT",
      source: "binance",
      interval: "30m",
      direction: "short",
      marginMode: "cross",
      leverage: 20,
      marginUsd: 12500,
      entryBackCandles: 60,
      replayStartBackCandles: 40,
      entryPriceOverride: null, // null = blank manual input; API never fills this
      takeSeconds: 26,           // recorded replay length (10–600 s)
      watermarkText: "TRADING REEL", // editable chart wordmark
      logoUrl: "assets/logo.png",               // optional logo image path for the watermark
      simLabel: "SIM",           // editable text after the symbol chevron
      positionCount: 1,          // editable "Positions (n)" tab number
      drawdownPct: 10,            // maximum adverse loss as % of margin
      turnSeconds: 10,            // playback seconds to the first profitable close
      change24hOverride: null,    // manual 24h display %; null = show "--" (no API)
      targetPnl: null,            // required positive final PNL target; null blocks until entered
      varyPattern: true,          // rotate through 100 real chart windows
      patternIndex: 0,            // next deck position (0–99)
      scenarioSeed: 0,            // advances for a different real window per record
      usedPatterns: [],           // saved unique chart-window signatures
      usedPatternLabels: [],      // saved chart-pattern names
      realizedPnl: -265.12,
      priceDecimals: 2,
      orderSize: 0.01,
      tpPrice: null,
      slPrice: null
    },
    {
      id: "account-2",
      handle: "@account_2",
      symbol: "ETHUSDT",
      source: "binance",
      interval: "30m",
      direction: "short",
      marginMode: "cross",
      leverage: 25,
      marginUsd: 9000,
      entryBackCandles: 60,
      replayStartBackCandles: 40,
      entryPriceOverride: null,
      takeSeconds: 26,
      watermarkText: "TRADING REEL",
      positionCount: 1,
      drawdownPct: 10,
      turnSeconds: 10,
      change24hOverride: null,    // manual 24h display %; null = show "--" (no API)
      targetPnl: null,            // required positive final PNL target; null blocks until entered
      varyPattern: true,
      patternIndex: 0,
      scenarioSeed: 0,            // advances for a different real window per record
      usedPatterns: [],           // saved unique chart-window signatures
      usedPatternLabels: [],      // saved chart-pattern names
      realizedPnl: -184.4,
      priceDecimals: 2,
      orderSize: 0.1,
      tpPrice: null,
      slPrice: null
    },
    {
      id: "account-3",
      handle: "@account_3",
      symbol: "SOLUSDT",
      source: "binance",
      interval: "30m",
      direction: "short",
      marginMode: "cross",
      leverage: 20,
      marginUsd: 7500,
      entryBackCandles: 60,
      replayStartBackCandles: 40,
      entryPriceOverride: null,
      takeSeconds: 26,
      watermarkText: "TRADING REEL",
      positionCount: 1,
      drawdownPct: 10,
      turnSeconds: 10,
      change24hOverride: null,    // manual 24h display %; null = show "--" (no API)
      targetPnl: null,            // required positive final PNL target; null blocks until entered
      varyPattern: true,
      patternIndex: 0,
      scenarioSeed: 0,            // advances for a different real window per record
      usedPatterns: [],           // saved unique chart-window signatures
      usedPatternLabels: [],      // saved chart-pattern names
      realizedPnl: -98.72,
      priceDecimals: 2,
      orderSize: 1,
      tpPrice: null,
      slPrice: null
    },
    {
      id: "account-4",
      handle: "@account_4",
      symbol: "BNBUSDT",
      source: "binance",
      interval: "30m",
      direction: "long",
      marginMode: "cross",
      leverage: 15,
      marginUsd: 6000,
      entryBackCandles: 50,
      replayStartBackCandles: 35,
      entryPriceOverride: null,
      takeSeconds: 26,
      watermarkText: "TRADING REEL",
      positionCount: 1,
      drawdownPct: 10,
      turnSeconds: 10,
      change24hOverride: null,    // manual 24h display %; null = show "--" (no API)
      targetPnl: null,            // required positive final PNL target; null blocks until entered
      varyPattern: true,
      patternIndex: 0,
      scenarioSeed: 0,            // advances for a different real window per record
      usedPatterns: [],           // saved unique chart-window signatures
      usedPatternLabels: [],      // saved chart-pattern names
      realizedPnl: -42.19,
      priceDecimals: 2,
      orderSize: 0.1,
      tpPrice: null,
      slPrice: null
    },
    {
      id: "account-5",
      handle: "@account_5",
      symbol: "XRPUSDT",
      source: "binance",
      interval: "30m",
      direction: "short",
      marginMode: "cross",
      leverage: 20,
      marginUsd: 5000,
      entryBackCandles: 60,
      replayStartBackCandles: 40,
      entryPriceOverride: null,
      takeSeconds: 26,
      watermarkText: "TRADING REEL",
      positionCount: 1,
      drawdownPct: 10,
      turnSeconds: 10,
      change24hOverride: null,    // manual 24h display %; null = show "--" (no API)
      targetPnl: null,            // required positive final PNL target; null blocks until entered
      varyPattern: true,
      patternIndex: 0,
      scenarioSeed: 0,            // advances for a different real window per record
      usedPatterns: [],           // saved unique chart-window signatures
      usedPatternLabels: [],      // saved chart-pattern names
      realizedPnl: -31.9,
      priceDecimals: 4,
      orderSize: 100,
      tpPrice: null,
      slPrice: null
    }
  ]
};

