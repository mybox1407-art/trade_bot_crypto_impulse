export interface VirtualPosition {
  symbol: string;
  entryPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  openedAt: string;
}

let currentPosition: VirtualPosition | null = null;

export function getPosition() {
  return currentPosition;
}

export function openPosition(pos: VirtualPosition) {
  currentPosition = pos;
}

export function closePosition() {
  currentPosition = null;
}
