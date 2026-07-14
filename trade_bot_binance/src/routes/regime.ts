import { Router } from 'express';
import { getCandles } from '../services/exchange';
import { detectMarketRegime } from '../services/strategy';

const router = Router();

router.get('/regime', async (_req, res) => {
  try {
    const symbol = 'BTC/USDT';
    const timeframe = '15m';
    const candles = await getCandles(symbol, timeframe, 250);

    if (candles.length < 200) {
      return res.status(200).json({ symbol, timeframe, ready: false, reason: 'not_enough_candles' });
    }

    const result = detectMarketRegime(candles);
    return res.json({ symbol, timeframe, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'unknown_error' });
  }
});

export default router;
