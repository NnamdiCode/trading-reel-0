/**
 * Candlestick replay chart.
 *
 * The chart receives a fractional cursor (e.g. 41.37). It renders candles up to
 * the cursor, scrolls continuously, and computes the live mark price from the
 * current candle's open/close path. The app uses markAt() for the PNL math, so
 * the chart and the number card can never disagree.
 */
(function () {
  "use strict";

  const GREEN = "#2ebd85";
  const RED = "#f6465d";
  const GRID = "rgba(90, 103, 111, 0.24)";
  const AXIS = "#626d76";
  const MUTED_LINE = "rgba(142, 153, 162, 0.55)";

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function smoothstep(t) {
    return t * t * (3 - 2 * t);
  }

  function seededNoise(seed) {
    const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
  }

  /** Price path inside a candle. Deterministic, starts at open, ends at close. */
  function interpolatePrice(candle, progress) {
    const p = clamp(progress, 0, 1);
    const base = candle.o + (candle.c - candle.o) * smoothstep(p);
    const span = Math.max(1e-12, candle.h - candle.l);
    const envelope = Math.sin(Math.PI * p);
    const wobble =
      seededNoise(candle.t) * span * 0.13 * envelope +
      Math.sin(p * Math.PI * 2.8 + candle.t * 0.00001) * span * 0.045 * envelope +
      Math.sin(p * Math.PI * 7.0 + candle.t * 0.00003) * span * 0.022 * envelope;
    return clamp(base + wobble, candle.l, candle.h);
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  class TradingChart {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.data = [];
      this.cssW = 0;
      this.cssH = 0;
      this.pixelRatio = 1;
      this.scaleFactor = 1;
      this.viewMin = null;
      this.viewMax = null;
      this.lastState = null;
      this.crosshair = null;
      this.raf = null;

      const self = this;
      if (typeof ResizeObserver !== "undefined") {
        this.ro = new ResizeObserver(function () { self.resize(); });
        this.ro.observe(canvas.parentElement);
      }
      window.addEventListener("resize", function () { self.resize(); });
      this.resize();
    }

    setScale(scale) {
      const next = Math.max(1, (window.devicePixelRatio || 1) * (scale || 1));
      if (Math.abs(next - this.pixelRatio) > 0.01) {
        this.pixelRatio = next;
        this.resize();
      }
    }

    setData(candles) {
      this.data = candles || [];
      this.viewMin = null;
      this.viewMax = null;
    }

    resize() {
      // Use the untransformed layout size. getBoundingClientRect() includes the
      // 9:16 stage scale, and using it here made the canvas render smaller and
      // left-aligned inside its own container.
      const parent = this.canvas.parentElement;
      const w = Math.max(40, parent.clientWidth);
      const h = Math.max(40, parent.clientHeight);
      const ratio = this.pixelRatio || 1;
      this.cssW = w;
      this.cssH = h;
      this.canvas.width = Math.round(w * ratio);
      this.canvas.height = Math.round(h * ratio);
      // The CSS width/height are 100%; do not pin them to the transformed size.
      this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (this.lastState) this.draw(this.lastState);
    }

    markAt(cursor) {
      if (!this.data.length) return 0;
      if (cursor >= this.data.length - 1 + 1) {
        return this.data[this.data.length - 1].c;
      }
      if (cursor <= 0) return this.data[0].o;
      const i = Math.floor(cursor);
      const candle = this.data[Math.min(i, this.data.length - 1)];
      return interpolatePrice(candle, cursor - i);
    }

    setCrosshair(point) {
      this.crosshair = point;
      if (this.lastState) this.draw(this.lastState);
    }

    draw(state) {
      this.lastState = state;
      if (!state || !this.data.length) return;

      const ctx = this.ctx;
      const W = this.cssW;
      const H = this.cssH;
      if (!W || !H) return;

      ctx.clearRect(0, 0, W, H);

      const rightAxis = 54;
      const bottomAxis = 18;
      const plotL = 0;
      const plotR = W - rightAxis;
      const plotT = 3;
      const plotB = H - bottomAxis;
      const plotW = plotR - plotL;
      const plotH = plotB - plotT;
      if (plotW <= 0 || plotH <= 0) return;

      const data = this.data;
      const cursor = state.cursor;
      const visible = Math.max(10, state.visibleCandles || 160);
      const currentIdx = clamp(Math.floor(cursor), 0, data.length - 1);
      const intra = clamp(cursor - currentIdx, 0, 1);
      const firstIdx = Math.max(0, Math.min(currentIdx, Math.floor(cursor) - visible + 1));
      const slot = plotW / visible;
      // Reference-style narrow bodies: density comes from the fixed viewport,
      // not from stretching a short take across the whole pane.
      const bodyW = Math.max(1.2, Math.min(4.6, slot * 0.68));
      const gapFraction = clamp(Number(state.futureGapFraction) || 0, 0, 0.6);
      const futureGap = plotW * gapFraction;
      const onscreenVisible = Math.max(2, Math.floor((plotW - futureGap) / slot));
      const firstOnscreen = Math.max(firstIdx, currentIdx - onscreenVisible + 1);

      let lo = Infinity;
      let hi = -Infinity;
      for (let i = firstOnscreen; i <= currentIdx; i++) {
        const c = data[i];
        lo = Math.min(lo, c.l);
        hi = Math.max(hi, c.h);
      }
      const mark = state.markPrice != null ? state.markPrice : this.markAt(cursor);
      lo = Math.min(lo, mark);
      hi = Math.max(hi, mark);
      if (!state.fitChart) {
        lo = Math.min(lo, state.entryPrice);
        hi = Math.max(hi, state.entryPrice);
        if (state.tpPrice) { lo = Math.min(lo, state.tpPrice); hi = Math.max(hi, state.tpPrice); }
        if (state.slPrice) { lo = Math.min(lo, state.slPrice); hi = Math.max(hi, state.slPrice); }
      }

      let span = hi - lo;
      if (!Number.isFinite(span) || span <= 0) span = Math.max(Math.abs(hi) * 0.01, 1e-9);
      const pad = span * 0.1;
      let targetMin = lo - pad;
      let targetMax = hi + pad;

      if (this.viewMin == null || state.resetScale) {
        this.viewMin = targetMin;
        this.viewMax = targetMax;
      } else {
        this.viewMin += (targetMin - this.viewMin) * 0.22;
        this.viewMax += (targetMax - this.viewMax) * 0.22;
        if (Math.abs(targetMin - this.viewMin) < 1e-9) this.viewMin = targetMin;
        if (Math.abs(targetMax - this.viewMax) < 1e-9) this.viewMax = targetMax;
      }

      const viewMin = this.viewMin;
      const viewMax = this.viewMax;
      const viewSpan = Math.max(1e-12, viewMax - viewMin);
      const yOf = function (price) {
        return plotB - ((price - viewMin) / viewSpan) * plotH;
      };
      const xOf = function (idx) {
        return plotR - futureGap - slot / 2 - (cursor - idx) * slot;
      };

      // ------------------------------------------------------------
      // Grid + right-side price axis
      // ------------------------------------------------------------
      if (state.showGrid !== false) {
        ctx.strokeStyle = GRID;
        ctx.lineWidth = 0.6;
        ctx.setLineDash([]);
        const ticks = 6;
        for (let i = 0; i <= ticks; i++) {
          const y = plotT + (plotH * i) / ticks;
          ctx.beginPath();
          ctx.moveTo(plotL, y + 0.5);
          ctx.lineTo(plotR, y + 0.5);
          ctx.stroke();
        }
        ctx.strokeStyle = "rgba(90, 103, 111, 0.12)";
        for (let i = 1; i < 4; i++) {
          const x = plotL + (plotW * i) / 4;
          ctx.beginPath();
          ctx.moveTo(x + 0.5, plotT);
          ctx.lineTo(x + 0.5, plotB);
          ctx.stroke();
        }
      }

      ctx.font = '8.4px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = AXIS;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      let decimals = state.decimals != null ? state.decimals : 2;
      // Keep the sampled chart axis readable for low-priced assets: if the
      // requested precision collapses the six labels, increase it until they
      // are visibly distinct. This affects chart labels only, not PNL math.
      for (let d = decimals; d < 8; d++) {
        const seen = new Set();
        for (let i = 0; i <= 6; i++) {
          seen.add(state.formatPrice(viewMax - (viewSpan * i) / 6, d));
        }
        decimals = d;
        if (seen.size >= 6) break;
      }
      for (let i = 0; i <= 6; i++) {
        const y = plotT + (plotH * i) / 6;
        const price = viewMax - (viewSpan * i) / 6;
        const label = state.formatPrice(price, decimals);
        ctx.fillText(label, W - 5, y);
      }

      // ------------------------------------------------------------
      // Watermark
      // ------------------------------------------------------------
      if (state.watermark) {
        const watermarkText = String(state.watermark);
        const requestedLogo = state.logoUrl || "";
        if (requestedLogo !== this.logoRequested) {
          this.logoRequested = requestedLogo;
          this.logoImage = null;
          if (requestedLogo) {
            const img = new Image();
            const self = this;
            img.onload = function () {
              if (self.logoRequested === requestedLogo) {
                self.logoImage = img;
                if (self.lastState) self.draw(self.lastState);
              }
            };
            img.onerror = function () {
              if (self.logoRequested === requestedLogo) {
                self.logoImage = null;
                if (self.lastState) self.draw(self.lastState);
              }
            };
            img.src = requestedLogo;
          }
        }

        const hasLogo = !!(this.logoImage && this.logoImage.complete &&
          this.logoImage.naturalWidth > 0 && this.logoRequested === requestedLogo);
        ctx.save();
        ctx.font = '700 29px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textBaseline = "middle";
        const textW = ctx.measureText(watermarkText).width;
        const iconR = 18;
        const gap = 6;
        const iconW = hasLogo ? 32 : iconR * 2;
        const iconH = hasLogo ? 32 : iconR * 2;
        const totalW = iconW + gap + textW;
        const centerX = plotL + plotW / 2;
        const centerY = plotT + plotH * 0.47;
        const iconLeft = centerX - totalW / 2;

        if (hasLogo) {
          ctx.globalAlpha = 0.10;
          ctx.drawImage(this.logoImage, iconLeft, centerY - iconH / 2, iconW, iconH);
          ctx.globalAlpha = 1;
        } else {
          const iconCx = iconLeft + iconR;
          ctx.strokeStyle = "rgba(210, 214, 222, 0.10)";
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(iconCx, centerY - iconR);
          ctx.lineTo(iconCx + iconR, centerY);
          ctx.lineTo(iconCx, centerY + iconR);
          ctx.lineTo(iconCx - iconR, centerY);
          ctx.closePath();
          ctx.stroke();
        }

        ctx.fillStyle = "rgba(210, 214, 222, 0.10)";
        ctx.textAlign = "left";
        ctx.fillText(watermarkText, iconLeft + iconW + gap, centerY + 1);
        ctx.restore();
      }
      // ------------------------------------------------------------
      // Candles
      // ------------------------------------------------------------
      for (let i = firstIdx; i <= currentIdx; i++) {
        const c = data[i];
        const x = xOf(i);
        if (x < plotL - slot || x > plotR + slot) continue;
        // Completed candles keep their real OHLC. The candle currently being
        // replayed uses the controlled last price as its close so the white
        // mark line is always exactly on the live candle close; its high/low
        // still include the real wick extremes.
        const isLive = i === currentIdx;
        const close = isLive ? mark : c.c;
        const high = isLive ? Math.max(c.h, c.o, mark) : c.h;
        const low = isLive ? Math.min(c.l, c.o, mark) : c.l;
        const up = isLive ? close >= c.o : c.c >= c.o;
        const color = up ? GREEN : RED;
        const yOpen = yOf(c.o);
        const yClose = yOf(close);
        const yHigh = yOf(high);
        const yLow = yOf(low);

        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, yHigh);
        ctx.lineTo(Math.round(x) + 0.5, yLow);
        ctx.stroke();

        const bodyTop = Math.min(yOpen, yClose);
        const bodyH = Math.max(1.2, Math.abs(yClose - yOpen));
        ctx.fillRect(x - bodyW / 2, bodyTop, bodyW, bodyH);
      }

      // ------------------------------------------------------------
      // Take-profit / stop-loss markers
      // ------------------------------------------------------------
      if (state.tpPrice) {
        this.drawHorizontalMarker(ctx, plotL, plotR, yOf(state.tpPrice), "#f0b90b", "TP " + state.formatPrice(state.tpPrice, decimals), state);
      }
      if (state.slPrice) {
        this.drawHorizontalMarker(ctx, plotL, plotR, yOf(state.slPrice), "#f6465d", "SL " + state.formatPrice(state.slPrice, decimals), state);
      }

      // ------------------------------------------------------------
      // Entry line + PNL pill + size pill
      // ------------------------------------------------------------
      const entryY = yOf(state.entryPrice);
      const pnlColor = state.pnl >= 0 ? GREEN : RED;
      ctx.save();
      ctx.strokeStyle = state.pnl >= 0 ? "rgba(46,189,133,0.8)" : "rgba(246,70,93,0.8)";
      ctx.lineWidth = 0.85;
      ctx.setLineDash([2, 2.4]);
      ctx.beginPath();
      ctx.moveTo(plotL, entryY);
      ctx.lineTo(plotR, entryY);
      ctx.stroke();
      ctx.restore();

      const pillText = "PnL " + state.pnlText;
      const sizeText = state.sizeText;
      ctx.font = '600 8.6px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      const pnlW = ctx.measureText(pillText).width + 13;
      const sizeW = ctx.measureText(sizeText).width + 13;
      const pillH = 17;
      let pillY = entryY - pillH / 2;
      pillY = clamp(pillY, plotT, plotB - pillH);

      ctx.save();
      ctx.fillStyle = pnlColor;
      roundRect(ctx, plotL, pillY, pnlW, pillH, 3.5);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(pillText, plotL + 6, pillY + pillH / 2 + 0.3);

      ctx.fillStyle = "rgba(27,35,38,0.92)";
      ctx.strokeStyle = pnlColor;
      ctx.lineWidth = 1;
      roundRect(ctx, plotL + pnlW + 1, pillY, sizeW, pillH, 3.5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#f2f4f5";
      ctx.fillText(sizeText, plotL + pnlW + 7, pillY + pillH / 2 + 0.3);
      ctx.restore();

      // ------------------------------------------------------------
      // Right-side entry price box (matches the reference's outlined tag)
      // ------------------------------------------------------------
      ctx.save();
      ctx.font = '700 10px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      const entryLabel = state.formatPrice(state.entryPrice, decimals);
      const entryW = Math.max(46, ctx.measureText(entryLabel).width + 16);
      const entryH = 22;
      const entryX = W - entryW - 2;
      const entryBoxY = clamp(entryY - entryH / 2, plotT, plotB - entryH);
      ctx.fillStyle = "rgba(27,35,38,0.94)";
      ctx.strokeStyle = pnlColor;
      ctx.lineWidth = 1;
      roundRect(ctx, entryX, entryBoxY, entryW, entryH, 3.5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = pnlColor;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(entryLabel, entryX + entryW / 2, entryBoxY + entryH / 2 + 0.3);
      ctx.restore();

      // ------------------------------------------------------------
      // Mark price line + white price box
      // ------------------------------------------------------------
      const markY = clamp(yOf(mark), plotT + 1, plotB - 1);
      ctx.save();
      // The reference's live line is neutral white/gray. Only the entry line
      // and the PNL pill carry the profit/loss color.
      ctx.strokeStyle = "rgba(224,230,233,0.74)";
      ctx.lineWidth = 0.75;
      ctx.setLineDash([1.4, 2.4]);
      ctx.beginPath();
      ctx.moveTo(plotL, markY + 0.5);
      ctx.lineTo(plotR, markY + 0.5);
      ctx.stroke();
      ctx.restore();

      const boxH = 31;
      ctx.save();
      ctx.font = '700 10.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      const priceLabelWidth = ctx.measureText(state.formatPrice(mark, decimals)).width;
      ctx.font = '8px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      const timeLabelWidth = ctx.measureText(state.markTime || "00:00").width;
      ctx.restore();
      const boxW = Math.max(58, Math.ceil(Math.max(priceLabelWidth, timeLabelWidth)) + 17);
      const boxX = W - boxW - 2;
      const boxY = clamp(markY - boxH / 2, 1, H - boxH - 1);
      ctx.save();
      ctx.shadowColor = "rgba(0,0,0,0.32)";
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 1;
      ctx.fillStyle = "#f2f4f5";
      roundRect(ctx, boxX, boxY, boxW, boxH, 5);
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.fillStyle = "#1a2023";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.font = '700 10.5px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillText(state.formatPrice(mark, decimals), boxX + 8, boxY + 11.5);
      ctx.fillStyle = "#5b666e";
      ctx.font = '8px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillText(state.markTime || "00:00", boxX + 8, boxY + 23.5);
      ctx.restore();

      // ------------------------------------------------------------
      // Low / high price tags (the small white "11,03" style markers)
      // ------------------------------------------------------------
      let lowIdx = firstOnscreen;
      let highIdx = firstOnscreen;
      for (let i = firstOnscreen; i <= currentIdx; i++) {
        if (data[i].l < data[lowIdx].l) lowIdx = i;
        if (data[i].h > data[highIdx].h) highIdx = i;
      }
      this.drawExtremeTag(ctx, xOf(lowIdx), yOf(data[lowIdx].l), state.formatPrice(data[lowIdx].l, decimals), false, plotL, plotR, plotT, plotB);
      if (highIdx !== lowIdx) {
        this.drawExtremeTag(ctx, xOf(highIdx), yOf(data[highIdx].h), state.formatPrice(data[highIdx].h, decimals), true, plotL, plotR, plotT, plotB);
      }


      // ------------------------------------------------------------
      // Crosshair
      // ------------------------------------------------------------
      if (this.crosshair && this.crosshair.inside) {
        const cx = clamp(this.crosshair.x, plotL, plotR);
        const cy = clamp(this.crosshair.y, plotT, plotB);
        ctx.save();
        ctx.strokeStyle = "rgba(210, 218, 223, 0.4)";
        ctx.lineWidth = 0.7;
        ctx.setLineDash([2, 2.5]);
        ctx.beginPath();
        ctx.moveTo(cx + 0.5, plotT);
        ctx.lineTo(cx + 0.5, plotB);
        ctx.moveTo(plotL, cy + 0.5);
        ctx.lineTo(plotR, cy + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);

        const crossPrice = viewMax - ((cy - plotT) / plotH) * viewSpan;
        const priceLabel = state.formatPrice(crossPrice, decimals);
        ctx.font = '8.4px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        const pw = ctx.measureText(priceLabel).width + 10;
        ctx.fillStyle = "#39434a";
        roundRect(ctx, plotR + 1, cy - 8, pw, 16, 3);
        ctx.fill();
        ctx.fillStyle = "#eef1f3";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(priceLabel, plotR + 6, cy + 0.3);

        // Find the candle closest to the crosshair for a time label.
        const idx = clamp(Math.round(cursor - (plotR - cx) / slot), 0, data.length - 1);
        const timeLabel = state.formatDateTime(data[idx].t);
        ctx.font = '8px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        const tw = ctx.measureText(timeLabel).width + 12;
        const tx = clamp(cx - tw / 2, plotL, plotR - tw);
        ctx.fillStyle = "#39434a";
        roundRect(ctx, tx, plotB + 2, tw, 16, 3);
        ctx.fill();
        ctx.fillStyle = "#eef1f3";
        ctx.textAlign = "center";
        ctx.fillText(timeLabel, tx + tw / 2, plotB + 10.5);
        ctx.restore();
      }
    }

    drawHorizontalMarker(ctx, plotL, plotR, y, color, label, state) {
      if (!Number.isFinite(y)) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.65;
      ctx.lineWidth = 0.7;
      ctx.setLineDash([2, 2.5]);
      ctx.beginPath();
      ctx.moveTo(plotL, y + 0.5);
      ctx.lineTo(plotR, y + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.font = '8px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      const w = ctx.measureText(label).width + 9;
      ctx.fillStyle = color;
      roundRect(ctx, plotL + 2, y - 8, w, 15, 3);
      ctx.fill();
      ctx.fillStyle = "#151b1e";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, plotL + 6, y + 0.2);
      ctx.restore();
    }

    drawExtremeTag(ctx, x, y, label, above, plotL, plotR, plotT, plotB) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (x < plotL || x > plotR || y < plotT || y > plotB) return;
      ctx.save();
      ctx.strokeStyle = "rgba(229, 234, 237, 0.85)";
      ctx.lineWidth = 0.8;
      const tick = above ? 7 : 7;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + tick, y);
      ctx.stroke();
      ctx.font = '8.2px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillStyle = "#d9dfe3";
      ctx.textAlign = "left";
      ctx.textBaseline = above ? "bottom" : "top";
      ctx.fillText(label, x + tick + 2, above ? y - 1 : y + 1);
      ctx.restore();
    }
  }

  window.TradingChart = TradingChart;
  window.TradingChart.interpolatePrice = interpolatePrice;
})();
