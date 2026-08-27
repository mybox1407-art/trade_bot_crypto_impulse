import fs from 'fs';
import path from 'path';

function ensureFileExists(filePath: string, headers: string[]) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, headers.join(',') + '\n');
  }
}

function writeRow(filePath: string, row: Record<string, string | number | boolean | null>) {
  const headers = Object.keys(row);
  ensureFileExists(filePath, headers);
  
  const values = headers.map(h => {
    const val = row[h];
    if (val === null || val === undefined) {
      return '';
    }
    const strVal = String(val);
    if (strVal.includes(',') || strVal.includes('"') || strVal.includes('\n')) {
      return `"${strVal.replace(/"/g, '""')}"`;
    }
    return strVal;
  });

  fs.appendFileSync(filePath, values.join(',') + '\n');
}

export function logSignalCheck(row: {
  timestamp: string;
  symbol: string;
  timeframe: string;
  side: string;
  price: number;
  regime: string;
  takeProfitPrice: number | null;
  stopLossPrice: number | null;
  positionSize: number | null;
  macdCrossUp: boolean;
  macdCrossDown: boolean;
  lastRsi: number;
  lastAtr: number;
  rsiBull: boolean;
  rsiBear: boolean;
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
  adx: number;
  adxRising: boolean;
  ema20: number;
  ema50: number;
  ema200: number;
  bbWidth: number;
  atrPct: number;
  signalTriggered: boolean;
  positionOpened: boolean;
  openPositionError?: string;
}) {
  writeRow('signal_log.csv', row);
}

export function logPositionOpen(row: {
  timestamp: string;
  positionId: string;
  symbol: string;
  side: string;
  entryPrice: number;
  quantity: number;
  notional: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  entryFee: number;
  balanceBefore: number;
  balanceAfter: number;
  riskCapital: number;
  maxNotionalByPercent: number;
  stopDistance: number;
  totalRiskPerUnit: number;
  calculatedQuantity: number;
  regime: string;
  macdCrossUp: boolean;
  macdCrossDown: boolean;
  lastRsi: number;
  lastAtr: number;
  adx: number;
  bbWidth: number;
  atrPct: number;
}) {
  writeRow('position_open_log.csv', row);
}

export function logPositionCheck(row: {
  timestamp: string;
  positionId: string;
  symbol: string;
  side: string;
  entryPrice: number;
  currentPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  unrealizedPnL: number;
  unrealizedPnLPercent: number;
  distanceToTP: number;
  distanceToTPPercent: number;
  distanceToSL: number;
  distanceToSLPercent: number;
  hitTakeProfit: boolean;
  hitStopLoss: boolean;
  action: string;
  positionAgeSeconds: number;
}) {
  writeRow('position_check_log.csv', row);
}

export function logPositionClose(row: {
  timestamp: string;
  positionId: string;
  symbol: string;
  side: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  notional: number;
  realizedPnL: number;
  realizedPnLPercent: number;
  entryFee: number;
  exitFee: number;
  totalFee: number;
  netPnL: number;
  netPnLPercent: number;
  balanceBefore: number;
  balanceAfter: number;
  reason: string;
  positionAgeSeconds: number;
  openedAt: string;
  closedAt: string;
  maxUnrealizedPnL?: number;
  maxUnrealizedPnLPercent?: number;
  worstUnrealizedPnL?: number;
  worstUnrealizedPnLPercent?: number;
}) {
  writeRow('trade_log.csv', row);
}

export function logError(row: {
  timestamp: string;
  context: string;
  symbol?: string;
  positionId?: string;
  error: string;
  stack?: string;
}) {
  writeRow('error_log.csv', row);
}
