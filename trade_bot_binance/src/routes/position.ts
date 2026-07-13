import { Router } from 'express';
import { getCurrentPrice } from '../services/exchange';
import { closePosition, getPosition, openPosition } from '../services/positionState';

const router = Router();

router.get('/status', (_req, res) => {
  res.json({
    ok: true,
    position: getPosition()
  });
});

router.post('/open', async (req, res) => {
  try {
    const { symbol } = req.body as { symbol?: string };

    if (!symbol) {
      return res.status(400).json({ ok: false, message: 'symbol is required' });
    }

    if (getPosition()) {
      return res.status(409).json({ ok: false, message: 'Position already open', position: getPosition() });
    }

    const entryPrice = await getCurrentPrice(symbol);
    const takeProfitPrice = entryPrice * 1.045;
    const stopLossPrice = entryPrice * 0.985;

    const result = openPosition({
      symbol,
      entryPrice,
      takeProfitPrice,
      stopLossPrice,
      openedAt: new Date().toISOString()
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

router.post('/close', (_req, res) => {
  try {
    res.json(closePosition());
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
