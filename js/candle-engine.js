/**
 * CandleEngine — tick-bucketed OHLC state machine.
 *
 * Closed candles are immutable. The active candle accepts ticks and only
 * ratchets its high/low outward. Bucket time is always derived from the
 * supplied source timestamp, never from render time.
 */
(function () {
  "use strict";

  function finitePrice(v) {
    return Number.isFinite(Number(v)) && Number(v) > 0;
  }

  function copyCandle(c) {
    return {
      t: Number(c.t != null ? c.t : c.time),
      time: Number(c.t != null ? c.t : c.time),
      o: Number(c.o != null ? c.o : c.open),
      h: Number(c.h != null ? c.h : c.high),
      l: Number(c.l != null ? c.l : c.low),
      c: Number(c.c != null ? c.c : c.close),
      v: Number(c.v || c.volume || 0),
      closed: true,
      synthetic: false
    };
  }

  class CandleEngine {
    constructor(intervalMs) {
      this.intervalMs = Math.max(1, Number(intervalMs) || 60000);
      this.candles = [];
      this.active = null;
    }

    seedHistory(history) {
      this.candles = [];
      this.active = null;
      const source = Array.isArray(history) ? history : [];
      for (let i = 0; i < source.length; i++) {
        this.candles.push(copyCandle(source[i]));
      }
    }

    begin(price, timestamp) {
      if (!finitePrice(price)) return null;
      const p = Number(price);
      const bucket = Math.floor(Number(timestamp) / this.intervalMs) * this.intervalMs;
      const active = {
        t: bucket,
        time: bucket,
        o: p,
        h: p,
        l: p,
        c: p,
        v: 0,
        closed: false,
        synthetic: false
      };
      this.active = active;
      this.candles.push(active);
      return active;
    }

    ingest(price, sourceTimestamp) {
      if (!finitePrice(price)) return this.active;
      const p = Number(price);
      const interval = this.intervalMs;
      const bucket = Math.floor(Number(sourceTimestamp) / interval) * interval;

      if (!this.active) {
        return this.begin(p, bucket);
      }

      if (bucket > this.active.time) {
        // Finalize the current candle permanently.
        this.active.c = Number(this.active.c);
        this.active.closed = true;
        this.active = null;

        let previousClose = Number(this.candles[this.candles.length - 1].c);
        let nextTime = this.candles[this.candles.length - 1].time + interval;

        // Zero-tick intervals become flat dojis so the time axis still advances.
        while (nextTime < bucket) {
          const flat = {
            t: nextTime,
            time: nextTime,
            o: previousClose,
            h: previousClose,
            l: previousClose,
            c: previousClose,
            v: 0,
            closed: true,
            synthetic: true
          };
          this.candles.push(flat);
          previousClose = flat.c;
          nextTime += interval;
        }

        const active = {
          t: bucket,
          time: bucket,
          o: previousClose,
          h: Math.max(previousClose, p),
          l: Math.min(previousClose, p),
          c: p,
          v: 0,
          closed: false,
          synthetic: false
        };
        this.active = active;
        this.candles.push(active);
        return active;
      }

      // Same bucket: mutate only the live close and ratchet high/low outward.
      const active = this.active;
      active.c = p;
      active.h = Math.max(active.h, p);
      active.l = Math.min(active.l, p);
      return active;
    }

    activeIndex() {
      return Math.max(0, this.candles.length - 1);
    }

    intraFraction(sourceTimestamp) {
      if (!this.active) return 0;
      const amount = (Number(sourceTimestamp) - this.active.time) / this.intervalMs;
      return Math.max(0, Math.min(0.999999, amount));
    }

    remainingMs(sourceTimestamp) {
      if (!this.active) return 0;
      return Math.max(0, this.active.time + this.intervalMs - Number(sourceTimestamp));
    }
  }

  window.CandleEngine = CandleEngine;
})();
