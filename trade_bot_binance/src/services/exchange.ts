import ccxt from 'ccxt';

const exchange = new ccxt.binance();

export async function getCurrentPrice(symbol: string) {
  await exchange.loadMarkets();
  const ticker = await exchange.fetchTicker(symbol);
  return ticker.last ?? ticker.close ?? ticker.bid ?? ticker.ask ?? null;
}
