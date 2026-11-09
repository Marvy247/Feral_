/**
 * Exact money arithmetic.
 *
 * Every amount in Feral is an integer number of minor units (bigint) plus an
 * asset descriptor that says how many decimals to shift. Floats are never used
 * for balances or limits: a policy engine that rounds differently from the
 * chain is not a safety tool, it is a bug factory.
 */

export interface Asset {
  /** Stable identifier used by policies. Native NEAR is "NEAR". */
  id: string;
  symbol: string;
  decimals: number;
  /** NEP-141 contract id, when the asset is a fungible token. */
  contract?: string;
}

export const NEAR: Asset = { id: 'NEAR', symbol: 'NEAR', decimals: 24 };

export const USDC_NEAR: Asset = {
  id: 'USDC',
  symbol: 'USDC',
  decimals: 6,
  // Circle's USDC on NEAR, as listed by the 1Click asset registry.
  contract: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
};

export const USDT_NEAR: Asset = {
  id: 'USDT',
  symbol: 'USDT',
  decimals: 6,
  contract: 'usdt.tether-token.near',
};

/** Default registry. Actors can extend it; unknown assets are still usable but must have explicit limits. */
export const DEFAULT_ASSETS: Record<string, Asset> = {
  NEAR,
  USDC: USDC_NEAR,
  USDT: USDT_NEAR,
};

const AMOUNT_RE = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmountError';
  }
}

/**
 * Parse a human decimal string ("1.5", "200") into minor units.
 *
 * Throws instead of silently truncating when the string carries more precision
 * than the asset supports. Silent truncation is how "1.0000004 USDC" becomes a
 * limit bypass in engines that compare after rounding.
 */
export function parseAmount(input: string, decimals: number): bigint {
  if (typeof input !== 'string') throw new AmountError(`amount must be a string, got ${typeof input}`);
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new AmountError('amount is empty');
  if (trimmed.startsWith('-')) throw new AmountError(`amount must not be negative: ${input}`);
  if (!AMOUNT_RE.test(trimmed)) throw new AmountError(`amount is not a plain decimal: ${input}`);

  const [whole, frac = ''] = trimmed.split('.');
  if (frac.length > decimals) {
    throw new AmountError(`amount ${input} has ${frac.length} decimals, asset supports ${decimals}`);
  }
  const padded = frac.padEnd(decimals, '0');
  return BigInt(whole + padded);
}

/** Render minor units back to a decimal string without trailing zeros. */
export function formatAmount(value: bigint, decimals: number): string {
  if (value < 0n) return '-' + formatAmount(-value, decimals);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

/**
 * USD value of an amount, in cents, rounded down.
 *
 * `prices` maps an asset id to its price in micro-USD (1_000_000n === $1.00).
 * Rounding down keeps limit checks conservative: we never approve something
 * that is actually above the threshold.
 */
export function usdCents(amount: bigint, asset: Asset, prices: Record<string, bigint>): bigint {
  const price = prices[asset.id];
  if (price === undefined) {
    throw new AmountError(`no USD price for asset ${asset.id}; policy cannot evaluate a fiat threshold`);
  }
  const micro = (amount * price) / 10n ** BigInt(asset.decimals);
  return micro / 10_000n;
}

/** Multiply two bigints, rounding down, without losing precision. */
export function mulDiv(value: bigint, numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new AmountError('division by zero');
  return (value * numerator) / denominator;
}

/** Basis points applied to an amount, rounded down (used for slippage and fees). */
export function bps(amount: bigint, basisPoints: number): bigint {
  if (!Number.isInteger(basisPoints) || basisPoints < 0) {
    throw new AmountError(`invalid basis points: ${basisPoints}`);
  }
  return mulDiv(amount, BigInt(basisPoints), 10_000n);
}

/** Sum of amounts, tolerant of an empty list. */
export function sumAmounts(values: readonly bigint[]): bigint {
  return values.reduce((acc, v) => acc + v, 0n);
}
