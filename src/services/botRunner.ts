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
      takeProfitPrice: result.takeProfitPrice ?? '',
      stopLossPrice: result.stopLossPrice ?? '',
      positionSize: result.positionSize ?? '',
      macdCrossUp: result.indicators.macdCrossUp,
      macdCrossDown: result.indicators.macdCrossDown,
      lastRsi: result.indicators.lastRsi,
      lastAtr: result.indicators.lastAtr,
      rsiBull: result.indicators.rsiBull,
      rsiBear: result.indicators.rsiBear,
      bbUpper: result.indicators.bbUpper,
      bbMiddle: result.indicators.bbMiddle,
      bbLower: result.indicators.bbLower,
      adx: result.indicators.regimeIndicators?.adx ?? '',
      adxRising: result.indicators.regimeIndicators?.adxRising ?? '',
      ema20: result.indicators.regimeIndicators?.ema20 ?? '',
      ema50: result.indicators.regimeIndicators?.ema50 ?? '',
      ema200: result.indicators.regimeIndicators?.ema200 ?? '',
      bbWidth: result.indicators.regimeIndicators?.bbWidth ?? '',
      atrPct: result.indicators.regimeIndicators?.atrPct ?? ''
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
