import { MAX_RISK_PER_TRADE, STARTING_BALANCE, TRADE_FEE_RATE } from './strategy';
import { logTrade } from './logger';

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
}) {
  if (currentPositions.length >= MAX_PARALLEL_POSITIONS) {
    return { ok: false, message: `Max ${MAX_PARALLEL_POSITIONS} open positions reached`, positions: currentPositions };
  }

  if (hasOpenPosition(data.symbol)) {
    return { ok: false, message: `Position for ${data.symbol} is already open`, positions: currentPositions };
  }

  if (!isValidLevels(data)) {
    return { ok: false, message: 'Invalid entry / stop / take-profit levels' };
  }

  const stopDistance = Math.abs(data.entryPrice - data.stopLossPrice);
  if (!isFinitePositive(stopDistance)) {
    return { ok: false, message: 'Invalid stop distance' };
  }

  const maxNotionalByPercent = getPositionNotional();
  const maxQuantityByPercent = maxNotionalByPercent / data.entryPrice;

  const riskCapital = getRiskCapital();
  const worstCaseFeePerUnit = (data.entryPrice + data.stopLossPrice) * TRADE_FEE_RATE;
  const totalRiskPerUnit = stopDistance + worstCaseFeePerUnit;
  const riskQuantity = riskCapital / totalRiskPerUnit;

  const quantity = Math.min(riskQuantity, maxQuantityByPercent);
  const notional = quantity * data.entryPrice;
  const entryFee = notional * TRADE_FEE_RATE;

  if (!isFinitePositive(quantity) || !isFinitePositive(notional) || !Number.isFinite(entryFee)) {
    return { ok: false, message: 'Calculated position size is invalid' };
  }

  if (balance < entryFee) {
    return { ok: false, message: 'Insufficient balance to pay entry fee' };
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
    openedAt: new Date().toISOString()
  };

  currentPositions = [...currentPositions, position];

  return { ok: true, balance, position, positions: currentPositions };
}

export function closePosition(positionId: string, exitPrice: number, reason: 'take_profit' | 'stop_loss' | 'manual') {
  const index = currentPositions.findIndex(position => position.id === positionId);
  if (index === -1) {
    return { ok: false, message: 'No open position' };
  }

  const position = currentPositions[index];
  const realizedPnL = position.side === 'long'
    ? (exitPrice - position.entryPrice) * position.quantity
    : (position.entryPrice - exitPrice) * position.quantity;

  const exitFee = exitPrice * position.quantity * TRADE_FEE_RATE;
  const totalFee = position.entryFee + exitFee;
  const netPnL = realizedPnL - exitFee;

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

  logTrade({
    timestamp: new Date().toISOString(),
    tradeId: position.id,
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
    reason,
    balanceAfter: balance
  });

  return { ok: true, balance, lastClosedTrade, positions: currentPositions };
}
