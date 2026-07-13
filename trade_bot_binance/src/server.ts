import express from 'express';

const app = express();

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.listen(3001, '0.0.0.0', () => {
  console.log('Server started on port 3001');
});
