import { TRADING_PAIRS, SIGNAL_CHECK_INTERVAL_MS, POSITION_CHECK_INTERVAL_MS } from '../config/constants';
import { runBotOnce } from './botRunner';
import { getCurrentPrice } from './exchange';
import { getPositions, openPosition, closePosition, hasOpenPosition, getOpenPositionsCount, MAX_PARALLEL_POSITIONS } from './positionState';
import { logSignalCheck, logPositionCheck } from './logger';

let signalCheckInterval: NodeJS.Timeout | null = null;
let positionCheckInterval: NodeJS.Timeout | null = null;

async function checkSignals() {
  console.log(`[${new Date().toISOString()}] Starting signal check for ${TRADING_PAIRS.length} pairs...`);

  for (const symbol of TRADING_PAIRS) {
    try {
      const result = await runBotOnce(symbol, '15m');

      if (!result.ready) {
        console.log(`[${new Date().toISOString()}] ${symbol}: Not ready - ${result.reason}`);
        continue;
      }

      const { buy, sell, side, price, takeProfitPrice, stopLossPrice, positionSize, regime } = result;

      if (buy || sell) {
        console.log(`[${new Date().toISOString()}] ${symbol}: Signal detected - ${side.toUpperCase()} @ ${price}, regime: ${regime}`);

        if (hasOpenPosition(symbol)) {
          console.log(`[${new Date().toISOString()}] ${symbol}: Position already open, skipping`);
          continue;
        }

        if (getOpenPositionsCount() >= MAX_PARALLEL_POSITIONS) {
          console.log(`[${new Date().toISOString()}] ${symbol}: Max positions (${MAX_PARALLEL_POSITIONS}) reached, skipping`);
          continue;
        }

        if (takeProfitPrice != null && stopLossPrice != null) {
          const openResult = openPosition({
            symbol,
            side: side as 'long' | 'short',
            entryPrice: price,
            takeProfitPrice,
            stopLossPrice
          });

          if (openResult.ok) {
            console.log(`[${new Date().toISOString()}] ${symbol}: Position opened - ${side} @ ${price}, TP: ${takeProfitPrice}, SL: ${stopLossPrice}`);
          } else {
            console.error(`[${new Date().toISOString()}] ${symbol}: Failed to open position - ${openResult.message}`);
          }
        }
      } else {
        console.log(`[${new Date().toISOString()}] ${symbol}: No signal - regime: ${regime}`);
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ${symbol}: Error during signal check - ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

async function checkPositions() {
  const positions = getPositions();

  if (positions.length === 0) {
    return;
  }

  console.log(`[${new Date().toISOString()}] Checking ${positions.length} open position(s)...`);

  for (const position of positions) {
    try {
      const currentPrice = await getCurrentPrice(position.symbol);

      const hitTakeProfit = position.side === 'long'
        ? currentPrice >= position.takeProfitPrice
        : currentPrice <= position.takeProfitPrice;

      const hitStopLoss = position.side === 'long'
        ? currentPrice <= position.stopLossPrice
        : currentPrice >= position.stopLossPrice;

      logPositionCheck({
        timestamp: new Date().toISOString(),
        positionId: position.id,
        symbol: position.symbol,
        side: position.side,
        entryPrice: position.entryPrice,
        currentPrice,
        takeProfitPrice: position.takeProfitPrice,
        stopLossPrice: position.stopLossPrice,
        hitTakeProfit,
        hitStopLoss,
        action: hitTakeProfit ? 'close_tp' : hitStopLoss ? 'close_sl' : 'hold'
      });

      if (hitTakeProfit) {
        const result = closePosition(position.id, currentPrice, 'take_profit');
        if (result.ok) {
          console.log(`[${new Date().toISOString()}] ${position.symbol}: Position closed at TP - exit: ${currentPrice}, PnL: ${result.lastClosedTrade?.netPnL}`);
        }
      } else if (hitStopLoss) {
        const result = closePosition(position.id, currentPrice, 'stop_loss');
        if (result.ok) {
          console.log(`[${new Date().toISOString()}] ${position.symbol}: Position closed at SL - exit: ${currentPrice}, PnL: ${result.lastClosedTrade?.netPnL}`);
        }
      } else {
        console.log(`[${new Date().toISOString()}] ${position.symbol}: Holding - current: ${currentPrice}, TP: ${position.takeProfitPrice}, SL: ${position.stopLossPrice}`);
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ${position.symbol}: Error checking position - ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}

export function startScheduler() {
  console.log(`[${new Date().toISOString()}] Starting scheduler...`);
  console.log(`[${new Date().toISOString()}] Signal check interval: ${SIGNAL_CHECK_INTERVAL_MS / 1000}s`);
  console.log(`[${new Date().toISOString()}] Position check interval: ${POSITION_CHECK_INTERVAL_MS / 1000}s`);
  console.log(`[${new Date().toISOString()}] Trading pairs: ${TRADING_PAIRS.join(', ')}`);

  checkSignals();
  signalCheckInterval = setInterval(checkSignals, SIGNAL_CHECK_INTERVAL_MS);

  checkPositions();
  positionCheckInterval = setInterval(checkPositions, POSITION_CHECK_INTERVAL_MS);
}

export function stopScheduler() {
  console.log(`[${new Date().toISOString()}] Stopping scheduler...`);

  if (signalCheckInterval) {
    clearInterval(signalCheckInterval);
    signalCheckInterval = null;
  }

  if (positionCheckInterval) {
    clearInterval(positionCheckInterval);
    positionCheckInterval = null;
  }

  console.log(`[${new Date().toISOString()}] Scheduler stopped`);
}
