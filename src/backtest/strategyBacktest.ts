import {
  analyzeMarket,
  Candle,
  detectMarketRegime,
  MarketRegime
} from '../services/strategy';

export type SideFilter = 'both' | 'long' | 'short';

export interface BacktestOptions {
  startingBalance?: number;
  commissionRate?: number;
  warmupCandles?: number;
  onePositionAtTime?: boolean;
  conservativeIntrabarExecution?: boolean;
  cooldownCandles?: number;
  progressLogEvery?: number;
  maxTradesPerDay?: number;
  timeStopBars?: number;
  earlyAbortBars?: number;
  earlyAbortMinR?: number;
  sideFilter?: SideFilter;
}

interface OpenPosition {
  side: 'long' | 'short';
  regime: MarketRegime | string;
  openedAt: number;
  entryPrice: number;
  stopLossPrice: number;
  initialStopLossPrice: number;
  takeProfitPrice: number;
  quantity: number;
  positionSize: number;
  balanceBefore: number;
  initialR: number;
}

export interface BacktestTrade {
  symbol: string;
  side: 'long' | 'short';
  regime: MarketRegime | string;
  openedAt: number;
  closedAt: number;
  entryPrice: number;
  exitPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  quantity: number;
  positionSize: number;
  closeReason:
    | 'stop_loss'
    | 'take_profit'
    | 'forced_close'
    | 'time_stop'
    | 'early_abort';
  grossPnl: number;
  commissionOpen: number;
  commissionClose: number;
  totalCommission: number;
  netPnl: number;
  balanceBefore: number;
  balanceAfter: number;
  barsHeld: number;
}

export interface BacktestSummary {
  symbol: string;
  tradesCount: number;
  wins: number;
  losses: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  avgNetPnl: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  startBalance: number;
  endBalance: number;
  returnPct: number;
  maxDrawdownAbs: number;
  maxDrawdownPct: number;
}

export interface RegimeBarBucket {
  bars: number;
  pct: number;
}

export interface RegimeTradeBucket {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  avgBarsHeld: number;
  closeReasons: Record<string, number>;
}

export interface RegimeStats {
  totalBars: number;
  barsByRegime: Record<string, RegimeBarBucket>;
  tradesByRegime: Record<string, RegimeTradeBucket>;
  closeReasonsAll: Record<string, number>;
}

export interface BacktestResult {
  symbol: string;
  options: Required<BacktestOptions>;
  trades: BacktestTrade[];
  summary: BacktestSummary;
  equityCurve: Array<{ time: number; balance: number }>;
  regimeStats: RegimeStats;
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'неизвестно';
  if (seconds < 60) return `${Math.round(seconds)} сек`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes} мин ${secs} сек`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours} ч ${mins} мин`;
}

function getCommission(turnover: number, commissionRate: number): number {
  return turnover * commissionRate;
}

function getGrossPnl(params: {
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
}): number {
  const { side, entryPrice, exitPrice, quantity } = params;
  if (side === 'long') return (exitPrice - entryPrice) * quantity;
  return (entryPrice - exitPrice) * quantity;
}

function utcDateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function emptyRegimeStats(): RegimeStats {
  return {
    totalBars: 0,
    barsByRegime: {},
    tradesByRegime: {},
    closeReasonsAll: {}
  };
}

function incReason(map: Record<string, number>, reason: string, n = 1): void {
  map[reason] = (map[reason] ?? 0) + n;
}

function buildRegimeStats(
  trades: BacktestTrade[],
  barCounts: Record<string, number>
): RegimeStats {
  const totalBars = Object.values(barCounts).reduce((a, b) => a + b, 0);

  const barsByRegime: Record<string, RegimeBarBucket> = {};
  for (const [reg, bars] of Object.entries(barCounts)) {
    barsByRegime[reg] = {
      bars,
      pct: totalBars > 0 ? round(bars / totalBars, 6) : 0
    };
  }

  const tradesByRegime: Record<string, RegimeTradeBucket> = {};
  const closeReasonsAll: Record<string, number> = {};

  for (const t of trades) {
    const reg = String(t.regime || 'unknown');

    if (!tradesByRegime[reg]) {
      tradesByRegime[reg] = {
        trades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        netProfit: 0,
        grossProfit: 0,
        grossLoss: 0,
        profitFactor: 0,
        avgBarsHeld: 0,
        closeReasons: {}
      };
    }

    const bucket = tradesByRegime[reg];
    bucket.trades += 1;
    bucket.netProfit += t.netPnl;
    bucket.avgBarsHeld += t.barsHeld;

    if (t.netPnl > 0) {
      bucket.wins += 1;
      bucket.grossProfit += t.netPnl;
    } else {
      bucket.losses += 1;
      bucket.grossLoss += t.netPnl;
    }

    incReason(bucket.closeReasons, t.closeReason);
    incReason(closeReasonsAll, t.closeReason);
  }

  for (const bucket of Object.values(tradesByRegime)) {
    const grossLossAbs = Math.abs(bucket.grossLoss);
    bucket.winRate = bucket.trades > 0 ? round(bucket.wins / bucket.trades, 6) : 0;
    bucket.netProfit = round(bucket.netProfit);
    bucket.grossProfit = round(bucket.grossProfit);
    bucket.grossLoss = round(bucket.grossLoss);
    bucket.profitFactor =
      grossLossAbs > 0
        ? round(bucket.grossProfit / grossLossAbs, 6)
        : bucket.grossProfit > 0
          ? Infinity
          : 0;
    bucket.avgBarsHeld = bucket.trades > 0 ? round(bucket.avgBarsHeld / bucket.trades, 2) : 0;
  }

  return { totalBars, barsByRegime, tradesByRegime, closeReasonsAll };
}

function tryOpenPosition(params: {
  symbol: string;
  visibleCandles: Candle[];
  currentBalance: number;
  commissionRate: number;
  sideFilter: SideFilter;
}): OpenPosition | null {
  const { visibleCandles, currentBalance, commissionRate, sideFilter } = params;
  const signal = analyzeMarket(visibleCandles);

  if (signal.side === 'none') return null;
  if (sideFilter === 'long' && signal.side !== 'long') return null;
  if (sideFilter === 'short' && signal.side !== 'short') return null;

  if (
    signal.positionSize == null ||
    signal.stopLossPrice == null ||
    signal.takeProfitPrice == null ||
    !Number.isFinite(signal.positionSize) ||
    !Number.isFinite(signal.stopLossPrice) ||
    !Number.isFinite(signal.takeProfitPrice)
  ) {
    return null;
  }

  const lastCandle = visibleCandles[visibleCandles.length - 1];
  const entryPrice = toNumber(signal.price);
  const stopLossPrice = toNumber(signal.stopLossPrice);
  const takeProfitPrice = toNumber(signal.takeProfitPrice);

  if (entryPrice <= 0 || stopLossPrice <= 0 || takeProfitPrice <= 0) return null;

  const initialR = Math.abs(entryPrice - stopLossPrice);
  if (initialR <= 0) return null;

  const requestedNotional = Math.max(0, toNumber(signal.positionSize));
  const maxAffordableNotional = currentBalance > 0
    ? currentBalance / (1 + commissionRate)
    : 0;

  const actualNotional = Math.min(requestedNotional, maxAffordableNotional);
  if (actualNotional <= 0) return null;

  const quantity = actualNotional / entryPrice;
  if (!Number.isFinite(quantity) || quantity <= 0) return null;

  return {
    side: signal.side,
    regime: signal.regime,
    openedAt: lastCandle.time,
    entryPrice,
    stopLossPrice,
    initialStopLossPrice: stopLossPrice,
    takeProfitPrice,
    quantity,
    positionSize: actualNotional,
    balanceBefore: currentBalance,
    initialR
  };
}

function buildTrade(params: {
  symbol: string;
  position: OpenPosition;
  exitPrice: number;
  closedAt: number;
  closeReason: BacktestTrade['closeReason'];
  balanceBeforeClose: number;
  commissionRate: number;
  barsHeld: number;
}): BacktestTrade {
  const {
    symbol,
    position,
    exitPrice,
    closedAt,
    closeReason,
    balanceBeforeClose,
    commissionRate,
    barsHeld
  } = params;

  const commissionOpen = getCommission(position.entryPrice * position.quantity, commissionRate);
  const commissionClose = getCommission(exitPrice * position.quantity, commissionRate);
  const totalCommission = commissionOpen + commissionClose;
  const grossPnl = getGrossPnl({
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    quantity: position.quantity
  });
  const netPnl = grossPnl - totalCommission;

  return {
    symbol,
    side: position.side,
    regime: position.regime,
    openedAt: position.openedAt,
    closedAt,
    entryPrice: round(position.entryPrice),
    exitPrice: round(exitPrice),
    stopLossPrice: round(position.stopLossPrice),
    takeProfitPrice: round(position.takeProfitPrice),
    quantity: round(position.quantity, 12),
    positionSize: round(position.entryPrice * position.quantity, 8),
    closeReason,
    grossPnl: round(grossPnl),
    commissionOpen: round(commissionOpen),
    commissionClose: round(commissionClose),
    totalCommission: round(totalCommission),
    netPnl: round(netPnl),
    balanceBefore: round(position.balanceBefore),
    balanceAfter: round(balanceBeforeClose + netPnl),
    barsHeld
  };
}

function processExitsOnCandle(params: {
  symbol: string;
  position: OpenPosition;
  candle: Candle;
  balance: number;
  commissionRate: number;
  barsHeld: number;
  conservative: boolean;
}): {
  trade: BacktestTrade | null;
  balance: number;
  stillOpen: boolean;
} {
  const { symbol, position, candle, commissionRate, barsHeld, conservative } = params;
  let { balance } = params;

  const hitStop =
    position.side === 'long'
      ? candle.low <= position.stopLossPrice
      : candle.high >= position.stopLossPrice;

  const hitTp =
    position.side === 'long'
      ? candle.high >= position.takeProfitPrice
      : candle.low <= position.takeProfitPrice;

  if (hitStop && hitTp && conservative) {
    const trade = buildTrade({
      symbol,
      position,
      exitPrice: position.stopLossPrice,
      closedAt: candle.time,
      closeReason: 'stop_loss',
      balanceBeforeClose: balance,
      commissionRate,
      barsHeld
    });

    balance = trade.balanceAfter;
    return { trade, balance, stillOpen: false };
  }

  if (hitStop) {
    const trade = buildTrade({
      symbol,
      position,
      exitPrice: position.stopLossPrice,
      closedAt: candle.time,
      closeReason: 'stop_loss',
      balanceBeforeClose: balance,
      commissionRate,
      barsHeld
    });

    balance = trade.balanceAfter;
    return { trade, balance, stillOpen: false };
  }

  if (hitTp) {
    const trade = buildTrade({
      symbol,
      position,
      exitPrice: position.takeProfitPrice,
      closedAt: candle.time,
      closeReason: 'take_profit',
      balanceBeforeClose: balance,
      commissionRate,
      barsHeld
    });

    balance = trade.balanceAfter;
    return { trade, balance, stillOpen: false };
  }

  return { trade: null, balance, stillOpen: true };
}

function calculateDrawdown(equityCurve: Array<{ time: number; balance: number }>) {
  let peak = equityCurve.length ? equityCurve[0].balance : 0;
  let maxDrawdownAbs = 0;
  let maxDrawdownPct = 0;

  for (const point of equityCurve) {
    if (point.balance > peak) peak = point.balance;
    const dd = peak - point.balance;
    const ddPct = peak > 0 ? dd / peak : 0;
    if (dd > maxDrawdownAbs) maxDrawdownAbs = dd;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
  }

  return {
    maxDrawdownAbs: round(maxDrawdownAbs),
    maxDrawdownPct: round(maxDrawdownPct, 6)
  };
}

function buildSummary(params: {
  symbol: string;
  trades: BacktestTrade[];
  startBalance: number;
  endBalance: number;
  equityCurve: Array<{ time: number; balance: number }>;
}): BacktestSummary {
  const { symbol, trades, startBalance, endBalance, equityCurve } = params;

  const wins = trades.filter(t => t.netPnl > 0);
  const losses = trades.filter(t => t.netPnl <= 0);

  const grossProfit = wins.reduce((a, b) => a + b.netPnl, 0);
  const grossLossSum = losses.reduce((a, b) => a + b.netPnl, 0);
  const grossLossAbs = Math.abs(grossLossSum);
  const netProfit = trades.reduce((a, b) => a + b.netPnl, 0);

  const profitFactor =
    grossLossAbs > 0 ? grossProfit / grossLossAbs : grossProfit > 0 ? Infinity : 0;

  const returnPct = startBalance > 0 ? (endBalance - startBalance) / startBalance : 0;
  const dd = calculateDrawdown(equityCurve);

  return {
    symbol,
    tradesCount: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: round(trades.length ? wins.length / trades.length : 0, 6),
    grossProfit: round(grossProfit),
    grossLoss: round(grossLossSum),
    netProfit: round(netProfit),
    avgNetPnl: round(trades.length ? netProfit / trades.length : 0),
    avgWin: round(wins.length ? grossProfit / wins.length : 0),
    avgLoss: round(losses.length ? grossLossSum / losses.length : 0),
    profitFactor: Number.isFinite(profitFactor) ? round(profitFactor, 6) : Infinity,
    startBalance: round(startBalance),
    endBalance: round(endBalance),
    returnPct: round(returnPct, 6),
    maxDrawdownAbs: dd.maxDrawdownAbs,
    maxDrawdownPct: dd.maxDrawdownPct
  };
}

export function runStrategyBacktest(
  symbol: string,
  candles: Candle[],
  options: BacktestOptions = {}
): BacktestResult {
  const resolvedOptions: Required<BacktestOptions> = {
    startingBalance: options.startingBalance ?? 500,
    commissionRate: options.commissionRate ?? 0.0005,
    warmupCandles: options.warmupCandles ?? 250,
    onePositionAtTime: options.onePositionAtTime ?? true,
    conservativeIntrabarExecution: options.conservativeIntrabarExecution ?? true,
    cooldownCandles: options.cooldownCandles ?? 12,
    progressLogEvery: options.progressLogEvery ?? 250,
    maxTradesPerDay: options.maxTradesPerDay ?? 0,
    timeStopBars: options.timeStopBars ?? 64,
    earlyAbortBars: options.earlyAbortBars ?? 16,
    earlyAbortMinR: options.earlyAbortMinR ?? 0.35,
    sideFilter: options.sideFilter ?? 'both'
  };

  if (!Array.isArray(candles) || candles.length === 0) {
    return {
      symbol,
      options: resolvedOptions,
      trades: [],
      summary: buildSummary({
        symbol,
        trades: [],
        startBalance: resolvedOptions.startingBalance,
        endBalance: resolvedOptions.startingBalance,
        equityCurve: []
      }),
      equityCurve: [],
      regimeStats: emptyRegimeStats()
    };
  }

  const sortedCandles = [...candles].sort((a, b) => a.time - b.time);

  let balance = resolvedOptions.startingBalance;
  let openPosition: OpenPosition | null = null;
  let openPositionIndex = -1;
  let cooldownRemaining = 0;

  const entriesPerDay = new Map<string, number>();
  const trades: BacktestTrade[] = [];
  const equityCurve: Array<{ time: number; balance: number }> = [
    { time: sortedCandles[0].time, balance: round(balance) }
  ];
  const barCounts: Record<string, number> = {};

  const startedAt = Date.now();
  const totalBarsToProcess = Math.max(sortedCandles.length - resolvedOptions.warmupCandles, 0);

  for (let i = resolvedOptions.warmupCandles; i < sortedCandles.length; i++) {
    const visibleCandles = sortedCandles.slice(0, i + 1);
    const currentCandle = sortedCandles[i];

    const regInfo = detectMarketRegime(visibleCandles);
    const regName = regInfo.ready ? regInfo.regime : 'unknown';
    barCounts[regName] = (barCounts[regName] ?? 0) + 1;

    if (resolvedOptions.progressLogEvery > 0) {
      const processedBars = i - resolvedOptions.warmupCandles;
      const shouldLog =
        processedBars > 0 &&
        (processedBars % resolvedOptions.progressLogEvery === 0 ||
          i === sortedCandles.length - 1);

      if (shouldLog) {
        const elapsedSec = (Date.now() - startedAt) / 1000;
        const speed = processedBars / Math.max(elapsedSec, 1e-9);
        const remainingBars = Math.max(totalBarsToProcess - processedBars, 0);
        const etaSec = remainingBars / Math.max(speed, 1e-9);
        const progressPct =
          totalBarsToProcess > 0 ? (processedBars / totalBarsToProcess) * 100 : 100;

        console.log(
          [
            `[${symbol}]`,
            `Прогресс: ${processedBars}/${totalBarsToProcess}`,
            `${round(progressPct, 2)}%`,
            `Скорость: ${round(speed, 2)} свеч/сек`,
            `ETA: ${formatDuration(etaSec)}`,
            `Сделок: ${trades.length}`,
            `Баланс: ${round(balance, 2)}`,
            `Открыта: ${openPosition ? `${openPosition.side}@${round(openPosition.entryPrice, 4)}` : 'нет'}`
          ].join(' | ')
        );
      }
    }

    if (openPosition) {
      const barsHeld = i - openPositionIndex;

      if (barsHeld >= resolvedOptions.timeStopBars) {
        const trade = buildTrade({
          symbol,
          position: openPosition,
          exitPrice: currentCandle.close,
          closedAt: currentCandle.time,
          closeReason: 'time_stop',
          balanceBeforeClose: balance,
          commissionRate: resolvedOptions.commissionRate,
          barsHeld
        });

        balance = trade.balanceAfter;
        trades.push(trade);
        equityCurve.push({ time: currentCandle.time, balance: round(balance) });
        cooldownRemaining = resolvedOptions.cooldownCandles;
        openPosition = null;
        openPositionIndex = -1;
      } else if (
        resolvedOptions.earlyAbortBars > 0 &&
        barsHeld >= resolvedOptions.earlyAbortBars
      ) {
        const fav =
          openPosition.side === 'long'
            ? currentCandle.close - openPosition.entryPrice
            : openPosition.entryPrice - currentCandle.close;

        if (fav < resolvedOptions.earlyAbortMinR * openPosition.initialR) {
          const trade = buildTrade({
            symbol,
            position: openPosition,
            exitPrice: currentCandle.close,
            closedAt: currentCandle.time,
            closeReason: 'early_abort',
            balanceBeforeClose: balance,
            commissionRate: resolvedOptions.commissionRate,
            barsHeld
          });

          balance = trade.balanceAfter;
          trades.push(trade);
          equityCurve.push({ time: currentCandle.time, balance: round(balance) });
          cooldownRemaining = resolvedOptions.cooldownCandles;
          openPosition = null;
          openPositionIndex = -1;
        }
      }
    }

    if (openPosition) {
      const result = processExitsOnCandle({
        symbol,
        position: openPosition,
        candle: currentCandle,
        balance,
        commissionRate: resolvedOptions.commissionRate,
        barsHeld: i - openPositionIndex,
        conservative: resolvedOptions.conservativeIntrabarExecution
      });

      balance = result.balance;

      if (result.trade) {
        trades.push(result.trade);
        equityCurve.push({ time: currentCandle.time, balance: round(balance) });
      }

      if (!result.stillOpen) {
        cooldownRemaining = resolvedOptions.cooldownCandles;
        openPosition = null;
        openPositionIndex = -1;
      }
    }

    if (openPosition && resolvedOptions.onePositionAtTime) continue;

    if (cooldownRemaining > 0) {
      cooldownRemaining -= 1;
      continue;
    }

    if (resolvedOptions.maxTradesPerDay > 0) {
      const dayKey = utcDateKey(currentCandle.time);
      const used = entriesPerDay.get(dayKey) ?? 0;
      if (used >= resolvedOptions.maxTradesPerDay) continue;
    }

    const maybeOpen = tryOpenPosition({
      symbol,
      visibleCandles,
      currentBalance: balance,
      commissionRate: resolvedOptions.commissionRate,
      sideFilter: resolvedOptions.sideFilter
    });

    if (maybeOpen) {
      openPosition = maybeOpen;
      openPositionIndex = i;

      if (resolvedOptions.maxTradesPerDay > 0) {
        const dayKey = utcDateKey(currentCandle.time);
        entriesPerDay.set(dayKey, (entriesPerDay.get(dayKey) ?? 0) + 1);
      }
    }
  }

  if (openPosition) {
    const lastCandle = sortedCandles[sortedCandles.length - 1];
    const trade = buildTrade({
      symbol,
      position: openPosition,
      exitPrice: lastCandle.close,
      closedAt: lastCandle.time,
      closeReason: 'forced_close',
      balanceBeforeClose: balance,
      commissionRate: resolvedOptions.commissionRate,
      barsHeld: sortedCandles.length - 1 - openPositionIndex
    });

    balance = trade.balanceAfter;
    trades.push(trade);
    equityCurve.push({ time: lastCandle.time, balance: round(balance) });
  }

  const regimeStats = buildRegimeStats(trades, barCounts);

  return {
    symbol,
    options: resolvedOptions,
    trades,
    summary: buildSummary({
      symbol,
      trades,
      startBalance: resolvedOptions.startingBalance,
      endBalance: balance,
      equityCurve
    }),
    equityCurve,
    regimeStats
  };
}
