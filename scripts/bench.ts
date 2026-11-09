/**
 * Latency benchmarks per check shape.
 *
 *   node scripts/bench.ts
 *
 * The engine is pure, so this measures the work the contract has to do on-chain:
 * parse, resolve limits, walk the checks. Numbers are microseconds; they are not
 * a marketing claim, just a way to notice a regression.
 */
import { makeGuard } from '../src/demo/scenarios.ts';
import type { ActionRequest } from '../src/core/engine.ts';

const { guard } = makeGuard();
guard.triggerCircuitBreaker('argo.near', 1, 'benchmark');

const shapes: { name: string; action: ActionRequest }[] = [
  { name: 'ft.transfer (USDC, allow-listed vendor)', action: { id: 'bench_1', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '5', to: 'compute.near' } },
  { name: 'ft.transfer (USDC, over per-tx cap)', action: { id: 'bench_2', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '26', to: 'compute.near' } },
  { name: 'native transfer (NEAR, stranger)', action: { id: 'bench_3', kind: 'near.transfer', actor: 'argo.near', asset: 'NEAR', amount: '0.1', to: 'attacker.near' } },
  { name: 'denied action kind (key.add)', action: { id: 'bench_4', kind: 'key.add', actor: 'argo.near', asset: 'NEAR', amount: '0.01', to: 'compute.near' } },
  { name: 'multi-agent aggregate check (scout)', action: { id: 'bench_5', kind: 'ft.transfer', actor: 'scout.near', asset: 'USDC', amount: '5', to: 'compute.near' } },
  { name: 'anomaly burst detection (sentry)', action: { id: 'bench_6', kind: 'ft.transfer', actor: 'sentry.near', asset: 'USDC', amount: '5', to: 'compute.near' } },
  { name: 'circuit breaker level 1 (argo)', action: { id: 'bench_7', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '1', to: 'compute.near' } },
];

const width = 46;
console.log('');
console.log('feral bench - pure engine, 2000 evaluations per shape');
console.log('');
console.log(`${'shape'.padEnd(width)}  ${'p50'.padEnd(10)}  ${'p95'.padEnd(10)}  ${'p99'.padEnd(10)}  max`);
console.log('-'.repeat(width + 44));

for (const shape of shapes) {
  const samples: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const started = performance.now();
    guard.preview({ ...shape.action, id: `${shape.action.id}_${i}` });
    samples.push((performance.now() - started) * 1000);
  }
  samples.sort((a, b) => a - b);
  const at = (fraction: number): number => samples[Math.min(samples.length - 1, Math.floor(samples.length * fraction))];
  const fmt = (value: number): string => `${value.toFixed(2)} us`;
  console.log(`${shape.name.padEnd(width)}  ${fmt(at(0.5)).padEnd(10)}  ${fmt(at(0.95)).padEnd(10)}  ${fmt(at(0.99)).padEnd(10)}  ${fmt(samples[samples.length - 1])}`);
}
