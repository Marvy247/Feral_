/**
 * NEAR Intents (1Click) client.
 *
 * The point of this file is that Feral is not a mock: the policy engine is fed a
 * real cross-chain quote from the live 1Click API, and then decides whether the
 * agent may take it. `dry: true` quotes are free and need no wallet, no key and
 * no funds, which is exactly what a judge needs to reproduce the demo.
 *
 * API: https://1click.chaindefuser.com/v0 (see docs.near-intents.org)
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { QuoteSnapshot } from '../core/engine.ts';

export const ONE_CLICK_BASE = 'https://1click.chaindefuser.com';

/** 1Click asset ids verified against GET /v0/tokens. */
export const ONE_CLICK_ASSETS = {
  NEAR: 'nep141:wrap.near',
  USDC_NEAR: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  USDT_NEAR: 'nep141:usdt.tether-token.near',
  USDC_ARB: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
  USDC_BASE: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  ETH: 'nep141:eth.omft.near',
} as const;

export interface TokenInfo {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price?: number;
  contractAddress?: string;
}

export interface QuoteRequest {
  originAsset: string;
  destinationAsset: string;
  /** Amount in the origin asset's smallest unit, as a decimal string. */
  amount: string;
  /** Destination-chain address that receives the output. */
  recipient: string;
  /** NEAR account that receives a refund if the swap fails. */
  refundTo: string;
  slippageTolerance: number;
  deadline: string;
  dry?: boolean;
}

export interface Quote {
  amountIn: string;
  amountInFormatted: string;
  amountInUsd?: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd?: string;
  minAmountOut: string;
  timeEstimate?: number;
  /** Present only for a live (non-dry) quote. */
  depositAddress?: string;
  depositMemo?: string;
  /** ISO deadline after which the quote must not be used. */
  deadline?: string;
  timeWhenInactive?: string;
  withdrawFee?: string;
  [key: string]: unknown;
}

export interface QuoteResponse {
  correlationId?: string;
  quote: Quote;
  quoteRequest?: Record<string, unknown>;
  signature?: string;
}

export class IntentsError extends Error {  status: number;
  body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'IntentsError';
    this.status = status;
    this.body = body;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Map a 1Click asset id ("nep141:wrap.near") back to a Feral policy asset id ("NEAR"). */
export function policyAssetFromOneClick(assetId: string): string | null {
  for (const [policyId, oneClickId] of Object.entries(ONE_CLICK_ASSETS)) {
    if (oneClickId === assetId) return policyId.startsWith('USDC_') || policyId.startsWith('USDT_') ? policyId.split('_')[0] : policyId;
  }
  return null;
}

async function request<T>(path: string, init: RequestInit, fetchImpl: FetchLike): Promise<T> {
  const response = await fetchImpl(`${ONE_CLICK_BASE}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      // No API key: the docs add a 25 bps platform fee to unauthenticated quotes.
      ...(init.headers ?? {}),
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new IntentsError(`1Click ${path} failed with ${response.status}: ${body.slice(0, 300)}`, response.status, body);
  }
  return JSON.parse(body) as T;
}

/** Live list of assets the solver network supports. */
export async function getTokens(fetchImpl: FetchLike = fetch): Promise<TokenInfo[]> {
  return request<TokenInfo[]>('/v0/tokens', { method: 'GET' }, fetchImpl);
}

/** Quote a cross-chain swap. `dry: true` validates without creating a deposit address. */
export async function requestQuote(input: QuoteRequest, fetchImpl: FetchLike = fetch): Promise<QuoteResponse> {
  const payload = {
    dry: input.dry ?? true,
    swapType: 'EXACT_INPUT',
    slippageTolerance: input.slippageTolerance,
    originAsset: input.originAsset,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: input.destinationAsset,
    amount: input.amount,
    refundTo: input.refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient: input.recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline: input.deadline,
  };
  return request<QuoteResponse>('/v0/quote', { method: 'POST', body: JSON.stringify(payload) }, fetchImpl);
}

/** Execution status for a live quote's deposit address. */
export async function getStatus(depositAddress: string, depositMemo: string | undefined, fetchImpl: FetchLike = fetch): Promise<unknown> {
  const query = new URLSearchParams({ depositAddress });
  if (depositMemo) query.set('depositMemo', depositMemo);
  return request<unknown>(`/v0/status?${query.toString()}`, { method: 'GET' }, fetchImpl);
}

// ---------------------------------------------------------------------------
// Fixtures: a recorded live quote, so the demo also works with no network.
// ---------------------------------------------------------------------------

export interface QuoteFixture {
  capturedAt: string;
  source: string;
  request: QuoteRequest;
  response: QuoteResponse;
}

export function fixturePath(dir = 'data/fixtures'): string {
  return join(dir, 'quote.json');
}

export async function captureQuote(input: QuoteRequest, dir = 'data/fixtures', fetchImpl: FetchLike = fetch): Promise<QuoteFixture> {
  const response = await requestQuote(input, fetchImpl);
  const fixture: QuoteFixture = {
    capturedAt: new Date().toISOString(),
    source: `${ONE_CLICK_BASE}/v0/quote`,
    request: input,
    response,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(fixturePath(dir), JSON.stringify(fixture, null, 2), 'utf8');
  return fixture;
}

export function loadQuoteFixture(dir = 'data/fixtures'): QuoteFixture {
  const file = fixturePath(dir);
  if (!existsSync(file)) throw new Error(`no quote fixture at ${file}; run "npm run quote:capture" with network access`);
  return JSON.parse(readFileSync(file, 'utf8')) as QuoteFixture;
}

export interface SnapshotOptions {
  /** Policy asset id the action spends, e.g. "NEAR". */
  policyAsset: string;
  /** Destination-chain address the output must go to. */
  destinationAddress: string;
  /** Absolute expiry; defaults to five minutes from now. */
  expiresAt?: string;
  venue?: string;
}

/**
 * Build the quote snapshot the engine checks from a real 1Click response.
 *
 * The engine speaks policy asset ids ("NEAR"), the venue speaks its own
 * ("nep141:wrap.near"), so the translation happens here, once, instead of
 * leaking venue ids into the policy layer.
 */
export function snapshotFromQuote(quote: Quote, fixture: QuoteFixture, options: SnapshotOptions): QuoteSnapshot {
  return {
    venue: options.venue ?? 'near-intents',
    originAsset: options.policyAsset,
    originAssetId: fixture.request.originAsset,
    destinationAsset: fixture.request.destinationAsset,
    destinationAddress: options.destinationAddress,
    amountIn: quote.amountIn,
    amountOut: quote.amountOut,
    minAmountOut: quote.minAmountOut,
    slippageBps: fixture.request.slippageTolerance,
    expiresAt: options.expiresAt ?? new Date(Date.now() + 300_000).toISOString(),
  };
}

