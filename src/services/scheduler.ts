import {
  TRADING_PAIRS,
  SIGNAL_CHECK_INTERVAL_MS,
  POSITION_CHECK_INTERVAL_MS
} from '../config/constants';
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
  getAvailableBalance,
  getReservedCapital,
  getRiskCapital,
  getPositionNotional,
  updatePositionMetadata
} from './positionState';
import { TRADE_FEE_RATE } from './strategy';
import { logSignalCheck, logPositionCheck, logError } from './logger';
import { notifyStartup, notifyError } from './telegram';
import axios from 'axios';

type SignalResult = {
  symbol: string;
  status:
    | 'signal'
    | 'no_signal'
    | 'position_open'
    | 'max_positions'
    | 'not_ready'
    | 'error';
  regime: string;
  hasSignal: boolean;
  side?: 'long' | 'short' | 'none';
  price?: number;
  reason: string;
};

let signalCheckInterval: NodeJS.Timeout | null = null;
let positionCheckInterval: NodeJS.Timeout | null = null;

let signalCheckRunning = false;
let positionCheckRunning = false;

function formatPrice(price: number) {
  return Number.isFinite(price) ? price.toFixed(4) : 'n/a';
}

function formatOpenPositionsForTelegram() {
  const positions = getPositions();

  if (positions.length === 0) {
    return 'No open positions';
  }

  return positions
    .map(position => {
      const sideEmoji = position.side === 'long' ? '🟢' : '🔴';

      return [
        `${sideEmoji} ${position.symbol}: ${position.side.toUpperCase()}`,
        `Entry ${formatPrice(position.entryPrice)}`,
        `TP ${formatPrice(position.takeProfitPrice)}`,
        `SL ${formatPrice(position.stopLossPrice)}`,
        `Notional $${position.notional.toFixed(2)}`
      ].join(' | ');
    })
    .join('\n');
}

async function sendTelegramSummary(signalResults: SignalResult[]) {
  const activeResults = signalResults.filter(
    result =>
      result.status === 'signal' ||
      result.status === 'no_signal' ||
      result.status === 'not_ready' ||
      result.status === 'error'
  );

  const signalsCount = signalResults.filter(
    result => result.status === 'signal'
  ).length;

  const noSignalCount = signalResults.filter(
    result =>
      result.status === 'no_signal' ||
      result.status === 'not_ready'
  ).length;

  const openPositionsCount = getOpenPositionsCount();

  const errorCount = signalResults.filter(
    result => result.status === 'error'
  ).length;

  const signalText =
    activeResults.length > 0
      ? activeResults
          .map(result => {
            if (result.status === 'error') {
              return `❌ ${result.symbol}: ERROR | ${result.reason}`;
            }

            if (result.status === 'not_ready') {
              return `⚠️ ${result.symbol}: NOT READY | ${result.reason}`;
            }

            if (result.status === 'signal') {
              const emoji = result.side === 'long' ? '🟢' : '🔴';
              const side = result.side?.toUpperCase() ?? 'SIGNAL';
              const price =
                result.price != null
                  ? ` @ ${formatPrice(result.price)}`
                  : '';

              return `${emoji} ${result.symbol}: ${result.regime} | ${side}${price} | ${result.reason}`;
            }

            return `⏳ ${result.symbol}: ${result.regime} | No signal | ${result.reason}`;
          })
          .join('\n')
      : 'No free symbols to analyze';

  const summaryMessage = `📊 Signal Check Summary

📌 Open positions: ${openPositionsCount}/${MAX_PARALLEL_POSITIONS}
${formatOpenPositionsForTelegram()}

💼 Equity: $${getBalance().toFixed(2)}
🔒 Reserved: $${getReservedCapital().toFixed(2)}
💵 Available: $${getAvailableBalance().toFixed(2)}

🔎 Signal scan
${signalText}

Signals: ${signalsCount} | No signals: ${noSignalCount} | Open: ${openPositionsCount}/${MAX_PARALLEL_POSITIONS} | Errors: ${errorCount}
${new Date().toISOString()}`;

  const shouldSendSummary =
    signalsCount > 0 ||
    errorCount > 0 ||
    activeResults.length > 0;

  if (!shouldSendSummary) {
    console.log(
      `[${new Date().toISOString()}] 📱 Telegram summary skipped — all positions are already open`
    );
    return;
  }

  try {
    const telegramToken = process.env.TELEGRAM_BOT_TOKEN || '';
    const telegramChatId = process.env.TELEGRAM_CHAT_ID || '';

    if (!telegramToken || !telegramChatId) {
      console.warn(
        `[${new Date().toISOString()}] ⚠️ Telegram summary skipped — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing`
      );
      return;
    }

    const url = `https://api.telegram.org/bot${telegramToken}/sendMessage`;

    await axios.post(url, {
      chat_id: telegramChatId,
      text: summaryMessage
    });

    console.log(`[${new Date().toISOString()}] 📱 Telegram summary sent`);
  } catch (error) {
    console.error(
      `[${new Date().toISOString()}] Failed to send summary: ${
        error instanceof Error ? error.message : 'Unknown'
      }`
    );
  }
}

async function checkSignals() {
  if (signalCheckRunning) {
    console.warn(
      `[${new Date().toISOString()}] ⏭ SIGNAL CHECK SKIPPED — previous check is still running`
    );
    return;
  }

  signalCheckRunning = true;

  try {
    console.log(
      `\n[${new Date().toISOString()}] ========== SIGNAL CHECK START ==========`
    );

    console.log(
      `[${new Date().toISOString()}] Pairs: ${TRADING_PAIRS.length}, ` +
        `Open positions: ${getOpenPositionsCount()}/${MAX_PARALLEL_POSITIONS}, ` +
        `Equity: $${getBalance().toFixed(2)}, ` +
        `Reserved: $${getReservedCapital().toFixed(2)}, ` +
        `Available: $${getAvailableBalance().toFixed(2)}`
    );

    const signalResults: SignalResult[] = [];

    for (const symbol of TRADING_PAIRS) {
      try {
        /**
         * Открытые позиции контролируются checkPositions().
         * Для них новые сигналы не рассчитываем.
         */
        if (hasOpenPosition(symbol)) {
          console.log(
            `[${new Date().toISOString()}] 📌 ${symbol}: SIGNAL CHECK SKIPPED — open position exists`
          );

          signalResults.push({
            symbol,
            status: 'position_open',
            regime: 'position_open',
            hasSignal: false,
            reason: 'Open position exists'
          });

          continue;
        }

        /**
         * Когда все три слота заняты, новые сигналы не считаем.
         */
        if (getOpenPositionsCount() >= MAX_PARALLEL_POSITIONS) {
          console.log(
            `[${new Date().toISOString()}] ⛔ ${symbol}: SIGNAL CHECK SKIPPED — ` +
              `max positions reached (${getOpenPositionsCount()}/${MAX_PARALLEL_POSITIONS})`
          );

          signalResults.push({
            symbol,
            status: 'max_positions',
            regime: 'max_positions',
            hasSignal: false,
            reason: `Max positions reached (${MAX_PARALLEL_POSITIONS})`
          });

          continue;
        }

        const result = await runBotOnce(symbol, '15m');

        if (!result.ready) {
          console.log(
            `[${new Date().toISOString()}] ❌ ${symbol}: NOT READY - ${result.reason}`
          );

          signalResults.push({
            symbol,
            status: 'not_ready',
            regime: 'unknown',
            hasSignal: false,
            reason: result.reason
          });

          continue;
        }

        const buy = (result as any).buy as boolean;
        const sell = (result as any).sell as boolean;
        const side = (result as any).side as 'long' | 'short' | 'none';
        const price = (result as any).price as number;
        const takeProfitPrice = (result as any).takeProfitPrice as number | null;
        const stopLossPrice = (result as any).stopLossPrice as number | null;
        const positionSize = (result as any).positionSize as number | null;
        const regime = (result as any).regime as string;
        const indicators = (result as any).indicators as any;

        console.log(`\n[${new Date().toISOString()}] 🔍 ${symbol} ANALYSIS:`);
        console.log(`   Price: ${formatPrice(price)}`);
        console.log(`   Regime: ${regime}`);
        console.log(
          `   MACD Cross Up: ${indicators?.macdCrossUp}, Down: ${indicators?.macdCrossDown}`
        );
        console.log(`   RSI: ${indicators?.lastRsi?.toFixed(2)}`);
        console.log(`   ATR: ${indicators?.lastAtr?.toFixed(4)}`);
        console.log(`   ADX: ${indicators?.regimeIndicators?.adx?.toFixed(2)}`);
        console.log(`   BB Width: ${indicators?.regimeIndicators?.bbWidth?.toFixed(4)}`);
        console.log(`   Signal: ${buy ? 'BUY' : sell ? 'SELL' : 'NONE'}`);

        let signalReason = '';

        if (buy || sell) {
          console.log(`\n[${new Date().toISOString()}] 🚨 ${symbol}: SIGNAL DETECTED!`);
          console.log(`   Side: ${side.toUpperCase()}`);
          console.log(`   Entry: ${formatPrice(price)}`);
          console.log(
            `   TP: ${takeProfitPrice?.toFixed(4)}, SL: ${stopLossPrice?.toFixed(4)}`
          );
          console.log(`   Strategy position size: ${positionSize?.toFixed(4)}`);

          signalReason = 'Signal detected';

          if (side === 'none') {
            const reason = 'Signal side is none';

            console.log(
              `[${new Date().toISOString()}] ❌ ${symbol}: FAILED TO OPEN - ${reason}`
            );

            signalResults.push({
              symbol,
              status: 'signal',
              regime,
              hasSignal: true,
              side,
              price,
              reason
            });

            continue;
          }

          if (takeProfitPrice == null || stopLossPrice == null) {
            const reason = 'Take profit or stop loss is missing';

            console.log(
              `[${new Date().toISOString()}] ❌ ${symbol}: FAILED TO OPEN - ${reason}`
            );

            signalResults.push({
              symbol,
              status: 'signal',
              regime,
              hasSignal: true,
              side,
              price,
              reason
            });

            continue;
          }

          const riskCapital = getRiskCapital();
          const maxNotionalByPercent = getPositionNotional();
          const stopDistance = Math.abs(price - stopLossPrice);
          const worstCaseFeePerUnit =
            (price + stopLossPrice) * TRADE_FEE_RATE;
          const totalRiskPerUnit = stopDistance + worstCaseFeePerUnit;
          const calculatedQuantity = riskCapital / totalRiskPerUnit;

          const openResult = openPosition({
            symbol,
            side,
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

          if (openResult.ok && openResult.position) {
            console.log(
              `[${new Date().toISOString()}] ✅ ${symbol}: POSITION OPENED!`
            );
            console.log(`   Position ID: ${openResult.position.id}`);
            console.log(
              `   Quantity: ${openResult.position.quantity.toFixed(4)}`
            );
            console.log(
              `   Notional: $${openResult.position.notional.toFixed(2)}`
            );
            console.log(`   Equity: $${openResult.balance.toFixed(2)}`);
            console.log(
              `   Reserved: $${openResult.reservedCapitalAfter.toFixed(2)}`
            );
            console.log(
              `   Available: $${openResult.availableBalanceAfter.toFixed(2)}`
            );

            signalResults.push({
              symbol,
              status: 'signal',
              regime,
              hasSignal: true,
              side,
              price,
              reason: 'Position opened'
            });
          } else {
            console.log(
              `[${new Date().toISOString()}] ❌ ${symbol}: FAILED TO OPEN - ${openResult.message}`
            );

            signalResults.push({
              symbol,
              status: 'signal',
              regime,
              hasSignal: true,
              side,
              price,
              reason: openResult.message || 'Unknown error'
            });
          }
        } else {
          console.log(`[${new Date().toISOString()}] ⏭ ${symbol}: NO SIGNAL`);

          if (regime === 'high_volatility') {
            signalReason = `High volatility (ATR%: ${indicators?.regimeIndicators?.atrPct?.toFixed(2)})`;

            console.log(
              `   Reason: HIGH_VOLATILITY regime ` +
                `(ATR%: ${indicators?.regimeIndicators?.atrPct?.toFixed(4)}, ` +
                `BB Width: ${indicators?.regimeIndicators?.bbWidth?.toFixed(4)})`
            );
          } else if (regime === 'range') {
            signalReason = `Range (ADX: ${indicators?.regimeIndicators?.adx?.toFixed(2)})`;

            console.log(
              `   Reason: RANGE regime ` +
                `(ADX: ${indicators?.regimeIndicators?.adx?.toFixed(2)}, ` +
                `BB Width: ${indicators?.regimeIndicators?.bbWidth?.toFixed(4)})`
            );
          } else if (regime === 'trend_up') {
            const reasons: string[] = [];

            if (!indicators?.macdCrossUp && !indicators?.macdCrossDown) {
              reasons.push('No MACD cross');
            }

            if (!indicators?.rsiBull) {
              reasons.push(
                `RSI not bull (${indicators?.lastRsi?.toFixed(2)})`
              );
            }

            if (price <= (indicators?.regimeIndicators?.ema200 ?? 0)) {
              reasons.push('Price below EMA200');
            }

            signalReason = reasons.join(', ') || 'Trend up - trades disabled';
            console.log(`   Reason: ${signalReason}`);
          } else if (regime === 'trend_down') {
            const reasons: string[] = [];

            if (!indicators?.macdCrossUp && !indicators?.macdCrossDown) {
              reasons.push('No MACD cross');
            }

            if (!indicators?.rsiBear) {
              reasons.push(
                `RSI not bear (${indicators?.lastRsi?.toFixed(2)})`
              );
            }

            if (price >= (indicators?.regimeIndicators?.ema200 ?? 0)) {
              reasons.push('Price above EMA200');
            }

            signalReason = reasons.join(', ') || 'No MACD cross down';
            console.log(`   Reason: ${signalReason}`);
          } else if (regime === 'breakout_watch') {
            signalReason = 'Waiting for BB breakout';

            console.log(`   Reason: BREAKOUT_WATCH - waiting for BB breakout`);
            console.log(
              `   BB Upper: ${indicators?.bbUpper?.toFixed(4)}, ` +
                `BB Lower: ${indicators?.bbLower?.toFixed(4)}`
            );
            console.log(
              `   Price vs BB: ${
                price > (indicators?.bbUpper ?? 0)
                  ? 'ABOVE'
                  : price < (indicators?.bbLower ?? 0)
                    ? 'BELOW'
                    : 'INSIDE'
              }`
            );
          } else {
            signalReason = 'Unknown regime';
            console.log(`   Reason: UNKNOWN regime or indicators not ready`);
          }

          signalResults.push({
            symbol,
            status: 'no_signal',
            regime,
            hasSignal: false,
            reason: signalReason
          });
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
        const errorMsg =
          error instanceof Error ? error.message : 'Unknown error';

        console.error(
          `[${new Date().toISOString()}] 💥 ${symbol}: ERROR - ${errorMsg}`
        );

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

        signalResults.push({
          symbol,
          status: 'error',
          regime: 'error',
          hasSignal: false,
          reason: errorMsg
        });
      }
    }

    await sendTelegramSummary(signalResults);

    console.log(
      `[${new Date().toISOString()}] ========== SIGNAL CHECK END ==========\n`
    );
  } finally {
    signalCheckRunning = false;
  }
}

async function checkPositions() {
  if (positionCheckRunning) {
    console.warn(
      `[${new Date().toISOString()}] ⏭ POSITION CHECK SKIPPED — previous check is still running`
    );
    return;
  }

  positionCheckRunning = true;

  try {
    const positions = getPositions();

    if (positions.length === 0) {
      return;
    }

    console.log(
      `\n[${new Date().toISOString()}] ========== POSITION CHECK START ==========`
    );

    console.log(
      `[${new Date().toISOString()}] Checking ${positions.length} position(s)...`
    );

    console.log(
      `[${new Date().toISOString()}] Equity: $${getBalance().toFixed(2)}, ` +
        `Reserved: $${getReservedCapital().toFixed(2)}, ` +
        `Available: $${getAvailableBalance().toFixed(2)}`
    );

    for (const position of positions) {
      try {
        if (!hasOpenPosition(position.symbol)) {
          console.log(
            `[${new Date().toISOString()}] ⏭ ${position.symbol}: POSITION CHECK SKIPPED — no longer open`
          );
          continue;
        }

        const currentPrice = await getCurrentPrice(position.symbol);

        const unrealizedPnL =
          position.side === 'long'
            ? (currentPrice - position.entryPrice) * position.quantity
            : (position.entryPrice - currentPrice) * position.quantity;

        const unrealizedPnLPercent =
          (unrealizedPnL / position.notional) * 100;

        const distanceToTP =
          position.side === 'long'
            ? position.takeProfitPrice - currentPrice
            : currentPrice - position.takeProfitPrice;

        const distanceToTPPercent =
          (distanceToTP / currentPrice) * 100;

        const distanceToSL =
          position.side === 'long'
            ? currentPrice - position.stopLossPrice
            : position.stopLossPrice - currentPrice;

        const distanceToSLPercent =
          (distanceToSL / currentPrice) * 100;

        const hitTakeProfit =
          position.side === 'long'
            ? currentPrice >= position.takeProfitPrice
            : currentPrice <= position.takeProfitPrice;

        const hitStopLoss =
          position.side === 'long'
            ? currentPrice <= position.stopLossPrice
            : currentPrice >= position.stopLossPrice;

        const openedAt = new Date(position.openedAt).getTime();
        const now = new Date().getTime();
        const positionAgeSeconds = Math.floor((now - openedAt) / 1000);

        const previousMaxPnL =
          position.metadata?.maxUnrealizedPnL ?? Number.NEGATIVE_INFINITY;

        const previousWorstPnL =
          position.metadata?.worstUnrealizedPnL ?? Number.POSITIVE_INFINITY;

        updatePositionMetadata(position.id, {
          maxUnrealizedPnL: Math.max(previousMaxPnL, unrealizedPnL),
          maxUnrealizedPnLPercent: Math.max(
            position.metadata?.maxUnrealizedPnLPercent ??
              Number.NEGATIVE_INFINITY,
            unrealizedPnLPercent
          ),
          worstUnrealizedPnL: Math.min(previousWorstPnL, unrealizedPnL),
          worstUnrealizedPnLPercent: Math.min(
            position.metadata?.worstUnrealizedPnLPercent ??
              Number.POSITIVE_INFINITY,
            unrealizedPnLPercent
          )
        });

        console.log(
          `\n[${new Date().toISOString()}] 📊 ${position.symbol} (${position.side.toUpperCase()}):`
        );
        console.log(
          `   Entry: ${position.entryPrice.toFixed(4)}, Current: ${currentPrice.toFixed(4)}`
        );
        console.log(
          `   TP: ${position.takeProfitPrice.toFixed(4)} (${distanceToTPPercent.toFixed(2)}% away)`
        );
        console.log(
          `   SL: ${position.stopLossPrice.toFixed(4)} (${distanceToSLPercent.toFixed(2)}% away)`
        );
        console.log(
          `   Unrealized PnL: $${unrealizedPnL.toFixed(2)} (${unrealizedPnLPercent.toFixed(2)}%)`
        );
        console.log(
          `   Reserved: $${position.reservedCapital.toFixed(2)}`
        );
        console.log(
          `   Age: ${Math.floor(positionAgeSeconds / 60)}m ${positionAgeSeconds % 60}s`
        );

        if (hitTakeProfit) {
          console.log(
            `[${new Date().toISOString()}] 🎯 ${position.symbol}: HIT TAKE PROFIT!`
          );

          const result = closePosition(
            position.id,
            currentPrice,
            'take_profit'
          );

          if (result.ok && result.balance !== undefined) {
            console.log(
              `[${new Date().toISOString()}] ✅ ${position.symbol}: CLOSED AT TP`
            );
            console.log(`   Exit: ${currentPrice.toFixed(4)}`);

            const pnlPercent = result.lastClosedTrade
              ? (result.lastClosedTrade.netPnL / position.notional) * 100
              : 0;

            console.log(
              `   Net PnL: $${result.lastClosedTrade?.netPnL.toFixed(2)} (${pnlPercent.toFixed(2)}%)`
            );
            console.log(`   Equity: $${result.balance.toFixed(2)}`);
            console.log(
              `   Reserved: $${result.reservedCapitalAfter.toFixed(2)}`
            );
            console.log(
              `   Available: $${result.availableBalanceAfter.toFixed(2)}`
            );
          } else {
            console.error(
              `[${new Date().toISOString()}] ❌ ${position.symbol}: FAILED TO CLOSE - ${result.message}`
            );

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
          console.log(
            `[${new Date().toISOString()}] 🛑 ${position.symbol}: HIT STOP LOSS!`
          );

          const result = closePosition(
            position.id,
            currentPrice,
            'stop_loss'
          );

          if (result.ok && result.balance !== undefined) {
            console.log(
              `[${new Date().toISOString()}] ✅ ${position.symbol}: CLOSED AT SL`
            );
            console.log(`   Exit: ${currentPrice.toFixed(4)}`);
            console.log(
              `   Net PnL: $${result.lastClosedTrade?.netPnL.toFixed(2)}`
            );
            console.log(`   Equity: $${result.balance.toFixed(2)}`);
            console.log(
              `   Reserved: $${result.reservedCapitalAfter.toFixed(2)}`
            );
            console.log(
              `   Available: $${result.availableBalanceAfter.toFixed(2)}`
            );
          } else {
            console.error(
              `[${new Date().toISOString()}] ❌ ${position.symbol}: FAILED TO CLOSE - ${result.message}`
            );

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
          action: hitTakeProfit
            ? 'close_tp'
            : hitStopLoss
              ? 'close_sl'
              : 'hold',
          positionAgeSeconds
        });
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : 'Unknown error';

        console.error(
          `[${new Date().toISOString()}] 💥 ${position.symbol}: ERROR - ${errorMsg}`
        );

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

    console.log(
      `[${new Date().toISOString()}] ========== POSITION CHECK END ==========\n`
    );
  } finally {
    positionCheckRunning = false;
  }
}

export function startScheduler() {
  console.log(`\n[${new Date().toISOString()}] 🚀 TRADING BOT STARTING...`);
  console.log(
    `[${new Date().toISOString()}] Port: ${Number(process.env.PORT) || 3002}`
  );
  console.log(
    `[${new Date().toISOString()}] Signal check interval: ${SIGNAL_CHECK_INTERVAL_MS / 1000}s`
  );
  console.log(
    `[${new Date().toISOString()}] Position check interval: ${POSITION_CHECK_INTERVAL_MS / 1000}s`
  );
  console.log(
    `[${new Date().toISOString()}] Trading pairs: ${[...TRADING_PAIRS].join(', ')}`
  );
  console.log(
    `[${new Date().toISOString()}] Max positions: ${MAX_PARALLEL_POSITIONS}`
  );

  const positionPercent =
    getBalance() > 0
      ? (getPositionNotional() / getBalance()) * 100
      : 0;

  console.log(
    `[${new Date().toISOString()}] Position size: ${positionPercent.toFixed(0)}% of equity`
  );
  console.log(
    `[${new Date().toISOString()}] Starting equity: $${getBalance().toFixed(2)}\n`
  );

  notifyStartup({
    port: Number(process.env.PORT) || 3002,
    tradingPairs: [...TRADING_PAIRS],
    signalInterval: SIGNAL_CHECK_INTERVAL_MS / 1000,
    positionInterval: POSITION_CHECK_INTERVAL_MS / 1000
  });

  void checkSignals();

  signalCheckInterval = setInterval(() => {
    void checkSignals();
  }, SIGNAL_CHECK_INTERVAL_MS);

  void checkPositions();

  positionCheckInterval = setInterval(() => {
    void checkPositions();
  }, POSITION_CHECK_INTERVAL_MS);
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
