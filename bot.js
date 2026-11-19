"use strict";

let exchange;

const SYMBOL = process.env.SYMBOL || "XAU/USDT:USDT";
const TIMEFRAME = "30m";
const ORDER_QTY = Number(process.env.ORDER_QTY || "0.01");
const TRADE_DIR = process.env.TRADE_DIR || "Both";
const EMA_FAST = 9;
const EMA_SLOW = 21;
const RSI_LEN = 14;
const MIN_EMA_GAP = 5.0;
const SLOPE_BARS = 4;
const MIN_SLOPE_MOVE = 2.5;
const SL_BUFFER = 6.0;
const RR_RATIO = 3.7;
const USE_SESSION = true;
if (!["Both", "Long Only", "Short Only"].includes(TRADE_DIR)) {
  console.error('TRADE_DIR must be "Both", "Long Only", or "Short Only".');
  process.exit(1);
}

const apiKey = process.env.BINANCE_DEMO_API_KEY;
const secret = process.env.BINANCE_DEMO_SECRET_KEY;
if (!apiKey || !secret) {
  console.error("Set BINANCE_DEMO_API_KEY and BINANCE_DEMO_SECRET_KEY.");
  process.exit(1);
}
if (!Number.isFinite(ORDER_QTY) || ORDER_QTY <= 0) {
  console.error("ORDER_QTY must be a positive number.");
  process.exit(1);
}

function ema(values, length) {
  const out = Array(values.length).fill(null);
  if (values.length < length) return out;
  const alpha = 2 / (length + 1);
  let previous = values.slice(0, length).reduce((sum, value) => sum + Number(value), 0) / length;
  out[length - 1] = previous;
  for (let i = length; i < values.length; i += 1) {
    previous = alpha * Number(values[i]) + (1 - alpha) * previous;
    out[i] = previous;
  }
  return out;
}

function rsi(values, length) {
  const out = Array(values.length).fill(null);
  const alpha = 1 / length;
  const decay = 1 - alpha;
  let gainNumerator = 0;
  let lossNumerator = 0;
  let totalWeight = 0;
  let validChanges = 0;
  for (let i = 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    gainNumerator = Math.max(change, 0) + decay * gainNumerator;
    lossNumerator = Math.max(-change, 0) + decay * lossNumerator;
    totalWeight = 1 + decay * totalWeight;
    validChanges += 1;
    if (validChanges >= length) {
      const avgGain = gainNumerator / totalWeight;
      const avgLoss = lossNumerator / totalWeight;
      out[i] = avgLoss === 0 ? 100 : (100 * avgGain) / (avgGain + avgLoss);
    }
  }
  return out;
}

function dailyVwap(candles) {
  const out = Array(candles.length).fill(null);
  let currentDay = null;
  let priceVolume = 0;
  let volume = 0;
  candles.forEach((candle, i) => {
    const day = new Date(candle[0]).toISOString().slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      priceVolume = 0;
      volume = 0;
    }
    const typical = (candle[2] + candle[3] + candle[4]) / 3;
    priceVolume += typical * candle[5];
    volume += candle[5];
    if (volume !== 0) out[i] = priceVolume / volume;
  });
  return out;
}

function inActiveSession() {
  if (!USE_SESSION) return true;
  const hour = new Date().getUTCHours();
  return hour >= 7 && hour < 20;
}

function getSignals(candles) {
  const closes = candles.map((c) => c[4]);
  const emaFast = ema(closes, EMA_FAST);
  const emaSlow = ema(closes, EMA_SLOW);
  const rsiValues = rsi(closes, RSI_LEN);
  const vwaps = dailyVwap(candles);
  const i = candles.length - 2; // last fully closed candle
  const prev = candles[i - 1];
  const curr = candles[i];
  const pastSlow = emaSlow[i - SLOPE_BARS];
  if (!curr || !prev || [emaFast[i], emaSlow[i], rsiValues[i], vwaps[i], pastSlow].some((v) => v == null)) {
    throw new Error("Not enough valid closed candles to calculate all indicators.");
  }

  const [timestamp, open, high, low, close] = curr;
  const [, , prevHigh, prevLow] = prev;
  const gap = Math.abs(emaFast[i] - emaSlow[i]);
  const slopeUp = emaSlow[i] - pastSlow >= MIN_SLOPE_MOVE;
  const slopeDown = pastSlow - emaSlow[i] >= MIN_SLOPE_MOVE;
  const supportTouched = low <= emaFast[i] || low <= emaSlow[i] || prevLow <= emaFast[i - 1] || prevLow <= emaSlow[i - 1];
  const resistanceTouched = high >= emaFast[i] || high >= emaSlow[i] || prevHigh >= emaFast[i - 1] || prevHigh >= emaSlow[i - 1];
  const allowLong = ["Both", "Long Only"].includes(TRADE_DIR) && slopeUp;
  const allowShort = ["Both", "Short Only"].includes(TRADE_DIR) && slopeDown;
  const longSignal = allowLong && gap >= MIN_EMA_GAP && close > vwaps[i] && emaFast[i] > emaSlow[i] &&
    rsiValues[i] > 55 && supportTouched && close > open && close > emaFast[i];
  const shortSignal = allowShort && gap >= MIN_EMA_GAP && close < vwaps[i] && emaFast[i] < emaSlow[i] &&
    rsiValues[i] < 45 && resistanceTouched && close < open && close < emaFast[i];

  return {
    candle: { timestamp, open, high, low, close },
    previous: { high: prevHigh, low: prevLow },
    rsi: rsiValues[i],
    longSignal,
    shortSignal,
  };
}

async function hasOpenPosition() {
  const positions = await exchange.fetchPositions([SYMBOL]);
  return positions.some((position) => Math.abs(Number(position.contracts || 0)) > 0);
}

async function placeTrade(side, entryPrice, stopPrice, targetPrice) {
  const amount = Number(exchange.amountToPrecision(SYMBOL, ORDER_QTY));
  const stop = Number(exchange.priceToPrecision(SYMBOL, stopPrice));
  const target = Number(exchange.priceToPrecision(SYMBOL, targetPrice));
  const closeSide = side === "buy" ? "sell" : "buy";
  console.log(`[${new Date().toISOString()}] DEMO ${side.toUpperCase()} amount=${amount} signal=${entryPrice} SL=${stop} TP=${target}`);
  await exchange.cancelAllOrders(SYMBOL);
  await exchange.createMarketOrder(SYMBOL, side, amount);
  try {
    await exchange.createOrder(SYMBOL, "STOP_MARKET", closeSide, amount, undefined, { stopPrice: stop, reduceOnly: true });
    await exchange.createOrder(SYMBOL, "TAKE_PROFIT_MARKET", closeSide, amount, undefined, { stopPrice: target, reduceOnly: true });
  } catch (error) {
    console.error("FAILED to place a protective exit order. Check the Binance demo position and orders immediately.", error);
    throw error;
  }
}

async function main() {
  const ccxt = (await import("ccxt")).default;
  exchange = new ccxt.binance({
    apiKey,
    secret,
    enableRateLimit: true,
    options: { defaultType: "future" },
  });
  exchange.enableDemoTrading(true);
  await exchange.loadMarkets();
  if (!exchange.markets[SYMBOL]) throw new Error(`${SYMBOL} is not available in Binance Futures Demo markets.`);
  console.log(`Starting Binance Futures DEMO bot: ${SYMBOL} ${TIMEFRAME}, qty=${ORDER_QTY}`);
  let lastCheckedCandle = null;
  let stopping = false;
  process.once("SIGTERM", () => { stopping = true; });
  process.once("SIGINT", () => { stopping = true; });

  while (!stopping) {
    try {
      if (inActiveSession()) {
        const candles = await exchange.fetchOHLCV(SYMBOL, TIMEFRAME, undefined, 100);
        if (candles.length < 30) throw new Error("Not enough candles to calculate indicators.");
        const signal = getSignals(candles);
        const candleTime = signal.candle.timestamp;
        if (candleTime !== lastCheckedCandle) {
          lastCheckedCandle = candleTime;
          console.log(`Closed candle ${new Date(candleTime).toISOString()} close=${signal.candle.close} RSI=${signal.rsi.toFixed(1)}`);
          if (!(await hasOpenPosition())) {
            if (signal.longSignal) {
              const stop = Math.min(signal.candle.low, signal.previous.low) - SL_BUFFER;
              const risk = signal.candle.close - stop;
              if (risk > 0) await placeTrade("buy", signal.candle.close, stop, signal.candle.close + risk * RR_RATIO);
            } else if (signal.shortSignal) {
              const stop = Math.max(signal.candle.high, signal.previous.high) + SL_BUFFER;
              const risk = stop - signal.candle.close;
              if (risk > 0) await placeTrade("sell", signal.candle.close, stop, signal.candle.close - risk * RR_RATIO);
            }
          }
        }
      }
    } catch (error) {
      console.error("Bot error:", error?.stack || error);
    }
    await new Promise((resolve) => setTimeout(resolve, 20_000));
  }
  console.log("Bot stopped.");
}

main().catch((error) => {
  console.error("Fatal bot error:", error?.stack || error);
  process.exitCode = 1;
});
