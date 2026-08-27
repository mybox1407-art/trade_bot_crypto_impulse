import { MAX_RISK_PER_TRADE, STARTING_BALANCE, TRADE_FEE_RATE } from './strategy';
import { logPositionOpen, logPositionClose } from './logger';

export const POSITION_PERCENT = 0.30;
export const MAX_PARALLEL_POSITIONS = 3;

export interface VirtualPosition {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  quantity: number;
  notional: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  entryFee: number;
  openedAt: string;
  metadata?: {
    regime: string;
    macdCrossUp: boolean;
    macdCrossDown: boolean;
    lastRsi: number;
    lastAtr: number;
    adx: number;
    bbWidth: number;
    atrPct: number;
    maxUnrealizedPnL?: number;
    maxUnrealizedPnLPercent?: number;
    worstUnrealizedPnL?: number;
    worstUnrealizedPnLPercent?: number;
  };
}

export interface ClosedTrade {
  id: string;
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  notional: number;
  realizedPnL: number;
  entryFee: number;
  exitFee: number;
  totalFee: number;
  netPnL: number;
  openedAt: string;
  closedAt: string;
  reason: 'take_profit' | 'stop_loss' | 'manual';
}

let balance = STARTING_BALANCE;
let currentPositions: VirtualPosition[] = [];
let lastClosedTrade: ClosedTrade | null = null;

function isFinitePositive(value: number) {
  return Number.isFinite(value) && value > 0;
}

function createPositionId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isValidLevels(params: {
  side: 'long' | 'short';
  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
}) {
  const { side, entryPrice, takeProfitPrice, stopLossPrice } = params;

  if (!isFinitePositive(entryPrice) || !Number.isFinite(takeProfitPrice) || !Number.isFinite(stopLossPrice)) {
    return false;
  }

  if (side === 'long') {
    return stopLossPrice < entryPrice && takeProfitPrice > entryPrice;
  }

  return stopLossPrice > entryPrice && takeProfitPrice < entryPrice;
}

export function getBalance() {
  return balance;
}

export function getPositions() {
  return currentPositions;
}

export function getPosition(symbol?: string) {
  if (symbol) {
    return currentPositions.find(position => position.symbol === symbol) ?? null;
  }

  return currentPositions[0] ?? null;
}

export function getPositionById(positionId: string) {
  return currentPositions.find(position => position.id === positionId) ?? null;
}

export function hasOpenPosition(symbol?: string) {
  if (!symbol) {
    return currentPositions.length > 0;
  }

  return currentPositions.some(position => position.symbol === symbol);
}

export function getLastClosedTrade() {
  return lastClosedTrade;
}

export function getPositionNotional() {
  return balance * POSITION_PERCENT;
}

export function getRiskCapital() {
  return balance * MAX_RISK_PER_TRADE;
}

export function getOpenPositionsCount() {
  return currentPositions.length;
}

export function openPosition(data: {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  metadata?: VirtualPosition['metadata'];
  riskCapital?: number;
  maxNotionalByPercent?: number;
  stopDistance?: number;
  totalRiskPerUnit?: number;
  calculatedQuantity?: number;
}) {
  const balanceBefore = balance;

  if (currentPositions.length >= MAX_PARALLEL_POSITIONS) {
    return { 
      ok: false, 
      message: `Max ${MAX_PARALLEL_POSITIONS} open positions reached`, 
      positions: currentPositions,
      balanceBefore,
      balanceAfter: balance
    };
  }

  if (hasOpenPosition(data.symbol)) {
    return { 
      ok: false, 
      message: `Position for ${data.symbol} is already open`, 
      positions: currentPositions,
      balanceBefore,
      balanceAfter: balance
    };
  }

  if (!isValidLevels(data)) {
    return { 
      ok: false, 
      message: 'Invalid entry / stop / take-profit levels',
      balanceBefore,
      balanceAfter: balance
    };
  }

  const stopDistance = data.stopDistance ?? Math.abs(data.entryPrice - data.stopLossPrice);
  if (!isFinitePositive(stopDistance)) {
    return { 
      ok: false, 
      message: 'Invalid stop distance',
      balanceBefore,
      balanceAfter: balance
    };
  }

  const maxNotionalByPercent = data.maxNotionalByPercent ?? getPositionNotional();
  const maxQuantityByPercent = maxNotionalByPercent / data.entryPrice;

  const riskCapital = data.riskCapital ?? getRiskCapital();
  const worstCaseFeePerUnit = (data.entryPrice + data.stopLossPrice) * TRADE_FEE_RATE;
  const totalRiskPerUnit = data.totalRiskPerUnit ?? (stopDistance + worstCaseFeePerUnit);
  const riskQuantity = data.calculatedQuantity ?? (riskCapital / totalRiskPerUnit);

  const quantity = Math.min(riskQuantity, maxQuantityByPercent);
  const notional = quantity * data.entryPrice;
  const entryFee = notional * TRADE_FEE_RATE;

  if (!isFinitePositive(quantity) || !isFinitePositive(notional) || !Number.isFinite(entryFee)) {
    return { 
      ok: false, 
      message: 'Calculated position size is invalid',
      balanceBefore,
      balanceAfter: balance
    };
  }

  if (balance < entryFee) {
    return { 
      ok: false, 
      message: 'Insufficient balance to pay entry fee',
      balanceBefore,
      balanceAfter: balance
    };
  }

  balance = balance - entryFee;

  const position: VirtualPosition = {
    id: createPositionId(),
    symbol: data.symbol,
    side: data.side,
    entryPrice: data.entryPrice,
    quantity,
    notional,
    takeProfitPrice: data.takeProfitPrice,
    stopLossPrice: data.stopLossPrice,
    entryFee,
    openedAt: new Date().toISOString(),
    metadata: data.metadata
  };

  currentPositions = [...currentPositions, position];

  logPositionOpen({
    timestamp: new Date().toISOString(),
    positionId: position.id,
    symbol: position.symbol,
    side: position.side,
    entryPrice: position.entryPrice,
    quantity: position.quantity,
    notional: position.notional,
    takeProfitPrice: position.takeProfitPrice,
    stopLossPrice: position.stopLossPrice,
    entryFee: position.entryFee,
    balanceBefore,
    balanceAfter: balance,
    riskCapital: riskCapital,
    maxNotionalByPercent: maxNotionalByPercent,
    stopDistance: stopDistance,
    totalRiskPerUnit: totalRiskPerUnit,
    calculatedQuantity: riskQuantity,
    regime: data.metadata?.regime ?? '',
    macdCrossUp: data.metadata?.macdCrossUp ?? false,
    macdCrossDown: data.metadata?.macdCrossDown ?? false,
    lastRsi: data.metadata?.lastRsi ?? 0,
    lastAtr: data.metadata?.lastAtr ?? 0,
    adx: data.metadata?.adx ?? 0,
    bbWidth: data.metadata?.bbWidth ?? 0,
    atrPct: data.metadata?.atrPct ?? 0
  });

  return { ok: true, balance, position, positions: currentPositions, balanceBefore, balanceAfter: balance };
}

export function closePosition(positionId: string, exitPrice: number, reason: 'take_profit' | 'stop_loss' | 'manual') {
  const index = currentPositions.findIndex(position => position.id === positionId);
  if (index === -1) {
    return { ok: false, message: 'No open position' };
  }

  const position = currentPositions[index];
  const balanceBefore = balance;

  const realizedPnL = position.side === 'long'
    ? (exitPrice - position.entryPrice) * position.quantity
    : (position.entryPrice - exitPrice) * position.quantity;

  const realizedPnLPercent = (realizedPnL / position.notional) * 100;

  const exitFee = exitPrice * position.quantity * TRADE_FEE_RATE;
  const totalFee = position.entryFee + exitFee;
  const netPnL = realizedPnL - exitFee;
  const netPnLPercent = (netPnL / position.notional) * 100;

  const openedAt = new Date(position.openedAt).getTime();
  const closedAt = new Date().getTime();
  const positionAgeSeconds = Math.floor((closedAt - openedAt) / 1000);

  lastClosedTrade = {
    id: position.id,
    symbol: position.symbol,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    quantity: position.quantity,
    notional: position.notional,
    realizedPnL,
    entryFee: position.entryFee,
    exitFee,
    totalFee,
    netPnL,
    openedAt: position.openedAt,
    closedAt: new Date().toISOString(),
    reason
  };

  balance = balance + netPnL;
  currentPositions = currentPositions.filter(openPosition => openPosition.id !== positionId);

  logPositionClose({
    timestamp: new Date().toISOString(),
    positionId: position.id,
    symbol: position.symbol,
    side: position.side,
    entryPrice: position.entryPrice,
    exitPrice,
    quantity: position.quantity,
    notional: position.notional,
    realizedPnL,
    realizedPnLPercent,
    entryFee: position.entryFee,
    exitFee,
    totalFee,
    netPnL,
    netPnLPercent,
    balanceBefore,
    balanceAfter: balance,
    reason,
    positionAgeSeconds,
    openedAt: position.openedAt,
    closedAt: new Date().toISOString(),
    maxUnrealizedPnL: position.metadata?.maxUnrealizedPnL,
    maxUnrealizedPnLPercent: position.metadata?.maxUnrealizedPnLPercent,
    worstUnrealizedPnL: position.metadata?.worstUnrealizedPnL,
    worstUnrealizedPnLPercent: position.metadata?.worstUnrealizedPnLPercent
  });

  return { ok: true, balance, lastClosedTrade, positions: currentPositions, balanceBefore, balanceAfter: balance };
}

export function updatePositionMetadata(positionId: string, updates: Partial<NonNullable<VirtualPosition['metadata']>>) {
  const index = currentPositions.findIndex(p => p.id === positionId);
  if (index === -1) {
    return false;
  }

  const position = currentPositions[index];
  if (!position.metadata) {
    position.metadata = {} as NonNullable<VirtualPosition['metadata']>;
  }

  position.metadata = { ...position.metadata, ...updates };
  return true;
}
