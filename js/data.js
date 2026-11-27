/**
 * Data loading for trading-reel-1.
 *
 * Historical candles come from Binance's public REST API. If a ticker is not
 * listed on Binance, load a CSV exported from any charting app. The recording
 * source is the past 48 hours of completed 15m candles. The historical seed is
 * real OHLC; the replay mapping and its chart path live in app.js, never in the
 * market-data responses.
 */
(function () {
  "use strict";

  const BINANCE_BASE = "https://api.binance.com/api/v3/klines";
  const BINANCE_TICKER_24H = "https://api.binance.com/api/v3/ticker/24hr";
  const BINANCE_EXCHANGE_INFO = "https://api.binance.com/api/v3/exchangeInfo";
  const BINANCE_PRODUCTS = "https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products";
  // The record planner requests 48 hours of 15m candles and selects a real
  // 24-hour chart window from that pool.
  const RANGE_MS = 48 * 60 * 60 * 1000;
  // A real, active, liquid spot pair. This removes bStocks/ETFs, inactive or
  // delisted products, zero-volume rows, and one-fill outliers.
  const MOVERS_MIN_QUOTE_VOLUME = 1_000_000;
  const MOVERS_MIN_TRADES = 1_000;
  const MOVERS_CHANGE_TOLERANCE = 1.0;
  const VALID_INTERVALS = ["1s", "1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d"];

  const INTERVAL_MS = {
    "1s": 1000,
    "1m": 60 * 1000,
    "3m": 3 * 60 * 1000,
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "30m": 30 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000
  };

  function intervalToMs(interval) {
    return INTERVAL_MS[interval] || INTERVAL_MS["30m"];
  }

  function normalizeCandle(c) {
    return {
      t: Number(c.t),
      o: Number(c.o),
      h: Number(c.h),
      l: Number(c.l),
      c: Number(c.c),
      v: Number(c.v || 0)
    };
  }

  /** Fetch public klines from Binance. Throws on network/API errors. */
  async function fetchBinance(symbol, interval, limit, endTime) {
    const sym = String(symbol || "").trim().toUpperCase();
    if (!sym) throw new Error("Enter a ticker symbol first.");
    if (!VALID_INTERVALS.includes(interval)) {
      throw new Error("Unsupported candle interval: " + interval);
    }
    let url =
      BINANCE_BASE +
      "?symbol=" + encodeURIComponent(sym) +
      "&interval=" + encodeURIComponent(interval) +
      "&limit=" + Math.min(1000, Math.max(20, limit || 400));
    if (Number.isFinite(Number(endTime)) && Number(endTime) > 0) {
      url += "&endTime=" + Math.floor(Number(endTime));
    }

    let res;
    try {
      res = await fetch(url, { cache: "no-store" });
    } catch (e) {
      throw new Error("Could not reach Binance. Check the connection or load a CSV.");
    }
    if (!res.ok) {
      let detail = "";
      try {
        const err = await res.json();
        detail = err && err.msg ? " " + err.msg : "";
      } catch (_) { /* ignore */ }
      throw new Error(
        "No Binance data for " + sym + " at " + interval + "." + detail +
        " Try another ticker or load a CSV."
      );
    }

    const json = await res.json();
    if (!Array.isArray(json) || json.length < 5) {
      throw new Error("Binance returned no usable candles for " + sym + ".");
    }

    return json.map(function (k) {
      return normalizeCandle({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[5] });
    });
  }

  /**
   * Fetch a candle history range for an interval. Binance allows at most 1000
   * candles per request, so smaller intervals paginate backwards. Only OHLCV
   * candles are fetched; the entry and every Studio value stay manual.
   */
  async function fetchBinanceWindow(symbol, interval, rangeMs) {
    const baseMs = intervalToMs(interval);
    const endTime = Date.now();
    const startTime = endTime - (rangeMs || RANGE_MS);
    const wanted = Math.ceil((rangeMs || RANGE_MS) / baseMs) + 2;
    const perPage = Math.min(1000, Math.max(20, wanted));
    const maxPages = Math.min(800, Math.ceil(wanted / 1000) + 4);
    const byTime = new Map();
    let cursor = endTime;

    for (let page = 0; page < maxPages; page++) {
      let chunk;
      try {
        chunk = await fetchBinance(symbol, interval, perPage, cursor);
      } catch (err) {
        if (page === 0) throw err;
        break;
      }
      if (!chunk.length) break;
      chunk.forEach(function (c) { byTime.set(c.t, c); });
      const earliest = chunk[0].t;
      if (earliest <= startTime) break;
      cursor = earliest - 1;
    }

    const all = Array.from(byTime.values())
      .filter(function (c) { return c.t >= startTime && c.t <= endTime; })
      .sort(function (a, b) { return a.t - b.t; });
    if (all.length < 2) {
      throw new Error("Binance returned fewer than 2 candles in the requested history window for " +
        String(symbol || "").toUpperCase() + " at " + interval + ".");
    }
    return all;
  }

  function detectDelimiter(header) {
    const candidates = [",", ";", "\t"];
    let best = ",";
    let bestCount = -1;
    candidates.forEach(function (d) {
      const count = header.split(d).length;
      if (count > bestCount) { best = d; bestCount = count; }
    });
    return best;
  }

  function parseTimestamp(value) {
    if (value == null) return NaN;
    const raw = String(value).trim().replace(/^"|"$/g, "");
    if (!raw) return NaN;

    if (/^\d+(\.\d+)?$/.test(raw)) {
      let n = Number(raw);
      if (n < 1e11) n *= 1000; // seconds -> ms
      return n;
    }

    // TradingView-style "2026-11-02T22:00:00Z" or "2026-11-02 22:00:00"
    let iso = raw.replace(" ", "T");
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)) iso += "Z";
    const parsed = Date.parse(iso);
    if (!Number.isNaN(parsed)) return parsed;
    return NaN;
  }

  function findColumn(headers, names) {
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i].toLowerCase().replace(/^\uFEFF/, "").trim();
      if (names.indexOf(h) !== -1) return i;
    }
    return -1;
  }

  /**
   * Parse CSV exported from Binance, TradingView, or a generic OHLCV file.
   * Accepts a header row or headerless time,open,high,low,close[,volume].
   */
  function parseCsv(text) {
    if (!text || !String(text).trim()) throw new Error("The CSV file is empty.");
    const rows = String(text)
      .replace(/^\uFEFF/, "")
      .split(/\r?\n/)
      .map(function (r) { return r.trim(); })
      .filter(function (r) { return r.length > 0; });

    if (rows.length < 6) throw new Error("The CSV needs at least 5 candles.");

    const first = rows[0];
    const delimiter = detectDelimiter(first);
    const firstCells = first.split(delimiter).map(function (h) {
      return h.trim().replace(/^"|"$/g, "");
    });
    const knownHeaders = [
      "time", "open_time", "timestamp", "date", "datetime",
      "open", "high", "low", "close", "volume"
    ];
    const looksLikeHeader = firstCells.some(function (cell) {
      return knownHeaders.indexOf(cell.toLowerCase().replace(/^\uFEFF/, "")) !== -1;
    });
    let headers = [];
    let start = 0;

    if (looksLikeHeader) {
      headers = firstCells;
      start = 1;
    } else {
      headers = ["time", "open", "high", "low", "close", "volume"];
    }

    let tIdx = findColumn(headers, ["time", "open_time", "timestamp", "date", "datetime", "open time"]);
    let oIdx = findColumn(headers, ["open", "o"]);
    let hIdx = findColumn(headers, ["high", "h"]);
    let lIdx = findColumn(headers, ["low", "l"]);
    let cIdx = findColumn(headers, ["close", "c"]);
    let vIdx = findColumn(headers, ["volume", "vol", "v"]);

    if (!looksLikeHeader) {
      tIdx = 0; oIdx = 1; hIdx = 2; lIdx = 3; cIdx = 4; vIdx = 5;
    } else if (tIdx < 0 || oIdx < 0 || hIdx < 0 || lIdx < 0 || cIdx < 0) {
      throw new Error(
        "CSV columns not recognized. Use time, open, high, low, close (volume optional)."
      );
    }

    const parsed = [];
    for (let i = start; i < rows.length; i++) {
      const cells = rows[i].split(delimiter).map(function (c) {
        return c.trim().replace(/^"|"$/g, "");
      });
      if (cells.length <= Math.max(tIdx, oIdx, hIdx, lIdx, cIdx)) continue;

      const t = parseTimestamp(cells[tIdx]);
      const o = Number(cells[oIdx]);
      const h = Number(cells[hIdx]);
      const l = Number(cells[lIdx]);
      const c = Number(cells[cIdx]);
      const v = vIdx >= 0 ? Number(cells[vIdx]) : 0;

      if (![t, o, h, l, c].every(Number.isFinite)) continue;
      if (h < l || o <= 0 || h <= 0 || l <= 0 || c <= 0) continue;

      parsed.push({ t: t, o: o, h: h, l: l, c: c, v: Number.isFinite(v) ? v : 0 });
    }

    if (parsed.length < 5) {
      throw new Error("The CSV contains fewer than 5 valid OHLC candles.");
    }

    parsed.sort(function (a, b) { return a.t - b.t; });
    const deduped = [];
    parsed.forEach(function (c) {
      if (deduped.length && deduped[deduped.length - 1].t === c.t) {
        deduped[deduped.length - 1] = c;
      } else {
        deduped.push(c);
      }
    });

    return deduped;
  }

  /** Aggregate candles upward (e.g. 30m CSV -> 1h chart). */
  function aggregate(candles, fromMs, toMs) {
    if (!candles.length) return [];
    if (toMs < fromMs) {
      throw new Error("This CSV only contains " + msLabel(fromMs) + " candles.");
    }
    if (toMs === fromMs) return candles.slice();

    const map = new Map();
    candles.forEach(function (c) {
      const bucket = Math.floor(c.t / toMs) * toMs;
      const existing = map.get(bucket);
      if (!existing) {
        map.set(bucket, { t: bucket, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v });
      } else {
        existing.h = Math.max(existing.h, c.h);
        existing.l = Math.min(existing.l, c.l);
        existing.c = c.c;
        existing.v += c.v;
      }
    });
    return Array.from(map.values()).sort(function (a, b) { return a.t - b.t; });
  }

  function msLabel(ms) {
    if (ms < 60000) return Math.round(ms / 1000) + "s";
    if (ms < 3600000) return Math.round(ms / 60000) + "m";
    if (ms < 86400000) return Math.round(ms / 3600000) + "h";
    return Math.round(ms / 86400000) + "d";
  }

  /**
   * Resolve candles for an account.
   * Returns { candles, baseInterval, sourceLabel, warning }
   */
  function utcStamp(ms) {
    const d = new Date(Number(ms));
    const p = function (n) { return String(n).padStart(2, "0"); };
    return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
      " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + " UTC";
  }

  async function loadCandles(account) {
    const interval = "15m";
    const baseMs = intervalToMs(interval);
    const interval48h = 48 * 60 * 60 * 1000;
    const rangeMs = interval48h + baseMs * 2;

    if (account.source === "csv") {
      let text = account.csvText || "";
      if (!text && account.csvUrl) {
        const res = await fetch(account.csvUrl, { cache: "no-store" });
        if (res.ok) text = await res.text();
      }
      if (!text) {
        throw new Error(
          "No CSV loaded for " + account.symbol +
          ". Set source: \"csv\" and csvUrl or csvText in js/config.js for this profile."
        );
      }
      let candles = parseCsv(text);
      const csvEnd = candles.length ? candles[candles.length - 1].t : 0;
      const csvStart = csvEnd - interval48h;
      candles = candles.filter(function (c) {
        return c.t > csvStart && c.t <= csvEnd;
      });
      if (candles.length < 2) {
        throw new Error("The CSV has fewer than 2 candles in the past 48 hours.");
      }
      return {
        candles: candles,
        baseInterval: "csv",
        sourceLabel: "CSV • " + candles.length + " candles • past 48 hours",
        rangeMs: interval48h,
        warning: "The chart is locked to 15m; a CSV with another interval is shown at its native spacing."
      };
    }

    const raw = await fetchBinanceWindow(account.symbol, interval, rangeMs);
    const now = Date.now();
    // The final kline can still be open. Only completed 15-minute candles are
    // used; 192 closes make exactly 48 hours.
    const completed = raw.filter(function (c) {
      return c.t + baseMs <= now;
    });
    const candles = completed.slice(-192);
    if (candles.length < 192) {
      throw new Error("Binance returned fewer than 192 completed 15-minute candles for the past 48 hours of " +
        String(account.symbol || "").toUpperCase() + ".");
    }
    return {
      candles: candles,
      baseInterval: interval,
      sourceLabel: "Binance • " + account.symbol + " • 15m • past 48h • 192 candles",
      rangeMs: interval48h,
      warning: ""
    };
  }



  /**
   * Top 25 verified USDT spot gainers/losers.
   *
   * The raw ticker endpoint also contains bStocks (tokenized stocks/ETFs) and
   * very thin markets, which made the displayed movers look wrong. This joins:
   *   - Binance's canonical /ticker/24hr percentage, price and quote volume;
   *   - /exchangeInfo for TRADING + spot-enabled USDT status;
   *   - Binance's public product catalog for the real name and category tags.
   * A row is included only when it is active spot, not bStocks/ETF, has at
   * least $1M 24h quote volume and 1,000 trades, and its product-catalog 24h
   * open/close change agrees with the official ticker within one percentage
   * point. Figures shown are the official ticker figures.
   */
  async function fetchTopMovers(limit) {
    const n = Math.max(1, Math.min(50, Number(limit) || 25));
    async function getJson(url, label) {
      let res;
      try {
        res = await fetch(url, { cache: "no-store" });
      } catch (e) {
        throw new Error("Could not reach Binance " + label + ".");
      }
      if (!res.ok) throw new Error("Binance " + label + " request failed (" + res.status + ").");
      try {
        return await res.json();
      } catch (e) {
        throw new Error("Binance " + label + " returned invalid JSON.");
      }
    }
    let tickerJson, exchangeJson, productJson;
    try {
      const results = await Promise.all([
        getJson(BINANCE_TICKER_24H, "24h tickers"),
        getJson(BINANCE_EXCHANGE_INFO, "exchange info"),
        getJson(BINANCE_PRODUCTS, "product catalog")
      ]);
      tickerJson = results[0];
      exchangeJson = results[1];
      productJson = results[2];
    } catch (e) {
      throw new Error(e.message + " The top-25 list was not updated; existing tickers still load their recent history.");
    }
    if (!Array.isArray(tickerJson)) throw new Error("Binance returned no 24h tickers.");
    if (!exchangeJson || !Array.isArray(exchangeJson.symbols)) {
      throw new Error("Binance returned no exchange status data.");
    }
    if (!productJson || !Array.isArray(productJson.data)) {
      throw new Error("Binance returned no product catalog data.");
    }

    const active = new Set();
    exchangeJson.symbols.forEach(function (info) {
      if (info.symbol && /USDT$/.test(info.symbol) &&
          info.status === "TRADING" &&
          info.quoteAsset === "USDT" &&
          info.isSpotTradingAllowed) {
        active.add(info.symbol);
      }
    });
    const products = new Map();
    productJson.data.forEach(function (p) {
      if (p && p.s) products.set(p.s, p);
    });

    const rows = [];
    tickerJson.forEach(function (row) {
      const symbol = row && row.symbol;
      if (!symbol || !active.has(symbol)) return;
      const product = products.get(symbol);
      if (!product || product.st !== "TRADING") return;
      const tags = (product.tags || []).map(function (x) { return String(x).toLowerCase(); });
      const name = String(product.an || product.adn || symbol);
      if (tags.indexOf("bstocks") !== -1 || name.toLowerCase().indexOf("bstocks") !== -1) return;
      const price = Number(row.lastPrice);
      const quoteVolume = Number(row.quoteVolume);
      const trades = Number(row.count);
      const change = Number(row.priceChangePercent);
      if (!(price > 0) || !(quoteVolume >= MOVERS_MIN_QUOTE_VOLUME) ||
          !(trades >= MOVERS_MIN_TRADES) || !Number.isFinite(change)) return;
      const catalogOpen = Number(product.o);
      const catalogClose = Number(product.c);
      if (!(catalogOpen > 0) || !Number.isFinite(catalogClose)) return;
      const catalogChange = (catalogClose - catalogOpen) / catalogOpen * 100;
      if (!Number.isFinite(catalogChange) ||
          Math.abs(catalogChange - change) > MOVERS_CHANGE_TOLERANCE) return;
      rows.push({
        ticker: symbol,
        symbol: symbol.replace(/USDT$/, ""),
        name: name,
        change: change,
        price: price,
        quoteVolume: quoteVolume,
        trades: trades
      });
    });
    if (rows.length < 2) {
      throw new Error("No verified active liquid Binance USDT movers were available. The top-25 list was not updated.");
    }
    const gainers = rows.slice().sort(function (a, b) {
      return b.change - a.change || b.quoteVolume - a.quoteVolume;
    }).slice(0, n);
    const losers = rows.slice().sort(function (a, b) {
      return a.change - b.change || b.quoteVolume - a.quoteVolume;
    }).slice(0, n);
    return {
      gainers: gainers,
      losers: losers,
      updatedAt: Date.now(),
      universe: rows.length,
      minQuoteVolume: MOVERS_MIN_QUOTE_VOLUME,
      minTrades: MOVERS_MIN_TRADES,
      source: "Binance 24h ticker + exchangeInfo + product catalog"
    };
  }

  window.TradingData = {
    fetchBinance: fetchBinance,
    fetchBinanceWindow: fetchBinanceWindow,
    RANGE_MS: RANGE_MS,
    parseCsv: parseCsv,
    aggregate: aggregate,
    loadCandles: loadCandles,
    fetchTopMovers: fetchTopMovers,
    intervalToMs: intervalToMs,
    VALID_INTERVALS: VALID_INTERVALS.slice()
  };
})();
