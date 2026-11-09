/**
 * Feral dashboard server: dependency-free HTTP, JSON API, one static page.
 *
 *   node src/app/server.ts        http://127.0.0.1:8787
 *
 * The server is a window onto the same FeralGuard the CLI uses. It holds no
 * authority of its own: pausing, thawing and approving are the guard's methods,
 * and every refusal is returned as `{ error }` rather than an HTML stack trace.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FeralGuard } from '../core/service.ts';
import { DEFAULT_PRICES, type ActionRequest } from '../core/engine.ts';
import { formatAmount } from '../core/money.ts';

const root = join(import.meta.dirname, '..', '..');
const policyText = readFileSync(join(root, 'examples', 'policy.yaml'), 'utf8');
const guard = FeralGuard.create({ policyText, prices: DEFAULT_PRICES, clock: () => Date.now() });
const STARTED = Date.now();

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

function fail(res: ServerResponse, status: number, error: string): void {
  json(res, status, { error });
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('body must be a JSON object');
  return parsed as Record<string, unknown>;
}

function agentView(account: string) {
  const state = guard.getAgent(account);
  if (!state) return null;
  const limits = guard.getEffectiveLimits(account);
  const assets: Record<string, unknown> = {};
  for (const [assetId, limit] of Object.entries(limits.assets)) {
    const decimals = guard.compiled.assets.get(assetId)?.decimals ?? 0;
    assets[assetId] = {
      ...limit,
      spentDay: formatAmount(guard.getAggregateSpent(assetId, 'day'), decimals),
      aggregateRemaining: formatAmount(guard.getAggregateRemaining(assetId, 'day'), decimals),
    };
  }
  return {
    account: state.account,
    tier: state.tier,
    reputation: guard.getReputation(account),
    paused: state.paused,
    status: state.paused ? 'paused' : guard.getCircuitBreakerLevel(account).level >= 2 ? 'frozen' : 'active',
    txCount: state.txCount,
    denyCount: state.denyCount,
    knownCounterparties: state.knownCounterparties,
    anomaly: { score: guard.getAnomalyScore(account), flags: guard.getAnomalyFlags(account) },
    breaker: guard.getCircuitBreakerLevel(account),
    effective: assets,
  };
}

function summary() {
  const agents = guard.getAgents().map((agent) => agentView(agent.account)).filter((agent) => agent !== null);
  const aggregate: Record<string, unknown> = {};
  for (const [assetId, limit] of guard.compiled.aggregateLimits.daily) {
    const decimals = guard.compiled.assets.get(assetId)?.decimals ?? 0;
    aggregate[assetId] = {
      limit: formatAmount(limit, decimals),
      spent: formatAmount(guard.getAggregateSpent(assetId, 'day'), decimals),
      reserved: formatAmount(guard.getAggregateReserved(assetId, 'day'), decimals),
      remaining: formatAmount(guard.getAggregateRemaining(assetId, 'day'), decimals),
    };
  }
  return {
    policy: {
      name: guard.policyDoc.name,
      version: guard.policyDoc.version,
      owner: guard.policyDoc.owner,
      hash: guard.policyHash,
      paused: guard.policyDoc.paused ?? false,
      expiresAt: guard.policyDoc.expiresAt ?? null,
    },
    vault: { breaker: guard.getCircuitBreakerLevel(), aggregate },
    agents,
    approvals: guard.pendingApprovals,
    timelocks: guard.pendingTimelocks,
    anomalyFeed: guard.anomalyFeed(),
    audit: guard.snapshot().audit,
    auditHead: guard.verifyAudit(),
    uptimeSeconds: Math.floor((Date.now() - STARTED) / 1000),
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const path = url.pathname;
  const method = req.method ?? 'GET';

  try {
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      const page = readFileSync(join(import.meta.dirname, 'ui', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page);
      return;
    }

    if (method === 'GET' && path === '/api/health') {
      json(res, 200, { ok: true, service: 'feral-dashboard', policyHash: guard.policyHash, uptimeSeconds: Math.floor((Date.now() - STARTED) / 1000) });
      return;
    }

    if (method === 'GET' && path === '/api/summary') {
      json(res, 200, summary());
      return;
    }

    if (method === 'GET' && path === '/api/policy') {
      json(res, 200, { hash: guard.policyHash, doc: guard.policyDoc });
      return;
    }

    if (method === 'GET' && path === '/api/agents') {
      json(res, 200, { agents: guard.getAgents().map((agent) => agentView(agent.account)) });
      return;
    }

    if (method === 'GET' && path === '/api/audit') {
      json(res, 200, { audit: guard.snapshot().audit, verify: guard.verifyAudit() });
      return;
    }

    if (method === 'GET' && path === '/api/approvals') {
      json(res, 200, { approvals: guard.pendingApprovals });
      return;
    }

    if (method === 'GET' && path === '/api/timelocks') {
      json(res, 200, { timelocks: guard.pendingTimelocks });
      return;
    }

    if (method === 'GET' && path === '/api/anomaly/feed') {
      json(res, 200, { feed: guard.anomalyFeed() });
      return;
    }

    if (method === 'GET' && path === '/api/circuit-breaker') {
      json(res, 200, guard.getCircuitBreakerLevel());
      return;
    }

    const agentMatch = path.match(/^\/api\/(agents|reputation|anomaly|circuit-breaker)\/([^/]+)(?:\/(pause|unpause|trigger))?$/);
    if (agentMatch) {
      const [, kind, rawAccount, verb] = agentMatch;
      const account = decodeURIComponent(rawAccount);
      if (method === 'GET') {
        if (kind === 'agents') {
          const agent = agentView(account);
          if (!agent) return fail(res, 404, `agent ${account} not found`);
          return json(res, 200, agent);
        }
        if (!guard.getAgent(account)) return fail(res, 404, `agent ${account} not found`);
        if (kind === 'reputation') {
          return json(res, 200, {
            account,
            reputation: guard.getReputation(account),
            effective: guard.getEffectiveLimits(account),
            history: guard.snapshot().audit.filter((record) => record.agent === account).map((record) => ({ at: record.at, before: record.reputationBefore, after: record.reputationAfter, verdict: record.verdict })),
          });
        }
        if (kind === 'anomaly') {
          return json(res, 200, { account, score: guard.getAnomalyScore(account), flags: guard.getAnomalyFlags(account) });
        }
        return json(res, 200, guard.getCircuitBreakerLevel(account));
      }
      if (method === 'POST') {
        if (verb === 'pause') {
          guard.pauseAgent(account);
          return json(res, 200, { ok: true, agent: agentView(account) });
        }
        if (verb === 'unpause') {
          guard.unpauseAgent(account);
          return json(res, 200, { ok: true, agent: agentView(account) });
        }
        if (verb === 'trigger' && kind === 'circuit-breaker') {
          const payload = await body(req);
          guard.triggerCircuitBreaker(account, Number(payload.level ?? 2), String(payload.reason ?? 'manual trigger'));
          return json(res, 200, { ok: true, breaker: guard.getCircuitBreakerLevel(account) });
        }
      }
    }

    if (method === 'GET' && path.startsWith('/api/aggregate/')) {
      const asset = decodeURIComponent(path.slice('/api/aggregate/'.length));
      const decimals = guard.compiled.assets.get(asset)?.decimals ?? 0;
      return json(res, 200, {
        asset,
        day: {
          limit: formatAmount(guard.compiled.aggregateLimits.daily.get(asset) ?? 0n, decimals),
          spent: formatAmount(guard.getAggregateSpent(asset, 'day'), decimals),
          reserved: formatAmount(guard.getAggregateReserved(asset, 'day'), decimals),
          remaining: formatAmount(guard.getAggregateRemaining(asset, 'day'), decimals),
        },
        month: {
          limit: formatAmount(guard.compiled.aggregateLimits.monthly.get(asset) ?? 0n, decimals),
          spent: formatAmount(guard.getAggregateSpent(asset, 'month'), decimals),
          remaining: formatAmount(guard.getAggregateRemaining(asset, 'month'), decimals),
        },
      });
    }

    if (method === 'POST' && path === '/api/evaluate') {
      const payload = await body(req);
      const action = payload.action as ActionRequest | undefined;
      if (!action) return fail(res, 400, 'body.action is required');
      if (payload.dryRun === true) return json(res, 200, { decision: guard.preview(action) });
      return json(res, 200, await guard.submit(action));
    }

    if (method === 'POST' && path === '/api/approve') {
      const payload = await body(req);
      if (typeof payload.id !== 'string') return fail(res, 400, 'body.id is required');
      return json(res, 200, await guard.approve(payload.id, String(payload.approver ?? guard.policyDoc.owner)));
    }

    if (method === 'POST' && path === '/api/reject') {
      const payload = await body(req);
      if (typeof payload.id !== 'string') return fail(res, 400, 'body.id is required');
      return json(res, 200, guard.reject(payload.id, String(payload.approver ?? guard.policyDoc.owner), payload.note === undefined ? undefined : String(payload.note)));
    }

    if (method === 'POST' && path === '/api/simulate') {
      const payload = await body(req);
      if (typeof payload.policy !== 'string') return fail(res, 400, 'body.policy must be policy text');
      return json(res, 200, guard.simulatePolicy(payload.policy));
    }

    if (method === 'POST' && path === '/api/timelock/propose') {
      const payload = await body(req);
      const id = guard.proposeTimelock(String(payload.actionType ?? 'withdraw'), payload.params ?? {});
      return json(res, 200, { id, timelocks: guard.pendingTimelocks });
    }

    const timelockMatch = path.match(/^\/api\/timelock\/([^/]+)\/(cancel|execute)$/);
    if (method === 'POST' && timelockMatch) {
      const [, id, verb] = timelockMatch;
      const payload = await body(req);
      const actor = typeof payload.actor === 'string' ? payload.actor : undefined;
      if (verb === 'cancel') guard.cancelTimelock(id, actor);
      else guard.executeTimelock(id, actor);
      return json(res, 200, { ok: true, pending: guard.pendingTimelocks });
    }

    if (method === 'POST' && path === '/api/emergency-freeze') {
      const payload = await body(req);
      guard.emergencyFreeze(typeof payload.actor === 'string' ? payload.actor : undefined);
      return json(res, 200, { ok: true, breaker: guard.getCircuitBreakerLevel() });
    }

    if (method === 'POST' && path === '/api/thaw') {
      const payload = await body(req);
      guard.thaw(typeof payload.actor === 'string' ? payload.actor : undefined);
      return json(res, 200, { ok: true, breaker: guard.getCircuitBreakerLevel() });
    }

    fail(res, 404, `no route for ${method} ${path}`);
  } catch (err) {
    fail(res, 400, (err as Error).message);
  }
});

const port = Number(process.env.PORT ?? 8787);
server.listen(port, '127.0.0.1', () => {
  console.log(`feral dashboard: http://127.0.0.1:${port}`);
  console.log(`policy ${guard.policyDoc.name}  hash ${guard.policyHash.slice(0, 12)}  ${guard.getAgents().length} agents`);
});
