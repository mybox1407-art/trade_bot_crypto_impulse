import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';

/**
 * Скачивание исторических свечей с Binance Spot
 *
 * Запуск:
 *   npx tsx src/backtest/downloadCandles.ts SOLUSDT 30 15m
 *   npx tsx src/backtest/downloadCandles.ts BTCUSDT 90 1h
 *   npx tsx src/backtest/downloadCandles.ts ETHUSDT 7 1m
 *
 * Args: <symbol> [days=21] [interval=15m]
 * Symbol: SOLUSDT / SOL/USDT / solusdt — всё ок
 * Intervals: 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1d, 3d, 1w, 1M
 */

type BinanceInterval =
  | '1m' | '3m' | '5m' | '15m' | '30m'
  | '1h' | '2h' | '4h' | '6h' | '8h' | '12h'
  | '1d' | '3d' | '1w' | '1M';

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type BinanceKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string
];

const VALID_INTERVALS = new Set<string>([
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '8h', '12h',
  '1d', '3d', '1w', '1M'
]);

const BASE_URLS = [
  'https://api.binance.com',
  'https://data-api.binance.vision',
  'https://api1.binance.com'
];

const LIMIT = 1000;
const REQUEST_PAUSE_MS = 250;

function normalizeSymbol(raw: string): string {
  return raw.replace('/', '').replace('-', '').toUpperCase();
}

function intervalToMs(interval: BinanceInterval): number {
  const map: Record<BinanceInterval, number> = {
    '1m': 60_000,
    '3m': 180_000,
    '5m': 300_000,
    '15m': 900_000,
    '30m': 1_800_000,
    '1h': 3_600_000,
    '2h': 7_200_000,
    '4h': 14_400_000,
    '6h': 21_600_000,
    '8h': 28_800_000,
    '12h': 43_200_000,
    '1d': 86_400_000,
    '3d': 259_200_000,
    '1w': 604_800_000,
    '1M': 2_592_000_000
  };

  return map[interval];
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function klineToCandle(k: BinanceKline): Candle {
  return {
    time: k[0],
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5])
  };
}

async function fetchKlinesPage(params: {
  baseUrl: string;
  symbol: string;
  interval: BinanceInterval;
  startTime: number;
  endTime: number;
}): Promise<BinanceKline[]> {
  const { baseUrl, symbol, interval, startTime, endTime } = params;

  const url = `${baseUrl}/api/v3/klines`;
  const response = await axios.get<BinanceKline[]>(url, {
    params: {
      symbol,
      interval,
      startTime,
      endTime,
      limit: LIMIT
    },
    timeout: 30_000
  });

  return response.data ?? [];
}

async function fetchKlinesWithFallback(params: {
  symbol: string;
  interval: BinanceInterval;
  startTime: number;
  endTime: number;
}): Promise<BinanceKline[]> {
  let lastError: unknown;

  for (const baseUrl of BASE_URLS) {
    try {
      return await fetchKlinesPage({ ...params, baseUrl });
    } catch (err: unknown) {
      lastError = err;

      if (axios.isAxiosError(err)) {
        const status = err.response?.status;

        if (
          status === 451 ||
          status === 403 ||
          status === 418 ||
          (status != null && status >= 500)
        ) {
          console.warn(`  host ${baseUrl} -> HTTP ${status}, fallback...`);
          continue;
        }

        if (status === 429) {
          const retryAfter = Number(err.response?.headers?.['retry-after'] ?? 5);
          console.warn(`  rate limit 429, sleep ${retryAfter}s...`);
          await sleep(retryAfter * 1000);
          return fetchKlinesPage({ ...params, baseUrl });
        }
      }

      throw err;
    }
  }

  throw lastError;
}

async function downloadAllCandles(params: {
  symbol: string;
  interval: BinanceInterval;
  fromMs: number;
  toMs: number;
}): Promise<Candle[]> {
  const { symbol, interval, fromMs, toMs } = params;
  const stepMs = intervalToMs(interval) * LIMIT;

  const all: Candle[] = [];
  let cursor = fromMs;
  let page = 0;

  while (cursor < toMs) {
    page += 1;
    const pageEnd = Math.min(cursor + stepMs, toMs);

    console.log(
      `Загружаю page ${page}: ${new Date(cursor).toISOString()} -> ${new Date(pageEnd).toISOString()} [${interval}]`
    );

    const raw = await fetchKlinesWithFallback({
      symbol,
      interval,
      startTime: cursor,
      endTime: pageEnd
    });

    if (raw.length === 0) {
      cursor = pageEnd;
      await sleep(REQUEST_PAUSE_MS);
      continue;
    }

    const candles = raw
      .map(klineToCandle)
      .filter(
        c =>
          Number.isFinite(c.time) &&
          Number.isFinite(c.open) &&
          Number.isFinite(c.high) &&
          Number.isFinite(c.low) &&
          Number.isFinite(c.close) &&
          Number.isFinite(c.volume) &&
          c.time >= fromMs &&
          c.time < toMs
      );

    all.push(...candles);

    const lastOpen = raw[raw.length - 1][0];
    const next = lastOpen + 1;

    if (next <= cursor) {
      cursor = pageEnd;
    } else {
      cursor = next;
    }

    if (raw.length < LIMIT && cursor < pageEnd) {
      cursor = pageEnd;
    }

    await sleep(REQUEST_PAUSE_MS);
  }

  const deduped = Array.from(
    new Map(all.map(c => [c.time, c])).values()
  ).sort((a, b) => a.time - b.time);

  return deduped;
}

async function main() {
  const [, , symbolArg, daysArg = '21', intervalArg = '15m'] = process.argv;

  if (!symbolArg) {
    console.error('Не указан symbol.');
    console.error('Пример: npx tsx src/backtest/downloadCandles.ts SOLUSDT 30 15m');
    console.error('        npx tsx src/backtest/downloadCandles.ts BTC/USDT 90 1h');
    process.exit(1);
  }

  const symbol = normalizeSymbol(symbolArg);

  if (!VALID_INTERVALS.has(intervalArg)) {
    console.error(`Некорректный интервал: ${intervalArg}`);
    console.error(`Допустимые: ${[...VALID_INTERVALS].join(', ')}`);
    process.exit(1);
  }

  const interval = intervalArg as BinanceInterval;

  const days = Number(daysArg);
  if (!Number.isFinite(days) || days <= 0) {
    console.error('Некорректное количество дней.');
    process.exit(1);
  }

  const toMs = Date.now();
  const fromMs = toMs - days * 24 * 60 * 60 * 1000;

  console.log(`Binance klines: ${symbol} | ${interval} | ${days}d`);
  console.log(`Период: ${new Date(fromMs).toISOString()} -> ${new Date(toMs).toISOString()}`);

  const candles = await downloadAllCandles({
    symbol,
    interval,
    fromMs,
    toMs
  });

  const outputDir = path.resolve(process.cwd(), 'src/backtest/data');
  ensureDir(outputDir);

  const outputFile = path.join(outputDir, `${symbol}_${interval}.json`);
  fs.writeFileSync(outputFile, JSON.stringify(candles, null, 2), 'utf-8');

  console.log(`Готово. Сохранено свечей: ${candles.length}`);
  if (candles.length > 0) {
    console.log(
      `Диапазон: ${new Date(candles[0].time).toISOString()} -> ${new Date(
        candles[candles.length - 1].time
      ).toISOString()}`
    );
  }
  console.log(`Файл: ${outputFile}`);
}

main().catch((error: unknown) => {
  console.error('Ошибка загрузки свечей Binance');

  if (axios.isAxiosError(error)) {
    console.error('message:', error.message);
    console.error('code:', error.code);

    if (error.response) {
      console.error('status:', error.response.status);
      console.error('data:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error('response: отсутствует');
    }
  } else if (error instanceof Error) {
    console.error('message:', error.message);
  } else {
    console.error(error);
  }

  process.exit(1);
});
