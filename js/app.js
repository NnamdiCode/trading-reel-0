/* global TradingData, TradingChart */
(function () {
  "use strict";

  const DEFAULTS = window.TRADING_REEL_CONFIG;
  const STORAGE_KEY = "trading-reel-1.accounts.v1";
  const SCHEMA_VERSION = 2;
  const MOVERS_REFRESH_MS = 60 * 60 * 1000;
  const MAX_TAKE_SECONDS = Math.max(60, Number(DEFAULTS.playback.maxTakeSeconds) || 600);
  const MAX_PLAYBACK_CANDLES = Math.ceil(MAX_TAKE_SECONDS / 0.9);
  // Recording-UI number formatting follows the selected language. Numeric
  // values, not user inputs, are localized with Intl.NumberFormat.
  const LANGUAGE_LOCALES = {
    en: "en-US",
    ar: "ar-EG-u-nu-latn",
    zh: "zh-CN",
    ja: "ja-JP",
    ko: "ko-KR",
    th: "th-TH",
    vi: "vi-VN",
    fr: "fr-FR",
    it: "it-IT",
    ru: "ru-RU",
    pt: "pt-BR",
    es: "es-ES",
    de: "de-DE",
    ms: "ms-MY",
    id: "id-ID"
  };
  // Same maintenance-margin assumption for liquidation and margin ratio. The
  // reference's 20x Cross card shows ~1.12%, i.e. 20 × 0.056%.
  const MAINTENANCE_MARGIN_RATE = 0.00056;
  const $ = function (sel, root) { return (root || document).querySelector(sel); };
  const $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  const state = {
    accounts: [],
    accountIndex: 0,
    profileNumber: 1,
    account: null,
    playback: null,
    data: [],
    rawIntervalMs: null,
    effectiveIntervalMs: null,
    sourceLabel: "",
    entryIdx: 0,
    startIdx: 0,
    entryPrice: 0,
    size: 0,
    margin: 0,
    leverage: 20,
    cursor: 0,
    startCursor: 0,
    endCursor: 0,
    mark: 0,
    pnl: 0,
    roi: 0,
    playing: false,
    paused: false,
    finished: false,
    closed: false,
    closedMark: 0,
    playStartTs: 0,
    playDuration: 1,
    pausedElapsed: 0,
    finishTs: 0,
    loadToken: 0,
    currentFrameTs: 0,
    lastBookAt: 0,
    bookRatio: 62,
    orderSide: "short",
    activeTab: "positions",
    activeNav: "futures",
    showGrid: true,
    chartFocus: false,
    fitChart: false,
    recording: false,
    studioDirty: false,
    studioSource: "binance",
    stageScale: 1,
    lastPnlText: "",
    lastRoiText: "",
    wasPlayingBeforeStudio: false,
    hiddenAt: 0,
    realValue: 0,
    realizedBase: 0,
    timerToast: null,
    timerHint: null,
    timerLoop: null,
    timerCrosshair: null,
    timerCountdown: null,
    secondsPerCandle: null,
    takeSeconds: null,
    lastChartTapAt: 0,
    lastNotchTapAt: 0,
    baseDataMs: null,
    loading: false,
    previewData: [],
    previewKey: "",
    previewIntervalMs: null,
    previewToken: 0,
    previewLoadingKey: "",
    previewTimer: null,
    pendingPatternIndex: 0,
    sizeFieldDirty: false,
    startOverrideMark: null,
    endOverrideMark: null,
    drawdownMark: null,
    drawdownCursor: null,
    controlledPath: null,
    patternPlan: null,
    engine: null,
    engineSourceTime: null,
    turnCursor: null,
    turnAtMs: 0,
    turnOverrideMark: null,
    chartCursor: null,
    valueCursor: null,
    playbackSteps: 1,
    progress: 0,
    lastUiTick: -1,
    lastChartStep: -1,
    renderedOnce: false,
    floorAtMs: null,
    floorDrawn: false,
    turnDrawn: false,
    turnPositiveDrawn: false,
    rawData: [],
    scenarioSeedUsed: 0,
    lastRecordedSeed: null,
    pendingRecordAdvance: false,
    studioBlockReason: "",
    footerActionAt: 0,
    previewPoolLength: 1,
    previewScenario: null,
    movers: { gainers: [], losers: [], updatedAt: 0, error: "" },
    scenario: null
  };

  const cache = new Map();
  let chart = null;
  let refs = {};

  const numberFormatters = new Map();
  function nf(decimals) {
    const d = Math.max(0, Math.min(8, decimals));
    const locale = currentNumberLocale();
    const key = locale + "|" + d;
    if (!numberFormatters.has(key)) {
      numberFormatters.set(key, new Intl.NumberFormat(locale, {
        minimumFractionDigits: d,
        maximumFractionDigits: d
      }));
    }
    return numberFormatters.get(key);
  }

  function fmt(value, decimals) {
    return nf(decimals == null ? 2 : decimals).format(Number.isFinite(Number(value)) ? Number(value) : 0);
  }

  function fmtSigned(value, decimals) {
    const v = Number(value);
    const d = decimals == null ? 2 : decimals;
    if (v > 0) return "+" + fmt(v, d);
    if (v < 0) return "-" + fmt(Math.abs(v), d);
    return fmt(0, d);
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  function esc(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }

  function setClass(el, className, on) {
    if (!el) return;
    el.classList.toggle(className, !!on);
  }

  // ---------------------------------------------------------------
  // Language / recording-UI translation
  // ---------------------------------------------------------------
  const I18N = window.TradingI18n || null;
  let i18nReverse = null;
  let i18nApplying = false;
  let i18nScheduled = false;
  const i18nPending = new Set();

  function normalizeLanguage(code) {
    const raw = String(code || "en").toLowerCase();
    const supported = I18N && Array.isArray(I18N.supported) ? I18N.supported : ["en"];
    return supported.indexOf(raw) !== -1 ? raw : "en";
  }

  function currentLanguage() {
    return normalizeLanguage(state.playback && state.playback.language);
  }

  function currentNumberLocale() {
    return LANGUAGE_LOCALES[currentLanguage()] || DEFAULTS.locale || "en-US";
  }

  function i18nTable(lang) {
    if (!I18N || !I18N.dictionary) return {};
    return I18N.dictionary[lang] || I18N.dictionary.en || {};
  }

  function tr(key, lang) {
    const table = i18nTable(lang || currentLanguage());
    if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
    const en = (I18N && I18N.dictionary && I18N.dictionary.en) || {};
    return Object.prototype.hasOwnProperty.call(en, key) ? en[key] : key;
  }

  function i18nSourceKey(text) {
    const clean = String(text == null ? "" : text).trim();
    if (!clean) return "";
    const en = (I18N && I18N.dictionary && I18N.dictionary.en) || {};
    if (Object.prototype.hasOwnProperty.call(en, clean)) return clean;
    if (!i18nReverse) {
      i18nReverse = new Map();
      const dict = (I18N && I18N.dictionary) || {};
      // English source keys win when a translation happens to equal a key.
      Object.keys(en).forEach(function (key) {
        i18nReverse.set(String(en[key]).trim(), key);
      });
      Object.keys(dict).forEach(function (lang) {
        if (lang === "en") return;
        Object.keys(dict[lang] || {}).forEach(function (key) {
          const val = String(dict[lang][key] == null ? "" : dict[lang][key]).trim();
          if (val && !i18nReverse.has(val)) i18nReverse.set(val, key);
        });
      });
    }
    return i18nReverse.get(clean) || "";
  }

  function dynamicTranslation(core, lang) {
    let m = core.match(/^(.*?)\s*\((\d+)\)$/);
    if (m) {
      const key = i18nSourceKey(m[1]);
      if (key === "Open Orders" || key === "Positions") {
        return tr(key, lang) + " (" + m[2] + ")";
      }
    }
    m = core.match(/^(.*?)\s*\($/);
    if (m) {
      const key = i18nSourceKey(m[1]);
      if (key === "Size") return tr(key, lang) + " (";
    }
    m = core.match(/^(.*?) (\d+)X$/);
    if (m) {
      const key = i18nSourceKey(m[1]);
      if (key === "Cross" || key === "Isolated") {
        return tr(key, lang) + " " + m[2] + "X";
      }
    }
    m = core.match(/^Pattern (\d+) \/ 100 · (.+)$/);
    if (m) {
      const suffix = i18nSourceKey(m[2]);
      if (suffix === "new real window each page load" || suffix === "fixed window") {
        return tr("Pattern", lang) + " " + m[1] + " / 100 · " + tr(suffix, lang);
      }
    }
    return "";
  }

  function translateTextNode(node, lang) {
    if (!node || node.nodeType !== 3) return;
    const parent = node.parentElement;
    if (!parent) return;
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|CODE|PRE)$/.test(parent.tagName)) return;
    if (parent.closest("[data-i18n-skip]")) return;
    const raw = node.nodeValue;
    if (!raw || !raw.trim()) return;
    const lead = raw.match(/^\s*/)[0];
    const trail = raw.match(/\s*$/)[0];
    const core = raw.slice(lead.length, raw.length - trail.length);
    if (!core) return;
    let next = dynamicTranslation(core, lang);
    if (!next) {
      const key = i18nSourceKey(core);
      if (!key) return;
      next = tr(key, lang);
    }
    if (next && next !== core) node.nodeValue = lead + next + trail;
  }

  function translateSubtree(node, lang) {
    if (!node) return;
    if (node.nodeType === 3) {
      translateTextNode(node, lang);
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.closest && node.closest("[data-i18n-skip]")) return;
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|CODE|PRE)$/.test(node.tagName)) return;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA|CODE|PRE)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
        if (p.closest("[data-i18n-skip]")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) translateTextNode(n, lang);
  }

  function applyLanguage(code) {
    const lang = normalizeLanguage(code || currentLanguage());
    const root = document.documentElement;
    root.lang = lang === "zh" ? "zh-CN" : lang;
    root.dir = lang === "ar" ? "rtl" : "ltr";
    document.body.classList.toggle("lang-ar", lang === "ar");
    if (refs.fLanguage) refs.fLanguage.value = lang;
    if (!I18N) return;
    i18nPending.clear();
    i18nApplying = true;
    try {
      translateSubtree(document.body, lang);
    } finally {
      i18nApplying = false;
    }
    if (refs.moverUpdated) renderMoverStatus();
    if (refs.moverHint) renderMoverHint();
  }

  function scheduleI18nFlush() {
    if (i18nScheduled) return;
    i18nScheduled = true;
    requestAnimationFrame(function () {
      i18nScheduled = false;
      if (i18nApplying || !i18nPending.size) return;
      const nodes = Array.from(i18nPending);
      i18nPending.clear();
      const lang = currentLanguage();
      i18nApplying = true;
      try {
        nodes.forEach(function (node) {
          if (node && node.isConnected) translateSubtree(node, lang);
        });
      } finally {
        i18nApplying = false;
      }
    });
  }

  function startLanguageObserver() {
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(function (mutations) {
      if (i18nApplying) return;
      let queued = false;
      mutations.forEach(function (m) {
        if (m.type === "characterData") {
          if (m.target && m.target.nodeType === 3) {
            i18nPending.add(m.target);
            queued = true;
          }
          return;
        }
        if (m.type === "childList") {
          for (let i = 0; i < m.addedNodes.length; i++) {
            const n = m.addedNodes[i];
            if (n.nodeType === 1 || n.nodeType === 3) {
              i18nPending.add(n);
              queued = true;
            }
          }
        }
      });
      if (queued) scheduleI18nFlush();
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  }

  function setLanguage(code) {
    const lang = normalizeLanguage(code);
    if (!state.playback) state.playback = {};
    state.playback.language = lang;
    if (refs.fLanguage) refs.fLanguage.value = lang;
    savePersisted();
    applyLanguage(lang);
    refreshLocaleNumbers();
  }

  function baseAsset(symbol) {
    return String(symbol || "").replace(/(USDT|USDC|BUSD|FDUSD|USD|BTC|ETH)$/i, "") || String(symbol || "");
  }

  const dateFormatterCache = {};
  function getDateFormatter(withSeconds) {
    const key = withSeconds ? "full" : "minute";
    if (!dateFormatterCache[key]) {
      const opts = {
        timeZone: DEFAULTS.timeZone || "UTC",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      };
      if (withSeconds) opts.second = "2-digit";
      try {
        dateFormatterCache[key] = new Intl.DateTimeFormat("en-GB", opts);
      } catch (_) {
        opts.timeZone = "UTC";
        dateFormatterCache[key] = new Intl.DateTimeFormat("en-GB", opts);
      }
    }
    return dateFormatterCache[key];
  }

  function dateParts(ts, withSeconds) {
    const parts = getDateFormatter(withSeconds).formatToParts(new Date(ts));
    const out = {};
    parts.forEach(function (p) { if (p.type !== "literal") out[p.type] = p.value; });
    return out;
  }

  function formatDateTime(ts) {
    const p = dateParts(ts, false);
    return p.year + "-" + p.month + "-" + p.day + " " + p.hour + ":" + p.minute;
  }

  function formatHM(ts, withSeconds) {
    const p = dateParts(ts, !!withSeconds);
    return p.hour + ":" + p.minute + (withSeconds ? ":" + p.second : "");
  }

  const orderSizeFormatters = new Map();
  function orderSizeText(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "0";
    const locale = currentNumberLocale();
    if (!orderSizeFormatters.has(locale)) {
      orderSizeFormatters.set(locale, new Intl.NumberFormat(locale, {
        useGrouping: false,
        maximumFractionDigits: 8
      }));
    }
    return orderSizeFormatters.get(locale).format(v);
  }

  function intervalFromMs(ms) {
    const entries = [
      ["1s", 1000], ["1m", 60000], ["3m", 180000], ["5m", 300000],
      ["15m", 900000], ["30m", 1800000], ["1h", 3600000], ["4h", 14400000], ["1d", 86400000]
    ];
    let best = entries[0];
    let bestDiff = Infinity;
    entries.forEach(function (e) {
      const diff = Math.abs(e[1] - ms);
      if (diff < bestDiff) { best = e; bestDiff = diff; }
    });
    return best[0];
  }

  function medianDelta(candles) {
    if (!candles || candles.length < 2) return 1800000;
    const diffs = [];
    for (let i = 1; i < Math.min(candles.length, 120); i++) {
      const d = candles[i].t - candles[i - 1].t;
      if (d > 0) diffs.push(d);
    }
    if (!diffs.length) return 1800000;
    diffs.sort(function (a, b) { return a - b; });
    return diffs[Math.floor(diffs.length / 2)];
  }

  function loadPersisted() {
    const defaultAccounts = clone(DEFAULTS.accounts || []);
    state.accounts = defaultAccounts;
    state.playback = Object.assign({}, DEFAULTS.playback || {});
    let savedProfileNumber = 0;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved && Array.isArray(saved.accounts) && saved.schemaVersion === SCHEMA_VERSION) {
          if (saved.accounts.length === 1) {
            // Single-account saves keep one complete edited profile. Put it
            // back into its original config slot so ?account=4 still means
            // profile 4 after a record/reload, and other profiles remain
            // available when the URL selects them.
            const only = saved.accounts[0];
            let originalIndex = defaultAccounts.findIndex(function (a) { return a.id === only.id; });
            if (originalIndex < 0) {
              originalIndex = Math.min(
                Math.max((Number(saved.profileNumber) || 1) - 1, 0),
                Math.max(0, defaultAccounts.length - 1)
              );
            }
            state.accounts = defaultAccounts.map(function (fallback, i) {
              return i === originalIndex
                ? Object.assign({}, clone(fallback), only)
                : clone(fallback);
            });
          } else {
            const merged = saved.accounts.map(function (a, i) {
              const fallback = defaultAccounts[i] || defaultAccounts[0];
              return Object.assign({}, clone(fallback), a);
            });
            if (merged.length) state.accounts = merged;
          }
          savedProfileNumber = Number(saved.profileNumber) || 0;
          if (saved.playback) Object.assign(state.playback, saved.playback);
        }
      }
    } catch (_) { /* storage can be unavailable in private mode */ }
    // Single-account mode: keep only the profile selected by the old ?account
    // parameter (or the last saved/first profile) and drop the switcher.
    const requestedProfile = Math.max(1, Math.round(Number(new URLSearchParams(location.search).get("account")) || 0));
    const fallbackProfile = savedProfileNumber >= 1 ? savedProfileNumber : 1;
    state.profileNumber = Math.min(
      requestedProfile || fallbackProfile,
      Math.max(1, state.accounts.length)
    );
    const chosenProfile = state.accounts[state.profileNumber - 1] || state.accounts[0];
    state.accounts = chosenProfile ? [chosenProfile] : [];
    // The candle window is a code-level visual setting. Older localStorage
    // saves carry the previous 30-candle value and were overriding config.js.
    state.playback.visibleCandles = DEFAULTS.playback.visibleCandles;
    state.playback.language = normalizeLanguage(state.playback.language);
  }

  function savePersisted() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        profileNumber: state.profileNumber,
        accounts: state.accounts,
        playback: state.playback
      }));
      return true;
    } catch (err) {
      showToast("Could not save locally. The CSV or account data may be too large.", 4200);
      return false;
    }
  }

  function getInitialAccountIndex() {
    const params = new URLSearchParams(location.search);
    const raw = params.get("account");
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 1 && n <= state.accounts.length) return Math.floor(n) - 1;
    return 0;
  }

  function updateAccountUrl() {
    try {
      const params = new URLSearchParams(location.search);
      params.set("account", String(state.profileNumber || (state.accountIndex + 1)));
      history.replaceState(null, "", location.pathname + "?" + params.toString());
    } catch (_) { /* file:// or restricted history */ }
  }

  function fitStage() {
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const scale = Math.min(vw / DEFAULTS.stage.width, vh / DEFAULTS.stage.height);
    state.stageScale = scale;
    document.documentElement.style.setProperty("--stage-scale", String(scale));
    if (chart) chart.setScale(scale);
  }

  function cacheKey(account) {
    // The record chart is locked to the past 48 hours of 15-minute candles.
    return [
      account.source, account.symbol, "15m",
      account.csvUrl || "", account.csvText ? account.csvText.length : 0
    ].join("|");
  }

  async function getCandles(account, force) {
    const key = cacheKey(account);
    const hit = cache.get(key);
    if (!force && hit && Date.now() - hit.at < 60 * 1000) return hit.result;
    const result = await TradingData.loadCandles(account);
    cache.set(key, { at: Date.now(), result: result });
    return result;
  }

  function prefetchOtherAccounts() {
    state.accounts.forEach(function (account, i) {
      if (i === state.accountIndex || account.source === "csv") return;
      setTimeout(function () {
        getCandles(account, false).catch(function () { /* silent background prefetch */ });
      }, 900 + i * 260);
    });
  }

  function showToast(message, ms) {
    if (refs.toast) {
      refs.toast.textContent = message;
      refs.toast.classList.remove("hidden");
    }
    if (refs.studioToast) {
      refs.studioToast.textContent = message;
      refs.studioToast.classList.remove("hidden");
    }
    clearTimeout(state.timerToast);
    state.timerToast = setTimeout(function () {
      if (refs.toast) refs.toast.classList.add("hidden");
      if (refs.studioToast) refs.studioToast.classList.add("hidden");
    }, ms || 1900);
  }

  function showChartMessage(message) {
    if (!refs.chartMessage) return;
    refs.chartMessage.textContent = message;
    refs.chartMessage.classList.remove("hidden");
  }

  function hideChartMessage() {
    if (refs.chartMessage) refs.chartMessage.classList.add("hidden");
  }

  function renderChrome() {
    const account = state.account;
    if (!account) return;
    setText(refs.symbolName, account.symbol);
    setText(refs.cardSymbol, account.symbol);
    setText(refs.assetBadge, account.direction === "short" ? "S" : "B");
    refs.assetBadge.classList.toggle("short", account.direction === "short");
    setText(refs.sizeAsset, baseAsset(account.symbol));
    state.leverage = clamp(Math.round(Number(account.leverage) || state.leverage || 1), 1, 125);
    setText(refs.crossLeverage, (account.marginMode === "isolated" ? "Isolated " : "Cross ") + state.leverage + "X");
    setText(refs.simPill, account.simLabel || DEFAULTS.brand.simBadge || "SIM");
    setText(refs.orderSizeLabel, orderSizeText(account.orderSize || DEFAULTS.ui.defaultOrderSize));
    setText(refs.costValue, "0 USDT");
    refs.closedTag.classList.add("hidden");
    setText(refs.posCount, "(" + (Number(account.positionCount) || 0) + ")");
    setText(refs.realizedValue, fmtSigned(state.realizedBase, 2));
    setClass(refs.realizedValue, "negative", state.realizedBase < 0);
    setClass(refs.realizedValue, "positive", state.realizedBase > 0);
    state.orderSide = account.direction === "long" ? "long" : "short";
    applyOrderSideVisuals();
    updateStudioActiveTab();
    // A background candle load must never repopulate the form and erase values
    // the user is currently editing.
    if (!refs.studio.classList.contains("hidden") && !state.studioDirty) populateStudio();
  }

  function updateStudioActiveTab() {
    if (!refs.studioTabs) return;
    $$(".studio-account-tab", refs.studioTabs).forEach(function (btn) {
      btn.classList.toggle("active", Number(btn.dataset.index) === state.accountIndex);
    });
  }

  function buildStudioTabs() {
    refs.studioTabs.style.display = state.accounts.length > 1 ? "" : "none";
    refs.studioTabs.innerHTML = state.accounts.map(function (a, i) {
      return '<button type="button" class="studio-account-tab' + (i === state.accountIndex ? " active" : "") +
        '" data-index="' + i + '"><strong>' + esc(a.handle || ("Account " + (i + 1))) +
        '</strong><span>' + (i + 1) + ' / ' + state.accounts.length + '</span></button>';
    }).join("");
  }

  function prepareData(result, account, opts) {
    const a = account || state.account;
    const options = opts || {};
    let candles = result.candles.slice();
    let intervalMs = result.baseInterval && result.baseInterval !== "csv"
      ? TradingData.intervalToMs(result.baseInterval)
      : TradingData.intervalToMs("15m");
    let warning = result.warning || "";
    let baseDataMs = intervalMs;

    if (a.source === "csv") {
      const baseMs = medianDelta(candles);
      baseDataMs = baseMs;
      if (intervalMs < baseMs * 0.92) {
        intervalMs = baseMs;
        warning = "This CSV is " + intervalFromMs(baseMs) + " data. The chart is using its native interval.";
      } else if (intervalMs > baseMs * 1.08) {
        candles = TradingData.aggregate(candles, baseMs, intervalMs);
      }
    }

    if (!options.preview) state.baseDataMs = baseDataMs;
    return { candles: candles, intervalMs: intervalMs, warning: warning, baseDataMs: baseDataMs };
  }

  function pickNarrativeStart(data, a, entryPrice, size, margin, lastIdx, entryIdx, liqPrice) {
    const directionSign = a.direction === "short" ? -1 : 1;
    const startBack = clamp(Math.round(Number(a.replayStartBackCandles) || 0), 0, MAX_PLAYBACK_CANDLES);
    const drawdownPct = clamp(Number(a.drawdownPct) || 0, 0, 100);
    const noDrawdown = !(drawdownPct > 0);
    const startTarget = noDrawdown
      ? entryPrice
      : entryPrice - directionSign * (drawdownPct / 100) * (margin / size);
    const minStart = Math.max(entryIdx + 1, lastIdx - 110);
    const maxStart = lastIdx - 8;
    let best = null;
    for (let s = minStart; s <= maxStart; s++) {
      if (noDrawdown) {
        if (entryPrice < data[s].l || entryPrice > data[s].h) continue;
        if (directionSign > 0 ? data[s].c >= entryPrice : data[s].c <= entryPrice) continue;
      } else if (directionSign > 0) {
        if (data[s].c >= entryPrice || data[s + 1].c >= entryPrice) continue;
      } else if (data[s].c <= entryPrice || data[s + 1].c <= entryPrice) {
        continue;
      }
      let turn = -1;
      let lossAfterStart = false;
      for (let j = s + (noDrawdown ? 1 : 2); j <= lastIdx; j++) {
        const pnlAtJ = size * (data[j].c - entryPrice) * directionSign;
        if (pnlAtJ < 0) lossAfterStart = true;
        if (pnlAtJ >= 0) { turn = j; break; }
      }
      if (turn < 0 || turn > lastIdx - 2) continue;
      if (noDrawdown && !lossAfterStart) continue;
      if (liqPrice != null) {
        let liquidates = false;
        for (let j = s; j <= lastIdx; j++) {
          if ((directionSign > 0 && data[j].l <= liqPrice) ||
              (directionSign < 0 && data[j].h >= liqPrice)) {
            liquidates = true;
            break;
          }
        }
        if (liquidates) continue;
      }
      let crosses = 0;
      let prevSign = Math.sign((data[s].c - entryPrice) * directionSign);
      for (let j = s + 1; j <= lastIdx; j++) {
        const sign = Math.sign((data[j].c - entryPrice) * directionSign);
        if (sign !== 0 && sign !== prevSign) { crosses += 1; prevSign = sign; }
      }
      const rangeOk = startTarget == null ||
        (data[s].l <= startTarget && startTarget <= data[s].h);
      const preferredOffset = Math.abs((lastIdx - s) - startBack);
      const lossCandles = turn - s;
      const score = crosses * 3 + Math.min(10, lossCandles) * 0.05 -
        preferredOffset * 0.05 + (rangeOk ? 1 : 0);
      if (!best || score > best.score) {
        best = { index: s, turn: turn, crosses: crosses, rangeOk: rangeOk, score: score };
      }
    }
    return best;
  }

  /**
   * Find the exact cursor of the first mark >= entry after replay starts.
   * This uses the same interpolatePrice() path as the chart, so the requested
   * turn time can be mapped to the real first-profit boundary.
   */
  function findFirstProfitCursor(data, startIdx, endIdx, entryPrice, directionSign) {
    if (!data || !TradingChart || !TradingChart.interpolatePrice) return null;
    const priceAt = TradingChart.interpolatePrice;
    for (let j = startIdx + 1; j <= endIdx; j++) {
      const candle = data[j];
      if (!candle) continue;
      const canCross = directionSign > 0 ? candle.h >= entryPrice : candle.l <= entryPrice;
      if (!canCross) continue;
      let prevP = 0;
      let prevValue = (priceAt(candle, 0) - entryPrice) * directionSign;
      if (prevValue >= 0) return j;
      for (let k = 1; k <= 48; k++) {
        const p = k / 48;
        const value = (priceAt(candle, p) - entryPrice) * directionSign;
        if (value >= 0) {
          let lo = prevP;
          let hi = p;
          for (let b = 0; b < 22; b++) {
            const mid = (lo + hi) / 2;
            const midValue = (priceAt(candle, mid) - entryPrice) * directionSign;
            if (midValue >= 0) hi = mid;
            else lo = mid;
          }
          return j + hi;
        }
        prevP = p;
        prevValue = value;
      }
    }
    return null;
  }

  /**
   * One deterministic scenario calculation shared by the pre-record preview and
   * the recorded screen. The preview cannot use a different path or different
   * rounding from the screen.
   */

  function smoothstep01(t) {
    const p = clamp(t, 0, 1);
    return p * p * (3 - 2 * p);
  }

  function controlledWave(p, amplitude, cycles) {
    // Tick-level travel inside the controlled path. It vanishes at every
    // anchor (p=0,1), so the floor/turn/target stay exact while each candle
    // gains its own high/low body and can flip red/green within its interval.
    const envelope = Math.pow(Math.sin(Math.PI * clamp(p, 0, 1)), 1.35);
    const turns = Math.max(4, Number(cycles) || 8);
    return Math.sin(p * Math.PI * 2 * turns) * envelope * amplitude;
  }

  function controlledMarkAt(path, cursor) {
    if (!path) return 0;
    if (Math.abs(cursor - path.floorCursor) <= 0.08) return path.floorMark;
    if (Math.abs(cursor - path.turnCursor) <= 0.025) return path.turnMark;
    if (cursor <= path.startCursor) return path.startMark;

    let value;
    let lo;
    let hi;
    if (cursor <= path.floorCursor) {
      const p = (cursor - path.startCursor) / Math.max(1e-9, path.floorCursor - path.startCursor);
      value = path.startMark + (path.floorMark - path.startMark) * smoothstep01(p) +
        controlledWave(p, Math.abs(path.floorMark - path.startMark) * 0.32, path.cycles);
      lo = Math.min(path.startMark, path.floorMark);
      hi = Math.max(path.startMark, path.floorMark);
      return clamp(value, lo, hi);
    }
    if (cursor <= path.turnCursor) {
      const p = (cursor - path.floorCursor) / Math.max(1e-9, path.turnCursor - path.floorCursor);
      value = path.floorMark + (path.turnMark - path.floorMark) * smoothstep01(p) +
        controlledWave(p, Math.abs(path.turnMark - path.floorMark) * 0.32, path.cycles);
      lo = Math.min(path.floorMark, path.turnMark);
      hi = Math.max(path.floorMark, path.turnMark);
      return clamp(value, lo, hi);
    }
    if (cursor <= path.endCursor) {
      const p = (cursor - path.turnCursor) / Math.max(1e-9, path.endCursor - path.turnCursor);
      const targetSpan = path.endMark - path.turnMark;
      const eased = smoothstep01(p);
      const envelope = Math.pow(Math.sin(Math.PI * clamp(p, 0, 1)), 1.35);
      // One-sided retracements: the path can dip below its smoothed advance but
      // never jumps the target. The extra ramp holds the first frames just
      // after the turn positive/negative in the trade direction, and the sine
      // envelope pins the final mark to the exact target. Unlike a full two-
      // sided wave this cannot touch the target early and flatten the tail.
      const dipRamp = smoothstep01(clamp(p * 12, 0, 1));
      const dip = (0.5 + 0.5 * Math.sin(p * Math.PI * 2 * Math.max(1, path.cycles))) *
        Math.abs(targetSpan) * 0.18 * envelope * dipRamp;
      value = path.turnMark + targetSpan * eased - Math.sign(targetSpan) * dip;
      lo = Math.min(path.turnMark, path.endMark);
      hi = Math.max(path.turnMark, path.endMark);
      return clamp(value, lo, hi);
    }
    return path.endMark;
  }

  function playbackSecondsPerCandle() {
    return clamp(Number(DEFAULTS.playback.secondsPerCandle) || 0.9, 0.3, 3);
  }

  function playbackCandleSpan(takeSeconds) {
    // Legacy fallback for the retired window fields. The active 48h/15m planner
    // chooses its playback count and cadence from the real pattern.
    return clamp(
      Math.round((Number(takeSeconds) || 10) / playbackSecondsPerCandle()),
      4,
      MAX_PLAYBACK_CANDLES
    );
  }

  function playbackPatternSignature(a, data, startIdx, endIdx) {
    return [a.interval, data[startIdx].t, data[endIdx].t].join("|");
  }

  function sourceTimeForCursor(data, cursor, intervalMs) {
    if (!data.length) return 0;
    const interval = Math.max(1, Number(intervalMs) || 60000);
    const last = data.length - 1;
    const c = Number(cursor) || 0;
    if (c > last) {
      // The generated replay can continue past the newest cached candle. Keep
      // source timestamps monotonic by extrapolating the real bucket clock.
      return Number(data[last].t) + (c - last) * interval;
    }
    const idx = clamp(Math.floor(c), 0, last);
    const frac = clamp(c - idx, 0, 1);
    return Number(data[idx].t) + frac * interval;
  }

  const PATTERN_MIN_PLAYBACK = 36;
  const PATTERN_MAX_PLAYBACK = 72;
  const PATTERN_MID_PLAYBACK = 48;

  function patternCandleStats(data, seedCount, playCount, boundary, dir, orient, floorMark) {
    const p = data.slice(seedCount, seedCount + playCount);
    if (p.length < playCount || boundary < 2 || boundary > playCount - 2) return null;
    const q = function (v) { return orient * Number(v); };
    const q0 = q(p[0].o);
    let floorIdx = -1;
    let qFloor = 0;
    if (dir > 0) {
      floorIdx = 0;
      qFloor = q(p[0].c);
      for (let i = 1; i < boundary; i++) {
        const v = q(p[i].c);
        if (v < qFloor) { qFloor = v; floorIdx = i; }
      }
      if (!(qFloor < q0)) return null;
    } else {
      floorIdx = 0;
      qFloor = q(p[0].c);
      for (let i = 1; i < boundary; i++) {
        const v = q(p[i].c);
        if (v > qFloor) { qFloor = v; floorIdx = i; }
      }
      if (!(qFloor > q0)) return null;
    }
    const qBoundary = q(p[boundary - 1].c);
    const qEnd = q(p[p.length - 1].c);
    if (dir > 0) {
      if (!(qBoundary > qFloor && qEnd > qBoundary)) return null;
    } else if (!(qBoundary < qFloor && qEnd < qBoundary)) return null;

    let strict = true;
    for (let i = boundary; i < playCount; i++) {
      const v = q(p[i].c);
      if (dir > 0 ? v < qBoundary : v > qBoundary) { strict = false; break; }
    }
    return {
      seedCount: seedCount,
      playCount: playCount,
      boundary: boundary,
      floorIdx: floorIdx,
      orient: orient,
      strict: strict,
      q0: q0,
      qFloor: qFloor,
      qBoundary: qBoundary,
      qEnd: qEnd,
      baseCandles: p
    };
  }

  function choosePatternWindow(a, data, entryPrice, floorMark, finalMark, takeSeconds, turnSeconds, directionSign) {
    const ratio = turnSeconds / takeSeconds;
    const used = new Set(Array.isArray(a.usedPatterns) ? a.usedPatterns : []);
    const usedLabels = new Set(Array.isArray(a.usedPatternLabels) ? a.usedPatternLabels : []);
    const seed = Math.max(0, Math.round(Number(a.scenarioSeed) || 0));
    const total = data.length;
    const candidates = [];

    for (let playCount = PATTERN_MIN_PLAYBACK; playCount <= PATTERN_MAX_PLAYBACK; playCount++) {
      const seedCount = total - playCount;
      if (seedCount < 0) continue;
      const boundary = Math.round(ratio * playCount);
      if (boundary < 2 || boundary > playCount - 2) continue;
      const turnCountError = Math.abs(ratio * playCount - boundary);
      const turnTimeError = turnCountError * (takeSeconds / playCount);
      const p = data.slice(seedCount, seedCount + playCount);
      if (p.length < playCount) continue;
      const signature = [a.symbol, "15m", p[0].t, p[p.length - 1].t].join("|");
      const label = classifyChartPattern(p, 0, p.length - 1);
      for (let oi = 0; oi < 2; oi++) {
        const orient = oi === 0 ? 1 : -1;
        const stats = patternCandleStats(data, seedCount, playCount, boundary, directionSign, orient, floorMark);
        if (!stats) continue;
        const score = (stats.strict ? 0 : 8) +
          (stats.floorIdx === 0 ? 2.5 : 0) +
          turnTimeError * 30 +
          Math.abs(playCount - PATTERN_MID_PLAYBACK) * 0.025 +
          (orient === -1 ? 0.25 : 0) +
          (used.has(signature) ? 3.2 : 0) +
          (usedLabels.has(label) ? 0.6 : 0);
        candidates.push({
          score: score,
          signature: signature,
          label: label,
          stats: stats,
          turnTimeError: turnTimeError
        });
      }
    }

    if (!candidates.length) return null;
    const strict = candidates.filter(function (c) { return c.stats.strict; });
    const pool = strict.length ? strict : candidates;
    pool.sort(function (x, y) { return x.score - y.score; });
    const chosen = pool[seed % pool.length];
    chosen.poolLength = pool.length;
    return chosen;
  }

  function mappedCandle(c, transform, orient) {
    const map = function (v) {
      return transform.a + transform.b * orient * Number(v);
    };
    const o = map(c.o);
    const h = map(c.h);
    const l = map(c.l);
    const cl = map(c.c);
    return {
      t: Number(c.t),
      time: Number(c.t),
      o: o,
      h: h,
      l: l,
      c: cl,
      v: Number(c.v || 0),
      closed: true,
      synthetic: false,
      actualOpen: Number(c.o),
      actualClose: Number(c.c)
    };
  }

  function normalizeMappedCandle(c) {
    c.h = Math.max(c.h, c.o, c.c);
    c.l = Math.min(c.l, c.o, c.c);
    if (!(c.h > c.l)) {
      const pad = Math.max(Math.abs(c.c) * 1e-6, 1e-9);
      c.h = c.c + pad;
      c.l = c.c - pad;
    }
    return c;
  }

  function buildPatternPlan(a, data, entryPrice, floorMark, finalMark, takeSeconds, turnSeconds, directionSign, noDrawdown) {
    const chosen = choosePatternWindow(a, data, entryPrice, floorMark, finalMark,
      takeSeconds, turnSeconds, directionSign);
    if (!chosen) return null;
    const stats = chosen.stats;
    const playCount = stats.playCount;
    const seedCount = stats.seedCount;
    const boundary = stats.boundary;
    const orient = stats.orient;
    const f = stats.floorIdx;
    const p = stats.baseCandles;
    const internalFloor = floorMark != null
      ? floorMark
      : entryPrice - directionSign * Math.max(entryPrice * 0.004, Math.abs(finalMark - entryPrice) * 0.18);

    const q0 = stats.q0;
    const qf = stats.qFloor;
    const qb = stats.qBoundary;
    const qe = stats.qEnd;
    const safe = function (den) {
      if (Math.abs(den) < 1e-12) return den >= 0 ? 1e-12 : -1e-12;
      return den;
    };
    const t1 = {
      b: (internalFloor - entryPrice) / safe(qf - q0)
    };
    t1.a = entryPrice - t1.b * q0;
    const t2 = {
      b: (entryPrice - internalFloor) / safe(qb - qf)
    };
    t2.a = internalFloor - t2.b * qf;
    const t3 = {
      b: (finalMark - entryPrice) / safe(qe - qb)
    };
    t3.a = entryPrice - t3.b * qb;

    const seedQEnd = seedCount > 0 ? orient * Number(data[seedCount - 1].c) : q0;
    const seedTransform = {
      b: t1.b,
      a: entryPrice - t1.b * seedQEnd
    };

    const seedCandles = [];
    for (let i = 0; i < seedCount; i++) {
      seedCandles.push(normalizeMappedCandle(mappedCandle(data[i], seedTransform, orient)));
    }

    const playback = [];
    for (let i = 0; i < playCount; i++) {
      const transform = i <= f ? t1 : (i <= boundary - 1 ? t2 : t3);
      let c = mappedCandle(p[i], transform, orient);
      if (directionSign > 0) {
        c.l = Math.max(c.l, internalFloor);
        if (i < boundary) {
          c.o = Math.min(c.o, entryPrice);
          c.c = Math.min(c.c, entryPrice);
          c.h = Math.min(c.h, entryPrice);
        } else {
          c.o = Math.max(c.o, entryPrice);
          c.c = Math.max(c.c, entryPrice);
          c.l = Math.max(c.l, entryPrice);
        }
      } else {
        c.h = Math.min(c.h, internalFloor);
        if (i < boundary) {
          c.o = Math.max(c.o, entryPrice);
          c.c = Math.max(c.c, entryPrice);
          c.l = Math.max(c.l, entryPrice);
        } else {
          c.o = Math.min(c.o, entryPrice);
          c.c = Math.min(c.c, entryPrice);
          c.h = Math.min(c.h, entryPrice);
        }
      }
      normalizeMappedCandle(c);
      playback.push(c);
    }

    // The exact final close must survive all shape/clip operations.
    if (playback.length) {
      const last = playback[playback.length - 1];
      const delta = finalMark - last.c;
      last.o += delta;
      last.h += delta;
      last.l += delta;
      last.c = finalMark;
      normalizeMappedCandle(last);
    }

    const candles = seedCandles.concat(playback);
    return {
      candles: candles,
      seedCount: seedCount,
      playCount: playCount,
      boundary: boundary,
      floorIdx: f,
      floorMark: internalFloor,
      targetMark: finalMark,
      entryPrice: entryPrice,
      directionSign: directionSign,
      orient: orient,
      startCursor: seedCount,
      endCursor: seedCount + playCount,
      floorCursor: seedCount + f + 1,
      turnCursor: seedCount + boundary,
      turnError: chosen.turnTimeError,
      turnMatched: true,
      patternName: chosen.label,
      patternSignature: chosen.signature,
      poolLength: chosen.poolLength || 1,
      secondsPerCandle: takeSeconds / playCount,
      noDrawdown: !!noDrawdown,
      playbackCandles: playCount
    };
  }

  function buildControlledScenario(a, data) {
    if (!a || !data || data.length < 192) return null;
    const leverage = clamp(Math.round(Number(a.leverage) || 1), 1, 125);
    const takeSeconds = clamp(
      Math.round(Number(a.takeSeconds) || 26),
      10,
      MAX_TAKE_SECONDS
    );
    const margin = effectiveMarginFor(a, Math.max(1, Number(a.marginUsd) || 1));
    const directionSign = a.direction === "short" ? -1 : 1;
    const drawdownPct = clamp(Number(a.drawdownPct) || 0, 0, 100);
    const noDrawdown = !(drawdownPct > 0);
    const turnSeconds = clamp(Math.round(Number(a.turnSeconds) || 10), 1, takeSeconds);
    const targetPnl = Number(a.targetPnl) > 0 ? Number(a.targetPnl) : null;
    const entryPrice = Number(a.entryPriceOverride);
    if (!(entryPrice > 0)) return null;
    const size = (margin * leverage) / entryPrice;
    if (!Number.isFinite(size) || size <= 0) return null;

    const warnings = [];
    const blockers = [];
    if (targetPnl == null) {
      const msg = "The final PNL target is required as a manual setting. Recording is blocked; enter a positive target value.";
      warnings.push(msg);
      blockers.push(msg);
    }
    if (!(turnSeconds < takeSeconds)) {
      const msg = "The requested turn must be less than the take length for uniform playback. Recording is blocked.";
      warnings.push(msg);
      blockers.push(msg);
    }

    let dataLow = Infinity;
    let dataHigh = -Infinity;
    data.forEach(function (c) {
      if (c.l < dataLow) dataLow = c.l;
      if (c.h > dataHigh) dataHigh = c.h;
    });
    if (entryPrice < dataLow || entryPrice > dataHigh) {
      const msg = "The manual entry " + fmt(entryPrice, a.priceDecimals || 2) +
        " is outside the loaded 48-hour 15m candle range " + fmt(dataLow, a.priceDecimals || 2) +
        "–" + fmt(dataHigh, a.priceDecimals || 2) +
        ". Recording is blocked; use a realistic entry or ticker.";
      warnings.push(msg);
      blockers.push(msg);
    }

    const floorMark = noDrawdown
      ? null
      : entryPrice - directionSign * (drawdownPct / 100) * (margin / size);
    const finalMark = targetPnl != null
      ? entryPrice + directionSign * (targetPnl / size)
      : entryPrice;

    let liquidated = false;
    const liqPrice = liquidationPriceFor(a, size, margin, entryPrice);
    if (liqPrice != null && floorMark != null) {
      if (directionSign > 0 ? floorMark <= liqPrice : floorMark >= liqPrice) {
        liquidated = true;
        const msg = "The max-drawdown mark is beyond Liq. Price " +
          fmt(liqPrice, a.priceDecimals || 2) + "; the controlled path would liquidate before the request. " +
          "Recording is blocked.";
        warnings.push(msg);
        blockers.push(msg);
      }
    }
    if (!(finalMark > 0)) {
      const msg = "The final PNL target produces a non-positive exit price. Recording is blocked.";
      warnings.push(msg);
      blockers.push(msg);
    }

    // Use the full 192-candle 48-hour source as the chart pool. The planner
    // selects the real playback candles from the latest part of the pool; the
    // preceding candles form a deep seed, so the 96 visible slots are filled
    // from the left edge instead of leaving empty "home" space behind price.
    let plan = buildPatternPlan(a, data, entryPrice, floorMark, finalMark,
      takeSeconds, turnSeconds, directionSign, noDrawdown);
    if (plan) {
      plan.windowStart = 0;
      plan.windowStartTime = Number(data[0].t);
      plan.windowEndTime = Number(data[data.length - 1].t);
      plan.sourceCandles = data.length;
    }
    if (!plan) {
      const msg = "No usable real pattern window could be mapped inside the 48-hour 15m source. Recording is blocked.";
      warnings.push(msg);
      blockers.push(msg);
    }

    const actualDrawdownPct = noDrawdown ? 0 : drawdownPct;
    const pnlEnd = targetPnl != null ? targetPnl : size * (finalMark - entryPrice) * directionSign;
    const roiEnd = margin ? (pnlEnd / margin) * 100 : 0;

    return {
      lastIdx: data.length - 1,
      entryIdx: plan ? plan.seedCount : Math.max(0, data.length - 48),
      startIdx: plan ? plan.seedCount : 0,
      startCursor: plan ? plan.startCursor : 0,
      endCursor: plan ? plan.endCursor : data.length,
      floorIdx: plan ? plan.floorIdx : 0,
      leverage: leverage,
      takeSeconds: takeSeconds,
      margin: margin,
      finalMark: finalMark,
      startMark: entryPrice,
      startMarkOverride: entryPrice,
      drawdownMark: floorMark,
      drawdownCursor: plan ? plan.floorCursor : null,
      maxLossPnl: noDrawdown ? 0 : -(drawdownPct / 100) * margin,
      maxLossMark: floorMark,
      endMarkOverride: finalMark,
      turnCursor: plan ? plan.turnCursor : null,
      turnMarkOverride: entryPrice,
      controlledPath: null,
      patternPlan: plan,
      targetPnl: targetPnl,
      entryPrice: entryPrice,
      size: size,
      notional: size * entryPrice,
      pnlStart: 0,
      pnlEnd: pnlEnd,
      roiEnd: roiEnd,
      liquidated: liquidated,
      turnIdx: plan ? Math.floor(plan.turnCursor) : 0,
      turnSeconds: turnSeconds,
      actualTurnSeconds: turnSeconds,
      drawdownPct: drawdownPct,
      actualDrawdownPct: actualDrawdownPct,
      turnMatched: !!plan,
      warnings: warnings,
      blockers: blockers,
      poolLength: plan ? plan.poolLength : 1,
      playbackSpan: plan ? plan.playCount : 0,
      playbackCandles: plan ? plan.playCount : 0,
      patternName: plan ? plan.patternName : classifyChartPattern(data, 0, data.length - 1),
      patternSignature: plan ? plan.patternSignature : ["15m", data[0].t, data[data.length - 1].t].join("|"),
      entryMatched: true,
      startTime: Number(data[0].t),
      endTime: Number(data[data.length - 1].t),
      sourceWindowStart: 0,
      sourceCandles: data.length,
      dataEndIdx: data.length - 1
    };
  }

  function buildScenario(a, data) {
    return buildControlledScenario(a, data);
  }

  function buildLegacyScenario(a, data) {
    if (!a || !data || data.length < 12) return null;
    const dataLastIdx = data.length - 1;
    const leverage = clamp(Math.round(Number(a.leverage) || 1), 1, 125);
    const takeSeconds = clamp(Number(a.takeSeconds) || 26, 10, MAX_TAKE_SECONDS);
    const margin = effectiveMarginFor(a, Math.max(1, Number(a.marginUsd) || 1));
    const directionSign = a.direction === "short" ? -1 : 1;
    const drawdownPct = clamp(Number(a.drawdownPct) || 0, 0, 100);
    const noDrawdown = !(drawdownPct > 0);
    const turnSeconds = clamp(Math.round(Number(a.turnSeconds) || 10), 1, takeSeconds);
    const targetPnl = Number(a.targetPnl) > 0 ? Number(a.targetPnl) : null;
    const entryPrice = Number(a.entryPriceOverride);
    if (!(entryPrice > 0)) return null;
    const size = (margin * leverage) / entryPrice;
    if (!Number.isFinite(size) || size <= 0) return null;
    const warnings = [];
    const blockers = [];
    if (targetPnl == null) {
      const msg = "The final PNL target is required as a manual setting. Recording is blocked; enter a positive target value.";
      warnings.push(msg);
      blockers.push(msg);
    }
    let dataLow = Infinity;
    let dataHigh = -Infinity;
    data.forEach(function (c) {
      if (c.l < dataLow) dataLow = c.l;
      if (c.h > dataHigh) dataHigh = c.h;
    });
    if (entryPrice < dataLow || entryPrice > dataHigh) {
      const msg = "The manual entry " + fmt(entryPrice, a.priceDecimals || 2) +
        " is outside the real candle range " + fmt(dataLow, a.priceDecimals || 2) +
        "–" + fmt(dataHigh, a.priceDecimals || 2) +
        " for this window. Recording is blocked; use a realistic entry, ticker or CSV.";
      warnings.push(msg);
      blockers.push(msg);
    }
    const liqPrice = liquidationPriceFor(a, size, margin, entryPrice);
    const foundWindow = findClosestScenarioWindow(a, data);
    const lastIdx = foundWindow ? foundWindow.endIdx : dataLastIdx;
    const maxEntryBack = Math.max(1, lastIdx - 6);
    const entryBack = clamp(Math.round(Number(a.entryBackCandles) || 1), 1, maxEntryBack);
    const startBack = clamp(Math.round(Number(a.replayStartBackCandles) || 0), 0, entryBack);
    const entryIdx = lastIdx - entryBack;
    const narrative = foundWindow ? null
      : pickNarrativeStart(data, a, entryPrice, size, margin, lastIdx, entryIdx, liqPrice);
    const startIdx = foundWindow
      ? foundWindow.startIdx
      : (narrative ? narrative.index : clamp(lastIdx - startBack, entryIdx + 1, lastIdx - 1));
    const floorMarkTarget = noDrawdown
      ? null
      : entryPrice - directionSign * (drawdownPct / 100) * (margin / size);
    const floorStartIdx = startIdx;
    const floorStartCursor = floorStartIdx + 0.999999;
    const floorCandle = data[floorStartIdx];
    const floorRangeOk = noDrawdown ||
      (floorCandle.l <= floorMarkTarget && floorMarkTarget <= floorCandle.h);
    if (!floorRangeOk) {
      const msg = "The requested max-drawdown mark " + fmt(floorMarkTarget, a.priceDecimals || 2) +
        " is outside the selected real drawdown candle. Recording is blocked; pick another " +
        "drawdown/window so the value can be followed exactly.";
      warnings.push(msg);
      blockers.push(msg);
    }

    // The replay starts at the manual entry with 0 PNL, then goes through the
    // real adverse move to the drawdown floor, turns at the requested second
    // and ends at the target. Starting at the entry is what gives the uniform
    // time→cursor map enough loss candles to place the turn exactly.
    let entryStartIdx = -1;
    for (let j = Math.max(0, entryIdx); j < floorStartIdx; j++) {
      const candle = data[j];
      if (candle && entryPrice >= candle.l && entryPrice <= candle.h) {
        entryStartIdx = j;
        break;
      }
    }
    if (entryStartIdx < 0) {
      // The replay may start at the entry candle with the manual entry mark
      // even when the candle body does not contain it; the mark is simulated.
      entryStartIdx = Math.max(0, Math.min(entryIdx, floorStartIdx - 1));
    }
    const startMark = entryPrice;
    const pnlStart = 0;
    const startCursor = entryStartIdx >= 0
      ? entryStartIdx + 0.999999
      : floorStartCursor;
    const startCandle = entryStartIdx >= 0 ? data[entryStartIdx] : floorCandle;
    const drawdownCursor = noDrawdown ? null : floorStartCursor;

    const finalTargetMark = targetPnl != null
      ? entryPrice + directionSign * (targetPnl / size)
      : null;
    let finalMark = finalTargetMark != null ? finalTargetMark : data[lastIdx].c;
    let endIdx = lastIdx;
    let liquidated = false;
    let liquidatedIdx = -1;
    const liquidationFrom = entryStartIdx >= 0 ? entryStartIdx : floorStartIdx;
    if (liqPrice != null) {
      for (let i = liquidationFrom; i <= lastIdx; i++) {
        const c = data[i];
        if ((directionSign > 0 && c.l <= liqPrice) ||
            (directionSign < 0 && c.h >= liqPrice)) {
          liquidated = true;
          liquidatedIdx = i;
          break;
        }
      }
    }
    if (liquidated) {
      finalMark = liqPrice;
      endIdx = liquidatedIdx;
      const msg = "The real path reaches Liq. Price " + fmt(liqPrice, a.priceDecimals || 2) +
        (liquidatedIdx === liquidationFrom ? " before replay begins" : " at " + formatDateTime(data[liquidatedIdx].t)) +
        "; the replay stops liquidated and the target is not reached. Recording is blocked " +
        "because the configured final PNL cannot be followed.";
      warnings.push(msg);
      blockers.push(msg);
    }

    let turnCursor = liquidated || entryStartIdx < 0 ? null
      : findFirstProfitCursor(data, floorStartIdx, lastIdx, entryPrice, directionSign);
    const turnIdx = turnCursor != null ? Math.floor(turnCursor) : null;
    const turnCandle = turnIdx != null ? data[turnIdx] : null;
    const turnMarkOverride = turnCandle &&
      entryPrice >= turnCandle.l && entryPrice <= turnCandle.h
      ? entryPrice : null;

    // One linear time→cursor map for the whole take. Starting at the entry and
    // ending at the target, solve the end cursor so the first-profit crossing
    // lands exactly at turnSeconds. No speed change is allowed at the turn.
    let timelineStartCursor = startCursor;
    let timelineStartIdx = entryStartIdx >= 0 ? entryStartIdx : floorStartIdx;
    let timelineEndCursor = lastIdx + 1;
    let timelineOk = false;
    const turnRatio = turnSeconds / takeSeconds;
    if (!liquidated && turnCursor != null && entryStartIdx >= 0 &&
        turnRatio > 0 && turnRatio < 1) {
      const afterFloor = noDrawdown || turnCursor > floorStartCursor;
      const solvedEnd = startCursor +
        (turnCursor - startCursor) * (takeSeconds / turnSeconds);
      if (afterFloor && Number.isFinite(solvedEnd) && solvedEnd > turnCursor &&
          solvedEnd >= lastIdx && solvedEnd <= lastIdx + 1) {
        timelineStartCursor = startCursor;
        timelineEndCursor = solvedEnd;
        timelineOk = true;
      }
    }
    if (!timelineOk && !liquidated) {
      const msg = "The requested turn " + turnSeconds + "s cannot be placed at one " +
        "uniform chart speed inside this real window. Recording is blocked; choose " +
        "another pattern/window or adjust the turn/take seconds.";
      warnings.push(msg);
      blockers.push(msg);
    }
    if (!foundWindow && !narrative) {
      const msg = "No real loss-first turn was found in this window for the requested values. " +
        "Recording is blocked; use New pattern now or change the ticker/window.";
      warnings.push(msg);
      blockers.push(msg);
    }
    if (turnCursor == null && !liquidated) {
      const msg = "No real first-profit crossing exists inside this window, so the requested " +
        "turn time cannot be placed. Recording is blocked.";
      warnings.push(msg);
      blockers.push(msg);
    }
    if (targetPnl != null && !liquidated) {
      const lastCandle = data[lastIdx];
      if (finalMark < lastCandle.l || finalMark > lastCandle.h) {
        const msg = "The target exit mark " + fmt(finalMark, a.priceDecimals || 2) +
          " is outside the selected real final candle. Recording is blocked; use another " +
          "target/window so the final PNL can be followed exactly.";
        warnings.push(msg);
        blockers.push(msg);
      }
    }
    const patternName = foundWindow ? foundWindow.patternName : visiblePatternName(data, lastIdx);
    const patternSignature = foundWindow ? foundWindow.patternSignature : visiblePatternSignature(a, data, lastIdx);
    if (Array.isArray(a.usedPatterns) && a.usedPatterns.indexOf(patternSignature) !== -1 && !foundWindow) {
      const msg = "No unused valid real chart pattern remains in the current history window for these exact settings. Recording is blocked; change the entry/target/drawdown/interval or reset the saved patterns.";
      warnings.push(msg);
      blockers.push(msg);
    }
    const actualDrawdownPct = noDrawdown ? 0 : drawdownPct;
    const actualTurnSeconds = turnCursor != null && timelineOk ? turnSeconds : null;
    const pnlEnd = size * (finalMark - entryPrice) * directionSign;
    const roiEnd = margin ? (pnlEnd / margin) * 100 : 0;
    const notional = size * entryPrice;
    return {
      lastIdx: lastIdx,
      entryIdx: entryIdx,
      startIdx: timelineStartIdx,
      startCursor: timelineStartCursor,
      endCursor: timelineEndCursor,
      leverage: leverage,
      takeSeconds: takeSeconds,
      margin: margin,
      finalMark: finalMark,
      startMark: startMark,
      startMarkOverride: entryPrice,
      drawdownMark: floorMarkTarget,
      drawdownCursor: drawdownCursor,
      maxLossPnl: noDrawdown ? 0 : -(drawdownPct / 100) * margin,
      maxLossMark: floorMarkTarget,
      endMarkOverride: targetPnl != null && !liquidated ? finalMark : null,
      turnCursor: turnCursor,
      turnMarkOverride: turnMarkOverride,
      targetPnl: targetPnl,
      entryPrice: entryPrice,
      size: size,
      notional: notional,
      pnlStart: pnlStart,
      pnlEnd: pnlEnd,
      roiEnd: roiEnd,
      liquidated: liquidated,
      turnIdx: turnIdx,
      turnSeconds: turnSeconds,
      actualTurnSeconds: actualTurnSeconds,
      drawdownPct: drawdownPct,
      actualDrawdownPct: actualDrawdownPct,
      turnMatched: turnCursor != null && timelineOk,
      warnings: warnings,
      blockers: blockers,
      poolLength: foundWindow ? (foundWindow.poolLength || 1) : 1,
      patternName: patternName,
      patternSignature: patternSignature,
      startTime: data[timelineStartIdx].t,
      endTime: data[endIdx].t,
      dataEndIdx: lastIdx
    };
  }

  /**
   * Heuristic naming of the real chart shape. This does not synthesize data; it
   * labels the selected real window so pattern rotation can prefer a new shape.
   */
  function classifyChartPattern(data, startIdx, endIdx) {
    if (!data || endIdx - startIdx < 4) return "Short real path";
    const closes = [];
    for (let i = Math.max(0, startIdx); i <= endIdx; i++) closes.push(data[i].c);
    const n = closes.length;
    if (n < 6) return "Short real path";
    let max = -Infinity, min = Infinity, maxIdx = 0, minIdx = 0;
    for (let i = 0; i < n; i++) {
      if (closes[i] > max) { max = closes[i]; maxIdx = i; }
      if (closes[i] < min) { min = closes[i]; minIdx = i; }
    }
    const range = Math.max(1e-12, max - min);
    const mid = (max + min) / 2;
    const net = (closes[n - 1] - closes[0]) / range;
    const maxPos = maxIdx / Math.max(1, n - 1);
    const minPos = minIdx / Math.max(1, n - 1);
    const peaks = [];
    const troughs = [];
    for (let i = 1; i < n - 1; i++) {
      if (closes[i] > closes[i - 1] && closes[i] >= closes[i + 1]) peaks.push(i);
      if (closes[i] < closes[i - 1] && closes[i] <= closes[i + 1]) troughs.push(i);
    }
    const prominent = function (arr, isPeak) {
      return arr.filter(function (i) {
        const prom = isPeak ? max - closes[i] : closes[i] - min;
        return prom > 0.12 * range;
      });
    };
    const p = prominent(peaks, true);
    const t = prominent(troughs, false);
    let crossedMid = 0;
    let prev = Math.sign(closes[0] - mid);
    for (let i = 1; i < n; i++) {
      const sg = Math.sign(closes[i] - mid);
      if (sg !== 0 && sg !== prev) { crossedMid += 1; prev = sg; }
    }
    if (range / Math.max(1e-9, Math.abs(mid)) < 0.0025 || p.length + t.length < 2) {
      return "Range / rectangle";
    }
    if (p.length >= 3) {
      const last = p.slice(-3);
      const values = [closes[last[0]], closes[last[1]], closes[last[2]]];
      const v1 = Math.min.apply(null, closes.slice(last[0], last[1] + 1));
      const v2 = Math.min.apply(null, closes.slice(last[1], last[2] + 1));
      if (Math.max.apply(null, values) - Math.min.apply(null, values) < 0.2 * range &&
          v1 < Math.min.apply(null, values) - 0.04 * range &&
          v2 < Math.min.apply(null, values) - 0.04 * range) {
        return "Triple top";
      }
    }
    if (t.length >= 3) {
      const last = t.slice(-3);
      const values = [closes[last[0]], closes[last[1]], closes[last[2]]];
      const v1 = Math.max.apply(null, closes.slice(last[0], last[1] + 1));
      const v2 = Math.max.apply(null, closes.slice(last[1], last[2] + 1));
      if (Math.max.apply(null, values) - Math.min.apply(null, values) < 0.2 * range &&
          v1 > Math.max.apply(null, values) + 0.04 * range &&
          v2 > Math.max.apply(null, values) + 0.04 * range) {
        return "Triple bottom";
      }
    }
    const segmentHalf = Math.floor(n / 2);
    const head = closes.slice(0, segmentHalf + 1);
    const tail = closes.slice(segmentHalf);
    const headRange = Math.max.apply(null, head) - Math.min.apply(null, head);
    const tailRange = Math.max.apply(null, tail) - Math.min.apply(null, tail);
    const headNet = (closes[segmentHalf] - closes[0]) / range;
    const tailNet = (closes[n - 1] - closes[segmentHalf]) / range;
    const q1 = closes.slice(0, Math.max(1, Math.floor(n * 0.2)));
    const q4 = closes.slice(Math.floor(n * 0.8));
    const q1Avg = q1.reduce(function (sum, v) { return sum + v; }, 0) / q1.length;
    const q4Avg = q4.reduce(function (sum, v) { return sum + v; }, 0) / q4.length;
    if (headNet > 0.35 && Math.abs(tailNet) < 0.28 &&
        tailRange < headRange * 0.7 && closes[n - 1] > mid) {
      return "Bull flag";
    }
    if (headNet < -0.35 && Math.abs(tailNet) < 0.28 &&
        tailRange < headRange * 0.7 && closes[n - 1] < mid) {
      return "Bear flag";
    }
    if (minPos > 0.28 && minPos < 0.62 && closes[0] > min + 0.22 * range &&
        closes[n - 1] > min + 0.65 * range && net > 0.18 && q4Avg > mid &&
        q1Avg > min + 0.15 * range) {
      return "Rounding bottom";
    }
    if (p.length >= 2 && t.length >= 2) {
      const pa = p[p.length - 2], pb = p[p.length - 1];
      const ta = t[t.length - 2], tb = t[t.length - 1];
      const firstPeak = closes[p[0]], lastPeak = closes[p[p.length - 1]];
      const firstTrough = closes[t[0]], lastTrough = closes[t[t.length - 1]];
      const firstWidth = Math.abs(firstPeak - firstTrough);
      const lastWidth = Math.abs(lastPeak - lastTrough);
      if (lastPeak < firstPeak && lastTrough < firstTrough &&
          lastWidth < firstWidth * 0.55) {
        return "Falling wedge";
      }
      if (Math.abs(closes[pa] - closes[pb]) < 0.12 * range &&
          closes[tb] > closes[ta] + 0.04 * range) {
        return "Ascending triangle";
      }
      if (Math.abs(closes[ta] - closes[tb]) < 0.12 * range &&
          closes[pb] < closes[pa] - 0.04 * range) {
        return "Descending triangle";
      }
      if (lastPeak > firstPeak && lastTrough > firstTrough &&
          lastWidth < firstWidth * 0.82) {
        return "Rising wedge";
      }
      if (lastPeak < firstPeak && lastTrough < firstTrough &&
          lastWidth < firstWidth * 0.82) {
        return "Falling wedge";
      }
    }
    if (p.length >= 3) {
      const last = p.slice(-3);
      if (closes[last[1]] >= closes[last[0]] && closes[last[1]] >= closes[last[2]] &&
          Math.abs(closes[last[0]] - closes[last[2]]) < 0.2 * range) {
        return "Head and shoulders top";
      }
    }
    if (t.length >= 3) {
      const last = t.slice(-3);
      if (closes[last[1]] <= closes[last[0]] && closes[last[1]] <= closes[last[2]] &&
          Math.abs(closes[last[0]] - closes[last[2]]) < 0.2 * range) {
        return "Inverse head and shoulders";
      }
    }
    if (p.length >= 2) {
      const a = p[p.length - 2], b = p[p.length - 1];
      let valley = Infinity;
      for (let i = a; i <= b; i++) valley = Math.min(valley, closes[i]);
      if (Math.abs(closes[a] - closes[b]) < 0.15 * range &&
          valley < Math.min(closes[a], closes[b]) - 0.15 * range) {
        return "Double top";
      }
    }
    if (t.length >= 2) {
      const a = t[t.length - 2], b = t[t.length - 1];
      let peak = -Infinity;
      for (let i = a; i <= b; i++) peak = Math.max(peak, closes[i]);
      if (Math.abs(closes[a] - closes[b]) < 0.15 * range &&
          peak > Math.max(closes[a], closes[b]) + 0.15 * range) {
        return "Double bottom";
      }
    }
    const half = Math.floor(n / 2);
    const firstRange = Math.max.apply(null, closes.slice(0, half)) -
      Math.min.apply(null, closes.slice(0, half));
    const secondRange = Math.max.apply(null, closes.slice(half)) -
      Math.min.apply(null, closes.slice(half));
    if (net > 0.12 && maxPos < 0.48 && secondRange < firstRange * 0.68 &&
        closes[n - 1] > mid) {
      return "Bull flag";
    }
    if (net < -0.05 && minPos < 0.6 && secondRange < firstRange * 0.8 &&
        closes[n - 1] < mid) {
      return "Bear flag";
    }
    if (minPos > 0.2 && minPos < 0.72 && closes[0] > mid && closes[n - 1] > mid &&
        net > 0.08) {
      const tail = closes.slice(Math.max(0, Math.floor(n * 0.78)));
      const tailMin = Math.min.apply(null, tail);
      if (tailMin < max - 0.035 * range) return "Cup and handle";
    }
    if (minPos > 0.22 && minPos < 0.8 && net > 0.08 && closes[n - 1] > mid &&
        closes[0] > mid && Math.abs(closes[0] - closes[n - 1]) < 0.3 * range) {
      return "Rounding bottom";
    }
    if (maxPos > 0.78 && closes[n - 1] > mid) return "Breakout / continuation";
    if (minPos > 0.78 && closes[n - 1] < mid) return "Breakdown";
    if (minPos > 0.2 && minPos < 0.8 && closes[n - 1] > mid) return "V-bottom reversal";
    if (maxPos > 0.2 && maxPos < 0.8 && closes[n - 1] < mid) return "Inverted-V top";
    if (net > 0.3) return "Ascending channel / higher lows";
    if (net < -0.3) return "Descending channel / lower highs";
    if (p.length >= 2 && t.length >= 2 && crossedMid >= 4) {
      if (secondRange < firstRange * 0.78) return "Symmetrical triangle / coil";
      return "Oscillating range";
    }
    return net >= 0 ? "Bullish continuation / grind" : "Bearish continuation / grind";
  }

  function visiblePatternSignature(a, data, e) {
    const visible = Math.max(10, Number(DEFAULTS.playback.visibleCandles) || 120);
    const first = Math.max(0, e - visible + 1);
    return [a.interval, data[first].t, data[e].t].join("|");
  }

  function visiblePatternName(data, e) {
    const visible = Math.max(10, Number(DEFAULTS.playback.visibleCandles) || 120);
    return classifyChartPattern(data, Math.max(0, e - visible + 1), e);
  }

  function findClosestScenarioWindow(a, data) {
    const entryPrice = Number(a.entryPriceOverride);
    if (!(entryPrice > 0) || data.length < 40) return null;
    const margin = effectiveMarginFor(a, Math.max(1, Number(a.marginUsd) || 1));
    const leverage = clamp(Math.round(Number(a.leverage) || 1), 1, 125);
    const takeSeconds = clamp(Number(a.takeSeconds) || 26, 10, MAX_TAKE_SECONDS);
    const turnSeconds = clamp(Math.round(Number(a.turnSeconds) || 10), 1, takeSeconds);
    const dir = a.direction === "short" ? -1 : 1;
    const size = (margin * leverage) / entryPrice;
    if (!(size > 0)) return null;
    let dataLow = Infinity;
    let dataHigh = -Infinity;
    data.forEach(function (c) {
      if (c.l < dataLow) dataLow = c.l;
      if (c.h > dataHigh) dataHigh = c.h;
    });
    if (entryPrice < dataLow || entryPrice > dataHigh) return null;
    const entryBack = clamp(Math.round(Number(a.entryBackCandles) || 1), 1, data.length - 6);
    const ddWanted = clamp(Number(a.drawdownPct) || 0, 0, 100);
    const noDrawdown = !(ddWanted > 0);
    const targetPnl = Number(a.targetPnl) > 0 ? Number(a.targetPnl) : null;
    const startTarget = noDrawdown
      ? entryPrice
      : entryPrice - dir * (ddWanted / 100) * (margin / size);
    const finalTarget = targetPnl != null
      ? entryPrice + dir * (targetPnl / size)
      : null;
    const liqPrice = liquidationPriceFor(a, size, margin, entryPrice);
    const seed = Math.max(0, Math.round(Number(a.scenarioSeed) || 0));
    const usedSignatures = new Set(Array.isArray(a.usedPatterns) ? a.usedPatterns : []);
    const usedLabels = new Set(Array.isArray(a.usedPatternLabels) ? a.usedPatternLabels : []);
    const byStart = new Map();
    const analysisFloor = Math.max(entryBack + 6, 20, data.length - 1 - 480);
    for (let e = data.length - 1; e >= analysisFloor; e--) {
      if (finalTarget != null && (data[e].l > finalTarget || data[e].h < finalTarget)) continue;
      const entryIdx = e - entryBack;
      for (let s = Math.max(entryIdx + 1, e - 110); s < e - 8; s++) {
        if (startTarget != null && (data[s].l > startTarget || data[s].h < startTarget)) continue;
        // The configured adverse drawdown is the maximum loss shown. Every
        // later real candle must still contain the drawdown mark in its price
        // range so the mark can be clamped to that floor without leaving the
        // real high/low envelope.
        if (!noDrawdown && startTarget != null) {
          let entirelyBeyondFloor = false;
          for (let j = s + 1; j <= e; j++) {
            if (dir > 0 ? data[j].h < startTarget : data[j].l > startTarget) {
              entirelyBeyondFloor = true;
              break;
            }
          }
          if (entirelyBeyondFloor) continue;
        }
        if (liqPrice != null) {
          // The position is already open at the entry candle. A candle that
          // would liquidate it before the replay start makes the take invalid,
          // even if the later drawdown window itself stays above Liq. Price.
          let liquidates = false;
          for (let j = Math.max(0, entryIdx); j <= e; j++) {
            if ((dir > 0 && data[j].l <= liqPrice) || (dir < 0 && data[j].h >= liqPrice)) {
              liquidates = true;
              break;
            }
          }
          if (liquidates) continue;
        }
        const pnlStart = size * (data[s].c - entryPrice) * dir;
        if (pnlStart >= 0) continue;
        const dd = -pnlStart / margin * 100;
        let turn = null;
        let lossAfterStart = false;
        for (let j = s + 1; j <= e; j++) {
          const pnlAtJ = size * (data[j].c - entryPrice) * dir;
          if (pnlAtJ < 0) lossAfterStart = true;
          if (pnlAtJ >= 0) { turn = j - s; break; }
        }
        if (turn == null || turn > e - s - 2) continue;
        if (noDrawdown && !lossAfterStart) continue;
        if (!noDrawdown) {
          let crossedBeforeTurn = false;
          for (let j = s; j < turn; j++) {
            if ((dir > 0 && data[j].h >= entryPrice) ||
                (dir < 0 && data[j].l <= entryPrice)) {
              crossedBeforeTurn = true;
              break;
            }
          }
          if (crossedBeforeTurn) continue;
        }
        let crosses = 0;
        let prevSign = Math.sign((data[s].c - entryPrice) * dir);
        for (let j = s + 1; j <= e; j++) {
          const sign = Math.sign((data[j].c - entryPrice) * dir);
          if (sign !== 0 && sign !== prevSign) { crosses += 1; prevSign = sign; }
        }
        const ddScore = noDrawdown ? 0 : Math.abs(dd - ddWanted) / Math.max(1, ddWanted);
        const age = (data.length - 1 - e) / Math.max(1, data.length - 1);
        let rangeSum = 0;
        for (let j = s; j <= e; j++) rangeSum += (data[j].h - data[j].l);
        const avgRange = rangeSum / Math.max(1, e - s + 1);
        const volScore = Math.min(3, avgRange / Math.max(entryPrice * 0.001, 1e-9));
        // +80% candle cadence target: keep only windows near the boosted span.
        const speedBoost = Math.max(0.1, Number(DEFAULTS.playback.candleSpeedBoost) || 1.8);
        const desiredSpan = Math.max(4, Math.round(takeSeconds * speedBoost / 0.9));
        const span = e - s;
        if (span < desiredSpan * 0.85 || span > desiredSpan * 1.6) continue;
        const spanPenalty = Math.abs(span - desiredSpan) / Math.max(1, desiredSpan) * 12;
        const turnRatio = turn / Math.max(1, span);
        const wantedTurnRatio = turnSeconds / Math.max(1, takeSeconds);
        const turnPenalty = Math.abs(turnRatio - wantedTurnRatio) * 4;
        const signature = visiblePatternSignature(a, data, e);
        if (usedSignatures.has(signature)) continue;
        const patternName = visiblePatternName(data, e);
        const labelPenalty = usedLabels.has(patternName) ? 0.9 : 0;
        const score = ddScore * 2 + crosses * 2.5 + volScore * 1.35 -
          Math.min(10, turn) * 0.04 + age * 0.04 + spanPenalty + turnPenalty + labelPenalty;
        const candidate = {
          score: score,
          patternName: patternName,
          patternSignature: signature,
          endIdx: e,
          startIdx: s,
          entryIdx: entryIdx,
          entryPrice: entryPrice,
          size: size,
          drawdownPct: noDrawdown ? 0 : dd,
          turn: turn,
          finalMark: data[e].c
        };
        // Keep the best end for every distinct start. Consecutive seeds then
        // select genuinely different real starts, not one start with a
        // one-candle end shift.
        const current = byStart.get(s);
        if (!current || candidate.score < current.score) byStart.set(s, candidate);
      }
    }
    const distinct = Array.from(byStart.values()).sort(function (x, y) {
      return x.score - y.score;
    });
    if (!distinct.length) return null;
    // Group starts into twelve-candle buckets before walking seeds. Choosing
    // the second-best raw start can still be only one candle away and look like
    // the same recording; buckets make successive seeds use visibly different
    // real windows while retaining the best candidate per region.
    const buckets = new Map();
    distinct.forEach(function (candidate) {
      const bucket = Math.floor(candidate.startIdx / 12);
      const current = buckets.get(bucket);
      if (!current || candidate.score < current.score) buckets.set(bucket, candidate);
    });
    const pool = Array.from(buckets.values()).sort(function (x, y) {
      return x.score - y.score;
    });
    const chosen = pool[seed % pool.length];
    chosen.poolLength = pool.length;
    chosen.poolIndex = seed % pool.length;
    return chosen;
  }

  /**
   * 100-pattern real-data deck. Each call advances one slot and picks a
   * different historical window (end time + entry/replay offsets). No candles
   * are invented; every pattern is a real slice of the market.
   */
  function nextPatternWindow(account) {
    if (!account) return null;
    const current = Number(account.patternIndex) || 0;
    const next = (current + 1) % 100;
    const pattern = next === 0 ? 100 : next;
    return {
      patternIndex: next,
      patternNumber: pattern
    };
  }

  function rememberPattern(scenario) {
    const a = state.account;
    if (!a || !scenario || !scenario.patternSignature) return;
    if (!Array.isArray(a.usedPatterns)) a.usedPatterns = [];
    if (a.usedPatterns.indexOf(scenario.patternSignature) === -1) {
      a.usedPatterns.push(scenario.patternSignature);
    }
    if (!Array.isArray(a.usedPatternLabels)) a.usedPatternLabels = [];
    if (scenario.patternName && a.usedPatternLabels.indexOf(scenario.patternName) === -1) {
      a.usedPatternLabels.push(scenario.patternName);
    }
    savePersisted();
  }

  function applyPatternToAccount(account, force) {
    if (!account || (!force && account.varyPattern === false)) return false;
    const next = nextPatternWindow(account);
    if (!next) return false;
    account.patternIndex = next.patternIndex;
    // The manual entry/start timing must survive a pattern change. Only the
    // real-window seed rotates; entryBackCandles and replayStartBackCandles
    // stay exactly as entered in the Studio.
    account.scenarioSeed = (Number(account.scenarioSeed) || 0) + 1;
    return true;
  }

  function sourceTimeAtCursor(cursor) {
    return sourceTimeForCursor(
      state.data,
      cursor,
      Math.max(1, Number(state.effectiveIntervalMs) || 60000)
    );
  }

  function formatCountdown(ms) {
    const total = Math.max(0, Math.ceil(Number(ms) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return (minutes > 0 ? minutes + ":" : "0:") + String(seconds).padStart(2, "0");
  }

  function initLiveEngine() {
    if (state.patternPlan && state.patternPlan.candles.length) {
      state.engine = null;
      if (chart) {
        chart.setData(state.patternPlan.candles);
        chart.resize();
      }
      return;
    }
    if (!state.scenario || !window.CandleEngine || !state.data.length) {
      state.engine = null;
      return;
    }
    const interval = Math.max(1, Number(state.effectiveIntervalMs) || 60000);
    const entryIdx = clamp(Math.round(Number(state.scenario.entryIdx) || 0), 0, state.data.length - 1);
    const leadIn = clamp(Math.round(Number(DEFAULTS.playback.leadInCandles) || 120), 1, 240);
    const seedStart = Math.max(0, entryIdx - leadIn + 1);
    const engine = new window.CandleEngine(interval);
    engine.seedHistory(state.data.slice(seedStart, entryIdx + 1));
    const nextCandle = state.data[entryIdx + 1];
    const startSource = sourceTimeAtCursor(state.startCursor);
    const activeTime = nextCandle
      ? Number(nextCandle.t)
      : Number(state.data[entryIdx].t) + interval;
    const previousClose = engine.candles.length
      ? engine.candles[engine.candles.length - 1].c
      : (state.scenario.startMark != null ? state.scenario.startMark : state.entryPrice);
    engine.begin(previousClose, activeTime);
    engine.ingest(state.scenario.startMark != null ? state.scenario.startMark : state.entryPrice, activeTime);
    state.engine = engine;
    if (chart) {
      chart.setData(engine.candles);
      chart.resize();
    }
  }

  function computeScenario() {
    const a = state.account;
    const scenario = buildScenario(a, state.data);
    if (!scenario) {
      state.scenario = null;
      state.patternPlan = null;
      state.engine = null;
      return;
    }
    // Keep all loaded candles. The generated replay can run beyond the cached
    // source series, and truncating here used to strand the chart at the last
    // real candle for long takes.
    state.scenario = scenario;
    state.patternPlan = scenario.patternPlan || null;
    if (state.patternPlan) {
      chart.setData(state.patternPlan.candles);
      chart.resize();
    }
    state.scenarioSeedUsed = Number(a.scenarioSeed) || 0;
    if (refs.stage) {
      refs.stage.dataset.scenarioSeed = String(state.scenarioSeedUsed);
      refs.stage.dataset.scenarioStart = String(scenario.startTime);
      refs.stage.dataset.scenarioEnd = String(scenario.endTime);
      refs.stage.dataset.scenarioTurn = String(scenario.turnSeconds);
      refs.stage.dataset.scenarioTarget = String(scenario.targetPnl != null ? scenario.targetPnl : "");
    }
    state.entryIdx = scenario.entryIdx;
    state.startIdx = scenario.startIdx;
    state.entryPrice = scenario.entryPrice;
    state.controlledPath = null;
    state.drawdownMark = state.patternPlan ? state.patternPlan.floorMark : (scenario.drawdownMark != null ? scenario.drawdownMark : null);
    state.patternPlan = scenario.patternPlan || null;
    state.leverage = scenario.leverage;
    state.size = scenario.size;
    state.margin = scenario.margin;
    // Start essentially at the start candle's close so the first displayed
    // PNL is exactly the value shown in the Studio preview.
    state.startCursor = Number.isFinite(Number(scenario.startCursor))
      ? Number(scenario.startCursor)
      : scenario.startIdx + 0.999999;
    state.endCursor = Number.isFinite(Number(scenario.endCursor))
      ? Number(scenario.endCursor)
      : state.data.length;
    const played = Math.max(1, state.endCursor - state.startCursor);
    state.takeSeconds = scenario.takeSeconds;
    state.secondsPerCandle = clamp(scenario.takeSeconds / played, 0.02, 20);
    state.startOverrideMark = scenario.startMarkOverride;
    state.endOverrideMark = scenario.endMarkOverride;
    if (!state.patternPlan) {
      state.drawdownMark = scenario.drawdownMark != null ? scenario.drawdownMark : null;
    }
    state.drawdownCursor = scenario.drawdownCursor != null ? scenario.drawdownCursor : null;
    state.controlledPath = null;
    state.turnCursor = scenario.turnCursor != null ? scenario.turnCursor : null;
    state.turnAtMs = scenario.turnMatched
      ? clamp(scenario.turnSeconds, 0, scenario.takeSeconds) * 1000
      : 0;
    state.turnOverrideMark = scenario.turnMarkOverride != null ? scenario.turnMarkOverride : null;
    state.cursor = state.startCursor;
    state.valueCursor = state.startCursor;
    state.chartCursor = state.startCursor;
    state.progress = 0;
    state.playbackSteps = Math.max(1, Math.round(state.endCursor - state.startCursor));
    state.lastUiTick = -1;
    state.lastChartStep = -1;
    state.renderedOnce = false;
    const playedMs = Math.max(1, scenario.takeSeconds * 1000);
    state.floorAtMs = scenario.drawdownCursor != null
      ? clamp((scenario.drawdownCursor - state.startCursor) / played * playedMs, 0, playedMs)
      : null;
    state.floorDrawn = false;
    state.turnDrawn = false;
    state.turnPositiveDrawn = false;
    state.closed = false;
    state.finished = false;
    state.playing = false;
    state.paused = false;
    state.realizedBase = Number(a.realizedPnl) || 0;
    state.mark = state.scenario && state.scenario.startMark != null
      ? state.scenario.startMark
      : chart.markAt(state.startCursor);
    state.pnl = computePnl(state.mark);
    state.roi = state.margin ? (state.pnl / state.margin) * 100 : 0;
    initLiveEngine();
    if (scenario.size <= 0 && scenario.warnings.length) {
      showToast(scenario.warnings[0], 5200);
    }
  }

  async function loadData(opts) {
    const options = opts || {};
    const token = ++state.loadToken;
    state.loading = true;
    showChartMessage("Loading real historical candles…");
    try {
      const result = await getCandles(state.account, !!options.force);
      if (token !== state.loadToken) return;
      const prepared = prepareData(result);
      if (prepared.candles.length < 192) {
        throw new Error("Only " + prepared.candles.length + " completed 15m candles were returned. The record chart needs the past 48 hours (192 candles); try another active ticker.");
      }
      state.rawData = prepared.candles.slice();
      state.data = prepared.candles;
      state.patternPlan = null;
      state.engine = null;
      state.account.interval = "15m";
      if (refs.fInterval) refs.fInterval.value = "15m";
      state.effectiveIntervalMs = prepared.intervalMs;
      state.rawIntervalMs = TradingData.intervalToMs("15m");
      state.sourceLabel = result.sourceLabel || "";
      chart.setData(state.data);
      chart.resize();
      computeScenario();
      if (options.rememberPattern && state.scenario) {
        rememberPattern(state.scenario);
      }
      if (state.pendingRecordAdvance && state.scenario && state.account) {
        // A record take may have started while this load was still fetching
        // the edited Studio values. The take uses the scenario just computed;
        // save the next seed so the following preview is a different real
        // window even when the first scenario was still null when Record was
        // pressed.
        state.lastRecordedSeed = state.scenarioSeedUsed;
        state.account.scenarioSeed = state.scenarioSeedUsed + 1;
        rememberPattern(state.scenario);
        state.pendingRecordAdvance = false;
        savePersisted();
      }
      if (options.advanceSeed && state.account && state.account.varyPattern !== false) {
        state.account.scenarioSeed = (Number(state.account.scenarioSeed) || 0) + 1;
        savePersisted();
      }

      hideChartMessage();
      renderChrome();
      renderMarketChrome();
      renderStaticPosition();
      updateChartTabs();
      resetRealizedDisplay();
      drawFrame(true);
      schedulePlayback(options.autoplay !== false, !!options.forcePlay, !!options.immediate);
      if (prepared.warning) showToast(prepared.warning, 4200);
      prefetchOtherAccounts();
      updateStudioPreview();
      if (!refs.studio.classList.contains("hidden")) pausePlayback();
    } catch (err) {
      if (token !== state.loadToken) return;
      state.pendingRecordAdvance = false;
      state.data = [];
      state.patternPlan = null;
      state.engine = null;
      state.mark = 0;
      state.pnl = 0;
      state.roi = 0;
      chart.setData([]);
      showChartMessage(err.message || "Could not load market data.");
      renderMarketChrome(true);
      renderStaticPosition();
      showToast(err.message || "Could not load market data.", 5000);
      updateStudioPreview();
    } finally {
      state.loading = false;
    }
  }

  function recordingDelayMs() {
    const countdown = clamp(Number(state.playback.countdown) || 0, 0, 10);
    const extra = Math.max(0, Number(state.playback.recordingStartDelayMs) || 0);
    // Hold the entry frame while the countdown is visible so the external
    // screen recorder has time to capture the start and the full loss phase.
    // The take clock itself (and the requested turn) begins after this hold.
    return Math.max(600, countdown * 1000 + 250, extra);
  }

  function hideCountdown() {
    clearInterval(state.timerCountdown);
    clearTimeout(state.timerCountdown);
    state.timerCountdown = null;
    if (refs.countdown) refs.countdown.classList.add("hidden");
  }

  function showCountdown() {
    if (!state.recording || !refs.countdown) {
      hideCountdown();
      return;
    }
    const total = clamp(Number(state.playback.countdown) || 0, 0, 10);
    if (!total) {
      hideCountdown();
      return;
    }
    hideCountdown();
    refs.countdown.classList.remove("hidden");
    let left = total;
    refs.countdownNum.textContent = String(left);
    state.timerCountdown = setInterval(function () {
      left -= 1;
      if (left <= 0) {
        hideCountdown();
      } else {
        refs.countdownNum.textContent = String(left);
      }
    }, 1000);
  }

  function resetPlaybackFrameState() {
    state.valueCursor = state.startCursor;
    state.chartCursor = state.startCursor;
    state.progress = 0;
    state.playbackSteps = Math.max(1, Math.round(state.endCursor - state.startCursor));
    state.lastUiTick = -1;
    state.lastChartStep = -1;
    state.renderedOnce = false;
    state.floorDrawn = false;
    state.turnDrawn = false;
    state.turnPositiveDrawn = false;
    const played = Math.max(1e-9, state.endCursor - state.startCursor);
    const playedMs = Math.max(1, (Number(state.takeSeconds) || 10) * 1000);
    state.floorAtMs = state.drawdownCursor != null
      ? clamp((state.drawdownCursor - state.startCursor) / played * playedMs, 0, playedMs)
      : null;
  }

  function schedulePlayback(enabled, forcePlay, immediate) {
    state.playing = false;
    state.paused = false;
    state.finished = false;
    state.closed = false;
    clearTimeout(state.timerLoop);
    clearTimeout(state.timerHint);
    refs.replayHint.classList.add("hidden");
    if (!state.data.length) return;

    state.cursor = state.startCursor;
    resetPlaybackFrameState();
    initLiveEngine();
    state.mark = state.engine && state.engine.active
      ? state.engine.active.c
      : chart.markAt(state.cursor);
    state.pnl = computePnl(state.mark);
    state.roi = state.margin ? (state.pnl / state.margin) * 100 : 0;
    state.playDuration = Math.max(1000, (Number(state.takeSeconds) || 10) * 1000);

    if ((state.playback.autoPlay !== false && enabled) || forcePlay) {
      state.playing = true;
      // One clock for the whole take. Recording starts immediately; the
      // optional countdown overlay runs over the moving chart and never
      // introduces a static/slow opening or shifts the requested turn.
      state.playStartTs = performance.now() + Number(
        immediate ? 0
          : (state.recording ? recordingDelayMs() : (state.playback.startDelayMs || 0))
      );
      if (state.recording && !immediate) showCountdown();
      else hideCountdown();
    }
    drawFrame(true);
  }

  function startReplay() {
    if (!state.data.length) {
      showToast("No candles loaded yet.", 2200);
      return;
    }
    clearTimeout(state.timerLoop);
    clearTimeout(state.timerHint);
    refs.replayHint.classList.add("hidden");
    state.closed = false;
    state.finished = false;
    state.paused = false;
    state.cursor = state.startCursor;
    resetPlaybackFrameState();
    initLiveEngine();
    state.mark = state.scenario && state.scenario.startMark != null
      ? state.scenario.startMark
      : chart.markAt(state.cursor);
    state.pnl = computePnl(state.mark);
    state.roi = state.margin ? (state.pnl / state.margin) * 100 : 0;
    state.realizedBase = Number(state.account.realizedPnl) || 0;
    resetRealizedDisplay();
    refs.closedTag.classList.add("hidden");
    setText(refs.posCount, "(" + (Number(state.account.positionCount) || 0) + ")");
    state.playDuration = Math.max(1000, (Number(state.takeSeconds) || 10) * 1000);
    state.playStartTs = performance.now() + Number(
      state.recording ? recordingDelayMs() : (state.playback.startDelayMs || 0)
    );
    state.playing = true;
    if (state.recording) showCountdown();
    drawFrame(true);
  }

  function pausePlayback() {
    if (!state.playing || state.finished || state.closed) return false;
    state.pausedElapsed = performance.now() - state.playStartTs;
    state.paused = true;
    return true;
  }

  function resumePlayback() {
    if (!state.paused || state.finished || state.closed) return false;
    state.playStartTs = performance.now() - state.pausedElapsed;
    state.paused = false;
    return true;
  }

  function computePnl(mark) {
    const dir = state.account && state.account.direction === "short" ? -1 : 1;
    return state.size * (mark - state.entryPrice) * dir;
  }

  function effectiveMarginFor(account, baseMargin) {
    // The Studio margin is the position margin. Mode selection must never
    // silently change it; the size/notional and ROI are derived from this exact
    // number so the pre-record sheet and the recorded position agree.
    return Math.max(1, Number(baseMargin != null ? baseMargin : (account && account.marginUsd)) || 1);
  }

  function marginRatioFor() {
    const maintenance = state.size * state.mark * MAINTENANCE_MARGIN_RATE;
    // This simulation has one position and one posted margin. Both Cross and
    // Isolated use that margin plus unrealized PNL as the liquidation buffer,
    // so the ratio reaches 100% at the displayed liquidation price.
    return Math.min(100, maintenance / Math.max(1, state.margin + state.pnl) * 100);
  }

  function patternMarkAt(cursor) {
    const plan = state.patternPlan;
    if (!plan || !plan.candles.length) return state.entryPrice;
    const data = plan.candles;
    const start = plan.seedCount;
    const count = plan.playCount;
    const value = Number(cursor);
    if (!Number.isFinite(value) || value <= start) return plan.entryPrice;
    if (value >= start + count) return data[data.length - 1].c;
    const pos = value - start;
    const idx = Math.min(count - 1, Math.floor(pos));
    const p = clamp(pos - idx, 0, 1);
    const gi = start + idx;
    const candle = data[gi];
    const previous = idx === 0 ? plan.entryPrice : data[gi - 1].c;
    const up = candle.c >= candle.o;
    const hi = Math.max(candle.h, candle.o, candle.c, previous);
    const lo = Math.min(candle.l, candle.o, candle.c, previous);
    let mark;
    if (up) {
      // Literal 24h candle playback: a green close is drawn from its high
      // toward its low, then resolves to the actual close.
      if (p <= 0.12) {
        mark = previous + (hi - previous) * smoothstep01(p / 0.12);
      } else if (p <= 0.78) {
        const q = (p - 0.12) / 0.66;
        mark = hi + (lo - hi) * smoothstep01(q);
      } else {
        const q = (p - 0.78) / 0.22;
        mark = lo + (candle.c - lo) * smoothstep01(q);
      }
    } else {
      // A red close is drawn from its low toward its high, then resolves down
      // to the actual close.
      if (p <= 0.12) {
        mark = previous + (lo - previous) * smoothstep01(p / 0.12);
      } else if (p <= 0.78) {
        const q = (p - 0.12) / 0.66;
        mark = lo + (hi - lo) * smoothstep01(q);
      } else {
        const q = (p - 0.78) / 0.22;
        mark = hi + (candle.c - hi) * smoothstep01(q);
      }
    }
    // Small deterministic texture inside the real high/low envelope.
    mark += (hi - lo) * 0.026 * Math.sin(p * Math.PI * 6 + candle.t * 0.00001) * Math.sin(Math.PI * p);

    if (plan.directionSign > 0) {
      mark = Math.max(mark, plan.floorMark);
      if (idx < plan.boundary) mark = Math.min(mark, plan.entryPrice);
      else mark = Math.max(mark, plan.entryPrice);
    } else {
      mark = Math.min(mark, plan.floorMark);
      if (idx < plan.boundary) mark = Math.max(mark, plan.entryPrice);
      else mark = Math.min(mark, plan.entryPrice);
    }
    return mark;
  }

  function drawFrame(resetScale) {
    if (!state.data.length) return;
    const data = state.data;
    const plan = state.patternPlan;
    const cursor = state.valueCursor != null ? state.valueCursor : state.cursor;
    const sourceTime = sourceTimeAtCursor(cursor);
    const chartData = plan ? plan.candles : (state.engine ? state.engine.candles : data);
    let chartCursor = state.chartCursor != null ? state.chartCursor : cursor;
    const currentIdx = clamp(Math.floor(cursor), 0, chartData.length - 1);
    const intra = clamp(cursor - currentIdx, 0, 1);
    let mark = state.closed
      ? state.closedMark
      : (plan ? patternMarkAt(cursor) : (state.controlledPath ? controlledMarkAt(state.controlledPath, cursor) : chart.markAt(cursor)));
    if (!plan && !state.closed && !state.controlledPath && state.startOverrideMark != null &&
        Math.abs(cursor - state.startCursor) < 0.01) {
      mark = state.startOverrideMark;
    }
    if (!plan && !state.closed && !state.controlledPath && !state.finished &&
        state.turnOverrideMark != null && state.turnCursor != null &&
        Math.abs(cursor - state.turnCursor) < 0.0005) {
      mark = state.turnOverrideMark;
    }
    if (!plan && !state.closed && state.finished && state.endOverrideMark != null) {
      mark = state.endOverrideMark;
    }
    if (!plan && !state.closed && !state.controlledPath && !state.finished &&
        state.drawdownCursor != null && state.drawdownMark != null &&
        Math.abs(cursor - state.drawdownCursor) < 0.0005) {
      mark = state.drawdownMark;
    }
    if (!plan && !state.closed && !state.controlledPath && state.drawdownMark != null) {
      const drawdownDir = state.account.direction === "short" ? -1 : 1;
      mark = drawdownDir > 0
        ? Math.max(mark, state.drawdownMark)
        : Math.min(mark, state.drawdownMark);
    }
    if (!state.closed) {
      const liq = liquidationPriceFor(state.account);
      const dir = state.account.direction === "short" ? -1 : 1;
      const candle = data[currentIdx];
      if (liq != null && ((dir > 0 && mark <= liq) ||
          (dir < 0 && mark >= liq) ||
          (!state.controlledPath && !plan && candle &&
            ((dir > 0 && candle.l <= liq) || (dir < 0 && candle.h >= liq))))) {
        liquidatePosition(liq);
        mark = liq;
      }
    }
    if (plan && !state.closed) {
      chartCursor = cursor;
      state.chartCursor = chartCursor;
    } else if (state.engine && !state.closed) {
      state.engine.ingest(mark, sourceTime);
      state.engineSourceTime = sourceTime;
      chartCursor = state.engine.activeIndex() + state.engine.intraFraction(sourceTime);
      state.chartCursor = chartCursor;
    }
    state.mark = mark;
    state.pnl = state.closed ? state.pnl : computePnl(mark);
    state.roi = state.margin ? (state.pnl / state.margin) * 100 : 0;

    const pnlText = fmtSigned(state.pnl, 2);
    const roiText = fmtSigned(state.roi, 2) + "%";
    setText(refs.pnlValue, pnlText);
    setClass(refs.pnlValue, "negative", state.pnl < 0);
    setClass(refs.pnlValue, "positive", state.pnl >= 0);
    setText(refs.roiValue, roiText);
    setClass(refs.roiValue, "negative", state.roi < 0);
    setClass(refs.roiValue, "positive", state.roi >= 0);
    setText(refs.marginRatio, fmt(marginRatioFor(), 2) + "%");
    setText(refs.markValue, fmt(mark, state.account.priceDecimals));

    const withSeconds = state.effectiveIntervalMs != null && state.effectiveIntervalMs < 60000;
    const playingEnded = state.finished && !state.closed;
    const visibleCursor = playingEnded
      ? (plan ? clamp(Number(state.endCursor) || chartData.length, 0, chartData.length)
        : (state.engine ? chartCursor : clamp(Number(state.endCursor) || data.length, 0.000001, data.length)))
      : chartCursor;
    // The reference keeps the candle width and the 55% future space fixed.
    // The clock in the right price tag is the current source candle's time,
    // which advances with the chart instead of counting down at render speed.
    const markTime = plan
      ? formatHM(chartData[clamp(Math.floor(visibleCursor), 0, chartData.length - 1)].t, withSeconds)
      : (state.engine && state.engine.active
        ? formatHM(state.engine.active.time, withSeconds)
        : formatHM(sourceTime, withSeconds));

    const futureGapFraction = Math.max(0, Math.min(0.7, Number(DEFAULTS.playback.futureGapFraction) || 0));
    const visibleCandles = Math.max(10, Number(DEFAULTS.playback.visibleCandles) || 160);
    const onscreenVisible = Math.max(2, Math.floor(visibleCandles * (1 - futureGapFraction)));
    if (refs.chartDate) {
      const firstIdx = clamp(Math.floor(visibleCursor) - onscreenVisible + 1, 0, chartData.length - 1);
      setText(refs.chartDate, formatDateTime(chartData[firstIdx].t));
    }

    const pnlPillText = pnlText;
    chart.draw({
      cursor: visibleCursor,
      visibleCandles: visibleCandles,
      futureGapFraction: futureGapFraction,
      markPrice: mark,
      markTime: markTime,
      liveUp: plan
        ? mark >= state.entryPrice
        : (state.engine && state.engine.active
          ? mark >= state.engine.active.o
          : mark >= state.entryPrice),
      entryPrice: state.entryPrice,
      sizeText: fmt(state.size, 2),
      pnl: state.pnl,
      pnlText: pnlPillText,
      decimals: Number(state.account.priceDecimals) || 2,
      formatPrice: function (v, d) { return fmt(v, d); },
      formatDateTime: formatDateTime,
      showGrid: state.showGrid,
      fitChart: state.fitChart,
      logoUrl: state.account.logoUrl || DEFAULTS.brand.logoUrl || "",
      watermark: state.account.watermarkText || DEFAULTS.brand.watermark || "",
      tpPrice: state.account.tpPrice ? Number(state.account.tpPrice) : null,
      slPrice: state.account.slPrice ? Number(state.account.slPrice) : null,
      finished: playingEnded,
      resetScale: !!resetScale
    });

    updateOrderBook(mark);
  }

  function updateOrderBook(mark) {
    if (!refs.bidPrice) return;
    const a = state.account;
    const decimals = Number(a.priceDecimals) || 2;
    const tick = Math.max(Math.pow(10, -decimals), mark * 0.00008);
    const lastCandle = state.data[state.data.length - 1];
    const volBase = lastCandle && lastCandle.v > 0 ? lastCandle.v : 1200;
    const now = performance.now();
    const seed = state.accountIndex * 1.7 + 0.3;
    const fast = now / 85;

    // High-frequency quote movement. The displayed prices jitter around the
    // replay mark, and the sizes/ratio bar share one fast oscillator.
    const bid1 = Math.max(0, mark - tick * (0.7 + 1.7 * Math.abs(Math.sin(fast + seed))));
    const bid2 = Math.max(0, mark - tick * (1.9 + 1.9 * Math.abs(Math.sin(fast * 1.37 + seed + 1.1))));
    setText(refs.bidPrice, fmt(bid1, decimals));
    setText(refs.askPrice, fmt(bid2, decimals));

    if (!state.lastBookAt || now - state.lastBookAt > 45) {
      state.lastBookAt = now;
      const pulse = Math.abs(Math.sin(now / 65 + seed));
      setText(refs.bidSize, fmt(volBase * 0.008 + volBase * 0.008 * pulse + 3.1, 2));
      setText(refs.askSize, fmt(volBase * 0.004 + volBase * 0.006 * (1 - pulse) + 1.4, 2));

      const green = clamp(
        50 + 32 * Math.sin(now / 95 + seed * 2) + 5 * Math.sin(now / 27 + seed),
        8, 92
      );
      const red = 100 - green;
      setText(refs.ratioBuy, fmt(green, 2) + "%");
      setText(refs.ratioSell, fmt(red, 2) + "%");
      refs.ratioGreen.style.width = green + "%";
      refs.ratioRed.style.width = red + "%";

      const depth1 = Math.round(green * 0.62);
      const depth2 = Math.round(red * 0.55);
      const row1 = refs.bidPrice.closest(".book-row");
      const row2 = refs.askPrice.closest(".book-row");
      if (row1) {
        row1.style.background = "linear-gradient(90deg, rgba(46,189,133,0.22) 0%, rgba(46,189,133,0.18) " +
          depth1 + "%, rgba(46,189,133,0.02) " + Math.min(100, depth1 + 22) + "%)";
      }
      if (row2) {
        row2.style.background = "linear-gradient(90deg, rgba(46,189,133,0.16) 0%, rgba(46,189,133,0.12) " +
          Math.max(5, 100 - depth2) + "%, rgba(46,189,133,0.015) " + Math.min(100, 100 - depth2 + 18) + "%)";
      }
    }
  }

  function renderMarketChrome(error) {
    if (error) {
      setText(refs.priceChange, "--");
      setClass(refs.priceChange, "green", false);
      setClass(refs.priceChange, "red", false);
      return;
    }
    const data = state.data;
    if (!data.length) return;
    const manual = state.account.change24hOverride;
    if (manual != null && Number.isFinite(Number(manual))) {
      // The entered number is a magnitude. Short always reads negative and
      // long always reads positive, regardless of whether a sign was typed.
      const magnitude = Math.abs(Number(manual));
      const change = state.account.direction === "short" ? -magnitude : magnitude;
      setText(refs.priceChange, fmtSigned(change, 2) + "%");
      setClass(refs.priceChange, "green", change >= 0);
      setClass(refs.priceChange, "red", change < 0);
    } else {
      setText(refs.priceChange, "--");
      setClass(refs.priceChange, "green", false);
      setClass(refs.priceChange, "red", false);
    }
  }

  function liquidationPriceFor(a, sizeArg, marginArg, entryArg) {
    if (!a) return null;
    const size = Number(sizeArg != null ? sizeArg : state.size);
    const margin = Number(marginArg != null ? marginArg : state.margin);
    const entry = Number(entryArg != null ? entryArg : state.entryPrice);
    if (!(size > 0) || !(margin > 0) || !(entry > 0)) return null;
    const mmr = MAINTENANCE_MARGIN_RATE;
    // Same margin/size/MMR calculation for Cross and Isolated. In this
    // single-position simulation the entered margin is the account buffer.
    const price = a.direction === "short"
      ? (margin + size * entry) / (size * (1 + mmr))
      : (size * entry - margin) / (size * (1 - mmr));
    return Number.isFinite(price) && price > 0 ? price : null;
  }

  function liqPriceText() {
    const price = liquidationPriceFor(state.account);
    return price == null ? "--" : fmt(price, Number(state.account.priceDecimals) || 2);
  }

  function liquidatePosition(liqPrice) {
    if (!state.account || state.closed) return;
    state.playing = false;
    state.paused = false;
    state.closed = true;
    state.finished = true;
    state.closedMark = liqPrice;
    state.pnl = computePnl(liqPrice);
    state.roi = state.margin ? (state.pnl / state.margin) * 100 : 0;
    state.realizedBase = (Number(state.account.realizedPnl) || 0) + state.pnl;
    setText(refs.realizedValue, fmtSigned(state.realizedBase, 2));
    setClass(refs.realizedValue, "negative", state.realizedBase < 0);
    setClass(refs.realizedValue, "positive", state.realizedBase > 0);
    setText(refs.closedTag, "LIQUIDATED");
    refs.closedTag.classList.remove("hidden");
    setText(refs.posCount, "(0)");
    clearTimeout(state.timerLoop);
    clearTimeout(state.timerHint);
    refs.replayHint.classList.add("hidden");
    showToast("Simulated position liquidated at " + fmt(liqPrice, state.account.priceDecimals) + ". Double-tap the chart to replay.", 4200);
  }

  function renderStaticPosition() {
    if (!state.account) return;
    const a = state.account;
    setText(refs.sizeValue, fmt(state.size, 2));
    setText(refs.marginValue, fmt(state.margin, 2));
    setText(refs.entryValue, fmt(state.entryPrice, a.priceDecimals));
    setText(refs.markValue, fmt(state.mark, a.priceDecimals));
    setText(refs.marginRatio, fmt(marginRatioFor(), 2) + "%");
    setText(refs.liqValue, liqPriceText());
    setText(refs.crossLeverage, (a.marginMode === "isolated" ? "Isolated " : "Cross ") + (a.leverage || state.leverage) + "X");
  }

  function resetRealizedDisplay() {
    setText(refs.realizedValue, fmtSigned(state.realizedBase, 2));
    setClass(refs.realizedValue, "negative", state.realizedBase < 0);
    setClass(refs.realizedValue, "positive", state.realizedBase > 0);
  }

  function applyOrderSideVisuals() {
    const short = state.orderSide === "short";
    refs.orderSideBtn.textContent = short ? "Sell/Short" : "Buy/Long";
    refs.orderSideBtn.classList.toggle("short", short);
    refs.orderSideBtn.classList.toggle("long", !short);
    refs.sideRed.classList.toggle("active", short);
    refs.sideGreen.classList.toggle("active", !short);
  }

  function refreshLocaleNumbers() {
    if (!state.account) return;
    renderChrome();
    renderMarketChrome();
    renderStaticPosition();
    if (refs.fSizeDisplay) updateCalculatedSize();
    if (refs.moverGainers || refs.moverLosers) renderMovers();
    if (!refs.studio.classList.contains("hidden") && state.studioDirty) {
      updateStudioPreview();
    }
    if (state.data && state.data.length) drawFrame(false);
  }

  function updateChartTabs() {
    if (!refs.chartToolbar) return;
    $$(".tf", refs.chartToolbar).forEach(function (btn) {
      const tf = btn.dataset.tf;
      btn.classList.toggle("active", tf === "15m");
    });
  }

  function onFinish() {
    state.finished = true;
    state.playing = false;
    state.finishTs = performance.now();
    drawFrame(false);
    if (state.playback.loop) {
      clearTimeout(state.timerLoop);
      state.timerLoop = setTimeout(function () {
        if (state.playback.loop) startReplay();
      }, 1600);
    } else {
      clearTimeout(state.timerHint);
      state.timerHint = setTimeout(function () {
        if (!state.recording) {
          refs.replayHint.classList.remove("hidden");
          setTimeout(function () { refs.replayHint.classList.add("hidden"); }, 3200);
        }
      }, 650);
    }
  }

  function frame(ts) {
    requestAnimationFrame(frame);
    state.currentFrameTs = ts;
    if (!state.data.length) return;
    if (state.playing && !state.paused && !state.finished && !state.closed) {
      const elapsed = ts - state.playStartTs;
      if (elapsed >= 0) {
        const duration = Math.max(1, state.playDuration);
        const progress = Math.min(1, elapsed / duration);
        const span = Math.max(1e-9, state.endCursor - state.startCursor);
        const plan = state.patternPlan;
        // The actual 24h pattern chooses an integral candle boundary for the
        // turn. Map the two take phases so that boundary lands exactly on the
        // requested turn second; the cadence change at the turn is tiny because
        // the selected boundary is already the nearest real candle boundary.
        let played = progress * span;
        if (plan && plan.playCount > 0 && state.takeSeconds > 0) {
          const elapsedSec = Math.min(state.takeSeconds, elapsed / 1000);
          if (elapsedSec <= state.scenario.turnSeconds) {
            played = (elapsedSec / state.scenario.turnSeconds) * plan.boundary;
          } else {
            const remain = Math.max(1e-9, state.takeSeconds - state.scenario.turnSeconds);
            played = plan.boundary +
              ((elapsedSec - state.scenario.turnSeconds) / remain) *
              (plan.playCount - plan.boundary);
          }
          played = clamp(played, 0, span);
        }
        state.progress = progress;
        state.valueCursor = state.startCursor + played;
        state.cursor = state.valueCursor;
        state.chartCursor = progress >= 1 ? state.endCursor : state.valueCursor;
        drawFrame(false);
        if (progress >= 1) {
          state.valueCursor = state.endCursor;
          state.cursor = state.endCursor;
          state.chartCursor = state.endCursor;
          onFinish();
        }
      }
    }
  }

  function closePosition() {
    if (state.closed) {
      showToast("Position is already closed. Double-tap the chart to replay.", 2400);
      return;
    }
    state.playing = false;
    state.paused = false;
    state.closed = true;
    state.closedMark = state.mark;
    state.finished = true;
    state.pnl = computePnl(state.closedMark);
    state.roi = state.margin ? (state.pnl / state.margin) * 100 : 0;
    state.realizedBase = (Number(state.account.realizedPnl) || 0) + state.pnl;
    setText(refs.realizedValue, fmtSigned(state.realizedBase, 2));
    setClass(refs.realizedValue, "negative", state.realizedBase < 0);
    setClass(refs.realizedValue, "positive", state.realizedBase > 0);
    setText(refs.closedTag, "CLOSED");
    refs.closedTag.classList.remove("hidden");
    setText(refs.posCount, "(0)");
    clearTimeout(state.timerLoop);
    clearTimeout(state.timerHint);
    refs.replayHint.classList.add("hidden");
    drawFrame(false);
    showToast("Simulated position closed. Double-tap the chart to replay.", 3000);
  }

  // ---------------------------------------------------------------
  // Chart interactions
  // ---------------------------------------------------------------
  function canvasPoint(e) {
    const rect = refs.canvas.getBoundingClientRect();
    const scaleX = refs.canvas.clientWidth ? rect.width / refs.canvas.clientWidth : 1;
    const scaleY = refs.canvas.clientHeight ? rect.height / refs.canvas.clientHeight : 1;
    return {
      x: (e.clientX - rect.left) / scaleX,
      y: (e.clientY - rect.top) / scaleY,
      inside: true
    };
  }

  function bindChartPointer() {
    let down = false;
    let moved = false;

    refs.canvas.addEventListener("pointerdown", function (e) {
      down = true;
      moved = false;
      refs.canvas.setPointerCapture && refs.canvas.setPointerCapture(e.pointerId);
      chart.setCrosshair(canvasPoint(e));
    });

    refs.canvas.addEventListener("pointermove", function (e) {
      if (!down) return;
      moved = true;
      chart.setCrosshair(canvasPoint(e));
    });

    refs.canvas.addEventListener("pointerup", function (e) {
      down = false;
      const now = Date.now();
      if (!moved && now - state.lastChartTapAt < 330) {
        state.lastChartTapAt = 0;
        chart.setCrosshair(null);
        startReplay();
        showToast("Replaying…", 900);
        return;
      }
      if (!moved) state.lastChartTapAt = now;
      clearTimeout(state.timerCrosshair);
      state.timerCrosshair = setTimeout(function () { chart.setCrosshair(null); }, 1300);
    });

    refs.canvas.addEventListener("pointercancel", function () {
      down = false;
      chart.setCrosshair(null);
    });
  }

  // ---------------------------------------------------------------
  // Bottom sheet
  // ---------------------------------------------------------------
  function openSheet(title, bodyHtml, actionsHtml) {
    refs.sheetTitle.textContent = title;
    refs.sheetBody.innerHTML = bodyHtml;
    refs.sheetActions.innerHTML = actionsHtml || "";
    refs.sheet.classList.remove("hidden");
    refs.sheetBackdrop.classList.remove("hidden");
  }

  function closeSheet() {
    refs.sheet.classList.add("hidden");
    refs.sheetBackdrop.classList.add("hidden");
    refs.sheetBody.innerHTML = "";
    refs.sheetActions.innerHTML = "";
  }

  function openInfoSheet() {
    openSheet(
      "About this PNL",
      '<div class="sheet-note">This is a <strong>historical simulation</strong>. PNL is calculated from real candles and the simulated entry, size and leverage. Nothing here is a live account balance or a promise of returns.</div>' +
      '<div class="sheet-note">' + esc(DEFAULTS.brand.disclaimer || "") + '</div>' +
      '<div class="sheet-row"><span>Long formula</span><strong>size × (mark − entry)</strong></div>' +
      '<div class="sheet-row"><span>Short formula</span><strong>size × (entry − mark)</strong></div>' +
      '<div class="sheet-row"><span>ROI</span><strong>PNL ÷ margin</strong></div>' +
      '<div class="sheet-row"><span>Margin</span><strong>entry × size ÷ leverage</strong></div>' +
      '<div class="sheet-row"><span>Margin ratio</span><strong>maintenance ÷ (margin + PNL)</strong></div>' +
      '<div class="sheet-row"><span>Liq. Price</span><strong>shown and calculated in both modes</strong></div>' +
      '<p class="sheet-note">Single-position simulation: the posted margin is the account buffer for both modes. Size, margin and entry stay fixed during a replay. Mark, PNL, ROI and margin ratio update with the real candles. Maintenance margin = size × mark × 0.056%.</p>',
      '<button class="cancel" data-sheet-close="1">Close</button>'
    );
  }

  function openLeverageSheet() {
    const a = state.account;
    const value = state.leverage;
    const presets = [1, 5, 10, 20, 50, 125];
    openSheet(
      "Leverage",
      '<div class="sheet-row"><span>' + (a.marginMode === "isolated" ? "Isolated leverage" : "Cross leverage") + '</span><strong id="levReadout">' + value + 'x</strong></div>' +
      '<input class="lev-slider" id="levSlider" type="range" min="1" max="125" step="1" value="' + value + '">' +
      '<div class="lev-scale"><span>1x</span><span>25x</span><span>50x</span><span>75x</span><span>100x</span><span>125x</span></div>' +
      '<div class="lev-presets" id="levPresets">' +
      presets.map(function (p) {
        return '<button type="button" data-lev="' + p + '" class="' + (p === value ? "active" : "") + '">' + p + 'x</button>';
      }).join("") +
      '</div>' +
      '<p class="sheet-note">The entered margin stays fixed. Changing leverage recalculates size, notional, liquidation price and ROI; for a target-PNL scenario, use Studio to re-solve the setup. This does not place an order.</p>',
      '<button class="cancel" data-sheet-close="1">Cancel</button><button class="confirm" data-lev-apply="1">Apply</button>'
    );

    const slider = $("#levSlider", refs.sheetBody);
    const readout = $("#levReadout", refs.sheetBody);
    function setLev(val) {
      const n = clamp(Math.round(Number(val)), 1, 125);
      slider.value = n;
      readout.textContent = n + "x";
      $$("#levPresets button", refs.sheetBody).forEach(function (b) {
        b.classList.toggle("active", Number(b.dataset.lev) === n);
      });
    }
    slider.addEventListener("input", function () { setLev(slider.value); });
    $("#levPresets", refs.sheetBody).addEventListener("click", function (e) {
      const btn = e.target.closest("button[data-lev]");
      if (btn) setLev(btn.dataset.lev);
    });
    refs.sheetActions.querySelector("[data-lev-apply]").addEventListener("click", function () {
      const next = clamp(Math.round(Number(slider.value)), 1, 125);
      a.leverage = next;
      state.leverage = next;
      state.margin = Math.max(1, Number(a.marginUsd) || 1);
      state.size = state.entryPrice > 0 ? (state.margin * next) / state.entryPrice : 0;
      state.pnl = computePnl(state.mark);
      state.roi = state.margin ? (state.pnl / state.margin) * 100 : 0;
      setText(refs.crossLeverage, (a.marginMode === "isolated" ? "Isolated " : "Cross ") + next + "X");
      renderStaticPosition();
      drawFrame(false);
      savePersisted();
      closeSheet();
    });
  }

  function openTpSlSheet() {
    const a = state.account;
    openSheet(
      "TP/SL",
      '<p class="sheet-note">These draw simulated take-profit and stop-loss lines on the chart. They do not send an order.</p>' +
      '<div class="sheet-field"><label for="tpInput">Take profit (USDT)</label><input class="sheet-input" id="tpInput" type="number" step="any" placeholder="' + fmt(state.mark * 1.05, a.priceDecimals) + '" value="' + (a.tpPrice || "") + '"></div>' +
      '<div class="sheet-field"><label for="slInput">Stop loss (USDT)</label><input class="sheet-input" id="slInput" type="number" step="any" placeholder="' + fmt(state.mark * 0.95, a.priceDecimals) + '" value="' + (a.slPrice || "") + '"></div>',
      '<button class="cancel" data-sheet-close="1">Cancel</button><button class="confirm" data-tpsl-apply="1">Apply</button>'
    );
    refs.sheetActions.querySelector("[data-tpsl-apply]").addEventListener("click", function () {
      const tp = Number($("#tpInput", refs.sheetBody).value);
      const sl = Number($("#slInput", refs.sheetBody).value);
      a.tpPrice = Number.isFinite(tp) && tp > 0 ? tp : null;
      a.slPrice = Number.isFinite(sl) && sl > 0 ? sl : null;
      savePersisted();
      drawFrame(false);
      closeSheet();
    });
  }

  function openCloseSheet() {
    openSheet(
      "Close position?",
      '<div class="sheet-note">This freezes the simulated PNL at <strong>' + fmtSigned(state.pnl, 2) + ' USDT</strong>. You can replay afterwards.</div>',
      '<button class="cancel" data-sheet-close="1">Cancel</button><button class="danger" data-close-position="1">Close position</button>'
    );
    refs.sheetActions.querySelector("[data-close-position]").addEventListener("click", function () {
      closeSheet();
      closePosition();
    });
  }

  function openRealizedSheet() {
    openSheet(
      "Realized PNL",
      '<div class="sheet-row"><span>Previously realized</span><strong>' + fmtSigned(Number(state.account.realizedPnl) || 0, 2) + ' USDT</strong></div>' +
      '<div class="sheet-row"><span>Current open PNL</span><strong>' + fmtSigned(state.pnl, 2) + ' USDT</strong></div>' +
      '<div class="sheet-row"><span>Total if closed now</span><strong>' + fmtSigned((Number(state.account.realizedPnl) || 0) + state.pnl, 2) + ' USDT</strong></div>' +
      '<p class="sheet-note">Realized PNL is part of the simulated position history. It is not a withdrawal or a live balance.</p>',
      '<button class="cancel" data-sheet-close="1">Close</button>'
    );
  }

  function openOrderSizeSheet() {
    const sizes = [0.01, 0.1, 0.5, 1, 10, 100];
    openSheet(
      "Order size",
      '<p class="sheet-note">This is the paper ticket size in the order panel. It is separate from the simulated position size.</p>' +
      '<div class="lev-presets" id="sizePresets">' +
      sizes.map(function (s) {
        return '<button type="button" data-size="' + s + '" class="' + (Number(state.account.orderSize) === s ? "active" : "") + '">' + orderSizeText(s) + '</button>';
      }).join("") + '</div>',
      '<button class="cancel" data-sheet-close="1">Cancel</button>'
    );
    $("#sizePresets", refs.sheetBody).addEventListener("click", function (e) {
      const btn = e.target.closest("button[data-size]");
      if (!btn) return;
      state.account.orderSize = Number(btn.dataset.size);
      setText(refs.orderSizeLabel, orderSizeText(state.account.orderSize));
      savePersisted();
      closeSheet();
    });
  }

  function openMoreSheet() {
    openSheet(
      "More",
      '<div class="sheet-note">Trading Reel 1 is a local historical replay studio. It uses real market candles and labels the output as simulated.</div>' +
      '<div class="sheet-row"><span>Ticker</span><strong>' + esc(state.account.symbol) + '</strong></div>' +
      '<div class="sheet-row"><span>Replay window</span><strong>' + (state.startIdx + 1) + ' → ' + state.data.length + '</strong></div>' +
      '<div class="sheet-row"><span>Take length</span><strong>' + (state.takeSeconds || 26) + ' s</strong></div>' +
      '<div class="sheet-row"><span>Data</span><strong>' + esc(state.sourceLabel || "—") + '</strong></div>',
      '<button class="cancel" data-sheet-close="1">Close</button>'
    );
  }

  function applyTicker(symbol) {
    const sym = String(symbol || "").trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "");
    if (!sym) {
      showToast("Enter a ticker symbol.", 2200);
      return;
    }
    state.account.symbol = sym;
    savePersisted();
    closeSheet();
    setAccount(0, { force: true, autoplay: true, forcePlay: true });
  }

  function moverPriceText(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "--";
    const decimals = n >= 1000 ? 2 : n >= 1 ? 4 : n >= 0.01 ? 6 : 8;
    return fmt(n, decimals);
  }

  function moverVolumeText(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "--";
    if (n >= 1e9) return fmt(n / 1e9, 2) + "B";
    if (n >= 1e6) return fmt(n / 1e6, 2) + "M";
    if (n >= 1e3) return fmt(n / 1e3, 2) + "K";
    return fmt(n, 0);
  }

  function moverText(m, up) {
    const change = Number(m.change) || 0;
    const name = m.name || m.symbol;
    const meta = [
      name,
      m.ticker,
      "last " + moverPriceText(m.price),
      "24h " + fmtSigned(change, 2) + "%",
      "vol " + moverVolumeText(m.quoteVolume) + " USDT",
      "trades " + fmt(Number(m.trades) || 0, 0)
    ].join(" · ");
    return '<button type="button" class="mover-item" data-ticker="' + esc(m.ticker) +
      '" title="' + esc(meta) + '">' +
      '<span class="mover-main"><span class="mover-sym">' + esc(m.symbol) + '</span>' +
      '<span class="mover-name">' + esc(name) + '</span></span>' +
      '<span class="mover-change ' + (up ? "mover-up" : "mover-down") + '">' +
      fmtSigned(change, 2) + '%</span></button>';
  }

  function renderMoverStatus() {
    if (!refs.moverUpdated) return;
    const movers = state.movers;
    setText(refs.moverUpdated, movers.updatedAt
      ? tr("Updated", currentLanguage()) + " " + formatHM(movers.updatedAt, false) +
        " · " + tr("top 25 each", currentLanguage())
      : tr("Loading…", currentLanguage()));
  }

  function renderMoverHint() {
    if (!refs.moverHint) return;
    const movers = state.movers;
    setText(refs.moverHint, movers.error
      ? "Binance 24h movers unavailable: " + movers.error + ". The current ticker still loads its recent candle history."
      : tr("Active Binance USDT spot pairs, verified against Binance exchange and 24h data, refreshed every hour. Selecting one loads its latest available candle history.",
          currentLanguage()));
  }

  function renderMovers() {
    const movers = state.movers;
    if (refs.moverGainers) {
      refs.moverGainers.innerHTML = movers.gainers.length
        ? movers.gainers.map(function (m) { return moverText(m, true); }).join("")
        : '<div class="mover-empty">' + (movers.error ? esc(movers.error) : "Loading…") + '</div>';
    }
    if (refs.moverLosers) {
      refs.moverLosers.innerHTML = movers.losers.length
        ? movers.losers.map(function (m) { return moverText(m, false); }).join("")
        : '<div class="mover-empty">' + (movers.error ? esc(movers.error) : "Loading…") + '</div>';
    }
    renderMoverStatus();
    renderMoverHint();
    renderTickerCatalog();
  }

  function renderTickerCatalog() {
    if (!refs.coinList) return;
    const seen = new Set();
    const all = [];
    (DEFAULTS.coins || []).forEach(function (c) { if (!seen.has(c.ticker)) { seen.add(c.ticker); all.push(c); } });
    state.movers.gainers.concat(state.movers.losers).forEach(function (m) {
      if (!seen.has(m.ticker)) { seen.add(m.ticker); all.push({ symbol: m.symbol, name: m.name || m.symbol, ticker: m.ticker }); }
    });
    refs.coinList.innerHTML = all.map(function (c) {
      return '<option value="' + esc(c.ticker) + '">' + esc(c.name) + (c.name !== c.ticker ? " · " + esc(c.ticker) : "") + '</option>';
    }).join("");
  }

  async function refreshTopMovers() {
    try {
      const movers = await TradingData.fetchTopMovers(25);
      state.movers = Object.assign({}, movers, { error: "" });
    } catch (err) {
      state.movers = Object.assign({}, state.movers, { error: err.message || "Could not load 24h movers." });
    }
    renderMovers();
  }

  function selectMoverTicker(ticker) {
    if (!ticker || !refs.fSymbol) return;
    refs.fSymbol.value = String(ticker).toUpperCase();
    state.studioDirty = true;
    scheduleStudioPreview();
    showToast("Ticker set to " + String(ticker).toUpperCase() + ". Entry price remains manual.", 3200);
  }

  function openSymbolSheet() {
    const current = String(state.account.symbol || "").toUpperCase();
    const chip = function (c) {
      return '<button type="button" class="ticker-chip' + (c.ticker === current ? " active" : "") +
        '" data-ticker="' + esc(c.ticker) + '">' + esc(c.symbol) + '</button>';
    };
    const baseChips = (DEFAULTS.coins || []).map(chip).join("");
    const gainerChips = state.movers.gainers.map(chip).join("");
    const loserChips = state.movers.losers.map(chip).join("");
    openSheet(
      "Select ticker",
      '<p class="sheet-note">Any Binance USDT ticker. The top 24h movers refresh automatically; selecting one loads its latest available candle history.</p>' +
      (gainerChips ? '<p class="sheet-row"><span>Top 24h gainers</span><strong>live</strong></p><div class="ticker-grid">' + gainerChips + '</div>' : '') +
      (loserChips ? '<p class="sheet-row"><span>Top 24h losers</span><strong>live</strong></p><div class="ticker-grid">' + loserChips + '</div>' : '') +
      '<p class="sheet-row"><span>Configured tickers</span><strong>pick</strong></p>' +
      '<div class="ticker-grid">' + baseChips + '</div>' +
      '<div class="sheet-field"><label for="customTicker">Custom ticker</label>' +
      '<input class="sheet-input" id="customTicker" type="text" autocapitalize="characters" autocomplete="off" placeholder="e.g. CLANKERUSDT" value="' + (current ? "" : "") + '"></div>',
      '<button class="cancel" data-sheet-close="1">Close</button><button class="confirm" data-custom-ticker="1">Load ticker</button>'
    );
    refs.sheetBody.addEventListener("click", function (e) {
      const btn = e.target.closest("[data-ticker]");
      if (btn) applyTicker(btn.dataset.ticker);
    });
    const input = $("#customTicker", refs.sheetBody);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") applyTicker(input.value);
    });
    refs.sheetActions.querySelector("[data-custom-ticker]").addEventListener("click", function () {
      applyTicker(input.value);
    });
  }

  function openSupportSheet() {
    openSheet(
      "Simulation support",
      '<div class="sheet-note">There is no live account behind this screen. To change settings, reload the page to return to the pre-record Studio. For data issues, edit js/config.js. For recording help, read README.md.</div>',
      '<button class="cancel" data-sheet-close="1">Close</button>'
    );
  }

  function copyShareText() {
    const direction = (state.account.direction || "long").toUpperCase();
    const text =
      state.account.symbol + " " + direction + " " + state.leverage + "x\n" +
      "PNL " + fmtSigned(state.pnl, 2) + " USDT (" + fmtSigned(state.roi, 2) + "%)\n" +
      "SIMULATED historical replay — not a live account.\n" +
      "Not financial advice.";
    const done = function () { showToast("Caption copied. The simulated label is included.", 2400); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (_) { showToast("Copy failed.", 1800); }
    document.body.removeChild(ta);
  }

  // ---------------------------------------------------------------
  // Tabs, nav, fullscreen chart
  // ---------------------------------------------------------------
  function setTab(tab) {
    state.activeTab = tab;
    $$(".tab", refs.tabs).forEach(function (btn) {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    });
    if (tab === "positions") {
      refs.positionsScreen.classList.remove("hidden");
      refs.altScreen.classList.add("hidden");
      refs.chartWrap && chart.resize();
    } else {
      refs.positionsScreen.classList.add("hidden");
      refs.altScreen.classList.remove("hidden");
      setText(refs.altTitle, tab === "orders" ? "No open orders" : "Bots are not simulated");
      setText(refs.altCopy, tab === "orders"
        ? "This reel follows a single position. Switch back to Positions to see the chart."
        : "The Bots screen is outside the scope of this replay studio. Switch back to Positions to continue.");
    }
  }

  function setNav(nav) {
    state.activeNav = nav;
    $$(".nav-item", refs.bottomNav).forEach(function (btn) {
      btn.classList.toggle("active", btn.dataset.nav === nav);
    });
    if (nav === "futures") {
      refs.altScreen.classList.add("hidden");
      if (state.activeTab === "positions") refs.positionsScreen.classList.remove("hidden");
      else setTab(state.activeTab);
      chart.resize();
      return;
    }
    refs.positionsScreen.classList.add("hidden");
    refs.altScreen.classList.remove("hidden");
    setText(refs.altTitle, nav.charAt(0).toUpperCase() + nav.slice(1) + " is outside this replay");
    setText(refs.altCopy, "This project recreates the Futures position view. Tap Futures to return to the recorded screen.");
  }

  function toggleChartFocus() {
    state.chartFocus = !state.chartFocus;
    refs.app.classList.toggle("chart-focus", state.chartFocus);
    setTimeout(function () { chart.resize(); drawFrame(false); }, 40);
  }

  // ---------------------------------------------------------------
  // Studio
  // ---------------------------------------------------------------
  function openStudio() {
    state.wasPlayingBeforeStudio = pausePlayback();
    document.body.classList.add("setup-mode");
    refs.studio.classList.remove("hidden");
    refs.studioFab.classList.add("hidden");
    populateStudio();
  }

  function closeStudio() {
    refs.studio.classList.add("hidden");
    document.body.classList.remove("setup-mode");
    clearTimeout(state.timerToast);
    if (refs.toast) refs.toast.classList.add("hidden");
    if (refs.studioToast) refs.studioToast.classList.add("hidden");
    if (!state.recording) refs.studioFab.classList.remove("hidden");
    if (state.wasPlayingBeforeStudio) {
      state.wasPlayingBeforeStudio = false;
      resumePlayback();
    }
  }

  function populateStudio() {
    const a = state.account;
    if (!a) return;
    setText(refs.studioKicker, (DEFAULTS.appName || "TRADING REEL 1") + (DEFAULTS.build ? " · " + DEFAULTS.build : ""));
    refs.fHandle.value = a.handle || "";
    refs.fWatermark.value = a.watermarkText || DEFAULTS.brand.watermark || "TRADING REEL";
    refs.fLogoUrl.value = a.logoUrl || DEFAULTS.brand.logoUrl || "";
    refs.fSimLabel.value = a.simLabel || "SIM";
    refs.fPositionCount.value = a.positionCount != null ? a.positionCount : 1;
    refs.fLanguage.value = currentLanguage();
    const savedDrawdown = Number(a.drawdownPct);
    refs.fDrawdownPct.value = savedDrawdown > 0 ? a.drawdownPct : "";
    refs.fTurnSeconds.value = a.turnSeconds != null ? a.turnSeconds : 10;
    refs.fSymbol.value = a.symbol || "";
    refs.fInterval.value = "15m";
    refs.fChange24h.value = a.change24hOverride != null ? a.change24hOverride : "";
    state.pendingPatternIndex = Number(a.patternIndex) || 0;
    refs.fVaryPattern.value = a.varyPattern === false ? "0" : "1";
    setText(refs.patternHint, "Pattern " + state.pendingPatternIndex + " / 100 · " +
      (a.varyPattern === false ? "fixed window" : "new real window each page load"));
    refs.fDirection.value = a.direction || "long";
    refs.fMarginMode.value = a.marginMode === "isolated" ? "isolated" : "cross";
    refs.fLeverage.value = a.leverage || 20;
    refs.fMargin.value = a.marginUsd || 10000;
    refs.fTakeSeconds.value = a.takeSeconds || 26;
    refs.fTargetPnl.value = a.targetPnl != null ? a.targetPnl : "";
    refs.fEntryBack.value = "192";
    refs.fStartBack.value = "—";
    refs.fEntryPrice.value = a.entryPriceOverride || "";
    updateCalculatedSize();
    refs.fCountdown.value = state.playback.countdown != null ? state.playback.countdown : 3;
    refs.fRealized.value = a.realizedPnl != null ? a.realizedPnl : 0;
    refs.fPriceDecimals.value = a.priceDecimals != null ? a.priceDecimals : 2;
    refs.fLoop.checked = !!state.playback.loop;
    refs.fAutoPlay.checked = state.playback.autoPlay !== false;
    state.studioSource = a.source || "binance";
    state.studioDirty = false;
    updateStudioPreview();
    updateStudioActiveTab();
    setText(refs.studioKicker, (DEFAULTS.appName || "TRADING REEL 1") + (DEFAULTS.build ? " · " + DEFAULTS.build : ""));
  }

  function formNumber(el, fallback) {
    const n = Number(el.value);
    return Number.isFinite(n) ? n : fallback;
  }

  function formOptionalNumber(el) {
    const raw = String(el && el.value != null ? el.value : "").trim();
    if (raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }



  function setStudioBlocked(reason, soft) {
    if (soft) return;
    state.studioBlockReason = reason || "";
    const blocked = !!reason;
    if (refs.applyBtn) {
      refs.applyBtn.disabled = blocked;
      refs.applyBtn.textContent = blocked ? "Fix settings to apply" : "Apply & replay";
      refs.applyBtn.title = blocked ? "Apply blocked: " + reason : "";
    }
    if (refs.recordBtn) {
      refs.recordBtn.disabled = blocked;
      refs.recordBtn.textContent = blocked ? "Recording blocked" : "Start recording";
      refs.recordBtn.title = blocked ? "Recording blocked: " + reason : "";
    }
  }

  function clearStudioPreview(message) {
    setText(refs.previewStartPnl, "--");
    setText(refs.previewEndPnl, "--");
    refs.previewStartPnl.className = "";
    refs.previewEndPnl.className = "";
    ["pvNotional", "pvQty", "pvEntry", "pvMargin", "pvRoi", "pvDrawdown", "pvTurn", "pvFinalMark", "pvRange", "pvPattern", "pvWindow"].forEach(function (id) {
      if (refs[id]) setText(refs[id], "--");
    });
    setText(refs.positionHint, message || "Choose a real market window.");
    if (refs.positionHint) refs.positionHint.classList.remove("warn");
    state.previewScenario = null;
    setStudioBlocked(message || "No usable real scenario for these settings.");
  }

  function updateCalculatedSize() {
    if (!refs.fSizeDisplay) return;
    if (document.activeElement === refs.fSizeDisplay) return;
    const entry = formNumber(refs.fEntryPrice, 0);
    const margin = formNumber(refs.fMargin, 0);
    const leverage = formNumber(refs.fLeverage, 0);
    const size = entry > 0 && margin > 0 && leverage > 0
      ? (margin * leverage) / entry
      : 0;
    refs.fSizeDisplay.value = size > 0
      ? fmt(size, 2) + " " + baseAsset(refs.fSymbol.value)
      : "";
  }

  function studioDraftFromForm() {
    const symbol = String(refs.fSymbol.value || "").trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "");
    if (!symbol) return { error: "Enter a ticker symbol." };
    const entryPrice = formNumber(refs.fEntryPrice, 0);
    if (!(entryPrice > 0)) {
      return { error: "Enter the manual entry price for this ticker." };
    }
    const targetPnlRaw = formNumber(refs.fTargetPnl, 0);
    if (!(targetPnlRaw > 0)) {
      return { error: "Enter the required positive final PNL target. It is a manual setting; the app does not use the real final close as a target." };
    }
    const a = state.account || {};
    const draft = Object.assign({}, a, {
      symbol: symbol,
      interval: "15m",
      direction: refs.fDirection.value === "short" ? "short" : "long",
      marginMode: refs.fMarginMode.value === "isolated" ? "isolated" : "cross",
      leverage: clamp(Math.round(formNumber(refs.fLeverage, 20)), 1, 125),
      marginUsd: Math.max(1, formNumber(refs.fMargin, 10000)),
      sizeOverride: null,
      takeSeconds: clamp(Math.round(formNumber(refs.fTakeSeconds, 26)), 10, MAX_TAKE_SECONDS),
      entryBackCandles: clamp(Math.round(formNumber(refs.fEntryBack, 50)), 1, MAX_PLAYBACK_CANDLES),
      replayStartBackCandles: clamp(Math.round(formNumber(refs.fStartBack, 30)), 0, MAX_PLAYBACK_CANDLES),
      entryPriceOverride: entryPrice,
      targetPnl: targetPnlRaw,
      drawdownPct: formOptionalNumber(refs.fDrawdownPct) == null
        ? null : clamp(formOptionalNumber(refs.fDrawdownPct), 0, 100),
      turnSeconds: clamp(Math.round(formNumber(refs.fTurnSeconds, 10)), 1,
        clamp(Math.round(formNumber(refs.fTakeSeconds, 26)), 10, MAX_TAKE_SECONDS)),
      priceDecimals: clamp(Math.round(formNumber(refs.fPriceDecimals, 2)), 0, 8),
      source: state.studioSource || a.source || "binance"
    });
    return { draft: draft, key: cacheKey(draft) };
  }

  function renderStudioPreview(draft, data, sourceWarning) {
    const scenario = buildScenario(draft, data);
    if (!scenario) {
      clearStudioPreview("The 48-hour 15m candle set is incomplete for this ticker. Try an active Binance USDT market.");
      return;
    }
    const blockReason = (scenario.blockers || []).join(" ");
    const plan = scenario.patternPlan || null;
    state.previewScenario = scenario;
    setStudioBlocked(blockReason);
    if (refs.fEntryBack) refs.fEntryBack.value = "192";
    if (refs.fStartBack) refs.fStartBack.value = plan ? String(plan.playCount) : "--";
    if (refs.rhythmHint) {
      setText(refs.rhythmHint, plan
        ? "48h 15m source · 192 source candles · " + plan.playCount +
          " playback candles at ~" + fmt(plan.secondsPerCandle, 2) +
          "s/candle · " + plan.seedCount + " history candles · full home area filled"
        : "48h 15m source · waiting for a usable pattern.");
    }
    state.previewPoolLength = Math.max(1, Number(scenario.poolLength) || 1);
    if (refs.newPatternBtn) {
      const noOther = state.previewPoolLength <= 1;
      refs.newPatternBtn.disabled = noOther;
      refs.newPatternBtn.title = noOther
        ? "Only one unused real chart pattern exists for these exact settings."
        : "Rotate to a new unused real chart pattern.";
    }
    if (refs.patternHint) {
      setText(refs.patternHint, "Pattern " + state.pendingPatternIndex + " / 100 · " +
        (scenario.patternName || "48h/15m chart") + " · 192 source candles · " +
        (plan ? plan.playCount + " playback + " + plan.seedCount + " history" : "no playback") +
        (state.previewPoolLength > 1
          ? " · " + state.previewPoolLength + " pattern options"
          : " · one pattern option"));
    }
    updateCalculatedSize();
    const pnlStart = scenario.pnlStart;
    const pnlEnd = scenario.pnlEnd;
    const decimals = draft.priceDecimals;
    setText(refs.previewStartPnl, fmtSigned(pnlStart, 2) + " USDT");
    setText(refs.previewEndPnl, fmtSigned(pnlEnd, 2) + " USDT");
    refs.previewStartPnl.className = pnlStart >= 0 ? "positive" : "negative";
    refs.previewEndPnl.className = pnlEnd >= 0 ? "positive" : "negative";
    setText(refs.pvNotional, fmt(scenario.notional, 2) + " USDT");
    setText(refs.pvQty, fmt(scenario.size, 2) + " " + baseAsset(draft.symbol));
    setText(refs.pvEntry, fmt(scenario.entryPrice, decimals));
    setText(refs.pvMargin, fmt(scenario.margin, 2) + " USDT");
    setText(refs.pvRoi, fmtSigned(scenario.roiEnd, 2) + "%");
    let ddText;
    if (scenario.drawdownPct > 0) {
      ddText = fmtSigned(scenario.maxLossPnl, 2) + " USDT (" +
        fmt(scenario.actualDrawdownPct, 2) + "% max drawdown, enforced)";
    } else {
      ddText = "— (no max drawdown)";
    }
    setText(refs.pvDrawdown, ddText);
    setText(refs.pvTurn, scenario.turnMatched
      ? fmt(scenario.turnSeconds, 1) + " s (exact)" : "no real turn");
    setText(refs.pvFinalMark, fmt(scenario.finalMark, decimals));
    let rangeLow = Infinity;
    let rangeHigh = -Infinity;
    data.forEach(function (c) {
      if (c.l < rangeLow) rangeLow = c.l;
      if (c.h > rangeHigh) rangeHigh = c.h;
    });
    setText(refs.pvRange, Number.isFinite(rangeLow) && Number.isFinite(rangeHigh)
      ? fmt(rangeLow, decimals) + " – " + fmt(rangeHigh, decimals)
      : "--");
    setText(refs.pvPattern, (scenario.patternName || "Real chart") + " · " +
      formatDateTime(scenario.startTime).slice(5));
    const endLabel = formatDateTime(scenario.endTime);
    setText(refs.pvWindow, formatDateTime(scenario.startTime) + " → " + endLabel.slice(5) +
      (scenario.liquidated ? " (liq)" : ""));
    const bits = [];
    bits.push("Manual entry " + fmt(scenario.entryPrice, decimals) + " → size " +
      fmt(scenario.size, 2) + " " + baseAsset(draft.symbol) + " · margin " +
      fmt(scenario.margin, 2) + " USDT · take ~" + scenario.takeSeconds + "s · " +
      "48h / 15m source · 192 candles · " +
      (plan ? plan.playCount : 0) + " playback candles at ~" +
      fmt(plan ? plan.secondsPerCandle : 0, 2) + "s/candle");
    if (scenario.drawdownPct > 0) {
      bits.push("start at entry 0 · max drawdown " + fmtSigned(scenario.maxLossPnl, 2) +
        " USDT (" + fmt(scenario.actualDrawdownPct, 2) + "%) enforced · turn " +
        scenario.turnSeconds + "s exact" + (scenario.turnMatched ? "" : " · no real turn"));
    } else {
      bits.push("no max drawdown · T0 at manual entry · turn " +
        scenario.turnSeconds + "s exact" + (scenario.turnMatched ? "" : " · no real turn"));
    }
    bits.push("ROI at end " + fmtSigned(scenario.roiEnd, 2) + "%");
    if (scenario.warnings.length) bits.push(scenario.warnings.join(" "));
    if (blockReason) bits.push("Recording is blocked until the settings can be matched by a real window.");
    if (sourceWarning) bits.push(sourceWarning);
    setText(refs.positionHint, bits.join(" · ").replace(/\.+$/, "") + ".");
    const scenarioProblem = scenario.size <= 0 || scenario.liquidated ||
      (scenario.warnings && scenario.warnings.length > 0) ||
      (scenario.blockers && scenario.blockers.length > 0) || !scenario.turnMatched;
    if (refs.positionHint) refs.positionHint.classList.toggle("warn", scenarioProblem);
  }

  function loadPreviewWindow(draft, key) {
    if (state.previewLoadingKey === key) return;
    const token = ++state.previewToken;
    state.previewLoadingKey = key;
    clearStudioPreview("Loading the selected 48h / 15m source…");
    getCandles(draft, false).then(function (result) {
      if (token !== state.previewToken) return;
      const prepared = prepareData(result, draft, { preview: true });
      state.previewData = prepared.candles;
      state.previewKey = key;
      state.previewIntervalMs = prepared.intervalMs;
      state.previewLoadingKey = "";
      const current = studioDraftFromForm();
      if (current.draft && current.key === key) {
        renderStudioPreview(current.draft, prepared.candles, prepared.warning);
      }
    }).catch(function (err) {
      if (token !== state.previewToken) return;
      state.previewLoadingKey = "";
      clearStudioPreview(err.message || "Could not load the selected real window.");
    });
  }

  function syncWindowFieldsFromTake() {
    if (refs.fEntryBack) refs.fEntryBack.value = "192";
    const take = clamp(Math.round(formNumber(refs.fTakeSeconds, 26)), 10, MAX_TAKE_SECONDS);
    const turn = clamp(Math.round(formNumber(refs.fTurnSeconds, 10)), 1, take);
    if (turn >= take && refs.fTurnSeconds) refs.fTurnSeconds.value = String(Math.max(1, take - 1));
    if (performance.now() - state.footerActionAt >= 1200) scheduleStudioPreview();
  }

  function syncTakeFromWindow(source) {
    const rawSpan = clamp(Math.round(formNumber(source, playbackCandleSpan(26))), 1, MAX_PLAYBACK_CANDLES);
    const take = clamp(Math.round(rawSpan * playbackSecondsPerCandle()), 10, MAX_TAKE_SECONDS);
    const actualSpan = playbackCandleSpan(take);
    if (refs.fTakeSeconds) refs.fTakeSeconds.value = String(take);
    if (refs.fEntryBack) refs.fEntryBack.value = String(actualSpan);
    if (refs.fStartBack) refs.fStartBack.value = String(actualSpan);
    const turn = clamp(Math.round(formNumber(refs.fTurnSeconds, 10)), 1, take);
    if (turn >= take && refs.fTurnSeconds) refs.fTurnSeconds.value = String(Math.max(1, take - 1));
    if (performance.now() - state.footerActionAt >= 1200) scheduleStudioPreview();
  }

  function syncMarginFromSize() {
    const entry = formNumber(refs.fEntryPrice, 0);
    const leverage = clamp(Math.round(formNumber(refs.fLeverage, 1)), 1, 125);
    const size = formNumber(refs.fSizeDisplay, 0);
    if (!(entry > 0) || !(size > 0) || !(leverage > 0)) return;
    const margin = size * entry / leverage;
    if (!Number.isFinite(margin) || margin <= 0) return;
    const rounded = Math.round(margin * 1e8) / 1e8;
    const changed = Math.abs(formNumber(refs.fMargin, 0) - rounded) > 1e-8;
    if (changed) refs.fMargin.value = String(rounded);
    updateCalculatedSize();
    if (changed) scheduleStudioPreview();
  }

  function updateStudioPreview() {
    if (!refs.previewStartPnl) return;
    updateCalculatedSize();
    const takeLimit = clamp(Math.round(formNumber(refs.fTakeSeconds, 26)), 10, MAX_TAKE_SECONDS);
    const turnValue = clamp(Math.round(formNumber(refs.fTurnSeconds, 10)), 1, takeLimit);
    if (turnValue >= takeLimit) refs.fTurnSeconds.value = String(Math.max(1, takeLimit - 1));
    if (refs.rhythmHint) {
      setText(refs.rhythmHint, "48h / 15m source locked · all 192 candles seed the chart · the real pattern and take set the playback cadence · fixed 214-slot viewport.");
    }
    const form = studioDraftFromForm();
    if (form.error) {
      clearStudioPreview(form.error);
      return;
    }
    const draft = form.draft;
    const key = form.key;
    if (state.account && cacheKey(state.account) === key &&
        (state.rawData.length || state.data.length)) {
      // Use the full candle set, not the chart data sliced to the last
      // scenario. A sliced preview can pick a different (or non-liquidating)
      // window from the full set that Apply/Record actually loads.
      renderStudioPreview(draft, state.rawData.length ? state.rawData : state.data, "");
      return;
    }
    if (state.previewData.length && state.previewKey === key) {
      renderStudioPreview(draft, state.previewData, "");
      return;
    }
    loadPreviewWindow(draft, key);
  }

  function scheduleStudioPreview() {
    clearTimeout(state.previewTimer);
    // Keep the footer available while the preview refreshes. Apply/Record
    // re-validate the current form and remain blocked if the new values fail.
    setStudioBlocked("Preview is updating for the edited settings…", true);
    state.previewTimer = setTimeout(updateStudioPreview, 260);
  }

  function validateForm() {
    const symbol = String(refs.fSymbol.value || "").trim().toUpperCase().replace(/[^A-Z0-9._-]/g, "");
    if (!symbol) { showToast("Enter a ticker symbol.", 2400); return null; }
    const leverage = clamp(Math.round(formNumber(refs.fLeverage, 20)), 1, 125);
    const marginUsd = Math.max(1, formNumber(refs.fMargin, 10000));
    const entryBack = clamp(Math.round(formNumber(refs.fEntryBack, 50)), 1, MAX_PLAYBACK_CANDLES);
    let startBack = clamp(Math.round(formNumber(refs.fStartBack, 30)), 1, MAX_PLAYBACK_CANDLES);
    if (startBack > entryBack) {
      startBack = entryBack;
      showToast("Replay start cannot be older than entry. Clamped to entry.", 2800);
    }
    const entryPriceRaw = formNumber(refs.fEntryPrice, 0);
    if (!(entryPriceRaw > 0)) {
      showToast("Enter the manual entry price for this ticker.", 3200);
      return null;
    }
    const takeSeconds = clamp(Math.round(formNumber(refs.fTakeSeconds, 26)), 10, MAX_TAKE_SECONDS);
    const turnSeconds = clamp(Math.round(formNumber(refs.fTurnSeconds, 10)), 1, takeSeconds);
    const watermarkText = String(refs.fWatermark.value || "").trim() || "TRADING REEL";
    const logoUrl = String(refs.fLogoUrl.value || "").trim();
    const simLabel = String(refs.fSimLabel.value || "").trim() || "SIM";
    const positionCount = clamp(Math.round(formNumber(refs.fPositionCount, 1)), 0, 99);
    const drawdownPctRaw = formOptionalNumber(refs.fDrawdownPct);
    const drawdownPct = drawdownPctRaw == null ? null : clamp(drawdownPctRaw, 0, 100);
    const targetPnlRaw = formNumber(refs.fTargetPnl, 0);
    if (!(targetPnlRaw > 0)) {
      showToast("Enter the required positive final PNL target. It is a manual setting; the real final close is not used as a target.", 3800);
      return null;
    }
    const changeRaw = String(refs.fChange24h.value || "").trim();
    const change24hOverride = changeRaw === "" ? null : Number(changeRaw);
    if (changeRaw !== "" && !Number.isFinite(change24hOverride)) {
      showToast("24h change must be a manually entered number, or blank.", 3200);
      return null;
    }
    const varyPattern = refs.fVaryPattern.value !== "0";
    const source = state.account ? state.account.source || "binance" : "binance";
    if (source === "csv" && !(state.account && (state.account.csvText || state.account.csvUrl))) {
      showToast("This account is configured for CSV but has no CSV text or csvUrl in config.js.", 3800);
      return null;
    }
    return {
      handle: String(refs.fHandle.value || "").trim() || "@account_" + (state.accountIndex + 1),
      watermarkText: watermarkText,
      logoUrl: logoUrl,
      simLabel: simLabel,
      positionCount: positionCount,
      drawdownPct: drawdownPct,
      turnSeconds: turnSeconds,
      change24hOverride: change24hOverride,
      varyPattern: varyPattern,
      symbol: symbol,
      interval: "15m",
      direction: refs.fDirection.value === "short" ? "short" : "long",
      marginMode: refs.fMarginMode.value === "isolated" ? "isolated" : "cross",
      leverage: leverage,
      marginUsd: marginUsd,
      sizeOverride: null,
      targetPnl: targetPnlRaw,
      takeSeconds: takeSeconds,
      entryBackCandles: entryBack,
      replayStartBackCandles: startBack,
      entryPriceOverride: entryPriceRaw,
      realizedPnl: formNumber(refs.fRealized, 0),
      priceDecimals: clamp(Math.round(formNumber(refs.fPriceDecimals, 2)), 0, 8),
      source: source,
      csvText: state.account ? state.account.csvText : "",
      csvName: state.account ? state.account.csvName : "",
      orderSize: state.account ? state.account.orderSize : DEFAULTS.ui.defaultOrderSize,
      tpPrice: state.account ? state.account.tpPrice : null,
      slPrice: state.account ? state.account.slPrice : null
    };
  }

  function applyForm(opts) {
    const options = opts || {};
    const draft = validateForm();
    if (!draft) return false;

    const a = state.account;
    Object.keys(draft).forEach(function (k) { a[k] = draft[k]; });
    if (Number.isFinite(Number(state.pendingPatternIndex))) {
      a.patternIndex = clamp(Math.round(Number(state.pendingPatternIndex)), 0, 99);
    }
    state.leverage = clamp(Math.round(Number(a.leverage) || state.leverage || 1), 1, 125);

    state.playback.countdown = clamp(Math.round(formNumber(refs.fCountdown, 3)), 0, 10);
    state.playback.loop = !!refs.fLoop.checked;
    state.playback.autoPlay = !!refs.fAutoPlay.checked;

    state.studioDirty = false;
    savePersisted();
    buildStudioTabs();
    renderChrome();

    if (options.closeStudio !== false) closeStudio();
    if (options.reload !== false) {
      // Apply/Record reuses the Studio preview's candle cache when the key is
      // unchanged, so the recorded window is exactly the window the user
      // previewed. The explicit Fetch fresh candles button still forces a new
      // Binance request through options.forceFresh.
      loadData({
        force: !!options.forceFresh,
        autoplay: true,
        forcePlay: true,
        advanceSeed: !!options.advanceSeed,
        rememberPattern: !!options.rememberPattern
      });
    }
    if (options.keepStudio && refs.studio.classList.contains("hidden")) openStudio();
    return true;
  }

  function switchStudioAccount(index) {
    if (index === state.accountIndex) return;
    if (state.studioDirty) {
      const ok = applyForm({ closeStudio: false, reload: false, keepStudio: true, newPattern: false });
      if (!ok) return;
    }
    setAccount(index, { force: false, autoplay: true });
  }

  function exportConfig() {
    const payload = {
      app: "trading-reel-1",
      schemaVersion: SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      accounts: state.accounts,
      playback: state.playback
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "trading-reel-1-config.json";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    showToast("Config exported.", 1800);
  }

  async function importConfig(file) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || !Array.isArray(parsed.accounts) || !parsed.accounts.length) {
        throw new Error("This JSON does not contain an accounts array.");
      }
      state.accounts = parsed.accounts.map(function (a, i) {
        const fallback = DEFAULTS.accounts[i] || DEFAULTS.accounts[0];
        return Object.assign({}, clone(fallback), a);
      });
      if (parsed.playback) Object.assign(state.playback, parsed.playback);
      state.playback.language = normalizeLanguage(state.playback.language);
      if (refs.fLanguage) refs.fLanguage.value = state.playback.language;
      savePersisted();
      applyLanguage(state.playback.language);
      closeSheet();
      closeStudio();
      state.accountIndex = 0;
      buildStudioTabs();
      setAccount(0, { force: true, autoplay: true, forcePlay: true });
      showToast("Config imported.", 2000);
    } catch (err) {
      showToast(err.message || "Could not import this JSON.", 4000);
    }
  }

  function resetDefaults() {
    if (!window.confirm("Clear all local edits and reload the five accounts from config.js?")) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) { /* ignore */ }
    location.href = location.pathname + "?account=1";
  }

  // ---------------------------------------------------------------
  // Recording mode
  // ---------------------------------------------------------------
  function refreshPatternForNextRecord() {
    const a = state.account;
    if (!a || a.varyPattern === false || !state.rawData.length) return false;
    if (state.lastRecordedSeed !== state.scenarioSeedUsed) return false;
    const nextSeed = (Number(a.scenarioSeed) || 0) > state.scenarioSeedUsed
      ? (Number(a.scenarioSeed) || 0)
      : state.scenarioSeedUsed + 1;
    a.scenarioSeed = nextSeed;
    state.data = state.rawData.slice();
    computeScenario();
    if (!state.scenario) return false;
    renderChrome();
    renderMarketChrome();
    renderStaticPosition();
    updateChartTabs();
    resetRealizedDisplay();
    drawFrame(true);
    savePersisted();
    return true;
  }

  function enterRecordingMode(opts) {
    const options = opts || {};
    if (state.studioBlockReason) {
      showToast("Recording blocked: " + state.studioBlockReason, 7000);
      return;
    }
    const needsApply = !options.skipApply &&
      !refs.studio.classList.contains("hidden") && state.studioDirty;
    state.pendingRecordAdvance = false;
    if (needsApply) {
      // The apply starts an async load. Mark the take so loadData can advance
      // the saved seed only after the edited scenario has actually been
      // computed.
      state.pendingRecordAdvance = true;
      const ok = applyForm({ closeStudio: false, reload: true, keepStudio: false });
      if (!ok) {
        state.pendingRecordAdvance = false;
        return;
      }
    }
    if (!state.pendingRecordAdvance) {
      if (state.account && state.account.varyPattern !== false &&
          state.rawData.length && state.lastRecordedSeed === state.scenarioSeedUsed) {
        refreshPatternForNextRecord();
      }
      if (state.scenario) {
        state.lastRecordedSeed = state.scenarioSeedUsed;
        state.account.scenarioSeed = state.scenarioSeedUsed + 1;
        rememberPattern(state.scenario);
        savePersisted();
      }
    }
    closeStudio();
    state.recording = true;
    document.body.classList.add("recording-mode");
    try {
      const params = new URLSearchParams(location.search);
      params.set("account", String(state.profileNumber || (state.accountIndex + 1)));
      params.delete("clean");
      params.delete("studio");
      history.replaceState(null, "", location.pathname + "?" + params.toString());
    } catch (_) { /* ignore */ }
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(function () { /* fullscreen is optional */ });
    }
    if (screen.orientation && screen.orientation.lock) {
      screen.orientation.lock("portrait").catch(function () { /* optional */ });
    }
    if (state.data.length && !state.loading) startReplay();
  }

  function exitRecordingMode() {
    state.recording = false;
    hideCountdown();
    document.body.classList.remove("recording-mode");
    try {
      const params = new URLSearchParams(location.search);
      params.delete("clean");
      history.replaceState(null, "", location.pathname + (params.toString() ? "?" + params.toString() : ""));
    } catch (_) { /* ignore */ }
    refs.studioFab.classList.remove("hidden");
    openStudio();
  }

  // ---------------------------------------------------------------
  // Account loading
  // ---------------------------------------------------------------
  async function setAccount(index, opts) {
    const options = opts || {};
    const idx = clamp(Number(index) || 0, 0, state.accounts.length - 1);
    state.accountIndex = idx;
    state.account = state.accounts[idx];
    state.data = [];
    state.closed = false;
    state.finished = false;
    state.playing = false;
    state.paused = false;
    state.activeTab = "positions";
    state.activeNav = "futures";
    state.orderSide = state.account.direction === "long" ? "long" : "short";
    state.realizedBase = Number(state.account.realizedPnl) || 0;
    state.studioSource = state.account.source || "binance";
    clearTimeout(state.timerLoop);
    clearTimeout(state.timerHint);
    hideCountdown();
    if (refs.replayHint) refs.replayHint.classList.add("hidden");
    if (!options.initial) {
      if (state.accounts.length > 1) state.profileNumber = idx + 1;
      updateAccountUrl();
    }

    $$(".tab", refs.tabs).forEach(function (btn) { btn.classList.toggle("active", btn.dataset.tab === "positions"); });
    $$(".nav-item", refs.bottomNav).forEach(function (btn) { btn.classList.toggle("active", btn.dataset.nav === "futures"); });
    refs.positionsScreen.classList.remove("hidden");
    refs.altScreen.classList.add("hidden");
    refs.app.classList.remove("chart-focus");
    state.chartFocus = false;

    renderChrome();
    resetRealizedDisplay();
    setText(refs.pnlValue, "0,00");
    setText(refs.roiValue, "0,00%");
    setText(refs.sizeValue, "--");
    setText(refs.marginValue, "--");
    setText(refs.entryValue, "--");
    setText(refs.markValue, "--");
    setText(refs.liqValue, "--");
    setText(refs.priceChange, "--");
    showChartMessage("Loading real historical candles…");
    await loadData({ force: !!options.force, autoplay: options.autoplay !== false, forcePlay: !!options.forcePlay });
  }

  // ---------------------------------------------------------------
  // Bind events
  // ---------------------------------------------------------------
  function bindEvents() {
    window.addEventListener("resize", fitStage);
    window.addEventListener("orientationchange", function () { setTimeout(fitStage, 200); });
    document.addEventListener("fullscreenchange", function () { setTimeout(fitStage, 120); });
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        state.hiddenAt = performance.now();
      } else {
        if (state.hiddenAt && state.playing && !state.paused && !state.finished) {
          state.playStartTs += performance.now() - state.hiddenAt;
          state.hiddenAt = 0;
          drawFrame(false);
        }
        if (!state.movers.updatedAt ||
            Date.now() - state.movers.updatedAt >= MOVERS_REFRESH_MS) {
          refreshTopMovers();
        }
      }
    });

    refs.orderSideBtn.addEventListener("click", function () {
      showToast(
        "Paper ticket: " + (state.orderSide === "short" ? "Sell/Short" : "Buy/Long") + " " +
        orderSizeText(state.account.orderSize) + " " + baseAsset(state.account.symbol) +
        " at market. No order is placed.",
        3000
      );
    });

    refs.depthToggle.addEventListener("click", function () {
      state.orderSide = state.orderSide === "short" ? "long" : "short";
      applyOrderSideVisuals();
    });

    refs.orderSizeBtn.addEventListener("click", openOrderSizeSheet);

    refs.tabs.addEventListener("click", function (e) {
      const btn = e.target.closest(".tab");
      if (btn) setTab(btn.dataset.tab);
    });

    refs.bottomNav.addEventListener("click", function (e) {
      const btn = e.target.closest(".nav-item");
      if (btn) setNav(btn.dataset.nav);
    });

    refs.symbolRow.addEventListener("click", openSymbolSheet);
    refs.copyBtn.addEventListener("click", copyShareText);
    refs.supportBtn.addEventListener("click", openSupportSheet);
    refs.moreBtn.addEventListener("click", openMoreSheet);
    refs.pnlInfo.addEventListener("click", openInfoSheet);
    refs.realizedBtn.addEventListener("click", openRealizedSheet);
    refs.leverageBtn.addEventListener("click", openLeverageSheet);
    refs.tpslBtn.addEventListener("click", openTpSlSheet);
    refs.closeBtn.addEventListener("click", openCloseSheet);
    refs.closeAllBtn.addEventListener("click", openCloseSheet);
    refs.hideOthers.addEventListener("change", function () {
      showToast("Only the simulated position is loaded.", 1800);
    });
    refs.sortBtn.addEventListener("click", function () {
      refs.sortBtn.classList.toggle("flipped");
    });

    refs.sheetBackdrop.addEventListener("click", closeSheet);
    refs.sheetClose.addEventListener("click", closeSheet);
    refs.sheet.addEventListener("click", function (e) {
      if (e.target.closest("[data-sheet-close]")) closeSheet();
    });

    refs.chartToolbar.addEventListener("click", function (e) {
      const btn = e.target.closest(".tf");
      if (!btn) return;
      const tf = btn.dataset.tf;
      if (tf === "time") {
        showToast("The time axis is driven by the candle timestamps.", 1800);
        return;
      }
      if (tf !== "15m") {
        showToast("Only the 15m interval is available. The chart is locked to each ticker's past 48 hours.", 3200);
        return;
      }
      changeInterval(tf);
    });

    refs.chartFullBtn.addEventListener("click", toggleChartFocus);
    refs.chartMenuBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      refs.chartMenu.classList.toggle("hidden");
    });
    refs.chartMenu.addEventListener("click", function (e) {
      e.stopPropagation();
      if (e.target.closest("#menuResetChart")) { refs.chartMenu.classList.add("hidden"); startReplay(); }
      if (e.target.closest("#menuToggleGrid")) { state.showGrid = !state.showGrid; drawFrame(false); }
      if (e.target.closest("#menuFitChart")) {
        state.fitChart = !state.fitChart;
        drawFrame(false);
        showToast(state.fitChart ? "Chart fitted to candles" : "Entry line included in scale", 1500);
      }
    });
    document.addEventListener("click", function () {
      refs.chartMenu.classList.add("hidden");
    });

    refs.studioFab.addEventListener("click", openStudio);
    refs.studioClose.addEventListener("click", closeStudio);
    // A footer button press blurs the focused Studio input. That blur can emit
    // a change event and temporarily disable the footer between mousedown and
    // mouseup, swallowing the user's first click. Ignore the blur-induced
    // change for a moment; the click reads the current form directly.
    function armFooterAction() {
      if (this.disabled) return;
      state.footerActionAt = performance.now();
    }
    refs.applyBtn.addEventListener("pointerdown", armFooterAction);
    refs.replayBtn.addEventListener("pointerdown", armFooterAction);
    refs.recordBtn.addEventListener("pointerdown", armFooterAction);
    refs.applyBtn.addEventListener("click", function () {
      applyForm({ closeStudio: true, reload: true, advanceSeed: true, rememberPattern: true });
    });
    refs.replayBtn.addEventListener("click", function () {
      if (state.studioDirty) {
        if (!applyForm({ closeStudio: false, reload: false, keepStudio: true, newPattern: false })) return;
      }
      closeStudio();
      startReplay();
    });
    refs.recordBtn.addEventListener("click", function () { enterRecordingMode(); });

    refs.studioTabs.addEventListener("click", function (e) {
      const btn = e.target.closest(".studio-account-tab");
      if (btn) switchStudioAccount(Number(btn.dataset.index));
    });

    if (refs.moverGainers) refs.moverGainers.addEventListener("click", function (e) {
      const btn = e.target.closest("[data-ticker]");
      if (btn) selectMoverTicker(btn.dataset.ticker);
    });
    if (refs.moverLosers) refs.moverLosers.addEventListener("click", function (e) {
      const btn = e.target.closest("[data-ticker]");
      if (btn) selectMoverTicker(btn.dataset.ticker);
    });
    refs.newPatternBtn.addEventListener("click", function () {
      if (state.previewPoolLength <= 1) {
        showToast("Only one unused valid real window exists for these exact settings. Change the entry, target, drawdown or interval.", 4200);
        return;
      }
      const currentPattern = state.previewScenario || state.scenario;
      if (currentPattern) rememberPattern(currentPattern);
      const next = nextPatternWindow({ patternIndex: state.pendingPatternIndex });
      if (!next || !state.account) return;
      state.pendingPatternIndex = next.patternIndex;
      state.account.scenarioSeed = (Number(state.account.scenarioSeed) || 0) + 1;
      state.studioDirty = true;
      savePersisted();
      setText(refs.patternHint, "Pattern " + next.patternIndex +
        " / 100 · new real window in preview · entry timing unchanged");
      scheduleStudioPreview();
      showToast("New real window selected; entry/start timing kept.", 3200);
    });

    refs.refreshDataBtn.addEventListener("click", function () {
      const ok = applyForm({
        closeStudio: false,
        reload: true,
        keepStudio: true,
        newPattern: false,
        forceFresh: true
      });
      if (ok) showToast("Refreshing candles…", 1600);
    });

    refs.fLoop.addEventListener("change", function () { state.playback.loop = refs.fLoop.checked; savePersisted(); });
    refs.fAutoPlay.addEventListener("change", function () { state.playback.autoPlay = refs.fAutoPlay.checked; savePersisted(); });
    if (refs.fLanguage) {
      refs.fLanguage.addEventListener("change", function () {
        setLanguage(refs.fLanguage.value);
      });
    }

    if (refs.fTakeSeconds) {
      refs.fTakeSeconds.addEventListener("input", function () {
        if (performance.now() - state.footerActionAt < 1200) return;
        syncWindowFieldsFromTake();
      });
      refs.fTakeSeconds.addEventListener("change", function () {
        syncWindowFieldsFromTake();
        if (performance.now() - state.footerActionAt >= 1200) scheduleStudioPreview();
      });
    }
    if (refs.fEntryBack) {
      refs.fEntryBack.addEventListener("change", function () {
        syncTakeFromWindow(refs.fEntryBack);
      });
    }
    if (refs.fStartBack) {
      refs.fStartBack.addEventListener("change", function () {
        syncTakeFromWindow(refs.fStartBack);
      });
    }
    if (refs.fSizeDisplay) {
      refs.fSizeDisplay.addEventListener("focus", function () {
        if (state.sizeFieldDirty) return;
        const entry = formNumber(refs.fEntryPrice, 0);
        const margin = formNumber(refs.fMargin, 0);
        const leverage = formNumber(refs.fLeverage, 0);
        const calculated = entry > 0 && margin > 0 && leverage > 0
          ? (margin * leverage) / entry
          : 0;
        refs.fSizeDisplay.value = calculated > 0
          ? String(Math.round(calculated * 100) / 100)
          : "";
        if (refs.fSizeDisplay.value) refs.fSizeDisplay.select();
      });
      refs.fSizeDisplay.addEventListener("input", function () {
        state.sizeFieldDirty = true;
        // Keep the margin-derived calculations live while the user types;
        // updateCalculatedSize is suppressed only for this focused field.
        const entry = formNumber(refs.fEntryPrice, 0);
        const leverage = clamp(Math.round(formNumber(refs.fLeverage, 1)), 1, 125);
        const size = formNumber(refs.fSizeDisplay, 0);
        if (entry > 0 && leverage > 0 && size > 0) {
          const margin = size * entry / leverage;
          if (Number.isFinite(margin) && margin > 0) {
            refs.fMargin.value = String(Math.round(margin * 1e8) / 1e8);
          }
        }
        scheduleStudioPreview();
      });
      refs.fSizeDisplay.addEventListener("change", function () {
        if (state.sizeFieldDirty) syncMarginFromSize();
        state.sizeFieldDirty = false;
        updateCalculatedSize();
      });
      refs.fSizeDisplay.addEventListener("blur", function () {
        if (state.sizeFieldDirty) syncMarginFromSize();
        state.sizeFieldDirty = false;
        updateCalculatedSize();
      });
    }

    refs.studio.addEventListener("input", function (e) {
      if (e.target === refs.fLanguage) return;
      if (performance.now() - state.footerActionAt < 1200) return;
      if (e.target.closest(".studio-scroll")) {
        state.studioDirty = true;
        scheduleStudioPreview();
      }
    });
    refs.studio.addEventListener("change", function (e) {
      if (e.target === refs.fLanguage) return;
      if (performance.now() - state.footerActionAt < 1200) return;
      if (e.target.closest(".studio-scroll")) {
        state.studioDirty = true;
        scheduleStudioPreview();
      }
    });

    refs.resetDefaultsBtn.addEventListener("click", resetDefaults);
    refs.exportBtn.addEventListener("click", exportConfig);
    refs.importBtn.addEventListener("click", function () { refs.importFile.click(); });
    refs.importFile.addEventListener("change", function (e) {
      const file = e.target.files && e.target.files[0];
      importConfig(file);
    });

    document.addEventListener("keydown", function (e) {
      const tag = (e.target && e.target.tagName) || "";
      if (["INPUT", "SELECT", "TEXTAREA"].indexOf(tag) !== -1) return;
      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        if (state.paused) { resumePlayback(); showToast("Playing", 700); }
        else if (pausePlayback()) showToast("Paused", 700);
        return;
      }
      if (e.key === "r" || e.key === "R") { startReplay(); return; }
      if (e.key === "f" || e.key === "F") { toggleChartFocus(); return; }
      if (e.key === "n" || e.key === "N") { setAccount((state.accountIndex + 1) % state.accounts.length); return; }
      if (e.key === "Escape") {
        if (!refs.sheet.classList.contains("hidden")) { closeSheet(); return; }
        if (!refs.studio.classList.contains("hidden")) { closeStudio(); return; }
        if (state.chartFocus) { toggleChartFocus(); return; }
      }
      if (/^[1-5]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        if (idx < state.accounts.length) setAccount(idx);
      }
    });
  }

  function changeInterval(tf) {
    if (!state.account) return;
    if (tf !== "15m") {
      showToast("Only the 15m interval is available.", 2400);
      return;
    }
    state.account.interval = "15m";
    if (refs.fInterval) refs.fInterval.value = "15m";
    updateChartTabs();
    savePersisted();
    setText(refs.priceChange, "--");
    showChartMessage("Loading the past 48 hours of 15m candles…");
    loadData({ force: true, autoplay: true, immediate: true });
  }

  // ---------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------
  function init() {
    refs = {
      viewport: $("#viewport"),
      stage: $("#stage"),
      app: $("#app"),
      notch: $("#notch"),
      symbolRow: $(".symbol-row"),
      symbolName: $("#symbolName"),
      priceChange: $("#priceChange"),
      simPill: $("#simPill"),
      supportBtn: $("#supportBtn"),
      moreBtn: $("#moreBtn"),
      orderSideBtn: $("#orderSideBtn"),
      bidPrice: $("#bidPrice"),
      askPrice: $("#askPrice"),
      bidSize: $("#bidSize"),
      askSize: $("#askSize"),
      ratioBuy: $("#ratioBuy"),
      ratioSell: $("#ratioSell"),
      ratioGreen: $("#ratioGreen"),
      ratioRed: $("#ratioRed"),
      orderSizeBtn: $("#orderSizeBtn"),
      orderSizeLabel: $("#orderSizeLabel"),
      depthToggle: $("#depthToggle"),
      sideRed: $("#sideRed"),
      sideGreen: $("#sideGreen"),
      costValue: $("#costValue"),
      tabs: $(".tabs"),
      copyBtn: $("#copyBtn"),
      hideOthers: $("#hideOthers"),
      closeAllBtn: $("#closeAllBtn"),
      sortBtn: $("#sortBtn"),
      posCount: $("#posCount"),
      cardSymbol: $("#cardSymbol"),
      assetBadge: $("#assetBadge"),
      crossLeverage: $("#crossLeverage"),
      closedTag: $("#closedTag"),
      pnlValue: $("#pnlValue"),
      roiValue: $("#roiValue"),
      pnlInfo: $("#pnlInfo"),
      sizeAsset: $("#sizeAsset"),
      sizeValue: $("#sizeValue"),
      marginValue: $("#marginValue"),
      marginRatio: $("#marginRatio"),
      entryValue: $("#entryValue"),
      markValue: $("#markValue"),
      liqValue: $("#liqValue"),
      realizedBtn: $("#realizedBtn"),
      realizedValue: $("#realizedValue"),
      leverageBtn: $("#leverageBtn"),
      tpslBtn: $("#tpslBtn"),
      closeBtn: $("#closeBtn"),
      positionsScreen: $("#positionsScreen"),

      chartToolbar: $("#chartToolbar"),
      chartWrap: $("#chartWrap"),
      canvas: $("#chartCanvas"),
      chartMessage: $("#chartMessage"),
      chartDate: $("#chartDate"),
      chartFullBtn: $("#chartFullBtn"),
      chartMenuBtn: $("#chartMenuBtn"),
      chartMenu: $("#chartMenu"),

      altScreen: $("#altScreen"),
      altTitle: $("#altTitle"),
      altCopy: $("#altCopy"),
      bottomNav: $("#bottomNav"),
      sheet: $("#sheet"),
      sheetBackdrop: $("#sheetBackdrop"),
      sheetTitle: $("#sheetTitle"),
      sheetBody: $("#sheetBody"),
      sheetActions: $("#sheetActions"),
      sheetClose: $("#sheetClose"),
      toast: $("#toast"),
      studioToast: $("#studioToast"),
      replayHint: $("#replayHint"),
      studioFab: $("#studioFab"),
      studio: $("#studio"),
      studioTabs: $("#studioAccountTabs"),
      studioClose: $("#studioClose"),
      studioKicker: $(".studio-kicker"),
      studioScroll: $(".studio-scroll"),
      fHandle: $("#fHandle"),
      fWatermark: $("#fWatermark"),
      fLogoUrl: $("#fLogoUrl"),
      fSimLabel: $("#fSimLabel"),
      fPositionCount: $("#fPositionCount"),
      fLanguage: $("#fLanguage"),
      fDrawdownPct: $("#fDrawdownPct"),
      fTurnSeconds: $("#fTurnSeconds"),

      fSymbol: $("#fSymbol"),
      fInterval: $("#fInterval"),
      fChange24h: $("#fChange24h"),
      fVaryPattern: $("#fVaryPattern"),
      patternHint: $("#patternHint"),
      newPatternBtn: $("#newPatternBtn"),
      moverUpdated: $("#moverUpdated"),
      moverGainers: $("#moverGainers"),
      moverLosers: $("#moverLosers"),
      moverHint: $("#moverHint"),
      fDirection: $("#fDirection"),
      fLeverage: $("#fLeverage"),
      fMargin: $("#fMargin"),
      fSizeDisplay: $("#fSizeDisplay"),
      fEntryBack: $("#fEntryBack"),
      fStartBack: $("#fStartBack"),
      rhythmHint: $("#rhythmHint"),
      entryPriceLabel: $("#entryPriceLabel"),
      entryPriceHint: $("#entryPriceHint"),
      fEntryPrice: $("#fEntryPrice"),
      fMarginMode: $("#fMarginMode"),
      fTakeSeconds: $("#fTakeSeconds"),
      fTargetPnl: $("#fTargetPnl"),
      fCountdown: $("#fCountdown"),
      pvNotional: $("#pvNotional"),
      pvQty: $("#pvQty"),
      pvEntry: $("#pvEntry"),
      pvMargin: $("#pvMargin"),
      pvRoi: $("#pvRoi"),
      pvDrawdown: $("#pvDrawdown"),
      pvTurn: $("#pvTurn"),
      pvFinalMark: $("#pvFinalMark"),
      pvRange: $("#pvRange"),
      pvPattern: $("#pvPattern"),
      pvWindow: $("#pvWindow"),
      countdown: $("#countdown"),
      countdownNum: $("#countdownNum"),
      coinList: $("#coinList"),
      fRealized: $("#fRealized"),
      fPriceDecimals: $("#fPriceDecimals"),
      fLoop: $("#fLoop"),
      fAutoPlay: $("#fAutoPlay"),
      refreshDataBtn: $("#refreshDataBtn"),
      previewStartPnl: $("#previewStartPnl"),
      previewEndPnl: $("#previewEndPnl"),
      positionHint: $("#positionHint"),
      applyBtn: $("#applyBtn"),
      replayBtn: $("#replayBtn"),
      recordBtn: $("#recordBtn"),
      resetDefaultsBtn: $("#resetDefaultsBtn"),
      exportBtn: $("#exportBtn"),
      importBtn: $("#importBtn"),
      importFile: $("#importFile")
    };

    loadPersisted();
    document.title = DEFAULTS.appName || "Trading Reel 1";
    startLanguageObserver();
    applyLanguage(state.playback.language);
    renderTickerCatalog();

    const stageCfg = DEFAULTS.stage;
    refs.stage.style.width = stageCfg.width + "px";
    refs.stage.style.height = stageCfg.height + "px";
    refs.app.style.width = stageCfg.appWidth + "px";
    refs.app.style.height = stageCfg.height + "px";
    const gutter = Math.max(0, (stageCfg.width - stageCfg.appWidth) / 2);
    refs.app.style.left = gutter + "px";
    $$(".stage-side").forEach(function (el) { el.style.width = gutter + "px"; });
    refs.notch.classList.toggle("hidden", stageCfg.showNotch === false);

    state.accountIndex = getInitialAccountIndex();
    // Advance the 100-pattern deck once per page load. Apply/replay reuses the
    // same window so the pre-record preview and the recorded UI stay identical.
    applyPatternToAccount(state.accounts[state.accountIndex]);
    savePersisted();
    chart = new TradingChart(refs.canvas);
    bindEvents();
    bindChartPointer();
    buildStudioTabs();
    fitStage();
    requestAnimationFrame(frame);

    const params = new URLSearchParams(location.search);
    const clean = params.get("clean") === "1";
    if (clean) {
      state.recording = true;
      document.body.classList.add("recording-mode");
      refs.studioFab.classList.add("hidden");
    }

    setAccount(state.accountIndex, { initial: true, force: false, autoplay: true });

    refreshTopMovers();
    setInterval(refreshTopMovers, MOVERS_REFRESH_MS);
    if (!clean && params.get("studio") !== "0") {
      setTimeout(openStudio, 300);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
