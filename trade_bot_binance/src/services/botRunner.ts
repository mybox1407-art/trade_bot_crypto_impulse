import { getCandles } from './exchange';
import { analyzeMarket } from './strategy';

export async function runBotOnce() {
  const symbol = 'BTC/USDT';
  const timeframe = '15m';
  const candles = await getCandles(symbol, timeframe, 250);

  if (candles.length < 200) {
    return { symbol, timeframe, ready: false };
  }

  const result = analyzeMarket(candles);

  return {
    symbol,
    timeframe,
    ...result
  };
}
