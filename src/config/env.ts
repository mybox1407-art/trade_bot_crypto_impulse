import dotenv from 'dotenv';

dotenv.config();

export const env = {
  port: Number(process.env.PORT) || 3002,
  apiKey: process.env.API_KEY || '',
  apiSecret: process.env.API_SECRET || '',
  nodeEnv: process.env.NODE_ENV || 'development'
};
