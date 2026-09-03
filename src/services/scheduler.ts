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

        const beTriggered = position.metadata?.beTriggered ?? false;
        const partialClosed = position.metadata?.partialClosed ?? false;

        // 1) BE+fees at +0.4%
        if (!beTriggered && unrealizedPnLPercent >= 0.4) {
          const feesPerUnit = (position.entryPrice + currentPrice) * TRADE_FEE_RATE;
          const bePrice =
            position.side === 'long'
              ? position.entryPrice + feesPerUnit
              : position.entryPrice - feesPerUnit;

          const newStop =
            position.side === 'long'
              ? Math.max(position.stopLossPrice, bePrice)
              : Math.min(position.stopLossPrice, bePrice);

          if (newStop !== position.stopLossPrice) {
            position.stopLossPrice = newStop;
            updatePositionMetadata(position.id, { beTriggered: true });
            console.log(
              `[${new Date().toISOString()}] 🛡 ${position.symbol}: MOVED SL TO BE+FEES @ ${formatPrice(newStop)}`
            );
          }
        }

        // 2) Partial close 50% after +0.8%
        if (!partialClosed && unrealizedPnLPercent >= 0.8) {
          const closeQty = position.quantity * 0.5;
          const partialResult = partialClosePosition(position.id, closeQty, currentPrice);

          if (partialResult.ok) {
            updatePositionMetadata(position.id, { partialClosed: true });
            console.log(
              `[${new Date().toISOString()}] 📉 ${position.symbol}: PARTIAL CLOSED ${closeQty.toFixed(4)} @ ${formatPrice(currentPrice)}`
            );
          }
        }

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
