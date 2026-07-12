import { Router } from 'express';
import { runBotOnce } from '../services/botRunner';

const router = Router();

router.post('/run', async (_req, res) => {
  const result = await runBotOnce();
  res.json(result);
});

export default router;
