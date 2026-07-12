import { getMockPrice } from './exchange';
import { shouldBuy } from './strategy';

export async function runBotOnce() {
  const price = await getMockPrice();
  const buy = shouldBuy(price);

  return {
    price,
    buy
  };
}
