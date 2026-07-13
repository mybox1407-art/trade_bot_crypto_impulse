import { Router } from 'express';
import { runBotOnce } from '../services/botRunner';

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

export default router;
