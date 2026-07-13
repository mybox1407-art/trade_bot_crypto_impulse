import { Router } from 'express';
import { runBotOnce } from '../services/botRunner';
import { getPosition } from '../services/positionState';

const router = Router();

router.post('/run', async (_req, res) => {
  try {
    const result = await runBotOnce();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

router.get('/status', (_req, res) => {
  res.json({
    ok: true,
    position: getPosition()
  });
});

export default router;
