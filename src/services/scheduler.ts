import { TRADING_PAIRS, SIGNAL_CHECK_INTERVAL_MS, POSITION_CHECK_INTERVAL_MS } from '../config/constants';
import { runBotOnce } from './botRunner';
import { getCurrentPrice } from './exchange';
import { 
  getPositions, 
  openPosition, 
  closePosition, 
  hasOpenPosition, 
  getOpenPositionsCount, 
  MAX_PARALLEL_POSITIONS,
  getBalance,
  getRiskCapital,
  getPositionNotional,
  updatePositionMetadata
} from './positionState';
import { logSignalCheck, logPositionCheck, logError } from './logger';

let signalCheckInterval: NodeJS.Timeout | null = null;
let positionCheckInterval: NodeJS.Timeout | null = null;

async function checkSignals() {
  console.log(`[${new Date().toISOString()}] Starting signal check for ${TRADING_PAIRS.length} pairs...`);

  for (const symbol of TRADING_PAIRS) {
    try {
      const result = await runBotOnce(symbol, '15m');

      if (!result.ready) {
        console.log(`[${new Date().toISOString()}] ${symbol}: Not ready - ${result.reason}`);
        logSignalCheck({
          timestamp: new Date().toISOString(),
          symbol,
          timeframe: '15m',
          side: 'none',
          price: result.price ?? 0,
          regime: result.regime ?? 'unknown',
          takeProfitPrice: null,
          stopLossPrice: null,
          positionSize: null,
          macdCrossUp: false,
          macdCrossDown: false,
          lastRsi: 0,
          lastAtr: 0,
          rsiBull: false,
          rsiBear: false,
          bbUpper: 0,
          bbMiddle: 0,
          bbLower: 0,
          adx: 0,
          adxRising: false,
          ema20: 0,
          ema50: 0,
          ema200: 0,
          bbWidth: 0,
          atrPct: 0,
          signalTriggered: false,
          positionOpened: false
        });
        continue;
      }

      const { buy, sell, side, price, takeProfitPrice, stopLossPrice, positionSize, regime, indicators } = result;
      const signalTriggered = buy || sell;

      if (signalTriggered) {
        console.log(`[${new Date().toISOString()}] ${symbol}: Signal detected - ${side.toUpperCase()} @ ${price}, regime: ${regime}`);

        if (hasOpenPosition(symbol)) {
          console.log(`[${new Date().toISOString()}] ${symbol}: Position already open, skipping`);
          logSignalCheck({
            timestamp: new Date().toISOString(),
            symbol,
            timeframe: '15m',
            side,
            price,
            regime,
            takeProfitPrice,
            stopLossPrice,
            positionSize,
            macdCrossUp: indicators?.macdCrossUp ?? false,
            macdCrossDown: indicators?.macdCrossDown ?? false,
            lastRsi: indicators?.lastRsi ?? 0,
            lastAtr: indicators?.lastAtr ?? 0,
            rsiBull: indicators?.rsiBull ?? false,
            rsiBear: indicators?.rsiBear ?? false,
            bbUpper: indicators?.bbUpper ?? 0,
            bbMiddle: indicators?.bbMiddle ?? 0,
            bbLower: indicators?.bbLower ?? 0,
            adx: indicators?.regimeIndicators?.adx ?? 0,
            adxRising: indicators?.regimeIndicators?.adxRising ?? false,
            ema20: indicators?.regimeIndicators?.ema20 ?? 0,
            ema50: indicators?.regimeIndicators?.ema50 ?? 0,
            ema200: indicators?.regimeIndicators?.ema200 ?? 0,
            bbWidth: indicators?.regimeIndicators?.bbWidth ?? 0,
            atrPct: indicators?.regimeIndicators?.atrPct ?? 0,
            signalTriggered: true,
            positionOpened: false,
            openPositionError: 'position_already_open'
          });
          continue;
        }

        if (getOpenPositionsCount() >= MAX_PARALLEL_POSITIONS) {
          console.log(`[${new Date().toISOString()}] ${symbol}: Max positions (${MAX_PARALLEL_POSITIONS}) reached, skipping`);
          logSignalCheck({
            timestamp: new Date().toISOString(),
            symbol,
            timeframe: '15m',
            side,
            price,
            regime,
            takeProfitPrice,
            stopLossPrice,
            positionSize,
            macdCrossUp: indicators?.macdCrossUp ?? false,
            macdCrossDown: indicators?.macdCrossDown ?? false,
            lastRsi: indicators?.lastRsi ?? 0,
            lastAtr: indicators?.lastAtr ?? 0,
            rsiBull: indicators?.rsiBull ?? false,
            rsiBear: indicators?.rsiBear ?? false,
            bbUpper: indicators?.bbUpper ?? 0,
            bbMiddle: indicators?.bbMiddle ?? 0,
            bbLower: indicators?.bbLower ?? 0,
            adx: indicators?.regimeIndicators?.adx ?? 0,
            adxRising: indicators?.regimeIndicators?.adxRising ?? false,
            ema20: indicators?.regimeIndicators?.ema20 ?? 0,
            ema50: indicators?.regimeIndicators?.ema50 ?? 0,
            ema200: indicators?.regimeIndicators?.ema200 ?? 0,
            bbWidth: indicators?.regimeIndicators?.bbWidth ?? 0,
            atrPct: indicators?.regimeIndicators?.atrPct ?? 0,
            signalTriggered: true,
            positionOpened: false,
            openPositionError: 'max_positions_reached'
          });
          continue;
        }

        if (takeProfitPrice != null && stopLossPrice != null) {
          const riskCapital = getRiskCapital();
          const maxNotionalByPercent = getPositionNotional();
          const stopDistance = Math.abs(price - stopLossPrice);
          const worstCaseFeePerUnit = (price + stopLossPrice) * 0.00075;
          const totalRiskPerUnit = stopDistance + worstCaseFeePerUnit;
          const calculatedQuantity = riskCapital / totalRiskPerUnit;

          const openResult = openPosition({
            symbol,
            side: side as 'long' | 'short',
            entryPrice: price,
            takeProfitPrice,
            stopLossPrice,
            metadata: {
              regime,
              macdCrossUp: indicators?.macdCrossUp ?? false,
              macdCrossDown: indicators?.macdCrossDown ?? false,
              lastRsi: indicators?.lastRsi ?? 0,
              lastAtr: indicators?.lastAtr ?? 0,
              adx: indicators?.regimeIndicators?.adx ?? 0,
              bbWidth: indicators?.regimeIndicators?.bbWidth ?? 0,
              atrPct: indicators?.regimeIndicators?.atrPct ?? 0
            },
            riskCapital,
            maxNotionalByPercent,
            stopDistance,
            totalRiskPerUnit,
            calculatedQuantity
          });

          if (openResult.ok) {
            console.log(`[${new Date().toISOString()}] ${symbol}: Position opened - ${side} @ ${price}, TP: ${takeProfitPrice}, SL: ${stopLossPrice}`);
            logSignalCheck({
              timestamp: new Date().toISOString(),
              symbol,
              timeframe: '15m',
              side,
              price,
              regime,
              takeProfitPrice,
              stopLossPrice,
              positionSize,
              macdCrossUp: indicators?.macdCrossUp ?? false,
              macdCrossDown: indicators?.macdCrossDown ?? false,
              lastRsi: indicators?.lastRsi ?? 0,
              lastAtr: indicators?.lastAtr ?? 0,
              rsiBull: indicators?.rsiBull ?? false,
              rsiBear: indicators?.rsiBear ?? false,
              bbUpper: indicators?.bbUpper ?? 0,
              bbMiddle: indicators?.bbMiddle ?? 0,
              bbLower: indicators?.bbLower ?? 0,
              adx: indicators?.regimeIndicators?.adx ?? 0,
              adxRising: indicators?.regimeIndicators?.adxRising ?? false,
              ema20: indicators?.regimeIndicators?.ema20 ?? 0,
              ema50: indicators?.regimeIndicators?.ema50 ?? 0,
              ema200: indicators?.regimeIndicators?.ema200 ?? 0,
              bbWidth: indicators?.regimeIndicators?.bbWidth ?? 0,
              atrPct: indicators?.regimeIndicators?.atrPct ?? 0,
              signalTriggered: true,
              positionOpened: true
            });
          } else {
            console.error(`[${new Date().toISOString()}] ${symbol}: Failed to open position - ${openResult.message}`);
            logSignalCheck({
              timestamp: new Date().toISOString(),
              symbol,
              timeframe: '15m',
              side,
              price,
              regime,
              takeProfitPrice,
              stopLossPrice,
              positionSize,
              macdCrossUp: indicators?.macdCrossUp ?? false,
              macdCrossDown: indicators?.macdCrossDown ?? false,
              lastRsi: indicators?.lastRsi ?? 0,
              lastAtr: indicators?.lastAtr ?? 0,
              rsiBull: indicators?.rsiBull ?? false,
              rsiBear: indicators?.rsiBear ?? false,
              bbUpper: indicators?.bbUpper ?? 0,
              bbMiddle: indicators?.bbMiddle ?? 0,
              bbLower: indicators?.bbLower ?? 0,
              adx: indicators?.regimeIndicators?.adx ?? 0,
              adxRising: indicators?.regimeIndicators?.adxRising ?? false,
              ema20: indicators?.regimeIndicators?.ema20 ?? 0,
              ema50: indicators?.regimeIndicators?.ema50 ?? 0,
              ema200: indicators?.regimeIndicators?.ema200 ?? 0,
              bbWidth: indicators?.regimeIndicators?.bbWidth ?? 0,
              atrPct: indicators?.regimeIndicators?.atrPct ?? 0,
              signalTriggered: true,
              positionOpened: false,
              openPositionError: openResult.message
            });
          }
        }
      } else {
        console.log(`[${new Date().toISOString()}] ${symbol}: No signal - regime: ${regime}`);
        logSignalCheck({
          timestamp: new Date().toISOString(),
          symbol,
          timeframe: '15m',
          side: 'none',
          price: price ?? 0,
          regime: regime ?? 'unknown',
          takeProfitPrice: null,
          stopLossPrice: null,
          positionSize: null,
          macdCrossUp: indicators?.macdCrossUp ?? false,
          macdCrossDown: indicators?.macdCrossDown ?? false,
          lastRsi: indicators?.lastRsi ?? 0,
          lastAtr: indicators?.lastAtr ?? 0,
          rsiBull: indicators?.rsiBull ?? false,
          rsiBear: indicators?.rsiBear ?? false,
          bbUpper: indicators?.bbUpper ?? 0,
          bbMiddle: indicators?.bbMiddle ?? 0,
          bbLower: indicators?.bbLower ?? 0,
          adx: indicators?.regimeIndicators?.adx ?? 0,
          adxRising: indicators?.regimeIndicators?.adxRising ?? false,
          ema20: indicators?.regimeIndicators?.ema20 ?? 0,
          ema50: indicators?.regimeIndicators?.ema50 ?? 0,
          ema200: indicators?.regimeIndicators?.ema200 ?? 0,
          bbWidth: indicators?.regimeIndicators?.bbWidth ?? 0,
          atrPct: indicators?.regimeIndicators?.atrPct ?? 0,
          signalTriggered: false,
          positionOpened: false
        });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[${new Date().toISOString()}] ${symbol}: Error during signal check - ${errorMsg}`);
      logError({
        timestamp: new Date().toISOString(),
        context: 'signal_check',
        symbol,
        error: errorMsg,
        stack: error instanceof Error ? error.stack : undefined
      });
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

      const unrealizedPnL = position.side === 'long'
        ? (currentPrice - position.entryPrice) * position.quantity
        : (position.entryPrice - currentPrice) * position.quantity;

      const unrealizedPnLPercent = (unrealizedPnL / position.notional) * 100;

      const distanceToTP = position.side === 'long'
        ? position.takeProfitPrice - currentPrice
        : currentPrice - position.takeProfitPrice;

      const distanceToTPPercent = (distanceToTP / currentPrice) * 100;

      const distanceToSL = position.side === 'long'
        ? currentPrice - position.stopLossPrice
        : position.stopLossPrice - currentPrice;

      const distanceToSLPercent = (distanceToSL / currentPrice) * 100;

      const hitTakeProfit = position.side === 'long'
        ? currentPrice >= position.takeProfitPrice
        : currentPrice <= position.takeProfitPrice;

      const hitStopLoss = position.side === 'long'
        ? currentPrice <= position.stopLossPrice
        : currentPrice >= position.stopLossPrice;

      const openedAt = new Date(position.openedAt).getTime();
      const now = new Date().getTime();
      const positionAgeSeconds = Math.floor((now - openedAt) / 1000);

      if (position.metadata) {
        if (position.metadata.maxUnrealizedPnL === undefined || unrealizedPnL > position.metadata.maxUnrealizedPnL) {
          position.metadata.maxUnrealizedPnL = unrealizedPnL;
          position.metadata.maxUnrealizedPnLPercent = unrealizedPnLPercent;
        }
        if (position.metadata.worstUnrealizedPnL === undefined || unrealizedPnL < position.metadata.worstUnrealizedPnL) {
          position.metadata.worstUnrealizedPnL = unrealizedPnL;
          position.metadata.worstUnrealizedPnLPercent = unrealizedPnLPercent;
        }
      }

      logPositionCheck({
        timestamp: new Date().toISOString(),
        positionId: position.id,
        symbol: position.symbol,
        side: position.side,
        entryPrice: position.entryPrice,
        currentPrice,
        takeProfitPrice: position.takeProfitPrice,
        stopLossPrice: position.stopLossPrice,
        unrealizedPnL,
        unrealizedPnLPercent,
        distanceToTP,
        distanceToTPPercent,
        distanceToSL,
        distanceToSLPercent,
        hitTakeProfit,
        hitStopLoss,
        action: hitTakeProfit ? 'close_tp' : hitStopLoss ? 'close_sl' : 'hold',
        positionAgeSeconds
      });

      if (hitTakeProfit) {
        const result = closePosition(position.id, currentPrice, 'take_profit');
        if (result.ok) {
          console.log(`[${new Date().toISOString()}] ${position.symbol}: Position closed at TP - exit: ${currentPrice}, PnL: ${result.lastClosedTrade?.netPnL}`);
        } else {
          console.error(`[${new Date().toISOString()}] ${position.symbol}: Failed to close at TP - ${result.message}`);
          logError({
            timestamp: new Date().toISOString(),
            context: 'close_position',
            symbol: position.symbol,
            positionId: position.id,
            error: result.message
          });
        }
      } else if (hitStopLoss) {
        const result = closePosition(position.id, currentPrice, 'stop_loss');
        if (result.ok) {
          console.log(`[${new Date().toISOString()}] ${position.symbol}: Position closed at SL - exit: ${currentPrice}, PnL: ${result.lastClosedTrade?.netPnL}`);
        } else {
          console.error(`[${new Date().toISOString()}] ${position.symbol}: Failed to close at SL - ${result.message}`);
          logError({
            timestamp: new Date().toISOString(),
            context: 'close_position',
            symbol: position.symbol,
            positionId: position.id,
            error: result.message
          });
        }
      } else {
        console.log(`[${new Date().toISOString()}] ${position.symbol}: Holding - current: ${currentPrice}, TP: ${position.takeProfitPrice}, SL: ${position.stopLossPrice}, unrealized PnL: ${unrealizedPnL.toFixed(2)} (${unrealizedPnLPercent.toFixed(2)}%)`);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[${new Date().toISOString()}] ${position.symbol}: Error checking position - ${errorMsg}`);
      logError({
        timestamp: new Date().toISOString(),
        context: 'position_check',
        symbol: position.symbol,
        positionId: position.id,
        error: errorMsg,
        stack: error instanceof Error ? error.stack : undefined
      });
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
