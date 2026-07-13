import express from 'express';
import healthRouter from './routes/health';
import botRouter from './routes/bot';

export const app = express();

app.use(express.json());
app.use('/health', healthRouter);
app.use('/bot', botRouter);
