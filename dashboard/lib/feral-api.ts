/**
 * Typed client for the Feral guard API.
 *
 * Requests are relative, so the browser talks to this Next app and the
 * rewrite in next.config.js forwards them to `feral serve` (default
 * http://127.0.0.1:8787). The dashboard holds no authority: every number and
 * every verdict below comes from the same FeralGuard the CLI uses.
 */

export interface FeralPolicy {
  name: string;
  version: number;
  owner: string;
  hash: string;
  paused: boolean;
  expiresAt: number | null;
}

export interface Breaker {
  level: number;
  reason: string;
  expiresAt: number;
}

export interface EffectiveAsset {
  perTx: string;
  daily: string;
  monthly: string;
  spentDay: string;
  aggregateRemaining: string;
}

export interface FeralAgent {
  account: string;
  tier: string;
  reputation: number;
  paused: boolean;
  status: 'active' | 'frozen' | 'paused';
  txCount: number;
  denyCount: number;
  knownCounterparties: string[];
  anomaly: { score: number; flags: string[] };
  breaker: Breaker;
  effective: Record<string, EffectiveAsset>;
}

export interface Approval {
  id: string;
  actionId: string;
  action: { actor: string; kind: string; asset: string; amount: string; to?: string | null };
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'executed' | 'superseded';
}

export interface AnomalyEvent {
  at: string;
  agent: string;
  flags: string[];
  score: number;
  severity: 'low' | 'medium' | 'high';
}

export interface AuditRecord {
  seq: number;
  at: string;
  actor: string;
  agent: string;
  actionId: string;
  kind: string;
  asset: string;
  amount: string;
  to: string | null;
  verdict: 'allow' | 'deny' | 'require_approval';
  reasons: string[];
  riskScore: number;
  policyHash: string;
  reputationBefore: number;
  reputationAfter: number;
  anomalyScore: number;
  circuitBreakerLevel: number;
  hash: string;
}

export interface AggregateRow {
  limit: string;
  spent: string;
  reserved: string;
  remaining: string;
}

export interface Summary {
  policy: FeralPolicy;
  vault: { breaker: Breaker; aggregate: Record<string, AggregateRow> };
  agents: FeralAgent[];
  approvals: Approval[];
  timelocks: { id: string; actionType: string; executesAt: number }[];
  anomalyFeed: AnomalyEvent[];
  audit: AuditRecord[];
  auditHead: { ok: boolean; records: number; head: string; brokenAt?: number };
  uptimeSeconds: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    cache: 'no-store',
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `request failed: ${response.status}`);
  return payload;
}

export function getSummary(): Promise<Summary> {
  return request<Summary>('/api/summary');
}

export function decideApproval(id: string, decision: 'approve' | 'reject'): Promise<unknown> {
  return request(`/api/${decision}`, { method: 'POST', body: JSON.stringify({ id }) });
}
