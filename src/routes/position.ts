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

function normalizeSymbol(symbol?: string) {
  return typeof symbol === 'string' ? symbol.trim().toUpperCase() : undefined;
}

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
    const rawBody = req.body as {
      symbol?: string;
      side?: 'long' | 'short';
      takeProfitPrice?: number;
      stopLossPrice?: number;
    };

    const symbol = normalizeSymbol(rawBody.symbol);
    const { side, takeProfitPrice, stopLossPrice } = rawBody;

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

router.post('/check-close', async (req, res) => {
  try {
    const symbol = normalizeSymbol((req.body as { symbol?: string }).symbol);

    if (!symbol) {
      return res.status(400).json({
        ok: false,
        message: 'symbol is required'
      });
    }

    const position = getPosition(symbol);

    if (!position) {
      return res.json({
        ok: true,
        action: 'none',
        symbol,
        reason: 'no_position'
      });
    }

    const currentPrice = await getCurrentPrice(position.symbol);

    const hitTakeProfit = position.side === 'long'
      ? currentPrice >= position.takeProfitPrice
      : currentPrice <= position.takeProfitPrice;

    const hitStopLoss = position.side === 'long'
      ? currentPrice <= position.stopLossPrice
      : currentPrice >= position.stopLossPrice;

    if (hitTakeProfit) {
      const result = closePosition(position.id, currentPrice, 'take_profit');

      return res.json({
        ok: true,
        action: 'closed',
        symbol: position.symbol,
        currentPrice,
        result
      });
    }

    if (hitStopLoss) {
      const result = closePosition(position.id, currentPrice, 'stop_loss');

      return res.json({
        ok: true,
        action: 'closed',
        symbol: position.symbol,
        currentPrice,
        result
      });
    }

    return res.json({
      ok: true,
      action: 'hold',
      symbol: position.symbol,
      currentPrice,
      position
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
    const rawBody = req.body as {
      positionId?: string;
      symbol?: string;
      reason?: 'take_profit' | 'stop_loss' | 'manual';
    };

    const { positionId, reason } = rawBody;
    const symbol = normalizeSymbol(rawBody.symbol);

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
