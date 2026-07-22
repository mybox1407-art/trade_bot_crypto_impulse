import fs from 'node:fs';
import path from 'node:path';
import { runStrategyBacktest, SideFilter } from './strategyBacktest';
import { Candle } from '../services/strategy';

const STARTING_BALANCE = 500;
const POSITION_PERCENT = Number(process.env.BACKTEST_POSITION_PERCENT ?? '0.1');
const COMMISSION_RATE = Number(process.env.BACKTEST_COMMISSION_RATE ?? '0');
const PROGRESS_LOG_EVERY = Number(process.env.BACKTEST_PROGRESS_EVERY ?? '250');
const WARMUP_CANDLES = Number(process.env.BACKTEST_WARMUP ?? '0');
const CLOSE_CHECK_INTERVAL_SEC = Number(process.env.BACKTEST_CLOSE_CHECK_SEC ?? '15');
const ONE_POSITION_AT_TIME =
  String(process.env.BACKTEST_ONE_POSITION_AT_TIME ?? 'true').toLowerCase() !== 'false';
const CONSERVATIVE_INTRABAR =
  String(process.env.BACKTEST_CONSERVATIVE_INTRABAR ?? 'true').toLowerCase() !== 'false';
const CLOSE_OPEN_POSITION_ON_END =
  String(process.env.BACKTEST_CLOSE_OPEN_POSITION_ON_END ?? 'false').toLowerCase() === 'true';
const SIDE_FILTER_ENV = process.env.BACKTEST_SIDE_FILTER ?? 'both';
const TRADE_START_AT = process.env.BACKTEST_TRADE_START_AT ?? '';

const ANSI = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m'
} as const;

type RunResult = ReturnType<typeof runStrategyBacktest>;

function colorize(text: string, color: keyof typeof ANSI): string {
  if (!process.stdout.isTTY) return text;
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function isValidCandle(candidate: unknown): candidate is Candle {
  if (!candidate || typeof candidate !== 'object') return false;
  const item = candidate as Record<string, unknown>;
  return (
    Number.isFinite(toNumber(item.time)) &&
    Number.isFinite(toNumber(item.open)) &&
    Number.isFinite(toNumber(item.high)) &&
    Number.isFinite(toNumber(item.low)) &&
    Number.isFinite(toNumber(item.close)) &&
    Number.isFinite(toNumber(item.volume))
  );
}

function normalizeCandles(raw: unknown): Candle[] {
  if (!Array.isArray(raw)) throw new Error('JSON root must be an array');

  const candles: Candle[] = raw.map((item, index) => {
    if (!isValidCandle(item)) {
      throw new Error(`Invalid candle at index ${index}`);
    }

    return {
      time: toNumber(item.time),
      open: toNumber(item.open),
      high: toNumber(item.high),
      low: toNumber(item.low),
      close: toNumber(item.close),
      volume: toNumber(item.volume)
    };
  });

  return candles.sort((a, b) => a.time - b.time);
}

function formatNumber(value: number, digits = 4): string {
  if (!Number.isFinite(value)) return 'NaN';
  return value.toFixed(digits);
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toISOString();
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'неизвестно';
  if (seconds < 60) return `${Math.round(seconds)} сек`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes} мин ${secs} сек`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ч ${minutes % 60} мин`;
}

function parseSideFilter(value: string | undefined): SideFilter {
  if (!value) return 'both';
  const v = value.trim().toLowerCase();
  if (v === 'both' || v === 'all') return 'both';
  if (v === 'long' || v === 'l') return 'long';
  if (v === 'short' || v === 's') return 'short';
  return 'both';
}

function parseTradeStartTime(value: string): number {
  if (!value) return 0;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : 0;
}

function estimateBacktestTime(candlesCount: number): { minSec: number; maxSec: number } {
  if (candlesCount <= 5000) return { minSec: 3, maxSec: 20 };
  if (candlesCount <= 15000) return { minSec: 10, maxSec: 60 };
  if (candlesCount <= 30000) return { minSec: 20, maxSec: 120 };
  return { minSec: 60, maxSec: 300 };
}

function printSummary(result: RunResult): void {
  const s = result.summary;
  const netColor = s.netProfit > 0 ? 'green' : s.netProfit < 0 ? 'red' : 'yellow';
  const retColor = s.returnPct > 0 ? 'green' : s.returnPct < 0 ? 'red' : 'yellow';
  const pfColor = s.profitFactor >= 1.2 ? 'green' : s.profitFactor >= 1 ? 'yellow' : 'red';

  console.log('\n========== ИТОГИ БЭКТЕСТА ==========');
  console.log(`Инструмент: ${s.symbol}`);
  console.log(`Side filter: ${result.options.sideFilter}`);
  console.log(`Сделок: ${s.tradesCount}`);
  console.log(`Побед: ${colorize(String(s.wins), 'green')}`);
  console.log(`Поражений: ${colorize(String(s.losses), 'red')}`);
  console.log(`Win rate: ${formatNumber(s.winRate * 100, 2)}%`);
  console.log(`Gross profit: ${colorize(formatNumber(s.grossProfit, 2), 'green')}`);
  console.log(`Gross loss: ${colorize(formatNumber(s.grossLoss, 2), 'red')}`);
  console.log(`Net profit: ${colorize(formatNumber(s.netProfit, 2), netColor)}`);
  console.log(`Avg net pnl: ${formatNumber(s.avgNetPnl, 2)}`);
  console.log(`Avg win: ${formatNumber(s.avgWin, 2)}`);
  console.log(`Avg loss: ${formatNumber(s.avgLoss, 2)}`);
  console.log(
    `Profit factor: ${colorize(Number.isFinite(s.profitFactor) ? formatNumber(s.profitFactor, 3) : 'Infinity', pfColor)}`
  );
  console.log(`Стартовый баланс: ${formatNumber(s.startBalance, 2)}`);
  console.log(`Финальный баланс: ${formatNumber(s.endBalance, 2)}`);
  console.log(`Доходность: ${colorize(formatNumber(s.returnPct * 100, 2) + '%', retColor)}`);
  console.log(`Макс. просадка: ${formatNumber(s.maxDrawdownAbs, 2)}`);
  console.log(`Макс. просадка %: ${formatNumber(s.maxDrawdownPct * 100, 2)}%`);
}

function printRegimeStats(result: RunResult): void {
  const rs = result.regimeStats;
  if (!rs || rs.totalBars === 0) {
    console.log('\n========== REGIME STATS ==========');
    console.log('Баров в обработке: 0');
    return;
  }

  const order = ['trend_up', 'trend_down', 'range', 'high_volatility', 'breakout_watch', 'unknown'];

  console.log('\n========== REGIME STATS ==========');
  console.log(`Баров в обработке: ${rs.totalBars}`);
  console.log(`Side filter: ${result.options.sideFilter}`);

  const barParts: string[] = [];
  const regimesSeen = new Set([
    ...order,
    ...Object.keys(rs.barsByRegime),
    ...Object.keys(rs.tradesByRegime)
  ]);

  for (const reg of [...order, ...[...regimesSeen].filter(r => !order.includes(r))]) {
    const b = rs.barsByRegime[reg];
    if (!b && !rs.tradesByRegime[reg]) continue;
    const pct = b ? (b.pct * 100).toFixed(1) : '0.0';
    const bars = b ? b.bars : 0;
    barParts.push(`${reg} ${pct}% (${bars})`);
  }

  console.log(`Bars: ${barParts.join(' | ')}`);
  console.log('\nTrades by regime:');

  const tradeRegs = [
    ...order.filter(r => rs.tradesByRegime[r]),
    ...Object.keys(rs.tradesByRegime).filter(r => !order.includes(r))
  ];

  if (!tradeRegs.length) {
    console.log(' нет');
  }

  for (const reg of tradeRegs) {
    const t = rs.tradesByRegime[reg];
    const pf = Number.isFinite(t.profitFactor) ? t.profitFactor.toFixed(3) : 'Infinity';
    const wr = (t.winRate * 100).toFixed(1);
    const reasons = Object.entries(t.closeReasons)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');

    console.log(
      ` ${reg}: n=${t.trades} WR=${wr}% PF=${pf} net=${t.netProfit.toFixed(2)} avgBars=${t.avgBarsHeld} | ${reasons}`
    );
  }

  const allReasons = Object.entries(rs.closeReasonsAll)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(' | ');

  console.log(`\nClose reasons: ${allReasons || 'нет'}`);
}

function printTrades(result: RunResult): void {
  console.log(`\n========== ВСЕ СДЕЛКИ (${result.trades.length}) ==========`);

  if (!result.trades.length) {
    console.log('Сделок нет.');
    return;
  }

  for (let i = 0; i < result.trades.length; i++) {
    const trade = result.trades[i];
    const line = [
      `#${i + 1}`,
      `Открыта: ${formatDate(trade.openedAt)}`,
      `Закрыта: ${formatDate(trade.closedAt)}`,
      `Сторона: ${trade.side}`,
      `Режим: ${trade.regime}`,
      `Вход: ${formatNumber(trade.entryPrice, 4)}`,
      `Выход: ${formatNumber(trade.exitPrice, 4)}`,
      `SL: ${formatNumber(trade.stopLossPrice, 4)}`,
      `TP: ${formatNumber(trade.takeProfitPrice, 4)}`,
      `Qty: ${formatNumber(trade.quantity, 6)}`,
      `Notional: ${formatNumber(trade.notional, 2)}`,
      `Причина: ${trade.closeReason}`,
      `Realized PnL: ${formatNumber(trade.realizedPnL, 2)}`,
      `Net PnL: ${formatNumber(trade.netPnl, 2)}`,
      `Комиссия: ${formatNumber(trade.totalCommission, 4)}`,
      `Bars: ${trade.barsHeld}`
    ].join(' | ');

    if (trade.netPnl > 0) console.log(colorize(line, 'green'));
    else if (trade.netPnl < 0) console.log(colorize(line, 'red'));
    else console.log(colorize(line, 'yellow'));
  }
}

function printOpenPosition(result: RunResult): void {
  if (!result.openPosition) return;

  const p = result.openPosition;

  console.log('\n========== ОТКРЫТАЯ ПОЗИЦИЯ ==========');
  console.log(`Сторона: ${p.side}`);
  console.log(`Режим: ${p.regime}`);
  console.log(`Открыта: ${formatDate(p.openedAt)}`);
  console.log(`Вход: ${formatNumber(p.entryPrice, 4)}`);
  console.log(`Последняя цена: ${formatNumber(p.lastPrice, 4)}`);
  console.log(`SL: ${formatNumber(p.stopLossPrice, 4)}`);
  console.log(`TP: ${formatNumber(p.takeProfitPrice, 4)}`);
  console.log(`Qty: ${formatNumber(p.quantity, 6)}`);
  console.log(`Notional: ${formatNumber(p.notional, 2)}`);
  console.log(`Unrealized gross: ${formatNumber(p.unrealizedGrossPnl, 2)}`);
  console.log(`Unrealized net: ${formatNumber(p.unrealizedNetPnl, 2)}`);
}

function printUsage(): void {
  console.log('npx tsx src/backtest/runBacktest.ts DATAFILE SYMBOL');
  console.log('Пример:');
  console.log('npx tsx src/backtest/runBacktest.ts ./src/backtest/data/SOLUSDT_15m.json SOLUSDT');
}

function main(): void {
  const [, , inputPathArg, symbolArg] = process.argv;

  if (!inputPathArg || !symbolArg) {
    printUsage();
    process.exit(1);
  }

  const absolutePath = path.resolve(process.cwd(), inputPathArg);

  if (!fs.existsSync(absolutePath)) {
    console.error(`Файл не найден: ${absolutePath}`);
    process.exit(1);
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(fs.readFileSync(absolutePath, 'utf-8'));
  } catch (e) {
    console.error('Ошибка чтения JSON.', e);
    process.exit(1);
  }

  let candles: Candle[];
  try {
    candles = normalizeCandles(rawJson);
  } catch (e) {
    console.error('Ошибка в формате свечей.', e);
    process.exit(1);
    return;
  }

  const estimated = estimateBacktestTime(candles.length);
  const tradeStartTime = parseTradeStartTime(TRADE_START_AT);
  const sideFilter = parseSideFilter(SIDE_FILTER_ENV);

  console.log('\n========== ПАРАМЕТРЫ ЗАПУСКА ==========');
  console.log(`Файл: ${absolutePath}`);
  console.log(`Инструмент: ${symbolArg}`);
  console.log(`Свечей загружено: ${candles.length}`);
  console.log(`Период данных: ${formatDate(candles[0].time)} -> ${formatDate(candles[candles.length - 1].time)}`);
  console.log(`Стартовый баланс: ${STARTING_BALANCE}`);
  console.log(`Position percent: ${formatNumber(POSITION_PERCENT * 100, 2)}%`);
  console.log(`Комиссия: ${formatNumber(COMMISSION_RATE * 100, 4)}%`);
  console.log(`Side filter: ${sideFilter}`);
  console.log(`Оценка времени: ~ ${formatDuration(estimated.minSec)} - ${formatDuration(estimated.maxSec)}`);
  console.log(`Лог прогресса: каждые ${PROGRESS_LOG_EVERY} свечей`);
  console.log(`One position at time: ${ONE_POSITION_AT_TIME ? 'ON' : 'OFF'}`);
  console.log(`Conservative intrabar: ${CONSERVATIVE_INTRABAR ? 'ON' : 'OFF'}`);
  console.log(`Warmup: ${WARMUP_CANDLES} бар`);
  console.log(`Trade start: ${tradeStartTime ? formatDate(tradeStartTime) : 'не задан'}`);
  console.log(`Close check interval: ${CLOSE_CHECK_INTERVAL_SEC} сек`);
  console.log(`Close open position on end: ${CLOSE_OPEN_POSITION_ON_END ? 'ON' : 'OFF'}`);
  console.log(`Прогресс: 0/${candles.length} свечей`);

  const startedAt = Date.now();

  const result = runStrategyBacktest(symbolArg, candles, {
    startingBalance: STARTING_BALANCE,
    positionPercent: POSITION_PERCENT,
    commissionRate: COMMISSION_RATE,
    warmupCandles: WARMUP_CANDLES,
    progressLogEvery: PROGRESS_LOG_EVERY,
    sideFilter,
    tradeStartTime,
    onePositionAtTime: ONE_POSITION_AT_TIME,
    conservativeIntrabarExecution: CONSERVATIVE_INTRABAR,
    closeOpenPositionOnEnd: CLOSE_OPEN_POSITION_ON_END,
    closeCheckIntervalSec: CLOSE_CHECK_INTERVAL_SEC
  });

  console.log('\n========== ВРЕМЯ ВЫПОЛНЕНИЯ ==========');
  console.log(`Фактическое время: ${formatDuration((Date.now() - startedAt) / 1000)}`);

  printSummary(result);
  printRegimeStats(result);
  printTrades(result);
  printOpenPosition(result);
}

main();
