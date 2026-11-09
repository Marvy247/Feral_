/**
 * Policy documents: parsing, strict validation, and compilation to the immutable
 * form the engine evaluates.
 *
 * Design rule: the policy is data, never code. It is written by a human, pinned
 * by hash, and evaluated by a pure function. Nothing an agent says at runtime
 * can add a rule, relax a limit or reorder a comparison.
 *
 * Version 2 adds everything Feral enforces beyond a single spending firewall:
 * multiple agents with per-agent limits, aggregate vault caps, adaptive
 * reputation, anomaly thresholds, circuit breakers and governance.
 */
import { AmountError, DEFAULT_ASSETS, parseAmount, formatAmount, type Asset } from './money.ts';
import { hashObject, canonicalJson } from './canonical.ts';
import { parseConfig } from './yaml.ts';
import {
  defaultReputationConfig,
  type ReputationConfig,
} from './reputation.ts';
import { defaultAnomalyConfig, type AnomalyConfig } from './anomaly.ts';

export const POLICY_VERSION = 2;

export type ActionKind =
  | 'near.transfer'
  | 'ft.transfer'
  | 'intent.swap'
  | 'api.pay'
  | 'key.add'
  | 'key.delete'
  | 'contract.call'
  | 'stake.delegate';

export const ACTION_KINDS: readonly ActionKind[] = [
  'near.transfer',
  'ft.transfer',
  'intent.swap',
  'api.pay',
  'key.add',
  'key.delete',
  'contract.call',
  'stake.delegate',
];

export interface AssetSpec {
  symbol: string;
  decimals: number;
  contract?: string;
}

export type AmountMap = Record<string, string | number>;

export interface AgentLimitsSpec {
  perTx?: AmountMap;
  daily?: AmountMap;
  monthly?: AmountMap;
}

export interface AgentSpec {
  account: string;
  tier: 'worker' | 'supervisor';
  limits: AgentLimitsSpec;
  attestationHash?: string;
}

export interface CircuitBreakerConfig {
  level1Duration: number;
  level1LimitFraction: number;
  level2RequiresOwner: boolean;
  level3RequiresQuorum: number;
  level4Timelock: number;
}

export interface GovernanceConfig {
  timelockDelay: number;
  watcherCanCancel: boolean;
}

export interface PolicyDoc {
  version: number;
  name: string;
  owner: string;
  /** Multisig owner support: M-of-N members may administer the vault. */
  multisig?: { threshold: number; members: string[] };
  /** Watchers may cancel timelocked administrative actions. */
  watchers?: string[];
  /** Guardians may trigger an emergency freeze. */
  guardians?: string[];
  /** Multiple agents under one vault. */
  agents?: AgentSpec[];
  /** Backward-compatible single-agent form. */
  agent?: string;
  expiresAt?: string;
  paused?: boolean;
  assets?: Record<string, AssetSpec>;
  limits: {
    perTx?: AmountMap;
    daily?: AmountMap;
    monthly?: AmountMap;
    defaultPerTxUsd?: number;
    /** Vault-wide caps shared by every agent. */
    aggregate?: {
      daily?: AmountMap;
      monthly?: AmountMap;
    };
  };
  counterparties?: {
    mode?: 'strict' | 'open';
    allow?: string[];
    deny?: string[];
    requireApprovalForNew?: boolean;
  };
  approvals?: {
    thresholdUsd?: number;
    approvers?: string[];
    quorum?: number;
    ttlSeconds?: number;
  };
  velocity?: {
    maxTxPerHour?: number;
    minIntervalSeconds?: number;
  };
  actions?: {
    allow?: ActionKind[];
    deny?: ActionKind[];
  };
  intents?: {
    venues?: string[];
    maxSlippageBps?: number;
    requireAllowlistedDestination?: boolean;
    /** Foreign-chain addresses (0x..., bc1..., etc.) the agent may swap out to. */
    allowedDestinations?: string[];
    perChainLimits?: Record<string, { daily?: number; monthly?: number }>;
  };
  risk?: {
    escalateAboveBudgetFraction?: number;
    escalateOnNewCounterparty?: boolean;
  };
  reputation?: Partial<ReputationConfig>;
  anomaly?: {
    burstThreshold?: number;
    drainageThreshold?: number;
    deviationSigma?: number;
    baselineUpdateInterval?: number;
    autoEscalate?: boolean;
  };
  circuitBreakers?: Partial<CircuitBreakerConfig>;
  governance?: Partial<GovernanceConfig>;
}

export interface PolicyIssue {
  path: string;
  message: string;
}

export class PolicyError extends Error {
  issues: PolicyIssue[];
  constructor(issues: PolicyIssue[]) {
    super(`invalid policy: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
    this.name = 'PolicyError';
    this.issues = issues;
  }
}

export interface AssetLimits {
  perTx: Map<string, bigint>;
  daily: Map<string, bigint>;
  monthly: Map<string, bigint>;
}

export interface CompiledPolicy {
  doc: PolicyDoc;
  hash: string;
  assets: Map<string, Asset>;
  /** Resolved limits for the primary agent (kept for convenience / legacy). */
  limits: AssetLimits & { defaultPerTxUsdCents?: bigint };
  /** Resolved per-agent limits, keyed by account id. */
  agentLimits: Map<string, AssetLimits>;
  /** Normalised agent list (an explicit `agent` becomes one entry). */
  agents: AgentSpec[];
  aggregateLimits: { daily: Map<string, bigint>; monthly: Map<string, bigint> };
  allow: Set<string>;
  deny: Set<string>;
  strictCounterparties: boolean;
  requireApprovalForNew: boolean;
  allowedActions: Set<ActionKind> | null;
  deniedActions: Set<ActionKind>;
  approval: {
    thresholdUsdCents?: bigint;
    approvers: string[];
    quorum: number;
    ttlSeconds: number;
  };
  velocity: { maxTxPerHour: number; minIntervalSeconds: number };
  intents: {
    venues: Set<string>;
    maxSlippageBps: number;
    requireAllowlistedDestination: boolean;
    allowedDestinations: Set<string>;
    perChainLimits: Record<string, { daily?: number; monthly?: number }>;
  };
  risk: {
    escalateAboveBudgetFraction: number | null;
    escalateOnNewCounterparty: boolean;
  };
  reputation: ReputationConfig;
  anomaly: AnomalyConfig;
  circuitBreakers: CircuitBreakerConfig;
  governance: GovernanceConfig;
  multisig: { threshold: number; members: string[] };
  watchers: string[];
  guardians: string[];
  expiresAt: number | null;
  warnings: PolicyIssue[];
}

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isValidAccountId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length < 2 || value.length > 64) return false;
  return ACCOUNT_RE.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function amountText(value: unknown, path: string, issues: PolicyIssue[]): string | null {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return value.toString();
  issues.push({ path, message: `expected an amount (string or number), got ${typeof value}` });
  return null;
}

function readAssetMap(
  source: Record<string, unknown>,
  path: string,
  issues: PolicyIssue[],
  registry: Map<string, Asset>,
): Map<string, bigint> | null {
  const out = new Map<string, bigint>();
  for (const [key, raw] of Object.entries(source)) {
    const text = amountText(raw, `${path}.${key}`, issues);
    if (text === null) continue;
    if (!registry.has(key) && !key.match(/^[A-Za-z0-9:_-]{1,64}$/)) {
      issues.push({ path: `${path}.${key}`, message: 'asset id has invalid characters' });
      continue;
    }
    try {
      const decimals = registry.get(key)?.decimals ?? 0;
      const parsed = parseAmount(text, decimals);
      if (parsed <= 0n) issues.push({ path: `${path}.${key}`, message: 'limit must be positive' });
      else out.set(key, parsed);
    } catch (err) {
      issues.push({ path: `${path}.${key}`, message: (err as AmountError).message });
    }
  }
  return out;
}

function hasEntries(map: AmountMap | undefined): boolean {
  return map !== undefined && Object.keys(map).length > 0;
}

function readLimitBlock(
  raw: unknown,
  path: string,
  issues: PolicyIssue[],
  registry: Map<string, Asset>,
): AgentLimitsSpec {
  const out: AgentLimitsSpec = {};
  if (!isPlainObject(raw)) {
    issues.push({ path, message: 'must be a map (perTx/daily/monthly)' });
    return out;
  }
  for (const key of ['perTx', 'daily', 'monthly'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (!isPlainObject(value)) {
      issues.push({ path: `${path}.${key}`, message: 'must be a map of asset id to amount' });
      continue;
    }
    readAssetMap(value, `${path}.${key}`, issues, registry);
    out[key] = value as AmountMap;
  }
  return out;
}

function numberInRange(
  value: unknown,
  path: string,
  issues: PolicyIssue[],
  min: number,
  max: number,
  integer = false,
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    issues.push({ path, message: `must be a number between ${min} and ${max}` });
    return undefined;
  }
  if (integer && !Number.isInteger(value)) {
    issues.push({ path, message: 'must be an integer' });
    return undefined;
  }
  return value;
}

function accountList(raw: unknown, path: string, issues: PolicyIssue[]): string[] | undefined {
  if (!Array.isArray(raw)) {
    issues.push({ path, message: 'must be a list of account ids' });
    return undefined;
  }
  const list: string[] = [];
  for (const [i, entry] of raw.entries()) {
    if (!isValidAccountId(entry)) issues.push({ path: `${path}[${i}]`, message: `invalid account id: ${String(entry)}` });
    else list.push(entry);
  }
  return list;
}

/** Validate raw parsed YAML/JSON into a structurally sound v2 policy document. */
export function validatePolicy(input: unknown): { doc: PolicyDoc; warnings: PolicyIssue[] } {
  const issues: PolicyIssue[] = [];
  const warnings: PolicyIssue[] = [];

  if (!isPlainObject(input)) throw new PolicyError([{ path: '', message: 'policy must be an object' }]);

  const doc: PolicyDoc = { version: 0, name: '', owner: '', limits: {} };

  if (input.version !== POLICY_VERSION) {
    issues.push({ path: 'version', message: `expected ${POLICY_VERSION}, got ${String(input.version)}` });
  } else doc.version = POLICY_VERSION;

  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    issues.push({ path: 'name', message: 'required, non-empty' });
  } else doc.name = input.name.trim();

  if (!isValidAccountId(input.owner)) issues.push({ path: 'owner', message: 'must be a lowercase NEAR account id' });
  else doc.owner = input.owner;

  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    if (typeof input.expiresAt !== 'string' || Number.isNaN(Date.parse(input.expiresAt))) {
      issues.push({ path: 'expiresAt', message: 'must be an ISO 8601 timestamp' });
    } else doc.expiresAt = input.expiresAt;
  }

  if (input.paused !== undefined) {
    if (typeof input.paused !== 'boolean') issues.push({ path: 'paused', message: 'must be a boolean' });
    else doc.paused = input.paused;
  }

  if (input.assets !== undefined) {
    if (!isPlainObject(input.assets)) issues.push({ path: 'assets', message: 'must be a map' });
    else {
      const assets: Record<string, AssetSpec> = {};
      for (const [id, raw] of Object.entries(input.assets)) {
        if (!isPlainObject(raw)) {
          issues.push({ path: `assets.${id}`, message: 'must be a map with symbol and decimals' });
          continue;
        }
        const decimals = raw.decimals;
        if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 24) {
          issues.push({ path: `assets.${id}.decimals`, message: 'must be an integer between 0 and 24' });
          continue;
        }
        const symbol = typeof raw.symbol === 'string' && raw.symbol.length > 0 ? raw.symbol : id;
        const spec: AssetSpec = { symbol, decimals };
        if (typeof raw.contract === 'string') spec.contract = raw.contract;
        assets[id] = spec;
      }
      doc.assets = assets;
    }
  }

  const registry = new Map<string, Asset>(Object.entries(DEFAULT_ASSETS));
  for (const [id, spec] of Object.entries(doc.assets ?? {})) {
    registry.set(id, { id, symbol: spec.symbol, decimals: spec.decimals, contract: spec.contract });
  }

  // ---- top-level limits (also the default for agents without their own) ----
  const limitsRaw = input.limits;
  if (!isPlainObject(limitsRaw)) {
    issues.push({ path: 'limits', message: 'required map (perTx/daily/monthly)' });
  } else {
    const limits: PolicyDoc['limits'] = {};
    for (const key of ['perTx', 'daily', 'monthly'] as const) {
      const raw = limitsRaw[key];
      if (raw === undefined) continue;
      if (!isPlainObject(raw)) {
        issues.push({ path: `limits.${key}`, message: 'must be a map of asset id to amount' });
        continue;
      }
      readAssetMap(raw, `limits.${key}`, issues, registry);
      limits[key] = raw as AmountMap;
    }
    if (limitsRaw.defaultPerTxUsd !== undefined) {
      const v = numberInRange(limitsRaw.defaultPerTxUsd, 'limits.defaultPerTxUsd', issues, 0.01, Number.MAX_SAFE_INTEGER);
      if (v !== undefined) limits.defaultPerTxUsd = v;
    }
    if (limitsRaw.aggregate !== undefined) {
      if (!isPlainObject(limitsRaw.aggregate)) {
        issues.push({ path: 'limits.aggregate', message: 'must be a map with daily/monthly' });
      } else {
        const aggregate: NonNullable<PolicyDoc['limits']['aggregate']> = {};
        for (const key of ['daily', 'monthly'] as const) {
          const raw = limitsRaw.aggregate[key];
          if (raw === undefined) continue;
          if (!isPlainObject(raw)) {
            issues.push({ path: `limits.aggregate.${key}`, message: 'must be a map of asset id to amount' });
            continue;
          }
          readAssetMap(raw, `limits.aggregate.${key}`, issues, registry);
          aggregate[key] = raw as AmountMap;
        }
        limits.aggregate = aggregate;
      }
    }
    doc.limits = limits;
  }

  // ---- agents ------------------------------------------------------------
  const agents: AgentSpec[] = [];
  if (input.agents !== undefined) {
    if (!Array.isArray(input.agents)) {
      issues.push({ path: 'agents', message: 'must be a list' });
    } else if (input.agents.length === 0 && input.agent === undefined) {
      // An empty list is only valid in legacy single-agent mode, where `agent`
      // supplies the one account.
      issues.push({ path: 'agents', message: 'must be a non-empty list' });
    } else {
      for (const [i, raw] of input.agents.entries()) {
        if (!isPlainObject(raw)) {
          issues.push({ path: `agents[${i}]`, message: 'must be a map' });
          continue;
        }
        if (!isValidAccountId(raw.account)) {
          issues.push({ path: `agents[${i}].account`, message: 'must be a lowercase NEAR account id' });
          continue;
        }
        if (agents.some((a) => a.account === raw.account)) {
          issues.push({ path: `agents[${i}].account`, message: `duplicate agent ${String(raw.account)}` });
          continue;
        }
        const tier = raw.tier === undefined ? 'worker' : raw.tier;
        if (tier !== 'worker' && tier !== 'supervisor') {
          issues.push({ path: `agents[${i}].tier`, message: "must be 'worker' or 'supervisor'" });
          continue;
        }
        const spec: AgentSpec = {
          account: raw.account,
          tier,
          limits: readLimitBlock(raw.limits, `agents[${i}].limits`, issues, registry),
        };
        if (raw.attestationHash !== undefined) {
          if (typeof raw.attestationHash !== 'string') {
            issues.push({ path: `agents[${i}].attestationHash`, message: 'must be a hex string' });
          } else spec.attestationHash = raw.attestationHash;
        }
        agents.push(spec);
      }
    }
  }

  if (input.agent !== undefined) {
    if (!isValidAccountId(input.agent)) {
      issues.push({ path: 'agent', message: 'must be a lowercase NEAR account id' });
    } else {
      doc.agent = input.agent;
      if (agents.length === 0) {
        agents.push({ account: input.agent, tier: 'worker', limits: {} });
      }
    }
  }

  if (agents.length === 0) {
    issues.push({ path: 'agents', message: 'at least one agent (or the legacy `agent` field) is required' });
  }
  for (const spec of agents) {
    if (spec.account === doc.owner) {
      issues.push({ path: `agents.${spec.account}`, message: 'agent must be a different account than owner, otherwise nothing is enforced' });
    }
  }
  if (agents.length > 0 && doc.agent === undefined) doc.agent = agents[0].account;
  doc.agents = agents;

  // ---- counterparties ----------------------------------------------------
  if (input.counterparties !== undefined) {
    if (!isPlainObject(input.counterparties)) issues.push({ path: 'counterparties', message: 'must be a map' });
    else {
      const cp = input.counterparties;
      const out: NonNullable<PolicyDoc['counterparties']> = {};
      if (cp.mode !== undefined) {
        if (cp.mode !== 'strict' && cp.mode !== 'open') issues.push({ path: 'counterparties.mode', message: "must be 'strict' or 'open'" });
        else out.mode = cp.mode;
      }
      for (const key of ['allow', 'deny'] as const) {
        const raw = cp[key];
        if (raw === undefined) continue;
        const list = accountList(raw, `counterparties.${key}`, issues);
        if (list) out[key] = list;
      }
      if (cp.requireApprovalForNew !== undefined) {
        if (typeof cp.requireApprovalForNew !== 'boolean') issues.push({ path: 'counterparties.requireApprovalForNew', message: 'must be a boolean' });
        else out.requireApprovalForNew = cp.requireApprovalForNew;
      }
      doc.counterparties = out;
    }
  }

  // ---- approvals ---------------------------------------------------------
  if (input.approvals !== undefined) {
    if (!isPlainObject(input.approvals)) issues.push({ path: 'approvals', message: 'must be a map' });
    else {
      const ap = input.approvals;
      const out: NonNullable<PolicyDoc['approvals']> = {};
      if (ap.thresholdUsd !== undefined) {
        const v = numberInRange(ap.thresholdUsd, 'approvals.thresholdUsd', issues, 0.01, Number.MAX_SAFE_INTEGER);
        if (v !== undefined) out.thresholdUsd = v;
      }
      if (ap.approvers !== undefined) {
        if (!Array.isArray(ap.approvers) || ap.approvers.length === 0) {
          issues.push({ path: 'approvals.approvers', message: 'must be a non-empty list of account ids' });
        } else {
          const list = accountList(ap.approvers, 'approvals.approvers', issues);
          if (list) out.approvers = list;
        }
      }
      if (ap.quorum !== undefined) {
        const v = numberInRange(ap.quorum, 'approvals.quorum', issues, 1, 100, true);
        if (v !== undefined) out.quorum = v;
      }
      if (ap.ttlSeconds !== undefined) {
        const v = numberInRange(ap.ttlSeconds, 'approvals.ttlSeconds', issues, 0, 30 * 86_400, true);
        if (v !== undefined) out.ttlSeconds = v;
      }
      if (out.thresholdUsd !== undefined && out.approvers === undefined) {
        issues.push({ path: 'approvals.approvers', message: 'required when thresholdUsd is set' });
      }
      doc.approvals = out;
    }
  }

  // ---- velocity ----------------------------------------------------------
  if (input.velocity !== undefined) {
    if (!isPlainObject(input.velocity)) issues.push({ path: 'velocity', message: 'must be a map' });
    else {
      const v = input.velocity;
      const out: NonNullable<PolicyDoc['velocity']> = {};
      for (const key of ['maxTxPerHour', 'minIntervalSeconds'] as const) {
        const raw = v[key];
        if (raw === undefined) continue;
        const n = numberInRange(raw, `velocity.${key}`, issues, 0, 1_000_000, true);
        if (n !== undefined) out[key] = n;
      }
      doc.velocity = out;
    }
  }

  // ---- actions -----------------------------------------------------------
  if (input.actions !== undefined) {
    if (!isPlainObject(input.actions)) issues.push({ path: 'actions', message: 'must be a map' });
    else {
      const out: NonNullable<PolicyDoc['actions']> = {};
      for (const key of ['allow', 'deny'] as const) {
        const raw = input.actions[key];
        if (raw === undefined) continue;
        if (!Array.isArray(raw)) {
          issues.push({ path: `actions.${key}`, message: 'must be a list of action kinds' });
          continue;
        }
        const list: ActionKind[] = [];
        for (const [i, entry] of raw.entries()) {
          if (typeof entry !== 'string' || !ACTION_KINDS.includes(entry as ActionKind)) {
            issues.push({ path: `actions.${key}[${i}]`, message: `unknown action kind: ${String(entry)}` });
          } else list.push(entry as ActionKind);
        }
        out[key] = list;
      }
      if (out.allow && out.deny) {
        for (const kind of out.allow.filter((k) => out.deny?.includes(k))) {
          issues.push({ path: 'actions', message: `${kind} is both allowed and denied` });
        }
      }
      doc.actions = out;
    }
  }

  // ---- intents -----------------------------------------------------------
  if (input.intents !== undefined) {
    if (!isPlainObject(input.intents)) issues.push({ path: 'intents', message: 'must be a map' });
    else {
      const it = input.intents;
      const out: NonNullable<PolicyDoc['intents']> = {};
      if (it.venues !== undefined) {
        if (!Array.isArray(it.venues) || it.venues.some((v) => typeof v !== 'string')) {
          issues.push({ path: 'intents.venues', message: 'must be a list of strings' });
        } else out.venues = it.venues as string[];
      }
      if (it.maxSlippageBps !== undefined) {
        const v = numberInRange(it.maxSlippageBps, 'intents.maxSlippageBps', issues, 0, 10_000, true);
        if (v !== undefined) out.maxSlippageBps = v;
      }
      if (it.requireAllowlistedDestination !== undefined) {
        if (typeof it.requireAllowlistedDestination !== 'boolean') {
          issues.push({ path: 'intents.requireAllowlistedDestination', message: 'must be a boolean' });
        } else out.requireAllowlistedDestination = it.requireAllowlistedDestination;
      }
      if (it.allowedDestinations !== undefined) {
        if (!Array.isArray(it.allowedDestinations) || it.allowedDestinations.some((v) => typeof v !== 'string' || v.length === 0)) {
          issues.push({ path: 'intents.allowedDestinations', message: 'must be a list of non-empty address strings' });
        } else out.allowedDestinations = (it.allowedDestinations as string[]).map((v) => v.trim());
      }
      if (it.perChainLimits !== undefined) {
        if (!isPlainObject(it.perChainLimits)) {
          issues.push({ path: 'intents.perChainLimits', message: 'must be a map of chain to {daily, monthly}' });
        } else {
          const chains: Record<string, { daily?: number; monthly?: number }> = {};
          for (const [chain, raw] of Object.entries(it.perChainLimits)) {
            if (!isPlainObject(raw)) {
              issues.push({ path: `intents.perChainLimits.${chain}`, message: 'must be a map' });
              continue;
            }
            const entry: { daily?: number; monthly?: number } = {};
            if (raw.daily !== undefined) {
              const v = numberInRange(raw.daily, `intents.perChainLimits.${chain}.daily`, issues, 0, Number.MAX_SAFE_INTEGER);
              if (v !== undefined) entry.daily = v;
            }
            if (raw.monthly !== undefined) {
              const v = numberInRange(raw.monthly, `intents.perChainLimits.${chain}.monthly`, issues, 0, Number.MAX_SAFE_INTEGER);
              if (v !== undefined) entry.monthly = v;
            }
            chains[chain] = entry;
          }
          out.perChainLimits = chains;
        }
      }
      doc.intents = out;
    }
  }

  // ---- risk --------------------------------------------------------------
  if (input.risk !== undefined) {
    if (!isPlainObject(input.risk)) issues.push({ path: 'risk', message: 'must be a map' });
    else {
      const r = input.risk;
      const out: NonNullable<PolicyDoc['risk']> = {};
      if (r.escalateAboveBudgetFraction !== undefined) {
        const v = numberInRange(r.escalateAboveBudgetFraction, 'risk.escalateAboveBudgetFraction', issues, 0.001, 1);
        if (v !== undefined) out.escalateAboveBudgetFraction = v;
      }
      if (r.escalateOnNewCounterparty !== undefined) {
        if (typeof r.escalateOnNewCounterparty !== 'boolean') issues.push({ path: 'risk.escalateOnNewCounterparty', message: 'must be a boolean' });
        else out.escalateOnNewCounterparty = r.escalateOnNewCounterparty;
      }
      doc.risk = out;
    }
  }

  // ---- governance --------------------------------------------------------
  if (input.multisig !== undefined) {
    if (!isPlainObject(input.multisig)) issues.push({ path: 'multisig', message: 'must be a map' });
    else {
      const members = input.multisig.members === undefined ? [] : accountList(input.multisig.members, 'multisig.members', issues);
      const threshold = input.multisig.threshold === undefined
        ? 0
        : numberInRange(input.multisig.threshold, 'multisig.threshold', issues, 0, 100, true);
      if (threshold !== undefined && threshold > 0 && (members?.length ?? 0) < threshold) {
        issues.push({ path: 'multisig.threshold', message: 'cannot exceed the number of members' });
      }
      if (members && threshold !== undefined) doc.multisig = { threshold, members };
    }
  }
  if (input.watchers !== undefined) {
    const list = accountList(input.watchers, 'watchers', issues);
    if (list) doc.watchers = list;
  }
  if (input.guardians !== undefined) {
    const list = accountList(input.guardians, 'guardians', issues);
    if (list) doc.guardians = list;
  }
  if (input.governance !== undefined) {
    if (!isPlainObject(input.governance)) issues.push({ path: 'governance', message: 'must be a map' });
    else {
      const g = input.governance;
      const out: NonNullable<PolicyDoc['governance']> = {};
      if (g.timelockDelay !== undefined) {
        const v = numberInRange(g.timelockDelay, 'governance.timelockDelay', issues, 0, 365 * 86_400, true);
        if (v !== undefined) out.timelockDelay = v;
      }
      if (g.watcherCanCancel !== undefined) {
        if (typeof g.watcherCanCancel !== 'boolean') issues.push({ path: 'governance.watcherCanCancel', message: 'must be a boolean' });
        else out.watcherCanCancel = g.watcherCanCancel;
      }
      doc.governance = out;
    }
  }

  if (input.reputation !== undefined) {
    if (!isPlainObject(input.reputation)) issues.push({ path: 'reputation', message: 'must be a map' });
    else {
      const r = input.reputation;
      const out: Partial<ReputationConfig> = {};
      for (const key of ['initial', 'cleanSpendBonus', 'denyPenalty', 'approvalBonus', 'anomalyPenalty', 'freezeThreshold'] as const) {
        if (r[key] === undefined) continue;
        const v = numberInRange(r[key], `reputation.${key}`, issues, 0, 100, true);
        if (v !== undefined) out[key] = v;
      }
      for (const key of ['recoveryWindowDays', 'recoveryBonus'] as const) {
        if (r[key] === undefined) continue;
        const v = numberInRange(r[key], `reputation.${key}`, issues, 0, 3650, true);
        if (v !== undefined) out[key] = v;
      }
      doc.reputation = out;
    }
  }

  if (input.anomaly !== undefined) {
    if (!isPlainObject(input.anomaly)) issues.push({ path: 'anomaly', message: 'must be a map' });
    else {
      const a = input.anomaly;
      const out: NonNullable<PolicyDoc['anomaly']> = {};
      if (a.burstThreshold !== undefined) {
        const v = numberInRange(a.burstThreshold, 'anomaly.burstThreshold', issues, 1, 1000, true);
        if (v !== undefined) out.burstThreshold = v;
      }
      if (a.drainageThreshold !== undefined) {
        const v = numberInRange(a.drainageThreshold, 'anomaly.drainageThreshold', issues, 0.01, 1);
        if (v !== undefined) out.drainageThreshold = v;
      }
      if (a.deviationSigma !== undefined) {
        const v = numberInRange(a.deviationSigma, 'anomaly.deviationSigma', issues, 1, 100, true);
        if (v !== undefined) out.deviationSigma = v;
      }
      if (a.baselineUpdateInterval !== undefined) {
        const v = numberInRange(a.baselineUpdateInterval, 'anomaly.baselineUpdateInterval', issues, 1, 100_000, true);
        if (v !== undefined) out.baselineUpdateInterval = v;
      }
      if (a.autoEscalate !== undefined) {
        if (typeof a.autoEscalate !== 'boolean') issues.push({ path: 'anomaly.autoEscalate', message: 'must be a boolean' });
        else out.autoEscalate = a.autoEscalate;
      }
      doc.anomaly = out;
    }
  }

  if (input.circuitBreakers !== undefined) {
    if (!isPlainObject(input.circuitBreakers)) issues.push({ path: 'circuitBreakers', message: 'must be a map' });
    else {
      const c = input.circuitBreakers;
      const out: Partial<CircuitBreakerConfig> = {};
      const numeric: [keyof CircuitBreakerConfig, number, number, boolean][] = [
        ['level1Duration', 0, 7 * 86_400, true],
        ['level1LimitFraction', 0.01, 1, false],
        ['level2RequiresOwner', 0, 1, false],
        ['level3RequiresQuorum', 1, 100, true],
        ['level4Timelock', 0, 365 * 86_400, true],
      ];
      for (const [key, min, max, integer] of numeric) {
        const raw = c[key];
        if (raw === undefined) continue;
        if (key === 'level2RequiresOwner') {
          if (typeof raw !== 'boolean') issues.push({ path: `circuitBreakers.${key}`, message: 'must be a boolean' });
          else continue;
        }
        const v = numberInRange(raw, `circuitBreakers.${key}`, issues, min, max, integer);
        if (v !== undefined) (out as Record<string, unknown>)[key] = v;
      }
      doc.circuitBreakers = out;
    }
  }

  // ---- cross checks ------------------------------------------------------
  if (doc.limits.perTx && doc.limits.daily) {
    for (const [asset, perTx] of Object.entries(doc.limits.perTx)) {
      const daily = doc.limits.daily[asset];
      if (daily === undefined) continue;
      try {
        const decimals = registry.get(asset)?.decimals ?? 0;
        if (parseAmount(String(daily), decimals) < parseAmount(String(perTx), decimals)) {
          warnings.push({ path: `limits.daily.${asset}`, message: 'daily limit is lower than the per-transaction limit' });
        }
      } catch {
        /* already reported */
      }
    }
  }

  const agentHasLimits = agents.some((a) => hasEntries(a.limits.perTx) || hasEntries(a.limits.daily));
  const hasTopLevelBound = hasEntries(doc.limits.perTx) || doc.limits.defaultPerTxUsd !== undefined;
  if (!hasTopLevelBound && !agentHasLimits) {
    issues.push({ path: 'limits.perTx', message: 'either perTx limits (top-level or per agent) or defaultPerTxUsd is required, otherwise nothing bounds a transfer' });
  }

  if (issues.length > 0) throw new PolicyError(issues);
  return { doc, warnings };
}

/** Parse YAML or JSON text into a validated policy document. */
export function loadPolicy(source: string): { doc: PolicyDoc; warnings: PolicyIssue[] } {
  return validatePolicy(parseConfig(source));
}

/** Compile a validated document into the immutable structure the engine uses. */
export function compilePolicy(doc: PolicyDoc): CompiledPolicy {
  const warnings: PolicyIssue[] = [];
  const assets = new Map<string, Asset>();
  for (const [id, asset] of Object.entries(DEFAULT_ASSETS)) assets.set(id, asset);
  for (const [id, spec] of Object.entries(doc.assets ?? {})) {
    assets.set(id, { id, symbol: spec.symbol, decimals: spec.decimals, contract: spec.contract });
  }

  const resolve = (map: AmountMap | undefined): Map<string, bigint> => {
    const out = new Map<string, bigint>();
    for (const [id, raw] of Object.entries(map ?? {})) {
      const asset = assets.get(id);
      if (!asset) {
        throw new PolicyError([{ path: `limits.*.${id}`, message: 'asset is not in the registry; declare it under assets' }]);
      }
      out.set(id, parseAmount(String(raw), asset.decimals));
    }
    return out;
  };

  const resolveLimits = (spec: AgentLimitsSpec | undefined): AssetLimits => ({
    perTx: resolve(spec?.perTx ?? doc.limits.perTx),
    daily: resolve(spec?.daily ?? doc.limits.daily),
    monthly: resolve(spec?.monthly ?? doc.limits.monthly),
  });

  const agents: AgentSpec[] = (doc.agents && doc.agents.length > 0)
    ? doc.agents.map((a) => ({ ...a, limits: { ...a.limits } }))
    : doc.agent
      ? [{ account: doc.agent, tier: 'worker', limits: {} }]
      : [];

  const agentLimits = new Map<string, AssetLimits>();
  for (const spec of agents) agentLimits.set(spec.account, resolveLimits(spec.limits));

  const primary = agents[0]?.account ?? doc.agent ?? '';
  const primaryLimits = primary ? agentLimits.get(primary) ?? resolveLimits(undefined) : resolveLimits(undefined);

  const allowedActions = doc.actions?.allow && doc.actions.allow.length > 0 ? new Set(doc.actions.allow) : null;
  const deniedActions = new Set<ActionKind>(doc.actions?.deny ?? []);
  const allow = new Set<string>(doc.counterparties?.allow ?? []);
  const deny = new Set<string>(doc.counterparties?.deny ?? []);
  const strictCounterparties =
    doc.counterparties?.mode === 'strict' || (doc.counterparties?.mode !== 'open' && allow.size > 0);

  const reputation: ReputationConfig = { ...defaultReputationConfig(), ...(doc.reputation ?? {}) };
  const anomalyDefaults = defaultAnomalyConfig();
  const anomaly: AnomalyConfig = {
    burstThreshold: doc.anomaly?.burstThreshold ?? anomalyDefaults.burstThreshold,
    burstWindowMs: anomalyDefaults.burstWindowMs,
    drainageThresholdBps:
      doc.anomaly?.drainageThreshold !== undefined
        ? Math.round(doc.anomaly.drainageThreshold * 10_000)
        : anomalyDefaults.drainageThresholdBps,
    deviationSigma: doc.anomaly?.deviationSigma ?? anomalyDefaults.deviationSigma,
    baselineUpdateInterval: doc.anomaly?.baselineUpdateInterval ?? anomalyDefaults.baselineUpdateInterval,
    autoEscalate: doc.anomaly?.autoEscalate ?? anomalyDefaults.autoEscalate,
  };

  const compiled: CompiledPolicy = {
    doc: { ...doc, agent: primary },
    hash: hashObject(doc),
    assets,
    limits: {
      ...primaryLimits,
      defaultPerTxUsdCents:
        doc.limits.defaultPerTxUsd === undefined ? undefined : BigInt(Math.round(doc.limits.defaultPerTxUsd * 100)),
    },
    agentLimits,
    agents,
    aggregateLimits: {
      daily: resolve(doc.limits.aggregate?.daily),
      monthly: resolve(doc.limits.aggregate?.monthly),
    },
    allow,
    deny,
    strictCounterparties,
    requireApprovalForNew: doc.counterparties?.requireApprovalForNew ?? false,
    allowedActions,
    deniedActions,
    approval: {
      thresholdUsdCents:
        doc.approvals?.thresholdUsd === undefined ? undefined : BigInt(Math.round(doc.approvals.thresholdUsd * 100)),
      approvers: doc.approvals?.approvers ?? [doc.owner],
      quorum: doc.approvals?.quorum ?? 1,
      ttlSeconds: doc.approvals?.ttlSeconds ?? 900,
    },
    velocity: {
      maxTxPerHour: doc.velocity?.maxTxPerHour ?? 0,
      minIntervalSeconds: doc.velocity?.minIntervalSeconds ?? 0,
    },
    intents: {
      venues: new Set(doc.intents?.venues ?? ['near-intents']),
      maxSlippageBps: doc.intents?.maxSlippageBps ?? 100,
      requireAllowlistedDestination: doc.intents?.requireAllowlistedDestination ?? true,
      allowedDestinations: new Set((doc.intents?.allowedDestinations ?? []).map((a) => a.toLowerCase())),
      perChainLimits: doc.intents?.perChainLimits ?? {},
    },
    risk: {
      escalateAboveBudgetFraction: doc.risk?.escalateAboveBudgetFraction ?? null,
      escalateOnNewCounterparty: doc.risk?.escalateOnNewCounterparty ?? false,
    },
    reputation,
    anomaly,
    circuitBreakers: {
      level1Duration: doc.circuitBreakers?.level1Duration ?? 3600,
      level1LimitFraction: doc.circuitBreakers?.level1LimitFraction ?? 0.1,
      level2RequiresOwner: doc.circuitBreakers?.level2RequiresOwner ?? true,
      level3RequiresQuorum: doc.circuitBreakers?.level3RequiresQuorum ?? 2,
      level4Timelock: doc.circuitBreakers?.level4Timelock ?? 86_400,
    },
    governance: {
      timelockDelay: doc.governance?.timelockDelay ?? 3600,
      watcherCanCancel: doc.governance?.watcherCanCancel ?? true,
    },
    multisig: doc.multisig ?? { threshold: 0, members: [] },
    watchers: doc.watchers ?? [],
    guardians: doc.guardians ?? (doc.owner ? [doc.owner] : []),
    expiresAt: doc.expiresAt ? Date.parse(doc.expiresAt) : null,
    warnings,
  };
  return compiled;
}

export function loadCompiledPolicy(source: string): CompiledPolicy {
  const { doc } = loadPolicy(source);
  return compilePolicy(doc);
}

/** Canonical on-the-wire form, used for hashing and display. */
export function serializePolicy(doc: PolicyDoc): string {
  return canonicalJson(doc);
}

export function describeLimitMap(map: Map<string, bigint>, policy: CompiledPolicy): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, value] of map) {
    const asset = policy.assets.get(id);
    out[id] = asset ? formatAmount(value, asset.decimals) : value.toString();
  }
  return out;
}
