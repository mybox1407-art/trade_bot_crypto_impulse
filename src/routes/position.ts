import { Router } from 'express';
import { getCurrentPrice } from '../services/exchange';
import {
  closePosition,
  getBalance,
  getLastClosedTrade,
  getOpenPositionsCount,
  getPosition,
  getPositionById,
  getPositions,
  hasOpenPosition,
  MAX_PARALLEL_POSITIONS,
  openPosition
} from '../services/positionState';

const router = Router();

router.get('/status', (_req, res) => {
  res.json({
    ok: true,
    balance: getBalance(),
    openPositionsCount: getOpenPositionsCount(),
    maxParallelPositions: MAX_PARALLEL_POSITIONS,
    positions: getPositions(),
    lastClosedTrade: getLastClosedTrade()
  });
});

router.get('/balance', (_req, res) => {
  res.json({
    ok: true,
    balance: getBalance()
  });
});

router.post('/open', async (req, res) => {
  try {
    const { symbol, side, takeProfitPrice, stopLossPrice } = req.body as {
      symbol?: string;
      side?: 'long' | 'short';
      takeProfitPrice?: number;
      stopLossPrice?: number;
    };

    if (!symbol || !side || takeProfitPrice == null || stopLossPrice == null) {
      return res.status(400).json({
        ok: false,
        message: 'symbol, side, takeProfitPrice, stopLossPrice are required'
      });
    }

    if (hasOpenPosition(symbol)) {
      return res.status(409).json({
        ok: false,
        message: `Position for ${symbol} already open`,
        positions: getPositions()
      });
    }

    if (getOpenPositionsCount() >= MAX_PARALLEL_POSITIONS) {
      return res.status(409).json({
        ok: false,
        message: `Max ${MAX_PARALLEL_POSITIONS} open positions reached`,
        positions: getPositions()
      });
    }

    const entryPrice = await getCurrentPrice(symbol);
    const result = openPosition({
      symbol,
      side,
      entryPrice,
      takeProfitPrice,
      stopLossPrice
    });

    const statusCode = result.ok ? 200 : 400;
    return res.status(statusCode).json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

router.get('/check-close', async (req, res) => {
  try {
    const { symbol } = req.query as { symbol?: string };
    const positions = symbol ? getPositions().filter(position => position.symbol === symbol) : getPositions();

    if (positions.length === 0) {
      return res.json({ ok: true, action: 'none', reason: 'no_position' });
    }

    const symbols = [...new Set(positions.map(position => position.symbol))];
    const prices = await Promise.all(symbols.map(async currentSymbol => [currentSymbol, await getCurrentPrice(currentSymbol)] as const));
    const priceMap = Object.fromEntries(prices);
    const closed: unknown[] = [];

    for (const pos of positions) {
      const currentPrice = priceMap[pos.symbol];

      const hitTakeProfit = pos.side === 'long'
        ? currentPrice >= pos.takeProfitPrice
        : currentPrice <= pos.takeProfitPrice;

      const hitStopLoss = pos.side === 'long'
        ? currentPrice <= pos.stopLossPrice
        : currentPrice >= pos.stopLossPrice;

      if (hitTakeProfit) {
        const result = closePosition(pos.id, currentPrice, 'take_profit');
        closed.push({ positionId: pos.id, symbol: pos.symbol, reason: 'take_profit', currentPrice, result });
        continue;
      }

      if (hitStopLoss) {
        const result = closePosition(pos.id, currentPrice, 'stop_loss');
        closed.push({ positionId: pos.id, symbol: pos.symbol, reason: 'stop_loss', currentPrice, result });
      }
    }

    if (closed.length > 0) {
      return res.json({
        ok: true,
        action: 'closed',
        closed,
        positions: getPositions()
      });
    }

    return res.json({
      ok: true,
      action: 'hold',
      prices: priceMap,
      positions: getPositions()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

router.post('/close', async (req, res) => {
  try {
    const { positionId, symbol, reason } = req.body as {
      positionId?: string;
      symbol?: string;
      reason?: 'take_profit' | 'stop_loss' | 'manual';
    };

    const position = positionId
      ? getPositionById(positionId)
      : symbol
        ? getPosition(symbol)
        : getPosition();

    if (!position) {
      return res.status(409).json({ ok: false, message: 'No open position' });
    }

    const exitPrice = await getCurrentPrice(position.symbol);
    const result = closePosition(position.id, exitPrice, reason || 'manual');

    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
