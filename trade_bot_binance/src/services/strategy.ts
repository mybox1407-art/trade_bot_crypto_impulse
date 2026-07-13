import { EMA, MACD, RSI, ATR } from 'technicalindicators';

const FEE_PER_SIDE = 0.00075;
const ROUND_TRIP_FEE = FEE_PER_SIDE * 2;

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function analyzeMarket(candles: Candle[]) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const ema200 = EMA.calculate({ period: 200, values: closes });
  const macd = MACD.calculate({
    values: closes,
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false
  });
  const rsi = RSI.calculate({ period: 14, values: closes });
  const atr = ATR.calculate({ period: 14, high: highs, low: lows, close: closes });

  if (ema200.length < 1 || macd.length < 2 || rsi.length < 1 || atr.length < 1) {
    return {
      price: closes[closes.length - 1],
      buy: false,
      takeProfitPrice: null,
      stopLossPrice: null,
      indicators: { ready: false }
    };
  }

  const lastClose = closes[closes.length - 1];
  const lastEma200 = ema200[ema200.length - 1];
  const lastMacd = macd[macd.length - 1];
  const prevMacd = macd[macd.length - 2];
  const lastRsi = rsi[rsi.length - 1];
  const lastAtr = atr[atr.length - 1];

  const trendUp = lastClose > lastEma200;
  const macdCrossUp = prevMacd.MACD! < prevMacd.signal! && lastMacd.MACD! > lastMacd.signal!;
  const rsiOk = lastRsi > 40 && lastRsi < 65;
  const buy = trendUp && macdCrossUp && rsiOk;

  const takeProfitPct = 0.045 + ROUND_TRIP_FEE;
  const stopLossPct = Math.min((1.5 * lastAtr) / lastClose, 0.02);

  return {
    price: lastClose,
    buy,
    takeProfitPrice: buy ? lastClose * (1 + takeProfitPct) : null,
    stopLossPrice: buy ? lastClose * (1 - stopLossPct) : null,
    indicators: { trendUp, macdCrossUp, rsiOk, lastRsi, lastAtr, ready: true }
  };
}
