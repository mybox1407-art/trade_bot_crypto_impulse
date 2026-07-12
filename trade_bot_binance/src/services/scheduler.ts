import cron from 'node-cron';
import { getCandles, getCurrentPrice } from './exchange';
import { analyzeMarket } from './strategy';
import { getPosition, openPosition, closePosition } from './positionState';
import { logSignalCheck, logTrade } from './logger';

const SYMBOL = 'BTC/USDT';
const ENTRY_TIMEFRAME = '15m';

export function startScheduler() {
  console.log('[SCHEDULER] Starting scheduler...');

  cron.schedule('*/15 * * * *', async () => {
    console.log('[ENTRY CHECK] Triggered at', new Date().toISOString());
    try {
      const candles = await getCandles(SYMBOL, ENTRY_TIMEFRAME, 250);
      console.log('[ENTRY CHECK] Candles fetched:', candles.length);

      if (candles.length < 200) {
        console.log('[ENTRY CHECK] Not enough candles, skipping.');
        return;
      }

      const result = analyzeMarket(candles);
      const positionOpen = !!getPosition();

      console.log('[ENTRY CHECK] Result:', result.buy, result.price);

      logSignalCheck({
        time: new Date().toISOString(),
        symbol: SYMBOL,
        price: result.price,
        buy: result.buy,
        trendUp: result.indicators.trendUp,
        macdCrossUp: result.indicators.macdCrossUp,
        rsiOk: result.indicators.rsiOk,
        lastRsi: result.indicators.lastRsi.toFixed(2),
        lastAtr: result.indicators.lastAtr.toFixed(2),
        positionAlreadyOpen: positionOpen,
        actionTaken: !positionOpen && result.buy ? 'OPEN' : 'SKIP'
      });

      console.log('[ENTRY CHECK] Logged to signal_log.csv');

      if (positionOpen || !result.buy || !result.takeProfitPrice || !result.stopLossPrice) return;

      openPosition({
        symbol: SYMBOL,
        entryPrice: result.price,
        takeProfitPrice: result.takeProfitPrice,
        stopLossPrice: result.stopLossPrice,
        openedAt: new Date().toISOString()
      });

      logTrade({
        event: 'OPEN',
        symbol: SYMBOL,
        entryPrice: result.price,
        takeProfitPrice: result.takeProfitPrice,
        stopLossPrice: result.stopLossPrice,
        time: new Date().toISOString()
      });
    } catch (err) {
      console.error('[ENTRY CHECK] ERROR:', err);
    }
  });

  cron.schedule('*/15 * * * * *', async () => {
    try {
      const position = getPosition();
      if (!position) return;

      const price = await getCurrentPrice(position.symbol);
      console.log('[MONITOR] price:', price);

      if (price >= position.takeProfitPrice) {
        logTrade({
          event: 'CLOSE_TP',
          symbol: position.symbol,
          entryPrice: position.entryPrice,
          exitPrice: price,
          pnlPct: ((price - position.entryPrice) / position.entryPrice * 100).toFixed(2),
          openedAt: position.openedAt,
          closedAt: new Date().toISOString()
        });
        closePosition();
      } else if (price <= position.stopLossPrice) {
        logTrade({
          event: 'CLOSE_SL',
          symbol: position.symbol,
          entryPrice: position.entryPrice,
          exitPrice: price,
          pnlPct: ((price - position.entryPrice) / position.entryPrice * 100).toFixed(2),
          openedAt: position.openedAt,
          closedAt: new Date().toISOString()
        });
        closePosition();
      }
    } catch (err) {
      console.error('[MONITOR] ERROR:', err);
    }
  });

  console.log('[SCHEDULER] Cron jobs registered.');
}
