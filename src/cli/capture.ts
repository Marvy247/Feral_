/**
 * Capture one real 1Click quote into data/fixtures/quote.json.
 *
 * Run once with network access; the repository then ships the fixture so the demo
 * and the tests are reproducible offline.
 */
import { captureQuote, ONE_CLICK_ASSETS } from '../chain/intents.ts';

const amount = process.argv[2] ?? '1'; // whole NEAR
const destination = process.argv[3] ?? '0x9a1f4b0c2d7e8f6a3b5c1d9e0f2a4b6c8d0e1f3a';

const fixture = await captureQuote({
  originAsset: ONE_CLICK_ASSETS.NEAR,
  destinationAsset: ONE_CLICK_ASSETS.USDC_ARB,
  amount: (BigInt(amount) * 10n ** 24n).toString(),
  recipient: destination,
  refundTo: 'alice.near',
  slippageTolerance: 50,
  deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
  dry: true,
});

console.log('captured at', fixture.capturedAt);
console.log('quote:', JSON.stringify(fixture.response.quote, null, 2).slice(0, 1200));
