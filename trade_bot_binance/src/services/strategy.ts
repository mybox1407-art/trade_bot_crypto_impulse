import { MACD, RSI, ATR } from 'technicalindicators';

const FEE_PER_SIDE = 0.00075;
const ROUND_TRIP_FEE = FEE_PER_SIDE * 2;
const TP_MULTIPLIER = 2.5;
const SL_MULTIPLIER = 1.5;

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

  if (macd.length < 2 || rsi.length < 1 || atr.length < 1) {
    return {
      price: closes[closes.length - 1],
      buy: false,
      takeProfitPrice: null,
      stopLossPrice: null,
      indicators: { ready: false }
    };
  }

  const lastClose = closes[closes.length - 1];
  const lastMacd = macd[macd.length - 1];
  const prevMacd = macd[macd.length - 2];
  const lastRsi = rsi[rsi.length - 1];
  const lastAtr = atr[atr.length - 1];

  const macdCrossUp = prevMacd.MACD! < prevMacd.signal! && lastMacd.MACD! > lastMacd.signal!;
  const rsiOk = lastRsi > 40 && lastRsi < 65;
  const buy = macdCrossUp && rsiOk;

  const takeProfitPrice = buy ? lastClose + lastAtr * TP_MULTIPLIER : null;
  const stopLossPrice = buy ? lastClose - lastAtr * SL_MULTIPLIER : null;

  return {
    price: lastClose,
    buy,
    takeProfitPrice,
    stopLossPrice,
    indicators: { macdCrossUp, rsiOk, lastRsi, lastAtr, ready: true }
  };
}
