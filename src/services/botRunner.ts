import { getCandles } from './exchange';
import { analyzeMarket, detectMarketRegime } from './strategy';
import { logSignalCheck } from './logger';

export async function runBotOnce(symbol = 'BTC/USDT', timeframe = '15m') {
  const candles = await getCandles(symbol, timeframe, 250);

  if (candles.length < 200) {
    return { symbol, timeframe, ready: false, reason: 'not_enough_candles' };
  }

  const result = analyzeMarket(candles);
  
  if (result.buy || result.sell) {
    logSignalCheck({
      timestamp: new Date().toISOString(),
      symbol,
      timeframe,
      side: result.side,
      price: result.price,
      regime: result.regime,
      takeProfitPrice: result.takeProfitPrice,
      stopLossPrice: result.stopLossPrice,
      positionSize: result.positionSize,
      macdCrossUp: result.indicators.macdCrossUp ?? false,
      macdCrossDown: result.indicators.macdCrossDown ?? false,
      lastRsi: result.indicators.lastRsi ?? 0,
      lastAtr: result.indicators.lastAtr ?? 0,
      rsiBull: result.indicators.rsiBull ?? false,
      rsiBear: result.indicators.rsiBear ?? false,
      bbUpper: result.indicators.bbUpper ?? 0,
      bbMiddle: result.indicators.bbMiddle ?? 0,
      bbLower: result.indicators.bbLower ?? 0,
      adx: result.indicators.regimeIndicators?.adx ?? 0,
      adxRising: result.indicators.regimeIndicators?.adxRising ?? false,
      ema20: result.indicators.regimeIndicators?.ema20 ?? 0,
      ema50: result.indicators.regimeIndicators?.ema50 ?? 0,
      ema200: result.indicators.regimeIndicators?.ema200 ?? 0,
      bbWidth: result.indicators.regimeIndicators?.bbWidth ?? 0,
      atrPct: result.indicators.regimeIndicators?.atrPct ?? 0,
      signalTriggered: true,
      positionOpened: false
    });
  }

  return { symbol, timeframe, ready: true, ...result };
}

export async function getMarketRegimeOnce(symbol = 'BTC/USDT', timeframe = '15m') {
  const candles = await getCandles(symbol, timeframe, 250);

  if (candles.length < 200) {
    return { symbol, timeframe, ready: false, reason: 'not_enough_candles' };
  }

  return { symbol, timeframe, ...detectMarketRegime(candles) };
}
