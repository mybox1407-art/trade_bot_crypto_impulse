import {
  analyzeMarket,
  Candle,
  detectMarketRegime,
  MarketRegime
} from '../services/strategy';

export type SideFilter = 'both' | 'long' | 'short';

export interface BacktestOptions {
  startingBalance?: number;
  positionPercent?: number;
  commissionRate?: number;
  warmupCandles?: number;
  onePositionAtTime?: boolean;
  conservativeIntrabarExecution?: boolean;
  cooldownCandles?: number;
  progressLogEvery?: number;
  maxTradesPerDay?: number;
  sideFilter?: SideFilter;
  tradeStartTime?: number;
  closeOpenPositionOnEnd?: boolean;
}

interface OpenPosition {
  symbol: string;
  side: 'long' | 'short';
  regime: MarketRegime | string;
  openedAt: number;
  entryPrice: number;
  quantity: number;
  notional: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  balanceBefore: number;
}

export interface OpenPositionSnapshot {
  symbol: string;
  side: 'long' | 'short';
  regime: MarketRegime | string;
  openedAt: number;
  entryPrice: number;
  quantity: number;
  notional: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  lastPrice: number;
  unrealizedGrossPnl: number;
  unrealizedNetPnl: number;
}

export interface BacktestTrade {
  symbol: string;
  side: 'long' | 'short';
  regime: MarketRegime | string;
  openedAt: number;
  closedAt: number;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  notional: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  realizedPnL: number;
  grossPnl: number;
  commissionOpen: number;
  commissionClose: number;
  totalCommission: number;
  netPnl: number;
  balanceBefore: number;
  balanceAfter: number;
  barsHeld: number;
  closeReason: 'take_profit' | 'stop_loss' | 'manual' | 'forced_close';
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
  openPosition: OpenPositionSnapshot | null;
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
    bucket.avgBarsHeld =
      bucket.trades > 0 ? round(bucket.avgBarsHeld / bucket.trades, 2) : 0;
  }

  return { totalBars, barsByRegime, tradesByRegime, closeReasonsAll };
}

function snapshotOpenPosition(params: {
  position: OpenPosition;
  lastPrice: number;
  commissionRate: number;
}): OpenPositionSnapshot {
  const { position, lastPrice, commissionRate } = params;

  const unrealizedGrossPnl = getGrossPnl({
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice: lastPrice,
    quantity: position.quantity
  });

  const estimatedOpenCommission = getCommission(position.notional, commissionRate);
  const estimatedCloseCommission = getCommission(position.quantity * lastPrice, commissionRate);
  const unrealizedNetPnl =
    unrealizedGrossPnl - estimatedOpenCommission - estimatedCloseCommission;

  return {
    symbol: position.symbol,
    side: position.side,
    regime: position.regime,
    openedAt: position.openedAt,
    entryPrice: round(position.entryPrice),
    quantity: round(position.quantity, 12),
    notional: round(position.notional, 8),
    takeProfitPrice: round(position.takeProfitPrice),
    stopLossPrice: round(position.stopLossPrice),
    lastPrice: round(lastPrice),
    unrealizedGrossPnl: round(unrealizedGrossPnl),
    unrealizedNetPnl: round(unrealizedNetPnl)
  };
}

function tryOpenPosition(params: {
  symbol: string;
  signalCandles: Candle[];
  executionCandle: Candle;
  currentBalance: number;
  positionPercent: number;
  sideFilter: SideFilter;
}): OpenPosition | null {
  const {
    symbol,
    signalCandles,
    executionCandle,
    currentBalance,
    positionPercent,
    sideFilter
  } = params;

  const signal = analyzeMarket(signalCandles);

  if (signal.side === 'none') return null;
  if (sideFilter === 'long' && signal.side !== 'long') return null;
  if (sideFilter === 'short' && signal.side !== 'short') return null;

  if (
    signal.stopLossPrice == null ||
    signal.takeProfitPrice == null ||
    !Number.isFinite(signal.stopLossPrice) ||
    !Number.isFinite(signal.takeProfitPrice)
  ) {
    return null;
  }

  const entryPrice = executionCandle.open;
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return null;

  const notional = currentBalance * positionPercent;
  if (!Number.isFinite(notional) || notional <= 0) return null;

  const quantity = notional / entryPrice;
  if (!Number.isFinite(quantity) || quantity <= 0) return null;

  return {
    symbol,
    side: signal.side,
    regime: signal.regime,
    openedAt: executionCandle.time,
    entryPrice,
    quantity,
    notional,
    takeProfitPrice: signal.takeProfitPrice,
    stopLossPrice: signal.stopLossPrice,
    balanceBefore: currentBalance
  };
}

function buildTrade(params: {
  position: OpenPosition;
  exitPrice: number;
  closedAt: number;
  closeReason: BacktestTrade['closeReason'];
  balanceBeforeClose: number;
  commissionRate: number;
  barsHeld: number;
}): BacktestTrade {
  const {
    position,
    exitPrice,
    closedAt,
    closeReason,
    balanceBeforeClose,
    commissionRate,
    barsHeld
  } = params;

  const grossPnl = getGrossPnl({
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    quantity: position.quantity
  });

  const commissionOpen = getCommission(position.notional, commissionRate);
  const commissionClose = getCommission(position.quantity * exitPrice, commissionRate);
  const totalCommission = commissionOpen + commissionClose;
  const netPnl = grossPnl - totalCommission;

  return {
    symbol: position.symbol,
    side: position.side,
    regime: position.regime,
    openedAt: position.openedAt,
    closedAt,
    entryPrice: round(position.entryPrice),
    exitPrice: round(exitPrice),
    quantity: round(position.quantity, 12),
    notional: round(position.notional, 8),
    takeProfitPrice: round(position.takeProfitPrice),
    stopLossPrice: round(position.stopLossPrice),
    realizedPnL: round(grossPnl),
    grossPnl: round(grossPnl),
    commissionOpen: round(commissionOpen),
    commissionClose: round(commissionClose),
    totalCommission: round(totalCommission),
    netPnl: round(netPnl),
    balanceBefore: round(position.balanceBefore),
    balanceAfter: round(balanceBeforeClose + netPnl),
    barsHeld,
    closeReason
  };
}

function processExitsOnCandle(params: {
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
  const { position, candle, commissionRate, barsHeld, conservative } = params;
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
    positionPercent: options.positionPercent ?? 0.1,
    commissionRate: options.commissionRate ?? 0,
    warmupCandles: options.warmupCandles ?? 0,
    onePositionAtTime: options.onePositionAtTime ?? true,
    conservativeIntrabarExecution: options.conservativeIntrabarExecution ?? true,
    cooldownCandles: options.cooldownCandles ?? 0,
    progressLogEvery: options.progressLogEvery ?? 250,
    maxTradesPerDay: options.maxTradesPerDay ?? 0,
    sideFilter: options.sideFilter ?? 'both',
    tradeStartTime: options.tradeStartTime ?? 0,
    closeOpenPositionOnEnd: options.closeOpenPositionOnEnd ?? false
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
      regimeStats: emptyRegimeStats(),
      openPosition: null
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
  const startIndex = Math.max(1, Math.min(resolvedOptions.warmupCandles, sortedCandles.length - 1));
  const totalBarsToProcess = Math.max(sortedCandles.length - startIndex, 0);

  for (let i = startIndex; i < sortedCandles.length; i++) {
    const signalCandles = sortedCandles.slice(0, i);
    const currentCandle = sortedCandles[i];

    const regInfo = detectMarketRegime(signalCandles);
    const regName = regInfo.ready ? regInfo.regime : 'unknown';
    barCounts[regName] = (barCounts[regName] ?? 0) + 1;

    if (resolvedOptions.progressLogEvery > 0) {
      const processedBars = i - startIndex;
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
      const result = processExitsOnCandle({
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
        cooldownRemaining = resolvedOptions.cooldownCandles;
        openPosition = null;
        openPositionIndex = -1;
        continue;
      }
    }

    if (openPosition && resolvedOptions.onePositionAtTime) continue;

    if (cooldownRemaining > 0) {
      cooldownRemaining -= 1;
      continue;
    }

    if (currentCandle.time < resolvedOptions.tradeStartTime) continue;

    if (resolvedOptions.maxTradesPerDay > 0) {
      const dayKey = utcDateKey(currentCandle.time);
      const used = entriesPerDay.get(dayKey) ?? 0;
      if (used >= resolvedOptions.maxTradesPerDay) continue;
    }

    const maybeOpen = tryOpenPosition({
      symbol,
      signalCandles,
      executionCandle: currentCandle,
      currentBalance: balance,
      positionPercent: resolvedOptions.positionPercent,
      sideFilter: resolvedOptions.sideFilter
    });

    if (!maybeOpen) continue;

    openPosition = maybeOpen;
    openPositionIndex = i;

    if (resolvedOptions.maxTradesPerDay > 0) {
      const dayKey = utcDateKey(currentCandle.time);
      entriesPerDay.set(dayKey, (entriesPerDay.get(dayKey) ?? 0) + 1);
    }

    const sameCandleResult = processExitsOnCandle({
      position: openPosition,
      candle: currentCandle,
      balance,
      commissionRate: resolvedOptions.commissionRate,
      barsHeld: 0,
      conservative: resolvedOptions.conservativeIntrabarExecution
    });

    balance = sameCandleResult.balance;

    if (sameCandleResult.trade) {
      trades.push(sameCandleResult.trade);
      equityCurve.push({ time: currentCandle.time, balance: round(balance) });
      cooldownRemaining = resolvedOptions.cooldownCandles;
      openPosition = null;
      openPositionIndex = -1;
    }
  }

  let openPositionSnapshot: OpenPositionSnapshot | null = null;

  if (openPosition) {
    const lastCandle = sortedCandles[sortedCandles.length - 1];

    if (resolvedOptions.closeOpenPositionOnEnd) {
      const trade = buildTrade({
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
    } else {
      openPositionSnapshot = snapshotOpenPosition({
        position: openPosition,
        lastPrice: lastCandle.close,
        commissionRate: resolvedOptions.commissionRate
      });
    }
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
    regimeStats,
    openPosition: openPositionSnapshot
  };
}
