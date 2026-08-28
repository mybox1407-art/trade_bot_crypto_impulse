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
import { notifyStartup, notifyError } from './telegram';

let signalCheckInterval: NodeJS.Timeout | null = null;
let positionCheckInterval: NodeJS.Timeout | null = null;

async function checkSignals() {
  console.log(`\n[${new Date().toISOString()}] ========== SIGNAL CHECK START ==========`);
  console.log(`[${new Date().toISOString()}] Pairs: ${TRADING_PAIRS.length}, Open positions: ${getOpenPositionsCount()}/${MAX_PARALLEL_POSITIONS}`);

  for (const symbol of TRADING_PAIRS) {
    try {
      const result = await runBotOnce(symbol, '15m');

      if (!result.ready) {
        console.log(`[${new Date().toISOString()}] ❌ ${symbol}: NOT READY - ${result.reason}`);
        continue;
      }

      const { buy, sell, side, price, takeProfitPrice, stopLossPrice, positionSize, regime, indicators } = result;
      
      console.log(`\n[${new Date().toISOString()}] 🔍 ${symbol} ANALYSIS:`);
      console.log(`   Price: ${price.toFixed(4)}`);
      console.log(`   Regime: ${regime}`);
      console.log(`   MACD Cross Up: ${indicators?.macdCrossUp}, Down: ${indicators?.macdCrossDown}`);
      console.log(`   RSI: ${indicators?.lastRsi?.toFixed(2)}`);
      console.log(`   ATR: ${indicators?.lastAtr?.toFixed(4)}`);
      console.log(`   ADX: ${indicators?.regimeIndicators?.adx?.toFixed(2)}`);
      console.log(`   BB Width: ${indicators?.regimeIndicators?.bbWidth?.toFixed(4)}`);
      console.log(`   Signal: ${buy ? 'BUY' : sell ? 'SELL' : 'NONE'}`);

      if (buy || sell) {
        console.log(`\n[${new Date().toISOString()}] 🚨 ${symbol}: SIGNAL DETECTED!`);
        console.log(`   Side: ${side.toUpperCase()}`);
        console.log(`   Entry: ${price.toFixed(4)}`);
        console.log(`   TP: ${takeProfitPrice?.toFixed(4)}, SL: ${stopLossPrice?.toFixed(4)}`);
        console.log(`   Position Size: ${positionSize?.toFixed(4)}`);

        if (hasOpenPosition(symbol)) {
          console.log(`[${new Date().toISOString()}] ⛔ ${symbol}: SKIPPED - position already open`);
          continue;
        }

        if (getOpenPositionsCount() >= MAX_PARALLEL_POSITIONS) {
          console.log(`[${new Date().toISOString()}] ⛔ ${symbol}: SKIPPED - max positions (${getOpenPositionsCount()}/${MAX_PARALLEL_POSITIONS})`);
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
            console.log(`[${new Date().toISOString()}] ✅ ${symbol}: POSITION OPENED!`);
            console.log(`   Position ID: ${openResult.position?.id}`);
            console.log(`   Quantity: ${openResult.position?.quantity.toFixed(4)}`);
            console.log(`   Notional: $${openResult.position?.notional.toFixed(2)}`);
            console.log(`   Balance: $${openResult.balance.toFixed(2)}`);
          } else {
            console.log(`[${new Date().toISOString()}] ❌ ${symbol}: FAILED TO OPEN - ${openResult.message}`);
          }
        }
      } else {
        console.log(`[${new Date().toISOString()}] ⏭ ${symbol}: NO SIGNAL`);
        
        // Почему нет сигнала?
        if (regime === 'high_volatility') {
          console.log(`   Reason: HIGH_VOLATILITY regime (ATR%: ${indicators?.regimeIndicators?.atrPct?.toFixed(4)}, BB Width: ${indicators?.regimeIndicators?.bbWidth?.toFixed(4)})`);
        } else if (regime === 'range') {
          console.log(`   Reason: RANGE regime (ADX: ${indicators?.regimeIndicators?.adx?.toFixed(2)}, BB Width: ${indicators?.regimeIndicators?.bbWidth?.toFixed(4)})`);
        } else if (regime === 'trend_up' || regime === 'trend_down') {
          const reasons = [];
          if (!indicators?.macdCrossUp && !indicators?.macdCrossDown) {
            reasons.push('No MACD cross');
          }
          if (regime === 'trend_up' && !indicators?.rsiBull) {
            reasons.push(`RSI not bull (${indicators?.lastRsi?.toFixed(2)})`);
          }
          if (regime === 'trend_down' && !indicators?.rsiBear) {
            reasons.push(`RSI not bear (${indicators?.lastRsi?.toFixed(2)})`);
          }
          if (regime === 'trend_up' && price <= (indicators?.regimeIndicators?.ema200 ?? 0)) {
            reasons.push('Price below EMA200');
          }
          if (regime === 'trend_down' && price >= (indicators?.regimeIndicators?.ema200 ?? 0)) {
            reasons.push('Price above EMA200');
          }
          console.log(`   Reason: ${reasons.join(', ') || 'Other conditions not met'}`);
        } else if (regime === 'breakout_watch') {
          console.log(`   Reason: BREAKOUT_WATCH - waiting for BB breakout`);
          console.log(`   BB Upper: ${indicators?.bbUpper?.toFixed(4)}, BB Lower: ${indicators?.bbLower?.toFixed(4)}`);
          console.log(`   Price vs BB: ${price > (indicators?.bbUpper ?? 0) ? 'ABOVE' : price < (indicators?.bbLower ?? 0) ? 'BELOW' : 'INSIDE'}`);
        } else {
          console.log(`   Reason: UNKNOWN regime or indicators not ready`);
        }
      }

      logSignalCheck({
        timestamp: new Date().toISOString(),
        symbol,
        timeframe: '15m',
        side: buy || sell ? side : 'none',
        price: price ?? 0,
        regime: regime ?? 'unknown',
        takeProfitPrice: takeProfitPrice ?? null,
        stopLossPrice: stopLossPrice ?? null,
        positionSize: positionSize ?? null,
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
        signalTriggered: buy || sell,
        positionOpened: false
      });

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[${new Date().toISOString()}] 💥 ${symbol}: ERROR - ${errorMsg}`);
      logError({
        timestamp: new Date().toISOString(),
        context: 'signal_check',
        symbol,
        error: String(errorMsg),
        stack: undefined
      });
      notifyError({
        context: 'signal_check',
        symbol,
        error: String(errorMsg)
      });
    }
  }

  console.log(`[${new Date().toISOString()}] ========== SIGNAL CHECK END ==========\n`);
}

async function checkPositions() {
  const positions = getPositions();

  if (positions.length === 0) {
    return;
  }

  console.log(`\n[${new Date().toISOString()}] ========== POSITION CHECK START ==========`);
  console.log(`[${new Date().toISOString()}] Checking ${positions.length} position(s)...`);

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

      console.log(`\n[${new Date().toISOString()}] 📊 ${position.symbol} (${position.side.toUpperCase()}):`);
      console.log(`   Entry: ${position.entryPrice.toFixed(4)}, Current: ${currentPrice.toFixed(4)}`);
      console.log(`   TP: ${position.takeProfitPrice.toFixed(4)} (${distanceToTPPercent.toFixed(2)}% away)`);
      console.log(`   SL: ${position.stopLossPrice.toFixed(4)} (${distanceToSLPercent.toFixed(2)}% away)`);
      console.log(`   Unrealized PnL: $${unrealizedPnL.toFixed(2)} (${unrealizedPnLPercent.toFixed(2)}%)`);
      console.log(`   Age: ${Math.floor(positionAgeSeconds / 60)}m ${positionAgeSeconds % 60}s`);

      if (hitTakeProfit) {
        console.log(`[${new Date().toISOString()}] 🎯 ${position.symbol}: HIT TAKE PROFIT!`);
        const result = closePosition(position.id, currentPrice, 'take_profit');
        if (result.ok) {
          console.log(`[${new Date().toISOString()}] ✅ ${position.symbol}: CLOSED AT TP`);
          console.log(`   Exit: ${currentPrice.toFixed(4)}`);
          console.log(`   Net PnL: $${result.lastClosedTrade?.netPnL.toFixed(2)} (${((result.lastClosedTrade?.netPnL || 0) / position.notional * 100).toFixed(2)}%)`);
          console.log(`   Balance: $${result.balance.toFixed(2)}`);
        } else {
          console.error(`[${new Date().toISOString()}] ❌ ${position.symbol}: FAILED TO CLOSE - ${result.message}`);
          logError({
            timestamp: new Date().toISOString(),
            context: 'close_position',
            symbol: position.symbol,
            positionId: position.id,
            error: String(result.message),
            stack: undefined
          });
          notifyError({
            context: 'close_position',
            symbol: position.symbol,
            error: String(result.message)
          });
        }
      } else if (hitStopLoss) {
        console.log(`[${new Date().toISOString()}] 🛑 ${position.symbol}: HIT STOP LOSS!`);
        const result = closePosition(position.id, currentPrice, 'stop_loss');
        if (result.ok) {
          console.log(`[${new Date().toISOString()}] ✅ ${position.symbol}: CLOSED AT SL`);
          console.log(`   Exit: ${currentPrice.toFixed(4)}`);
          console.log(`   Net PnL: $${result.lastClosedTrade?.netPnL.toFixed(2)}`);
          console.log(`   Balance: $${result.balance.toFixed(2)}`);
        } else {
          console.error(`[${new Date().toISOString()}] ❌ ${position.symbol}: FAILED TO CLOSE - ${result.message}`);
          logError({
            timestamp: new Date().toISOString(),
            context: 'close_position',
            symbol: position.symbol,
            positionId: position.id,
            error: String(result.message),
            stack: undefined
          });
          notifyError({
            context: 'close_position',
            symbol: position.symbol,
            error: String(result.message)
          });
        }
      } else {
        console.log(`[${new Date().toISOString()}] ⏳ ${position.symbol}: HOLDING`);
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

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[${new Date().toISOString()}] 💥 ${position.symbol}: ERROR - ${errorMsg}`);
      logError({
        timestamp: new Date().toISOString(),
        context: 'position_check',
        symbol: position.symbol,
        positionId: position.id,
        error: String(errorMsg),
        stack: undefined
      });
      notifyError({
        context: 'position_check',
        symbol: position.symbol,
        error: String(errorMsg)
      });
    }
  }

  console.log(`[${new Date().toISOString()}] ========== POSITION CHECK END ==========\n`);
}

export function startScheduler() {
  console.log(`\n[${new Date().toISOString()}] 🚀 TRADING BOT STARTING...`);
  console.log(`[${new Date().toISOString()}] Port: ${Number(process.env.PORT) || 3002}`);
  console.log(`[${new Date().toISOString()}] Signal check interval: ${SIGNAL_CHECK_INTERVAL_MS / 1000}s`);
  console.log(`[${new Date().toISOString()}] Position check interval: ${POSITION_CHECK_INTERVAL_MS / 1000}s`);
  console.log(`[${new Date().toISOString()}] Trading pairs: ${[...TRADING_PAIRS].join(', ')}`);
  console.log(`[${new Date().toISOString()}] Max positions: ${MAX_PARALLEL_POSITIONS}\n`);

  notifyStartup({
    port: Number(process.env.PORT) || 3002,
    tradingPairs: [...TRADING_PAIRS],
    signalInterval: SIGNAL_CHECK_INTERVAL_MS / 1000,
    positionInterval: POSITION_CHECK_INTERVAL_MS / 1000
  });

  checkSignals();
  signalCheckInterval = setInterval(checkSignals, SIGNAL_CHECK_INTERVAL_MS);

  checkPositions();
  positionCheckInterval = setInterval(checkPositions, POSITION_CHECK_INTERVAL_MS);
}

export function stopScheduler() {
  console.log(`\n[${new Date().toISOString()}] 🛑 Stopping scheduler...`);

  if (signalCheckInterval) {
    clearInterval(signalCheckInterval);
    signalCheckInterval = null;
  }

  if (positionCheckInterval) {
    clearInterval(positionCheckInterval);
    positionCheckInterval = null;
  }

  console.log(`[${new Date().toISOString()}] Scheduler stopped\n`);
}
