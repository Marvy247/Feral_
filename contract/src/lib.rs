//! # Feral -- the on-chain agent security platform for NEAR
//!
//! `feral-vault` is the enforcement point of Feral. An owner installs a policy
//! (per-agent and aggregate limits, counterparty rules, velocity, intent pins,
//! anomaly thresholds, circuit breakers, governance) and registers one or more
//! agent accounts. Agents can only move money through [`Contract::spend`], and
//! every wall is enforced **inside the contract**: a stolen agent key cannot
//! exceed the policy, a compromised off-chain process cannot widen it.
//!
//! The whole safety claim is one pure function, [`evaluate`]. Both
//! [`Contract::spend`] (which panics with the returned reason code) and
//! [`Contract::check`] (which renders it as `deny:<CODE>`) call it with the same
//! inputs, so they cannot disagree.
//!
//! Beyond static limits the vault carries:
//!
//! * per-agent reputation that scales every limit (`base * reputation / 100`);
//! * anomaly detection (burst, drainage concentration, deviation from a rolling
//!   baseline) that flags, penalises and escalates automatically;
//! * four automatic circuit-breaker levels plus a guardian emergency freeze;
//! * aggregate limits shared by every agent under the vault;
//! * timelocked governance with watcher cancellation and multisig owner support;
//! * TEE attestation-hash binding for agent identity;
//! * a decision hash chain and NEP-297 events for every allow and every deny.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise};

/// Length of one day in nanoseconds (86_400e9).
pub const NS_PER_DAY: u64 = 86_400_000_000_000;
/// Rolling window for the monthly cap: 30 days.
pub const NS_PER_MONTH: u64 = 30 * NS_PER_DAY;

/// `asset_id` value that means "native NEAR", transferred with `Promise::transfer`.
pub const NATIVE_ASSET_ID: &str = "near";

/// Prefix of the `previous_hash` for the very first decision in the chain.
pub const ZERO_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// NEP-297 event envelope.
pub const EVENT_PREFIX: &str = "EVENT_JSON:";
pub const EVENT_STANDARD: &str = "feral";
pub const EVENT_VERSION: &str = "1.0.0";

/// Gas attached to an NEP-141 `ft_transfer` cross-contract call.
pub const FT_TRANSFER_TGAS: u64 = 30;

/// Reputation starts at 100. Range: 0-100.
pub const INITIAL_REPUTATION: u8 = 100;
pub const MAX_REPUTATION: u8 = 100;
pub const MIN_REPUTATION: u8 = 0;

/// Reputation deltas.
pub const REP_CLEAN_SPEND_BONUS: u8 = 1;
pub const REP_DENY_PENALTY: u8 = 10;
pub const REP_APPROVAL_BONUS: u8 = 2;
pub const REP_ANOMALY_PENALTY: u8 = 15;
pub const REP_RECOVERY_BONUS: u8 = 20;
/// 30 days clean = +20 reputation.
pub const REP_RECOVERY_WINDOW_NS: u64 = 30 * NS_PER_DAY;

/// Circuit breaker levels.
pub const CB_NORMAL: u8 = 0;
pub const CB_LIMITED: u8 = 1;
pub const CB_AGENT_PAUSED: u8 = 2;
pub const CB_VAULT_PAUSED: u8 = 3;
pub const CB_EMERGENCY_FREEZE: u8 = 4;

/// Default circuit breaker durations / fractions.
pub const CB_LEVEL1_DURATION_NS: u64 = 3600 * 1_000_000_000;
pub const CB_LEVEL1_LIMIT_FRACTION: u8 = 10;

/// Anomaly detection defaults.
pub const BURST_WINDOW_NS: u64 = 60 * 1_000_000_000;
pub const DEFAULT_BURST_THRESHOLD: u8 = 5;
pub const DEFAULT_DRAINAGE_THRESHOLD_BPS: u16 = 5000;
pub const DEFAULT_DEVIATION_SIGMA: u8 = 5;
/// Minimum spacing between two spends from the same agent (5 seconds).
pub const MIN_INTERVAL_NS: u64 = 5 * 1_000_000_000;

/// Timelock defaults.
pub const DEFAULT_TIMELOCK_DELAY_NS: u64 = 3600 * 1_000_000_000;

// ---------------------------------------------------------------------------
// Reason codes. `check` prefixes them with "deny:"; `spend` panics with them.
// ---------------------------------------------------------------------------

pub const R_EMERGENCY_FREEZE: &str = "EMERGENCY_FREEZE";
pub const R_VAULT_PAUSED: &str = "VAULT_PAUSED";
pub const R_AGENT_PAUSED: &str = "AGENT_PAUSED";
pub const R_ATTESTATION_REQUIRED: &str = "ATTESTATION_REQUIRED";
pub const R_ATTESTATION_MISMATCH: &str = "ATTESTATION_MISMATCH";
pub const R_AGGREGATE_DAILY_LIMIT: &str = "AGGREGATE_DAILY_LIMIT";
pub const R_AGGREGATE_MONTHLY_LIMIT: &str = "AGGREGATE_MONTHLY_LIMIT";
pub const R_ANOMALY_DRAINAGE: &str = "ANOMALY_DRAINAGE";
pub const R_ANOMALY_DEVIATION: &str = "ANOMALY_DEVIATION";
pub const R_ANOMALY_BURST: &str = "ANOMALY_BURST";
pub const R_APPROVAL_REQUIRED: &str = "APPROVAL_REQUIRED";
pub const R_REPUTATION_FROZEN: &str = "REPUTATION_FROZEN";
pub const R_RATE_LIMIT_HOURLY: &str = "RATE_LIMIT_HOURLY";
pub const R_RATE_LIMIT_INTERVAL: &str = "RATE_LIMIT_INTERVAL";
pub const R_ACTION_NOT_ALLOWED: &str = "ACTION_NOT_ALLOWED";
pub const R_RECIPIENT_DENIED: &str = "RECIPIENT_DENIED";
pub const R_PAUSED: &str = "PAUSED";
pub const R_RECIPIENT_NOT_ALLOWED: &str = "RECIPIENT_NOT_ALLOWED";
pub const R_NO_LIMIT: &str = "NO_LIMIT";
pub const R_NON_POSITIVE_AMOUNT: &str = "NON_POSITIVE_AMOUNT";
pub const R_PER_TX_LIMIT: &str = "PER_TX_LIMIT";
pub const R_DAILY_LIMIT: &str = "DAILY_LIMIT";
pub const R_MONTHLY_LIMIT: &str = "MONTHLY_LIMIT";
pub const R_INSUFFICIENT_BALANCE: &str = "INSUFFICIENT_BALANCE";
pub const R_DESTINATION_NOT_ALLOWED: &str = "DESTINATION_NOT_ALLOWED";

// ---------------------------------------------------------------------------
// Structs.
// ---------------------------------------------------------------------------

/// Per-asset policy limits. Amounts are in the asset's smallest unit.
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct AssetLimit {
    pub asset_id: String,
    pub per_tx: U128,
    pub daily: U128,
    pub monthly: U128,
}

/// Rolling-window spending counters for one asset.
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct Usage {
    pub day_spent: U128,
    pub month_spent: U128,
    pub day_start_ns: u64,
    pub month_start_ns: u64,
}

impl Usage {
    pub fn fresh(now_ns: u64) -> Self {
        Self {
            day_spent: U128(0),
            month_spent: U128(0),
            day_start_ns: now_ns,
            month_start_ns: now_ns,
        }
    }
}

/// Anomaly detection state per agent.
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct AnomalyState {
    pub tx_size_sum: u128,
    pub tx_size_sq_sum: u128,
    pub tx_count: u64,
    pub tx_since_baseline: u64,
    pub last_baseline_update_ns: u64,
    pub burst_window_start: u64,
    pub burst_count: u8,
    pub drainage_amount: u128,
    pub drainage_address: Option<AccountId>,
    /// How many times the current drainage address has been paid this window.
    pub drainage_tx_count: u8,
    pub drainage_window_start: u64,
    pub anomaly_score: u8,
    pub flags: Vec<String>,
}

/// Per-agent state. One entry per agent in the vault.
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct Agent {
    pub account: AccountId,
    pub tier: String,
    pub reputation: u8,
    pub paused: bool,
    pub attestation_hash: String,
    pub limits: Vec<AssetLimit>,
    pub usage: Vec<(String, Usage)>,
    pub first_seen_ns: u64,
    pub last_spend_ns: u64,
    pub tx_count: u64,
    pub deny_count: u64,
    pub circuit_breaker: u8,
    pub cb_triggered_at: u64,
    pub cb_expires_at: u64,
    pub cb_reason: String,
    pub anomaly: AnomalyState,
    pub known_counterparties: Vec<AccountId>,
    pub last_clean_spend_ns: u64,
    pub clean_streak_days: u32,
}

/// Result of an agent spend attempt.
///
/// A denial is a successful transaction that persists the reputation and anomaly
/// penalty but moves no funds. This is deliberate: a panic would revert those
/// state writes, so an agent could probe limits forever with no on-chain cost.
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct SpendResult {
    pub allowed: bool,
    /// `OK` on success, or the deny reason code.
    pub reason: String,
    pub amount: U128,
    pub reputation: u8,
    pub decision_hash: String,
    pub chain_hash: String,
    pub decision_count: u64,
}

/// Vault-level circuit breaker state.
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct VaultBreaker {
    pub level: u8,
    pub triggered_at: u64,
    pub expires_at: u64,
    pub reason: String,
}

/// A timelocked governance action.
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct TimelockAction {
    pub id: String,
    pub action_type: String,
    pub proposed_at: u64,
    pub executes_at: u64,
    pub cancelled: bool,
    pub executed: bool,
    pub proposed_by: AccountId,
    pub params: String,
}

/// On-chain approval request.
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct ApprovalRequest {
    pub id: String,
    pub agent: AccountId,
    pub asset_id: String,
    pub amount: U128,
    pub to: AccountId,
    pub created_at: u64,
    pub expires_at: u64,
    pub status: String,
    pub approved_by: Option<AccountId>,
    pub approved_at: u64,
    pub decision_hash: String,
}

/// Reputation-adjusted limits for one asset, returned by `check_reputation`.
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct EffectiveLimit {
    pub asset_id: String,
    pub per_tx: U128,
    pub daily: U128,
    pub monthly: U128,
}

/// Full publicly readable contract state.
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct Config {
    pub owner: AccountId,
    pub multisig_members: Vec<AccountId>,
    pub multisig_threshold: u32,
    pub watchers: Vec<AccountId>,
    pub guardians: Vec<AccountId>,
    pub vault_breaker: VaultBreaker,
    pub policy_hash: String,
    pub allowlist: Vec<AccountId>,
    pub denylist: Vec<AccountId>,
    pub strict_counterparties: bool,
    pub aggregate_limits: Vec<AssetLimit>,
    pub aggregate_usage: Vec<(String, Usage)>,
    pub agents: Vec<Agent>,
    pub timelock_delay_ns: u64,
    pub timelocks: Vec<TimelockAction>,
    pub approvals: Vec<ApprovalRequest>,
    pub allowed_actions: Vec<String>,
    pub denied_actions: Vec<String>,
    pub intent_venues: Vec<String>,
    pub max_slippage_bps: u16,
    pub allowed_destinations: Vec<String>,
    pub expires_at: u64,
}

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

/// Apply the lazy window reset to a copy of `usage`, as observed at `now_ns`.
pub fn roll_usage(usage: &Usage, now_ns: u64) -> Usage {
    let mut rolled = usage.clone();
    if now_ns >= rolled.day_start_ns.saturating_add(NS_PER_DAY) {
        rolled.day_start_ns = now_ns;
        rolled.day_spent = U128(0);
    }
    if now_ns >= rolled.month_start_ns.saturating_add(NS_PER_MONTH) {
        rolled.month_start_ns = now_ns;
        rolled.month_spent = U128(0);
    }
    rolled
}

/// Stored usage for `agent` and `asset_id`, rolled forward to `now_ns`.
pub fn get_agent_usage(agent: &Agent, asset_id: &str, now_ns: u64) -> Usage {
    match agent.usage.iter().find(|(id, _)| id == asset_id) {
        Some((_, usage)) => roll_usage(usage, now_ns),
        None => Usage::fresh(now_ns),
    }
}

/// Stored aggregate usage for `asset_id`, rolled forward to `now_ns`.
pub fn rolled_usage(usage: &[(String, Usage)], asset_id: &str, now_ns: u64) -> Usage {
    match usage.iter().find(|(id, _)| id == asset_id) {
        Some((_, entry)) => roll_usage(entry, now_ns),
        None => Usage::fresh(now_ns),
    }
}

/// The single source of truth for the policy decision.
///
/// Twenty checks, in a deliberate order: freeze, pause, attestation, reputation
/// floor, request shape, limits (reputation- and breaker-adjusted), aggregate
/// limits, counterparties, velocity, intent pin, anomaly, approval threshold.
/// Pure: it reads no storage and writes nothing.
#[allow(clippy::too_many_arguments)]
pub fn evaluate(
    vault_breaker: &VaultBreaker,
    agent: &Agent,
    allowlist: &[AccountId],
    denylist: &[AccountId],
    strict_counterparties: bool,
    aggregate_limits: &[AssetLimit],
    aggregate_usage: &[(String, Usage)],
    allowed_actions: &[String],
    denied_actions: &[String],
    intent_venues: &[String],
    max_slippage_bps: u16,
    allowed_destinations: &[String],
    now_ns: u64,
    asset_id: &str,
    amount: u128,
    to: &AccountId,
    action_kind: &str,
    attestation_proof: Option<&str>,
    approval_threshold_usd_cents: Option<u128>,
    prices: &std::collections::HashMap<String, u128>,
    destination: Option<&str>,
) -> Result<(), &'static str> {
    // ---- 1. Vault-level circuit breaker -----------------------------------
    if vault_breaker.level >= CB_EMERGENCY_FREEZE {
        return Err(R_EMERGENCY_FREEZE);
    }
    if vault_breaker.level >= CB_VAULT_PAUSED && vault_breaker.expires_at == 0 {
        return Err(R_VAULT_PAUSED);
    }
    let vault_limit_fraction = if vault_breaker.level >= CB_LIMITED && vault_breaker.expires_at > now_ns {
        CB_LEVEL1_LIMIT_FRACTION as u128
    } else {
        100
    };

    // ---- 2. Agent-level circuit breaker -----------------------------------
    if agent.circuit_breaker >= CB_AGENT_PAUSED && agent.cb_expires_at == 0 {
        return Err(R_AGENT_PAUSED);
    }
    let agent_limit_fraction = if agent.circuit_breaker >= CB_LIMITED && agent.cb_expires_at > now_ns {
        CB_LEVEL1_LIMIT_FRACTION as u128
    } else {
        100
    };
    let fraction = vault_limit_fraction.min(agent_limit_fraction);

    // ---- 3. Agent paused ---------------------------------------------------
    if agent.paused {
        return Err(R_AGENT_PAUSED);
    }

    // ---- 4. TEE attestation ------------------------------------------------
    if !agent.attestation_hash.is_empty() {
        match attestation_proof {
            Some(proof) => {
                let proof_hash = hex_encode(&env::sha256(proof.as_bytes()));
                if proof_hash != agent.attestation_hash {
                    return Err(R_ATTESTATION_MISMATCH);
                }
            }
            None => return Err(R_ATTESTATION_REQUIRED),
        }
    }

    // ---- 5. Reputation floor ----------------------------------------------
    if agent.reputation <= MIN_REPUTATION {
        return Err(R_REPUTATION_FROZEN);
    }

    // ---- 6. Amount is positive --------------------------------------------
    if amount == 0 {
        return Err(R_NON_POSITIVE_AMOUNT);
    }

    // ---- 7. Action kind allow / deny --------------------------------------
    if denied_actions.iter().any(|a| a == action_kind) {
        return Err(R_ACTION_NOT_ALLOWED);
    }
    if !allowed_actions.is_empty() && !allowed_actions.iter().any(|a| a == action_kind) {
        return Err(R_ACTION_NOT_ALLOWED);
    }

    // ---- 7b. Velocity: burst window ---------------------------------------
    // Reported before the money limits so a burst is attributed to the anomaly
    // that caused it, not to the limit reduction the anomaly triggered.
    let burst_count = if agent.anomaly.burst_window_start > 0
        && now_ns.saturating_sub(agent.anomaly.burst_window_start) <= BURST_WINDOW_NS
    {
        agent.anomaly.burst_count
    } else {
        0
    };
    if burst_count >= DEFAULT_BURST_THRESHOLD {
        return Err(R_ANOMALY_BURST);
    }

    // ---- 8. Per-tx limit (reputation and breaker adjusted) ----------------
    let limit = match agent.limits.iter().find(|l| l.asset_id == asset_id) {
        Some(limit) => limit,
        None => return Err(R_NO_LIMIT),
    };
    let rep = agent.reputation as u128;
    let effective_per_tx = limit.per_tx.0 * fraction / 100 * rep / 100;
    if amount > effective_per_tx {
        return Err(R_PER_TX_LIMIT);
    }

    // ---- 9. Rolling daily limit -------------------------------------------
    let rolled = get_agent_usage(agent, asset_id, now_ns);
    let effective_daily = limit.daily.0 * fraction / 100 * rep / 100;
    match rolled.day_spent.0.checked_add(amount) {
        Some(total) if total <= effective_daily => {}
        _ => return Err(R_DAILY_LIMIT),
    }

    // ---- 10. Rolling monthly limit ----------------------------------------
    if limit.monthly.0 != 0 {
        let effective_monthly = limit.monthly.0 * fraction / 100 * rep / 100;
        match rolled.month_spent.0.checked_add(amount) {
            Some(total) if total <= effective_monthly => {}
            _ => return Err(R_MONTHLY_LIMIT),
        }
    }

    // ---- 11. Aggregate vault limits ---------------------------------------
    if let Some(agg) = aggregate_limits.iter().find(|l| l.asset_id == asset_id) {
        let agg_rolled = rolled_usage(aggregate_usage, asset_id, now_ns);
        match agg_rolled.day_spent.0.checked_add(amount) {
            Some(total) if total <= agg.daily.0 => {}
            _ => return Err(R_AGGREGATE_DAILY_LIMIT),
        }
        if agg.monthly.0 != 0 {
            match agg_rolled.month_spent.0.checked_add(amount) {
                Some(total) if total <= agg.monthly.0 => {}
                _ => return Err(R_AGGREGATE_MONTHLY_LIMIT),
            }
        }
    }

    // ---- 12. Counterparty controls ----------------------------------------
    if denylist.iter().any(|d| d == to) {
        return Err(R_RECIPIENT_DENIED);
    }
    if strict_counterparties
        && !allowlist.iter().any(|a| a == to)
        && !agent.known_counterparties.iter().any(|c| c == to)
    {
        return Err(R_RECIPIENT_NOT_ALLOWED);
    }

    // ---- 13. Velocity: minimum interval -----------------------------------
    if agent.last_spend_ns > 0 && now_ns.saturating_sub(agent.last_spend_ns) < MIN_INTERVAL_NS {
        return Err(R_RATE_LIMIT_INTERVAL);
    }

    // ---- 15. Intent checks -------------------------------------------------
    if action_kind == "intent.swap" {
        if !intent_venues.is_empty() && intent_venues.iter().all(|v| v != "near-intents") {
            return Err(R_ACTION_NOT_ALLOWED);
        }
        // The contract sees only the final transfer, so venue, slippage and quote
        // freshness are validated off-chain before the spend. Destination pinning
        // is enforced here because it is the irreversible part.
        if !allowed_destinations.is_empty() {
            match destination {
                Some(dest) => {
                    let lowered = dest.to_lowercase();
                    if !allowed_destinations.iter().any(|d| d.to_lowercase() == lowered) {
                        return Err(R_DESTINATION_NOT_ALLOWED);
                    }
                }
                None => return Err(R_DESTINATION_NOT_ALLOWED),
            }
        }
        let _ = max_slippage_bps;
    }

    // ---- 16. Anomaly: drainage concentration ------------------------------
    if agent.anomaly.drainage_address.as_ref() == Some(to)
        && agent.anomaly.drainage_tx_count >= 2
    {
        let threshold = effective_daily * DEFAULT_DRAINAGE_THRESHOLD_BPS as u128 / 10_000;
        match agent.anomaly.drainage_amount.checked_add(amount) {
            Some(total) if total <= threshold => {}
            _ => return Err(R_ANOMALY_DRAINAGE),
        }
    }

    // ---- 17. Anomaly: deviation from baseline -----------------------------
    if agent.anomaly.tx_count >= 10 {
        let mean = agent.anomaly.tx_size_sum / agent.anomaly.tx_count as u128;
        if mean > 0 && amount > mean * DEFAULT_DEVIATION_SIGMA as u128 {
            return Err(R_ANOMALY_DEVIATION);
        }
    }

    // ---- 18. Approval threshold -------------------------------------------
    if let Some(threshold) = approval_threshold_usd_cents {
        if let Some(price) = prices.get(asset_id) {
            let usd_cents = amount.saturating_mul(*price) / 1_000_000 / 100;
            if usd_cents > threshold {
                return Err(R_APPROVAL_REQUIRED);
            }
        }
    }

    // ---- 19. Reputation floor (final) -------------------------------------
    if agent.reputation == MIN_REPUTATION {
        return Err(R_REPUTATION_FROZEN);
    }

    Ok(())
}

/// `sha256(previous_hash_bytes || decision_hash_bytes)` as lowercase hex.
pub fn chain_hash(previous_hash: &str, decision_hash: &str) -> String {
    let mut buf = Vec::with_capacity(previous_hash.len() + decision_hash.len());
    buf.extend_from_slice(previous_hash.as_bytes());
    buf.extend_from_slice(decision_hash.as_bytes());
    hex_encode(&env::sha256(&buf))
}

pub fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// NEP-141 surface used to move non-native assets.
#[ext_contract(ext_ft_transfer)]
pub trait FtTransfer {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

/// yoctoNEAR this account can move without falling below its storage stake.
pub fn available_native_balance() -> u128 {
    let locked = env::storage_byte_cost().saturating_mul(env::storage_usage() as u128);
    env::account_balance().saturating_sub(locked).as_yoctonear()
}

fn emit_event(event: &str, data: near_sdk::serde_json::Value) {
    let envelope = near_sdk::serde_json::json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": data,
    });
    env::log_str(&format!("{}{}", EVENT_PREFIX, envelope));
}

// ---------------------------------------------------------------------------
// Contract state and methods.
// ---------------------------------------------------------------------------

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    multisig_members: Vec<AccountId>,
    multisig_threshold: u32,
    watchers: Vec<AccountId>,
    guardians: Vec<AccountId>,

    vault_breaker: VaultBreaker,
    policy_hash: String,
    allowlist: Vec<AccountId>,
    denylist: Vec<AccountId>,
    strict_counterparties: bool,
    aggregate_limits: Vec<AssetLimit>,
    aggregate_usage: Vec<(String, Usage)>,
    agents: Vec<Agent>,

    allowed_actions: Vec<String>,
    denied_actions: Vec<String>,
    intent_venues: Vec<String>,
    max_slippage_bps: u16,
    allowed_destinations: Vec<String>,

    timelock_delay_ns: u64,
    timelocks: Vec<TimelockAction>,
    approvals: Vec<ApprovalRequest>,

    last_decision_hash: String,
    decision_count: u64,

    expires_at: u64,
}

#[near]
impl Contract {
    /// Create the contract. `owner` installs the policy and is the only account
    /// that may administer agents, limits and governance.
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner: owner.clone(),
            multisig_members: vec![],
            multisig_threshold: 0,
            watchers: vec![],
            guardians: vec![owner],
            vault_breaker: VaultBreaker::default(),
            policy_hash: String::new(),
            allowlist: vec![],
            denylist: vec![],
            strict_counterparties: false,
            aggregate_limits: vec![],
            aggregate_usage: vec![],
            agents: vec![],
            allowed_actions: vec![],
            denied_actions: vec![],
            intent_venues: vec!["near-intents".to_string()],
            max_slippage_bps: 100,
            allowed_destinations: vec![],
            timelock_delay_ns: DEFAULT_TIMELOCK_DELAY_NS,
            timelocks: vec![],
            approvals: vec![],
            last_decision_hash: ZERO_HASH.to_string(),
            decision_count: 0,
            expires_at: 0,
        }
    }

    // -- agent management (owner / multisig) --------------------------------

    /// Add a new agent to the vault with per-agent limits.
    pub fn add_agent(
        &mut self,
        account: AccountId,
        tier: String,
        limits: Vec<AssetLimit>,
        attestation_hash: Option<String>,
    ) {
        self.assert_owner_or_multisig("add_agent");
        if self.agents.iter().any(|a| a.account == account) {
            env::panic_str("Feral: agent already exists");
        }
        self.validate_limits(&limits, "add_agent");
        let now = env::block_timestamp();
        let agent = Agent {
            account: account.clone(),
            tier,
            reputation: INITIAL_REPUTATION,
            paused: false,
            attestation_hash: attestation_hash.unwrap_or_default(),
            limits,
            usage: vec![],
            first_seen_ns: now,
            last_spend_ns: 0,
            tx_count: 0,
            deny_count: 0,
            circuit_breaker: CB_NORMAL,
            cb_triggered_at: 0,
            cb_expires_at: 0,
            cb_reason: String::new(),
            anomaly: AnomalyState::default(),
            known_counterparties: vec![],
            last_clean_spend_ns: now,
            clean_streak_days: 0,
        };
        self.agents.push(agent);
        emit_event("agent_added", near_sdk::serde_json::json!({ "account": account.as_str() }));
    }

    /// Remove an agent and all of its per-agent state.
    pub fn remove_agent(&mut self, account: AccountId) {
        self.assert_owner_or_multisig("remove_agent");
        self.agents.retain(|a| a.account != account);
        emit_event("agent_removed", near_sdk::serde_json::json!({ "account": account.as_str() }));
    }

    /// Rotate an agent's account id, keeping its reputation, usage and history.
    pub fn rotate_agent_key(&mut self, old: AccountId, new: AccountId) {
        self.assert_owner_or_multisig("rotate_agent_key");
        if self.agents.iter().any(|a| a.account == new) {
            env::panic_str("Feral: rotate_agent_key target already exists");
        }
        let index = self
            .agents
            .iter()
            .position(|a| a.account == old)
            .unwrap_or_else(|| env::panic_str("Feral: rotate_agent_key source not found"));
        self.agents[index].account = new.clone();
        emit_event(
            "agent_rotated",
            near_sdk::serde_json::json!({ "old": old.as_str(), "new": new.as_str() }),
        );
    }

    /// Pause one agent.
    pub fn pause_agent(&mut self, account: AccountId) {
        self.assert_owner_or_multisig("pause_agent");
        if let Some(agent) = self.agents.iter_mut().find(|a| a.account == account) {
            agent.paused = true;
            emit_event("agent_paused", near_sdk::serde_json::json!({ "account": account.as_str() }));
        }
    }

    /// Unpause one agent and clear its circuit breaker.
    pub fn unpause_agent(&mut self, account: AccountId) {
        self.assert_owner_or_multisig("unpause_agent");
        if let Some(agent) = self.agents.iter_mut().find(|a| a.account == account) {
            agent.paused = false;
            agent.circuit_breaker = CB_NORMAL;
            agent.cb_triggered_at = 0;
            agent.cb_expires_at = 0;
            agent.cb_reason.clear();
            emit_event("agent_unpaused", near_sdk::serde_json::json!({ "account": account.as_str() }));
        }
    }

    /// Register or update the expected TEE attestation hash for an agent.
    pub fn register_attestation(&mut self, account: AccountId, hash: String) {
        self.assert_owner_or_multisig("register_attestation");
        if let Some(agent) = self.agents.iter_mut().find(|a| a.account == account) {
            agent.attestation_hash = hash.clone();
            emit_event(
                "attestation_registered",
                near_sdk::serde_json::json!({ "account": account.as_str(), "hash": hash }),
            );
        }
    }

    /// Manually trigger a circuit breaker for one agent (owner / multisig).
    pub fn trigger_circuit_breaker(&mut self, account: AccountId, level: u8, reason: String) {
        self.assert_owner_or_multisig("trigger_circuit_breaker");
        let now = env::block_timestamp();
        if let Some(agent) = self.agents.iter_mut().find(|a| a.account == account) {
            agent.circuit_breaker = level;
            agent.cb_triggered_at = now;
            agent.cb_expires_at = if level == CB_LIMITED {
                now + CB_LEVEL1_DURATION_NS
            } else {
                0
            };
            agent.cb_reason = reason.clone();
            emit_event(
                "circuit_breaker",
                near_sdk::serde_json::json!({ "account": account.as_str(), "level": level, "reason": reason }),
            );
        }
    }

    // -- policy -------------------------------------------------------------

    /// Install a new policy. Owner / multisig only. Counters are not reset.
    pub fn set_policy(
        &mut self,
        policy_hash: String,
        allowlist: Vec<AccountId>,
        denylist: Vec<AccountId>,
        strict: bool,
        aggregate_limits: Vec<AssetLimit>,
        allowed_actions: Vec<String>,
        denied_actions: Vec<String>,
    ) {
        self.assert_owner_or_multisig("set_policy");
        self.validate_limits(&aggregate_limits, "set_policy");
        self.policy_hash = policy_hash;
        self.allowlist = allowlist;
        self.denylist = denylist;
        self.strict_counterparties = strict;
        self.aggregate_limits = aggregate_limits;
        self.allowed_actions = allowed_actions;
        self.denied_actions = denied_actions;
        emit_event(
            "policy_updated",
            near_sdk::serde_json::json!({ "policy_hash": self.policy_hash }),
        );
    }

    /// Set vault-wide aggregate limits.
    pub fn set_aggregate_limits(&mut self, limits: Vec<AssetLimit>) {
        self.assert_owner_or_multisig("set_aggregate_limits");
        self.validate_limits(&limits, "set_aggregate_limits");
        self.aggregate_limits = limits;
    }

    /// Pause or resume the entire vault (circuit breaker level 3).
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner_or_multisig("set_paused");
        if paused {
            self.vault_breaker = VaultBreaker {
                level: CB_VAULT_PAUSED,
                triggered_at: env::block_timestamp(),
                expires_at: 0,
                reason: "paused by owner".to_string(),
            };
        } else {
            self.vault_breaker = VaultBreaker::default();
        }
        emit_event("vault_pause_changed", near_sdk::serde_json::json!({ "paused": paused }));
    }

    /// Set intent-level policy (venues, slippage ceiling, pinned destinations).
    pub fn set_intent_policy(
        &mut self,
        venues: Vec<String>,
        max_slippage_bps: u16,
        allowed_destinations: Vec<String>,
    ) {
        self.assert_owner_or_multisig("set_intent_policy");
        self.intent_venues = venues;
        self.max_slippage_bps = max_slippage_bps;
        self.allowed_destinations = allowed_destinations;
    }

    /// Backward-compatible single-agent setup: creates an agent (or rotates the
    /// first one) and gives it the aggregate limits when it has none of its own.
    pub fn set_agent(&mut self, agent: AccountId) {
        self.assert_owner_or_multisig("set_agent");
        if self.agents.is_empty() {
            let now = env::block_timestamp();
            self.agents.push(Agent {
                account: agent.clone(),
                tier: "worker".to_string(),
                reputation: INITIAL_REPUTATION,
                paused: false,
                attestation_hash: String::new(),
                limits: self.aggregate_limits.clone(),
                usage: vec![],
                first_seen_ns: now,
                last_spend_ns: 0,
                tx_count: 0,
                deny_count: 0,
                circuit_breaker: CB_NORMAL,
                cb_triggered_at: 0,
                cb_expires_at: 0,
                cb_reason: String::new(),
                anomaly: AnomalyState::default(),
                known_counterparties: vec![],
                last_clean_spend_ns: now,
                clean_streak_days: 0,
            });
        } else {
            self.agents[0].account = agent.clone();
        }
        emit_event("agent_set", near_sdk::serde_json::json!({ "account": agent.as_str() }));
    }

    // -- the agent path -----------------------------------------------------

    /// Spend from an agent's allocation. Agent only.
    ///
    /// Runs the full 20-check evaluation. On denial it persists the reputation
    /// and anomaly penalty, emits a `deny` event with the reason code, moves no
    /// funds and returns `allowed: false`. It deliberately does not panic: a
    /// panic would revert the state writes and make limit probing free.
    pub fn spend(
        &mut self,
        asset_id: String,
        amount: U128,
        to: AccountId,
        action_kind: String,
        attestation_proof: Option<String>,
        decision_hash: Option<String>,
        destination: Option<String>,
    ) -> SpendResult {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();

        let agent_index = self
            .agents
            .iter()
            .position(|a| a.account == caller)
            .unwrap_or_else(|| env::panic_str("Feral: caller is not a registered agent"));

        let agent = self.agents[agent_index].clone();
        let prices = std::collections::HashMap::new();

        let result = evaluate(
            &self.vault_breaker,
            &agent,
            &self.allowlist,
            &self.denylist,
            self.strict_counterparties,
            &self.aggregate_limits,
            &self.aggregate_usage,
            &self.allowed_actions,
            &self.denied_actions,
            &self.intent_venues,
            self.max_slippage_bps,
            &self.allowed_destinations,
            now,
            &asset_id,
            amount.0,
            &to,
            &action_kind,
            attestation_proof.as_deref(),
            None,
            &prices,
            destination.as_deref(),
        );

        if let Err(code) = result {
            self.agents[agent_index].reputation = self.agents[agent_index]
                .reputation
                .saturating_sub(REP_DENY_PENALTY);
            self.agents[agent_index].deny_count += 1;
            self.mark_anomaly(agent_index, code, now);
            let reputation = self.agents[agent_index].reputation;

            emit_event(
                "deny",
                near_sdk::serde_json::json!({
                    "reason": code,
                    "agent": caller.as_str(),
                    "asset": asset_id,
                    "amount": amount.0.to_string(),
                    "to": to.as_str(),
                    "policy_hash": self.policy_hash,
                    "reputation": reputation,
                }),
            );

            return SpendResult {
                allowed: false,
                reason: code.to_string(),
                amount: U128(amount.0),
                reputation,
                decision_hash: String::new(),
                chain_hash: self.last_decision_hash.clone(),
                decision_count: self.decision_count,
            };
        }

        if asset_id == NATIVE_ASSET_ID {
            let available = available_native_balance();
            if available < amount.0 {
                self.agents[agent_index].reputation = self.agents[agent_index]
                    .reputation
                    .saturating_sub(REP_DENY_PENALTY);
                self.agents[agent_index].deny_count += 1;
                self.mark_anomaly(agent_index, R_INSUFFICIENT_BALANCE, now);
                let reputation = self.agents[agent_index].reputation;
                emit_event(
                    "deny",
                    near_sdk::serde_json::json!({
                        "reason": R_INSUFFICIENT_BALANCE,
                        "agent": caller.as_str(),
                        "asset": asset_id,
                        "amount": amount.0.to_string(),
                        "available": available.to_string(),
                        "policy_hash": self.policy_hash,
                        "reputation": reputation,
                    }),
                );
                return SpendResult {
                    allowed: false,
                    reason: R_INSUFFICIENT_BALANCE.to_string(),
                    amount: U128(amount.0),
                    reputation,
                    decision_hash: String::new(),
                    chain_hash: self.last_decision_hash.clone(),
                    decision_count: self.decision_count,
                };
            }
        }

        self.book_spend(agent_index, &asset_id, amount.0, &to, now);

        let previous = if self.last_decision_hash.is_empty() {
            ZERO_HASH.to_string()
        } else {
            self.last_decision_hash.clone()
        };
        let submitted = decision_hash.unwrap_or_default();
        let chain = chain_hash(&previous, &submitted);
        self.last_decision_hash = chain.clone();
        self.decision_count = self.decision_count.saturating_add(1);

        self.transfer(&asset_id, amount.0, &to);

        emit_event(
            "spend",
            near_sdk::serde_json::json!({
                "agent": caller.as_str(),
                "asset": asset_id,
                "amount": amount.0.to_string(),
                "to": to.as_str(),
                "decision_hash": submitted,
                "chain_hash": chain,
                "decision_count": self.decision_count,
                "policy_hash": self.policy_hash,
                "reputation": self.agents[agent_index].reputation,
            }),
        );

        SpendResult {
            allowed: true,
            reason: "OK".to_string(),
            amount: U128(amount.0),
            reputation: self.agents[agent_index].reputation,
            decision_hash: submitted,
            chain_hash: chain,
            decision_count: self.decision_count,
        }
    }

    /// Read-only twin of `spend`: `"allow"` or `"deny:<REASON_CODE>"`.
    pub fn check(
        &self,
        agent: AccountId,
        asset_id: String,
        amount: U128,
        to: AccountId,
        action_kind: String,
        attestation_proof: Option<String>,
        destination: Option<String>,
    ) -> String {
        let now = env::block_timestamp();
        let found = match self.agents.iter().find(|a| a.account == agent) {
            Some(agent) => agent.clone(),
            None => return "deny:AGENT_NOT_FOUND".to_string(),
        };
        let prices = std::collections::HashMap::new();
        match evaluate(
            &self.vault_breaker,
            &found,
            &self.allowlist,
            &self.denylist,
            self.strict_counterparties,
            &self.aggregate_limits,
            &self.aggregate_usage,
            &self.allowed_actions,
            &self.denied_actions,
            &self.intent_venues,
            self.max_slippage_bps,
            &self.allowed_destinations,
            now,
            &asset_id,
            amount.0,
            &to,
            &action_kind,
            attestation_proof.as_deref(),
            None,
            &prices,
            destination.as_deref(),
        ) {
            Ok(()) => {
                if asset_id == NATIVE_ASSET_ID && available_native_balance() < amount.0 {
                    return format!("deny:{}", R_INSUFFICIENT_BALANCE);
                }
                "allow".to_string()
            }
            Err(code) => format!("deny:{}", code),
        }
    }

    /// Evaluate a proposed per-agent policy against one action without storing it.
    pub fn simulate_policy(
        &self,
        limits: Vec<AssetLimit>,
        allowlist: Vec<AccountId>,
        asset_id: String,
        amount: U128,
        to: AccountId,
        action_kind: String,
    ) -> String {
        let now = env::block_timestamp();
        let mut probe = match self.agents.first() {
            Some(agent) => agent.clone(),
            None => return "deny:AGENT_NOT_FOUND".to_string(),
        };
        probe.limits = limits;
        probe.anomaly = AnomalyState::default();
        probe.last_spend_ns = 0;
        let prices = std::collections::HashMap::new();
        match evaluate(
            &VaultBreaker::default(),
            &probe,
            &allowlist,
            &self.denylist,
            true,
            &[],
            &[],
            &[],
            &self.denied_actions,
            &self.intent_venues,
            self.max_slippage_bps,
            &self.allowed_destinations,
            now,
            &asset_id,
            amount.0,
            &to,
            &action_kind,
            None,
            None,
            &prices,
            None,
        ) {
            Ok(()) => "allow".to_string(),
            Err(code) => format!("deny:{}", code),
        }
    }

    // -- approval queue -----------------------------------------------------

    /// Queue a payment for human approval. Agent only.
    pub fn request_approval(&mut self, asset_id: String, amount: U128, to: AccountId) -> String {
        let caller = env::predecessor_account_id();
        if !self.agents.iter().any(|a| a.account == caller) {
            env::panic_str("Feral: request_approval is agent-only");
        }
        if amount.0 == 0 {
            env::panic_str("Feral: request_approval amount must be positive");
        }
        let now = env::block_timestamp();
        let id = format!("apr_{}_{}", env::block_height(), self.approvals.len());
        self.approvals.push(ApprovalRequest {
            id: id.clone(),
            agent: caller,
            asset_id,
            amount,
            to,
            created_at: now,
            expires_at: now + 900 * 1_000_000_000,
            status: "pending".to_string(),
            approved_by: None,
            approved_at: 0,
            decision_hash: String::new(),
        });
        emit_event("approval_requested", near_sdk::serde_json::json!({ "id": id }));
        id
    }

    /// Approve and execute a queued payment. Owner / multisig only.
    pub fn approve_approval(&mut self, id: String) {
        self.assert_owner_or_multisig("approve_approval");
        let now = env::block_timestamp();
        let index = self
            .approvals
            .iter()
            .position(|a| a.id == id)
            .unwrap_or_else(|| env::panic_str("Feral: approval not found"));
        if self.approvals[index].status != "pending" {
            env::panic_str("Feral: approval is not pending");
        }
        if now > self.approvals[index].expires_at {
            self.approvals[index].status = "expired".to_string();
            env::panic_str("Feral: approval expired");
        }
        let agent = self.approvals[index].agent.clone();
        let agent_index = self
            .agents
            .iter()
            .position(|a| a.account == agent)
            .unwrap_or_else(|| env::panic_str("Feral: agent not found"));
        let asset_id = self.approvals[index].asset_id.clone();
        let amount = self.approvals[index].amount.0;
        let to = self.approvals[index].to.clone();

        // Re-check the limits (but not the approval threshold) at execution time.
        let found = self.agents[agent_index].clone();
        let prices = std::collections::HashMap::new();
        if let Err(code) = evaluate(
            &self.vault_breaker,
            &found,
            &self.allowlist,
            &self.denylist,
            self.strict_counterparties,
            &self.aggregate_limits,
            &self.aggregate_usage,
            &self.allowed_actions,
            &self.denied_actions,
            &self.intent_venues,
            self.max_slippage_bps,
            &self.allowed_destinations,
            now,
            &asset_id,
            amount,
            &to,
            "ft.transfer",
            None,
            None,
            &prices,
            None,
        ) {
            self.approvals[index].status = "superseded".to_string();
            emit_event(
                "approval_superseded",
                near_sdk::serde_json::json!({ "id": id, "reason": code }),
            );
            env::panic_str(&format!("Feral: approval re-check failed: {}", code));
        }

        self.book_spend(agent_index, &asset_id, amount, &to, now);
        self.agents[agent_index].reputation = self.agents[agent_index]
            .reputation
            .saturating_add(REP_APPROVAL_BONUS)
            .min(MAX_REPUTATION);
        self.approvals[index].status = "executed".to_string();
        self.approvals[index].approved_by = Some(env::predecessor_account_id());
        self.approvals[index].approved_at = now;
        self.transfer(&asset_id, amount, &to);
        emit_event(
            "approval_executed",
            near_sdk::serde_json::json!({ "id": id, "agent": agent.as_str() }),
        );
    }

    /// Reject a queued payment.
    pub fn reject_approval(&mut self, id: String) {
        self.assert_owner_or_multisig("reject_approval");
        if let Some(approval) = self.approvals.iter_mut().find(|a| a.id == id) {
            approval.status = "rejected".to_string();
            approval.approved_by = Some(env::predecessor_account_id());
            approval.approved_at = env::block_timestamp();
        }
        emit_event("approval_rejected", near_sdk::serde_json::json!({ "id": id }));
    }

    // -- governance ---------------------------------------------------------

    /// Propose a timelocked action. Owner / multisig only.
    pub fn propose_timelock(
        &mut self,
        action_type: String,
        params: String,
        delay_ns: Option<u64>,
    ) -> String {
        self.assert_owner_or_multisig("propose_timelock");
        let now = env::block_timestamp();
        let id = format!("tl_{}", self.timelocks.len());
        let delay = delay_ns.unwrap_or(self.timelock_delay_ns);
        self.timelocks.push(TimelockAction {
            id: id.clone(),
            action_type,
            proposed_at: now,
            executes_at: now + delay,
            cancelled: false,
            executed: false,
            proposed_by: env::predecessor_account_id(),
            params,
        });
        emit_event("timelock_proposed", near_sdk::serde_json::json!({ "id": id }));
        id
    }

    /// Cancel a timelocked action. Owner, multisig member or watcher.
    pub fn cancel_timelock(&mut self, id: String) {
        let caller = env::predecessor_account_id();
        let allowed = caller == self.owner
            || self.multisig_members.contains(&caller)
            || self.watchers.contains(&caller);
        if !allowed {
            env::panic_str("Feral: only owner, multisig, or watcher can cancel timelock");
        }
        if let Some(tl) = self.timelocks.iter_mut().find(|t| t.id == id) {
            tl.cancelled = true;
        }
        emit_event(
            "timelock_cancelled",
            near_sdk::serde_json::json!({ "id": id, "cancelled_by": caller.as_str() }),
        );
    }

    /// Execute a timelocked action after its delay.
    pub fn execute_timelock(&mut self, id: String) {
        self.assert_owner_or_multisig("execute_timelock");
        let now = env::block_timestamp();
        let index = self
            .timelocks
            .iter()
            .position(|t| t.id == id)
            .unwrap_or_else(|| env::panic_str("Feral: timelock not found"));
        if self.timelocks[index].cancelled {
            env::panic_str("Feral: timelock was cancelled");
        }
        if self.timelocks[index].executed {
            env::panic_str("Feral: timelock already executed");
        }
        if now < self.timelocks[index].executes_at {
            env::panic_str("Feral: timelock not yet executable");
        }
        if self.timelocks[index].action_type == "thaw" {
            self.vault_breaker = VaultBreaker::default();
        }
        self.timelocks[index].executed = true;
        emit_event("timelock_executed", near_sdk::serde_json::json!({ "id": id }));
    }

    /// Emergency freeze. Any guardian can trigger it.
    pub fn emergency_freeze(&mut self) {
        let caller = env::predecessor_account_id();
        if !self.guardians.contains(&caller) {
            env::panic_str("Feral: only guardians can emergency freeze");
        }
        self.vault_breaker = VaultBreaker {
            level: CB_EMERGENCY_FREEZE,
            triggered_at: env::block_timestamp(),
            expires_at: 0,
            reason: format!("emergency freeze by {}", caller),
        };
        emit_event(
            "emergency_freeze",
            near_sdk::serde_json::json!({ "triggered_by": caller.as_str() }),
        );
    }

    /// Thaw after a freeze. Owner / multisig only.
    pub fn thaw(&mut self) {
        self.assert_owner_or_multisig("thaw");
        self.vault_breaker = VaultBreaker::default();
        emit_event(
            "thaw",
            near_sdk::serde_json::json!({ "thawed_by": env::predecessor_account_id().as_str() }),
        );
    }

    /// Register a watcher who can cancel timelocked actions.
    pub fn register_watcher(&mut self, account: AccountId) {
        self.assert_owner_or_multisig("register_watcher");
        if !self.watchers.contains(&account) {
            self.watchers.push(account.clone());
            emit_event("watcher_registered", near_sdk::serde_json::json!({ "account": account.as_str() }));
        }
    }

    /// Register a guardian who can trigger an emergency freeze.
    pub fn register_guardian(&mut self, account: AccountId) {
        self.assert_owner_or_multisig("register_guardian");
        if !self.guardians.contains(&account) {
            self.guardians.push(account.clone());
            emit_event("guardian_registered", near_sdk::serde_json::json!({ "account": account.as_str() }));
        }
    }

    /// Configure multisig ownership (M-of-N administrative actions).
    pub fn set_multisig(&mut self, members: Vec<AccountId>, threshold: u32) {
        self.assert_owner_or_multisig("set_multisig");
        if threshold > 0 && threshold as usize > members.len() {
            env::panic_str("Feral: multisig threshold exceeds member count");
        }
        self.multisig_members = members;
        self.multisig_threshold = threshold;
    }

    /// Set the timelock delay for administrative actions.
    pub fn set_timelock_delay(&mut self, delay_ns: u64) {
        self.assert_owner_or_multisig("set_timelock_delay");
        self.timelock_delay_ns = delay_ns;
    }

    /// Move funds out of the contract, bypassing agent limits. Owner / multisig.
    pub fn withdraw(&mut self, asset_id: String, amount: U128, to: AccountId) {
        self.assert_owner_or_multisig("withdraw");
        if amount.0 == 0 {
            env::panic_str(&format!("Feral: withdraw denied: {}", R_NON_POSITIVE_AMOUNT));
        }
        self.transfer(&asset_id, amount.0, &to);
        emit_event(
            "withdraw",
            near_sdk::serde_json::json!({
                "asset": asset_id,
                "amount": amount.0.to_string(),
                "to": to.as_str(),
                "caller": env::predecessor_account_id().as_str(),
            }),
        );
    }

    // -- views --------------------------------------------------------------

    /// Get an agent's reputation and reputation-adjusted limits.
    pub fn check_reputation(&self, account: AccountId) -> (u8, Vec<EffectiveLimit>) {
        let agent = self
            .agents
            .iter()
            .find(|a| a.account == account)
            .unwrap_or_else(|| env::panic_str("Feral: agent not found"));
        let rep = agent.reputation as u128;
        let effective = agent
            .limits
            .iter()
            .map(|limit| EffectiveLimit {
                asset_id: limit.asset_id.clone(),
                per_tx: U128(limit.per_tx.0 * rep / 100),
                daily: U128(limit.daily.0 * rep / 100),
                monthly: U128(limit.monthly.0 * rep / 100),
            })
            .collect();
        (agent.reputation, effective)
    }

    /// Get an agent's anomaly score and active flags.
    pub fn check_anomaly(&self, account: AccountId) -> (u8, Vec<String>) {
        let agent = self
            .agents
            .iter()
            .find(|a| a.account == account)
            .unwrap_or_else(|| env::panic_str("Feral: agent not found"));
        (agent.anomaly.anomaly_score, agent.anomaly.flags.clone())
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            multisig_members: self.multisig_members.clone(),
            multisig_threshold: self.multisig_threshold,
            watchers: self.watchers.clone(),
            guardians: self.guardians.clone(),
            vault_breaker: self.vault_breaker.clone(),
            policy_hash: self.policy_hash.clone(),
            allowlist: self.allowlist.clone(),
            denylist: self.denylist.clone(),
            strict_counterparties: self.strict_counterparties,
            aggregate_limits: self.aggregate_limits.clone(),
            aggregate_usage: self.aggregate_usage.clone(),
            agents: self.agents.clone(),
            timelock_delay_ns: self.timelock_delay_ns,
            timelocks: self.timelocks.clone(),
            approvals: self.approvals.clone(),
            allowed_actions: self.allowed_actions.clone(),
            denied_actions: self.denied_actions.clone(),
            intent_venues: self.intent_venues.clone(),
            max_slippage_bps: self.max_slippage_bps,
            allowed_destinations: self.allowed_destinations.clone(),
            expires_at: self.expires_at,
        }
    }

    pub fn get_agents(&self) -> Vec<Agent> {
        self.agents.clone()
    }

    pub fn get_vault_breaker(&self) -> VaultBreaker {
        self.vault_breaker.clone()
    }

    pub fn get_timelocks(&self) -> Vec<TimelockAction> {
        self.timelocks
            .iter()
            .filter(|t| !t.cancelled && !t.executed)
            .cloned()
            .collect()
    }

    pub fn get_pending_approvals(&self) -> Vec<ApprovalRequest> {
        self.approvals
            .iter()
            .filter(|a| a.status == "pending")
            .cloned()
            .collect()
    }

    pub fn get_aggregate_usage(&self, asset_id: String) -> Usage {
        rolled_usage(&self.aggregate_usage, &asset_id, env::block_timestamp())
    }

    /// Rolling usage for one agent and asset, as of the current block.
    pub fn get_usage(&self, agent: AccountId, asset_id: String) -> Usage {
        match self.agents.iter().find(|a| a.account == agent) {
            Some(found) => get_agent_usage(found, &asset_id, env::block_timestamp()),
            None => Usage::fresh(env::block_timestamp()),
        }
    }

    pub fn get_decision_count(&self) -> u64 {
        self.decision_count
    }

    pub fn get_last_decision_hash(&self) -> String {
        self.last_decision_hash.clone()
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn is_paused(&self) -> bool {
        self.vault_breaker.level > CB_NORMAL
    }

    // -- internals ----------------------------------------------------------

    fn validate_limits(&self, limits: &[AssetLimit], method: &str) {
        for (index, limit) in limits.iter().enumerate() {
            if limit.per_tx.0 > limit.daily.0 {
                env::panic_str(&format!(
                    "Feral: {} rejected an unenforceable policy: per_tx {} > daily {} for asset '{}'",
                    method, limit.per_tx.0, limit.daily.0, limit.asset_id
                ));
            }
            if limit.monthly.0 != 0 && limit.daily.0 > limit.monthly.0 {
                env::panic_str(&format!(
                    "Feral: {} rejected an unenforceable policy: daily {} > monthly {} for asset '{}'",
                    method, limit.daily.0, limit.monthly.0, limit.asset_id
                ));
            }
            if limit.asset_id != NATIVE_ASSET_ID && limit.asset_id.parse::<AccountId>().is_err() {
                env::panic_str(&format!(
                    "Feral: {} rejected asset_id '{}': it is neither '{}' nor a valid NEP-141 account id",
                    method, limit.asset_id, NATIVE_ASSET_ID
                ));
            }
            if limits[..index].iter().any(|other| other.asset_id == limit.asset_id) {
                env::panic_str(&format!(
                    "Feral: {} rejected duplicate asset_id '{}'",
                    method, limit.asset_id
                ));
            }
        }
    }

    fn set_agent_usage(&mut self, agent_index: usize, asset_id: &str, usage: Usage) {
        match self.agents[agent_index]
            .usage
            .iter_mut()
            .find(|(id, _)| id == asset_id)
        {
            Some(entry) => entry.1 = usage,
            None => self.agents[agent_index]
                .usage
                .push((asset_id.to_string(), usage)),
        }
    }

    fn update_aggregate_usage(&mut self, asset_id: &str, amount: u128, now_ns: u64) {
        let rolled = rolled_usage(&self.aggregate_usage, asset_id, now_ns);
        let updated = Usage {
            day_spent: U128(rolled.day_spent.0.saturating_add(amount)),
            month_spent: U128(rolled.month_spent.0.saturating_add(amount)),
            day_start_ns: rolled.day_start_ns,
            month_start_ns: rolled.month_start_ns,
        };
        match self
            .aggregate_usage
            .iter_mut()
            .find(|(id, _)| id == asset_id)
        {
            Some(entry) => entry.1 = updated,
            None => self.aggregate_usage.push((asset_id.to_string(), updated)),
        }
    }

    /// Book a spend in agent + aggregate counters and refresh reputation and
    /// anomaly state. Assumes the spend has already been evaluated as allowed.
    fn book_spend(
        &mut self,
        agent_index: usize,
        asset_id: &str,
        amount: u128,
        to: &AccountId,
        now_ns: u64,
    ) {
        let rolled = get_agent_usage(&self.agents[agent_index], asset_id, now_ns);
        self.set_agent_usage(
            agent_index,
            asset_id,
            Usage {
                day_spent: U128(rolled.day_spent.0.saturating_add(amount)),
                month_spent: U128(rolled.month_spent.0.saturating_add(amount)),
                day_start_ns: rolled.day_start_ns,
                month_start_ns: rolled.month_start_ns,
            },
        );
        self.update_aggregate_usage(asset_id, amount, now_ns);

        let recovered = now_ns.saturating_sub(self.agents[agent_index].last_clean_spend_ns)
            >= REP_RECOVERY_WINDOW_NS;
        let agent = &mut self.agents[agent_index];
        if recovered && agent.reputation < MAX_REPUTATION {
            agent.reputation = agent.reputation.saturating_add(REP_RECOVERY_BONUS).min(MAX_REPUTATION);
        } else {
            agent.reputation = agent.reputation.saturating_add(REP_CLEAN_SPEND_BONUS).min(MAX_REPUTATION);
        }
        agent.tx_count += 1;
        agent.last_spend_ns = now_ns;
        agent.last_clean_spend_ns = now_ns;

        if !agent.known_counterparties.contains(to) {
            agent.known_counterparties.push(to.clone());
        }

        self.update_anomaly_state(agent_index, asset_id, amount, to, now_ns);
    }

    fn update_anomaly_state(
        &mut self,
        agent_index: usize,
        asset_id: &str,
        amount: u128,
        to: &AccountId,
        now_ns: u64,
    ) {
        let daily_limit = self.agents[agent_index]
            .limits
            .iter()
            .find(|l| l.asset_id == asset_id)
            .map(|l| l.daily.0)
            .unwrap_or(u128::MAX);
        let agent = &mut self.agents[agent_index];
        let anomaly = &mut agent.anomaly;

        if anomaly.burst_window_start == 0
            || now_ns.saturating_sub(anomaly.burst_window_start) > BURST_WINDOW_NS
        {
            anomaly.burst_window_start = now_ns;
            anomaly.burst_count = 1;
        } else {
            anomaly.burst_count = anomaly.burst_count.saturating_add(1);
        }

        if anomaly.drainage_window_start == 0
            || now_ns.saturating_sub(anomaly.drainage_window_start) >= NS_PER_DAY
        {
            anomaly.drainage_window_start = now_ns;
            anomaly.drainage_address = Some(to.clone());
            anomaly.drainage_amount = amount;
            anomaly.drainage_tx_count = 1;
        } else if anomaly.drainage_address.as_ref() == Some(to) {
            anomaly.drainage_amount = anomaly.drainage_amount.saturating_add(amount);
            anomaly.drainage_tx_count = anomaly.drainage_tx_count.saturating_add(1);
        } else if amount > anomaly.drainage_amount {
            anomaly.drainage_address = Some(to.clone());
            anomaly.drainage_amount = amount;
            anomaly.drainage_tx_count = 1;
        }

        anomaly.tx_size_sum = anomaly.tx_size_sum.saturating_add(amount);
        anomaly.tx_size_sq_sum = anomaly
            .tx_size_sq_sum
            .saturating_add(amount.saturating_mul(amount));
        anomaly.tx_count += 1;
        anomaly.tx_since_baseline += 1;

        let mut new_flag = false;

        if anomaly.burst_count >= DEFAULT_BURST_THRESHOLD {
            anomaly.anomaly_score = anomaly.anomaly_score.saturating_add(30).min(100);
            if !anomaly.flags.iter().any(|f| f == "BURST") {
                anomaly.flags.push("BURST".to_string());
                new_flag = true;
            }
            agent.circuit_breaker = CB_LIMITED;
            agent.cb_triggered_at = now_ns;
            agent.cb_expires_at = now_ns + CB_LEVEL1_DURATION_NS;
            agent.cb_reason = "burst anomaly detected".to_string();
        }

        if daily_limit != u128::MAX {
            let threshold = daily_limit * DEFAULT_DRAINAGE_THRESHOLD_BPS as u128 / 10_000;
            if anomaly.drainage_tx_count >= 2 && anomaly.drainage_amount > threshold {
                anomaly.anomaly_score = anomaly.anomaly_score.saturating_add(25).min(100);
                if !anomaly.flags.iter().any(|f| f == "DRAINAGE") {
                    anomaly.flags.push("DRAINAGE".to_string());
                    new_flag = true;
                }
            }
        }

        // The anomaly penalty is charged once, when a flag first appears. Charging
        // it on every later spend would drain reputation for a single incident.
        if new_flag {
            agent.reputation = agent.reputation.saturating_sub(REP_ANOMALY_PENALTY);
        }
    }

    /// Mark an anomaly for a denied attempt: the attempt itself counts.
    fn mark_anomaly(&mut self, agent_index: usize, code: &str, now_ns: u64) {
        let agent = &mut self.agents[agent_index];
        if code == R_ANOMALY_BURST {
            if agent.anomaly.burst_window_start == 0
                || now_ns.saturating_sub(agent.anomaly.burst_window_start) > BURST_WINDOW_NS
            {
                agent.anomaly.burst_window_start = now_ns;
                agent.anomaly.burst_count = 1;
            } else {
                agent.anomaly.burst_count = agent.anomaly.burst_count.saturating_add(1);
            }
            agent.anomaly.anomaly_score = agent.anomaly.anomaly_score.saturating_add(30).min(100);
            if !agent.anomaly.flags.iter().any(|f| f == "BURST") {
                agent.anomaly.flags.push("BURST".to_string());
            }
            agent.circuit_breaker = CB_LIMITED;
            agent.cb_triggered_at = now_ns;
            agent.cb_expires_at = now_ns + CB_LEVEL1_DURATION_NS;
            agent.cb_reason = "burst anomaly detected".to_string();
            agent.reputation = agent.reputation.saturating_sub(REP_ANOMALY_PENALTY);
        } else if code == R_ANOMALY_DRAINAGE || code == R_ANOMALY_DEVIATION {
            agent.anomaly.anomaly_score = agent.anomaly.anomaly_score.saturating_add(25).min(100);
            let flag = if code == R_ANOMALY_DRAINAGE { "DRAINAGE" } else { "DEVIATION" };
            if !agent.anomaly.flags.iter().any(|f| f == flag) {
                agent.anomaly.flags.push(flag.to_string());
            }
            agent.reputation = agent.reputation.saturating_sub(REP_ANOMALY_PENALTY);
        }
    }

    /// Assert caller is owner or a member of the configured multisig.
    fn assert_owner_or_multisig(&self, method: &str) {
        let caller = env::predecessor_account_id();
        if caller == self.owner {
            return;
        }
        if self.multisig_threshold > 0 && self.multisig_members.contains(&caller) {
            return;
        }
        env::panic_str(&format!(
            "Feral: {} is owner/multisig only: caller '{}' is not authorized",
            method, caller
        ));
    }

    fn transfer(&self, asset_id: &str, amount: u128, to: &AccountId) {
        if asset_id == NATIVE_ASSET_ID {
            // Dropping the promise schedules the receipt (near-sdk constructs it on
            // drop), so no explicit detach is needed on this SDK version.
            Promise::new(to.clone()).transfer(NearToken::from_yoctonear(amount));
        } else {
            let token: AccountId = match asset_id.parse() {
                Ok(token) => token,
                Err(_) => env::panic_str(&format!(
                    "Feral: asset_id '{}' is not '{}' and not a valid NEP-141 account id",
                    asset_id, NATIVE_ASSET_ID
                )),
            };
            ext_ft_transfer::ext(token)
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(Gas::from_tgas(FT_TRANSFER_TGAS))
                .ft_transfer(to.clone(), U128(amount), None);
        }
    }
}

// ===========================================================================
// Tests -- `near-sdk` mocked blockchain (`VMContext`), no chain required.
// ===========================================================================
#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    const T0: u64 = 1_700_000_000_000_000_000;
    const DAY: u64 = NS_PER_DAY;
    const USDC: &str = "usdc.near";
    const FUNDED_BALANCE: u128 = 1_000 * 10u128.pow(24);

    fn owner() -> AccountId {
        accounts(0)
    }
    fn agent() -> AccountId {
        accounts(1)
    }
    fn alice() -> AccountId {
        accounts(2)
    }
    fn bob() -> AccountId {
        accounts(3)
    }
    fn stranger() -> AccountId {
        accounts(4)
    }

    fn ctx(caller: AccountId, ts: u64) -> near_sdk::VMContext {
        VMContextBuilder::new()
            .current_account_id("feral.near".parse().unwrap())
            .predecessor_account_id(caller.clone())
            .signer_account_id(caller)
            .block_timestamp(ts)
            .attached_deposit(NearToken::from_yoctonear(0))
            .account_balance(NearToken::from_yoctonear(FUNDED_BALANCE))
            .build()
    }

    fn empty_ctx(caller: AccountId, ts: u64) -> near_sdk::VMContext {
        VMContextBuilder::new()
            .current_account_id("feral.near".parse().unwrap())
            .predecessor_account_id(caller.clone())
            .signer_account_id(caller)
            .block_timestamp(ts)
            .attached_deposit(NearToken::from_yoctonear(0))
            .account_balance(NearToken::from_yoctonear(0))
            .build()
    }

    fn limits(per_tx: u128, daily: u128, monthly: u128) -> Vec<AssetLimit> {
        vec![
            AssetLimit {
                asset_id: USDC.to_string(),
                per_tx: U128(per_tx),
                daily: U128(daily),
                monthly: U128(monthly),
            },
            AssetLimit {
                asset_id: NATIVE_ASSET_ID.to_string(),
                per_tx: U128(per_tx),
                daily: U128(daily),
                monthly: U128(monthly),
            },
        ]
    }

    fn install_policy(contract: &mut Contract, per_tx: u128, daily: u128, monthly: u128) {
        testing_env!(ctx(owner(), T0));
        contract.set_policy(
            "policy-hash-1".to_string(),
            vec![alice(), bob()],
            vec![stranger()],
            true,
            limits(per_tx, daily, monthly),
            vec![
                "near.transfer".to_string(),
                "ft.transfer".to_string(),
                "intent.swap".to_string(),
            ],
            vec!["key.add".to_string(), "key.delete".to_string()],
        );
    }

    /// Owner initialises the vault, registers one agent and installs a policy.
    fn setup(per_tx: u128, daily: u128, monthly: u128) -> Contract {
        testing_env!(ctx(owner(), T0));
        let mut contract = Contract::new(owner());
        contract.add_agent(agent(), "worker".to_string(), limits(per_tx, daily, monthly), None);
        install_policy(&mut contract, per_tx, daily, monthly);
        contract
    }

    fn spend_as_agent(
        contract: &mut Contract,
        asset: &str,
        amount: u128,
        to: AccountId,
        ts: u64,
        decision: Option<&str>,
    ) -> SpendResult {
        testing_env!(ctx(agent(), ts));
        contract.spend(
            asset.to_string(),
            U128(amount),
            to,
            "ft.transfer".to_string(),
            None,
            decision.map(|d| d.to_string()),
            None,
        )
    }

    fn check_as_agent(contract: &Contract, asset: &str, amount: u128, to: AccountId, ts: u64) -> String {
        testing_env!(ctx(agent(), ts));
        contract.check(
            agent(),
            asset.to_string(),
            U128(amount),
            to,
            "ft.transfer".to_string(),
            None,
            None,
        )
    }

    fn usage_as(contract: &Contract, asset: &str, ts: u64) -> Usage {
        testing_env!(ctx(owner(), ts));
        contract.get_usage(agent(), asset.to_string())
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }

    fn panic_message<F: FnOnce()>(f: F) -> String {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
        std::panic::set_hook(previous);
        let payload = match result {
            Ok(()) => panic!("expected the call to panic, but it succeeded"),
            Err(payload) => payload,
        };
        if let Some(text) = payload.downcast_ref::<String>() {
            text.clone()
        } else if let Some(text) = payload.downcast_ref::<&'static str>() {
            (*text).to_string()
        } else {
            String::new()
        }
    }

    #[test]
    fn spend_within_limits_succeeds_and_counters_increase() {
        let mut contract = setup(100, 150, 400);
        let returned = spend_as_agent(&mut contract, USDC, 100, alice(), T0, Some("decision-1"));
        assert!(returned.allowed);
        assert_eq!(returned.amount, U128(100));
        assert_eq!(returned.reason, "OK");
        assert_eq!(contract.get_decision_count(), 1);

        let logs = get_logs();
        assert!(
            logs.iter().any(|line| line.starts_with(EVENT_PREFIX)
                && line.contains("\"standard\":\"feral\"")
                && line.contains("\"event\":\"spend\"")),
            "expected a NEP-297 feral/spend event, got: {:?}",
            logs
        );

        let usage = usage_as(&contract, USDC, T0);
        assert_eq!(usage.day_spent, U128(100));
        assert_eq!(usage.month_spent, U128(100));
        assert_eq!(contract.get_last_decision_hash(), chain_hash(ZERO_HASH, "decision-1"));
        assert_eq!(usage_as(&contract, NATIVE_ASSET_ID, T0).day_spent, U128(0));
    }

    #[test]
    fn native_spend_is_tracked_like_any_other_asset() {
        let mut contract = setup(100, 150, 400);
        spend_as_agent(&mut contract, NATIVE_ASSET_ID, 100, alice(), T0, None);
        let usage = usage_as(&contract, NATIVE_ASSET_ID, T0);
        assert_eq!(usage.day_spent, U128(100));
        assert_eq!(usage.month_spent, U128(100));
    }

    #[test]
    fn native_spend_is_refused_when_the_vault_cannot_cover_it() {
        let mut contract = setup(100, 150, 400);
        testing_env!(empty_ctx(agent(), T0));
        let denied = contract.spend(
            NATIVE_ASSET_ID.to_string(),
            U128(100),
            alice(),
            "ft.transfer".to_string(),
            None,
            None,
            None,
        );
        assert!(!denied.allowed);
        assert_eq!(denied.reason, R_INSUFFICIENT_BALANCE);
        assert_eq!(denied.reputation, 90);
    }

    #[test]
    fn check_agrees_when_the_vault_cannot_cover_the_transfer() {
        let contract = setup(100, 150, 400);
        testing_env!(empty_ctx(agent(), T0));
        assert_eq!(
            contract.check(
                agent(),
                NATIVE_ASSET_ID.to_string(),
                U128(100),
                alice(),
                "ft.transfer".to_string(),
                None,
                None
            ),
            format!("deny:{}", R_INSUFFICIENT_BALANCE)
        );
    }

    #[test]
    fn spend_above_per_tx_limit_is_denied_and_penalised() {
        let mut contract = setup(100, 150, 400);
        let denied = spend_as_agent(&mut contract, USDC, 101, alice(), T0, None);
        assert!(!denied.allowed);
        assert_eq!(denied.reason, R_PER_TX_LIMIT);
        assert_eq!(denied.reputation, 90);
        assert_eq!(contract.get_agents()[0].deny_count, 1);
    }

    #[test]
    fn second_spend_that_breaks_the_daily_limit_is_denied() {
        let mut contract = setup(100, 150, 400);
        assert!(spend_as_agent(&mut contract, USDC, 100, alice(), T0, None).allowed);
        let denied = spend_as_agent(&mut contract, USDC, 60, bob(), T0 + 6_000_000_000, None);
        assert!(!denied.allowed);
        assert_eq!(denied.reason, R_DAILY_LIMIT);
    }

    #[test]
    fn daily_window_resets_after_a_day() {
        let mut contract = setup(100, 150, 1000);
        spend_as_agent(&mut contract, USDC, 100, alice(), T0, None);
        assert_eq!(
            check_as_agent(&contract, USDC, 100, alice(), T0 + 6_000_000_000),
            "deny:DAILY_LIMIT"
        );
        // Pay a different allow-listed vendor so the next-day spend is not a
        // single-destination concentration (drainage detection is a separate test).
        spend_as_agent(&mut contract, USDC, 100, bob(), T0 + DAY, None);
        let usage = usage_as(&contract, USDC, T0 + DAY);
        assert_eq!(usage.day_spent, U128(100));
        assert_eq!(usage.month_spent, U128(200));
    }

    #[test]
    fn monthly_limit_catches_spending_spread_across_days() {
        let mut contract = setup(100, 150, 250);
        assert!(spend_as_agent(&mut contract, USDC, 100, alice(), T0, None).allowed);
        assert!(spend_as_agent(&mut contract, USDC, 100, alice(), T0 + DAY, None).allowed);
        let denied = spend_as_agent(&mut contract, USDC, 100, alice(), T0 + 2 * DAY, None);
        assert!(!denied.allowed);
        assert_eq!(denied.reason, R_MONTHLY_LIMIT);
    }

    #[test]
    fn monthly_window_resets_after_thirty_days() {
        let mut contract = setup(100, 150, 250);
        spend_as_agent(&mut contract, USDC, 100, alice(), T0, None);
        spend_as_agent(&mut contract, USDC, 100, alice(), T0 + DAY, None);
        assert_eq!(
            check_as_agent(&contract, USDC, 100, alice(), T0 + 2 * DAY),
            "deny:MONTHLY_LIMIT"
        );
        spend_as_agent(&mut contract, USDC, 100, bob(), T0 + NS_PER_MONTH, None);
        assert_eq!(
            usage_as(&contract, USDC, T0 + NS_PER_MONTH).month_spent,
            U128(100)
        );
    }

    #[test]
    fn recipient_outside_allowlist_is_denied() {
        let mut contract = setup(100, 150, 400);
        let denied = spend_as_agent(&mut contract, USDC, 10, accounts(5), T0, None);
        assert!(!denied.allowed);
        assert_eq!(denied.reason, R_RECIPIENT_NOT_ALLOWED);
    }

    #[test]
    fn denylisted_recipient_is_denied() {
        let mut contract = setup(100, 150, 400);
        let denied = spend_as_agent(&mut contract, USDC, 10, stranger(), T0, None);
        assert!(!denied.allowed);
        assert_eq!(denied.reason, R_RECIPIENT_DENIED);
    }

    #[test]
    fn paused_agent_spend_is_denied() {
        let mut contract = setup(100, 150, 400);
        testing_env!(ctx(owner(), T0));
        contract.pause_agent(agent());
        let denied = spend_as_agent(&mut contract, USDC, 10, alice(), T0, None);
        assert!(!denied.allowed);
        assert_eq!(denied.reason, R_AGENT_PAUSED);
    }

    #[test]
    fn unpausing_restores_spending() {
        let mut contract = setup(100, 150, 400);
        testing_env!(ctx(owner(), T0));
        contract.pause_agent(agent());
        testing_env!(ctx(owner(), T0));
        contract.unpause_agent(agent());
        spend_as_agent(&mut contract, USDC, 10, alice(), T0, None);
        assert_eq!(usage_as(&contract, USDC, T0).day_spent, U128(10));
    }

    #[test]
    #[should_panic(expected = "owner/multisig only")]
    fn agent_cannot_set_policy() {
        let mut contract = setup(100, 150, 400);
        testing_env!(ctx(agent(), T0));
        contract.set_policy(
            "hijacked".to_string(),
            vec![stranger()],
            vec![],
            true,
            limits(u128::MAX, u128::MAX, 0),
            vec![],
            vec![],
        );
    }

    #[test]
    #[should_panic(expected = "owner/multisig only")]
    fn agent_cannot_pause_the_vault() {
        let mut contract = setup(100, 150, 400);
        testing_env!(ctx(agent(), T0));
        contract.set_paused(true);
    }

    #[test]
    #[should_panic(expected = "owner/multisig only")]
    fn agent_cannot_withdraw() {
        let mut contract = setup(100, 150, 400);
        testing_env!(ctx(agent(), T0));
        contract.withdraw(USDC.to_string(), U128(1), agent());
    }

    #[test]
    #[should_panic(expected = "owner/multisig only")]
    fn agent_cannot_add_an_agent() {
        let mut contract = setup(100, 150, 400);
        testing_env!(ctx(agent(), T0));
        contract.add_agent(stranger(), "worker".to_string(), vec![], None);
    }

    #[test]
    #[should_panic(expected = "not a registered agent")]
    fn owner_cannot_spend() {
        let mut contract = setup(100, 150, 400);
        testing_env!(ctx(owner(), T0));
        contract.spend(
            USDC.to_string(),
            U128(10),
            alice(),
            "ft.transfer".to_string(),
            None,
            None,
            None,
        );
    }

    #[test]
    fn check_is_a_view_and_agrees_with_spend() {
        let contract = setup(100, 150, 400);
        assert_eq!(check_as_agent(&contract, USDC, 100, alice(), T0), "allow");
        assert_eq!(usage_as(&contract, USDC, T0).day_spent, U128(0));
        assert_eq!(contract.get_decision_count(), 0);
    }

    #[test]
    #[should_panic(expected = "unenforceable")]
    fn set_policy_rejects_per_tx_above_daily() {
        let mut contract = setup(100, 150, 400);
        testing_env!(ctx(owner(), T0));
        contract.set_policy(
            "bad".to_string(),
            vec![alice()],
            vec![],
            true,
            vec![AssetLimit {
                asset_id: USDC.to_string(),
                per_tx: U128(200),
                daily: U128(100),
                monthly: U128(400),
            }],
            vec![],
            vec![],
        );
    }

    #[test]
    #[should_panic(expected = "unenforceable")]
    fn set_policy_rejects_daily_above_monthly() {
        let mut contract = setup(100, 150, 400);
        testing_env!(ctx(owner(), T0));
        contract.set_policy(
            "bad".to_string(),
            vec![alice()],
            vec![],
            true,
            vec![AssetLimit {
                asset_id: USDC.to_string(),
                per_tx: U128(100),
                daily: U128(300),
                monthly: U128(200),
            }],
            vec![],
            vec![],
        );
    }

    #[test]
    fn set_policy_does_not_reset_counters() {
        let mut contract = setup(100, 150, 400);
        spend_as_agent(&mut contract, USDC, 100, alice(), T0, Some("decision-1"));
        let hash_before = contract.get_last_decision_hash();
        testing_env!(ctx(owner(), T0 + 1));
        install_policy(&mut contract, 40, 120, 300);
        let usage = usage_as(&contract, USDC, T0 + 1);
        assert_eq!(usage.day_spent, U128(100));
        assert_eq!(contract.get_decision_count(), 1);
        assert_eq!(contract.get_last_decision_hash(), hash_before);
        assert_eq!(contract.get_config().policy_hash, "policy-hash-1");
    }

    #[test]
    fn decision_hash_chain_advances_and_count_increments() {
        let mut contract = setup(100, 150, 400);
        assert_eq!(contract.get_decision_count(), 0);
        assert_eq!(contract.get_last_decision_hash(), ZERO_HASH);
        spend_as_agent(&mut contract, USDC, 10, alice(), T0, Some("decision-1"));
        let first = contract.get_last_decision_hash();
        assert_eq!(
            first,
            hex(&env::sha256(&[ZERO_HASH.as_bytes(), b"decision-1".as_slice()].concat()))
        );
        spend_as_agent(&mut contract, USDC, 10, bob(), T0 + 6_000_000_000, Some("decision-2"));
        let second = contract.get_last_decision_hash();
        assert_ne!(first, second);
        assert_eq!(contract.get_decision_count(), 2);
    }

    #[test]
    fn spend_without_decision_hash_still_advances_the_chain() {
        let mut contract = setup(100, 150, 400);
        spend_as_agent(&mut contract, USDC, 10, alice(), T0, None);
        let first = contract.get_last_decision_hash();
        assert_eq!(first, hex(&env::sha256(ZERO_HASH.as_bytes())));
        spend_as_agent(&mut contract, USDC, 10, alice(), T0 + 6_000_000_000, None);
        assert_eq!(contract.get_last_decision_hash(), hex(&env::sha256(first.as_bytes())));
    }

    #[test]
    fn unknown_asset_has_no_limit() {
        let contract = setup(100, 150, 400);
        assert_eq!(check_as_agent(&contract, "dai.near", 1, alice(), T0), "deny:NO_LIMIT");
    }

    #[test]
    fn zero_amount_is_rejected() {
        let contract = setup(100, 150, 400);
        assert_eq!(
            check_as_agent(&contract, USDC, 0, alice(), T0),
            "deny:NON_POSITIVE_AMOUNT"
        );
    }

    #[test]
    fn zero_amount_spend_is_denied() {
        let mut contract = setup(100, 150, 400);
        let denied = spend_as_agent(&mut contract, USDC, 0, alice(), T0, None);
        assert!(!denied.allowed);
        assert_eq!(denied.reason, R_NON_POSITIVE_AMOUNT);
    }

    #[test]
    fn owner_withdraw_bypasses_limits_and_usage() {
        let mut contract = setup(100, 150, 400);
        spend_as_agent(&mut contract, USDC, 100, alice(), T0, Some("decision-1"));
        let hash_after_spend = contract.get_last_decision_hash();
        testing_env!(ctx(owner(), T0 + 1));
        contract.withdraw(USDC.to_string(), U128(1_000_000), accounts(5));
        assert_eq!(usage_as(&contract, USDC, T0 + 1).day_spent, U128(100));
        assert_eq!(contract.get_decision_count(), 1);
        assert_eq!(contract.get_last_decision_hash(), hash_after_spend);
    }

    #[test]
    #[should_panic(expected = "NON_POSITIVE_AMOUNT")]
    fn owner_withdraw_of_zero_panics() {
        let mut contract = setup(100, 150, 400);
        testing_env!(ctx(owner(), T0));
        contract.withdraw(USDC.to_string(), U128(0), alice());
    }

    #[test]
    fn set_agent_rotates_the_key() {
        let mut contract = setup(100, 150, 400);
        testing_env!(ctx(owner(), T0));
        contract.set_agent(stranger());
        testing_env!(ctx(agent(), T0));
        let denied = panic_message(|| {
            contract.spend(
                USDC.to_string(),
                U128(10),
                alice(),
                "ft.transfer".to_string(),
                None,
                None,
                None,
            );
        });
        assert!(denied.contains("not a registered agent"), "unexpected panic: {}", denied);
        testing_env!(ctx(stranger(), T0));
        contract.spend(
            USDC.to_string(),
            U128(10),
            alice(),
            "ft.transfer".to_string(),
            None,
            None,
            None,
        );
        assert_eq!(contract.get_agents()[0].account, stranger());
    }

    #[test]
    fn get_config_reports_the_installed_policy() {
        let contract = setup(100, 150, 400);
        let config = contract.get_config();
        assert_eq!(config.owner, owner());
        assert!(config.watchers.is_empty());
        assert_eq!(config.policy_hash, "policy-hash-1");
        assert_eq!(config.allowlist, vec![alice(), bob()]);
        assert_eq!(config.agents.len(), 1);
        assert_eq!(config.aggregate_limits, limits(100, 150, 400));
    }

    #[test]
    fn get_usage_of_a_fresh_asset_is_zero() {
        let contract = setup(100, 150, 400);
        let usage = usage_as(&contract, "dai.near", T0);
        assert_eq!(usage.day_spent, U128(0));
        assert_eq!(usage.month_spent, U128(0));
    }

    // -- reputation ---------------------------------------------------------

    #[test]
    fn reputation_starts_at_100() {
        let contract = setup(100, 150, 400);
        let (reputation, effective) = contract.check_reputation(agent());
        assert_eq!(reputation, 100);
        assert_eq!(effective[0].per_tx, U128(100));
    }

    #[test]
    fn reputation_drops_10_on_denial() {
        let mut contract = setup(100, 150, 400);
        let denied = spend_as_agent(&mut contract, USDC, 101, alice(), T0, None);
        assert!(!denied.allowed);
        assert_eq!(contract.check_reputation(agent()).0, 90);
        assert_eq!(contract.get_agents()[0].deny_count, 1);
    }

    #[test]
    fn reputation_rises_1_on_clean_spend() {
        let mut contract = setup(100, 150, 400);
        // Drop to 90 first: the penalty must survive the denied call.
        spend_as_agent(&mut contract, USDC, 101, alice(), T0, None);
        assert_eq!(contract.check_reputation(agent()).0, 90);
        assert!(spend_as_agent(&mut contract, USDC, 10, alice(), T0 + 6_000_000_000, None).allowed);
        assert_eq!(contract.check_reputation(agent()).0, 91);
    }

    #[test]
    fn reputation_adjusts_limits() {
        let mut contract = setup(100, 1000, 0);
        for i in 0..5 {
            let denied = spend_as_agent(&mut contract, USDC, 101, alice(), T0 + i * 6_000_000_000, None);
            assert!(!denied.allowed);
        }
        let (reputation, effective) = contract.check_reputation(agent());
        assert_eq!(reputation, 50);
        assert_eq!(effective[0].daily, U128(500));
        // 600 is within the base 1000 daily cap but above the effective 500.
        assert_eq!(
            check_as_agent(&contract, USDC, 600, alice(), T0 + 60_000_000_000),
            "deny:PER_TX_LIMIT"
        );
    }

    #[test]
    fn reputation_freezes_agent_at_zero() {
        let mut contract = setup(100, 1000, 0);
        for i in 0..10 {
            let denied = spend_as_agent(&mut contract, USDC, 101, alice(), T0 + i * 6_000_000_000, None);
            assert!(!denied.allowed);
        }
        assert_eq!(contract.check_reputation(agent()).0, 0);
        assert_eq!(
            check_as_agent(&contract, USDC, 1, alice(), T0 + 120_000_000_000),
            "deny:REPUTATION_FROZEN"
        );
    }

    // -- multi-agent --------------------------------------------------------

    fn two_agent_vault() -> Contract {
        testing_env!(ctx(owner(), T0));
        let mut contract = Contract::new(owner());
        contract.add_agent(agent(), "worker".to_string(), limits(100, 100, 0), None);
        contract.add_agent(bob(), "worker".to_string(), limits(100, 100, 0), None);
        contract.set_policy(
            "multi".to_string(),
            vec![alice()],
            vec![],
            true,
            limits(100, 150, 0),
            vec!["ft.transfer".to_string()],
            vec![],
        );
        contract
    }

    #[test]
    fn multiple_agents_have_independent_limits() {
        let mut contract = two_agent_vault();
        spend_as_agent(&mut contract, USDC, 70, alice(), T0, None);
        testing_env!(ctx(bob(), T0 + 6_000_000_000));
        contract.spend(
            USDC.to_string(),
            U128(70),
            alice(),
            "ft.transfer".to_string(),
            None,
            None,
            None,
        );
        assert_eq!(usage_as(&contract, USDC, T0).day_spent, U128(70));
    }

    #[test]
    fn aggregate_limit_blocks_both_agents() {
        let mut contract = two_agent_vault();
        assert!(spend_as_agent(&mut contract, USDC, 80, alice(), T0, None).allowed);
        testing_env!(ctx(bob(), T0 + 6_000_000_000));
        let denied = contract.spend(
            USDC.to_string(),
            U128(80),
            alice(),
            "ft.transfer".to_string(),
            None,
            None,
            None,
        );
        assert!(!denied.allowed);
        testing_env!(ctx(bob(), T0 + 6_000_000_000));
        assert_eq!(
            contract.check(
                bob(),
                USDC.to_string(),
                U128(71),
                alice(),
                "ft.transfer".to_string(),
                None,
                None
            ),
            "deny:AGGREGATE_DAILY_LIMIT"
        );
    }

    #[test]
    fn pausing_one_agent_does_not_affect_others() {
        let mut contract = two_agent_vault();
        testing_env!(ctx(owner(), T0));
        contract.pause_agent(agent());
        testing_env!(ctx(agent(), T0));
        assert_eq!(
            contract.check(
                agent(),
                USDC.to_string(),
                U128(1),
                alice(),
                "ft.transfer".to_string(),
                None,
                None
            ),
            "deny:AGENT_PAUSED"
        );
        testing_env!(ctx(bob(), T0));
        assert_eq!(
            contract.check(
                bob(),
                USDC.to_string(),
                U128(1),
                alice(),
                "ft.transfer".to_string(),
                None,
                None
            ),
            "allow"
        );
    }

    #[test]
    fn agent_removal_clears_its_state() {
        let mut contract = two_agent_vault();
        testing_env!(ctx(owner(), T0));
        contract.remove_agent(bob());
        assert_eq!(contract.get_agents().len(), 1);
        testing_env!(ctx(bob(), T0));
        assert_eq!(
            contract.check(
                bob(),
                USDC.to_string(),
                U128(1),
                alice(),
                "ft.transfer".to_string(),
                None,
                None
            ),
            "deny:AGENT_NOT_FOUND"
        );
    }

    // -- anomaly ------------------------------------------------------------

    #[test]
    fn burst_detection_triggers_circuit_breaker() {
        let mut contract = setup(10, 1000, 0);
        for i in 0..5u64 {
            spend_as_agent(
                &mut contract,
                USDC,
                1,
                alice(),
                T0 + i * 6_000_000_000,
                None,
            );
        }
        testing_env!(ctx(agent(), T0 + 30_000_000_000));
        assert_eq!(
            contract.check(
                agent(),
                USDC.to_string(),
                U128(1),
                alice(),
                "ft.transfer".to_string(),
                None,
                None
            ),
            "deny:ANOMALY_BURST"
        );
        let agent_state = &contract.get_agents()[0];
        assert!(agent_state.anomaly.flags.iter().any(|f| f == "BURST"));
        assert_eq!(agent_state.circuit_breaker, CB_LIMITED);
    }

    #[test]
    fn drainage_detection_flags_high_concentration() {
        let mut contract = setup(20, 100, 0);
        // Space the payments past the 60s burst window: this test is about
        // concentration, not about velocity.
        for i in 0..5u64 {
            spend_as_agent(
                &mut contract,
                USDC,
                10,
                alice(),
                T0 + i * 61_000_000_000,
                None,
            );
        }
        testing_env!(ctx(agent(), T0 + 305_000_000_000));
        assert_eq!(
            contract.check(
                agent(),
                USDC.to_string(),
                U128(10),
                alice(),
                "ft.transfer".to_string(),
                None,
                None
            ),
            "deny:ANOMALY_DRAINAGE"
        );
    }

    #[test]
    fn deviation_detection_flags_outlier_transaction() {
        let mut contract = setup(100, 1000, 0);
        // One payment per burst window, so only the baseline size matters here.
        for i in 0..10u64 {
            spend_as_agent(
                &mut contract,
                USDC,
                10,
                alice(),
                T0 + i * 61_000_000_000,
                None,
            );
        }
        testing_env!(ctx(agent(), T0 + 610_000_000_000));
        assert_eq!(
            contract.check(
                agent(),
                USDC.to_string(),
                U128(100),
                alice(),
                "ft.transfer".to_string(),
                None,
                None
            ),
            "deny:ANOMALY_DEVIATION"
        );
    }

    #[test]
    fn anomaly_reduces_reputation() {
        let mut contract = setup(10, 1000, 0);
        for i in 0..5u64 {
            spend_as_agent(
                &mut contract,
                USDC,
                1,
                alice(),
                T0 + i * 6_000_000_000,
                None,
            );
        }
        // 5 clean spends: 100 + 5 capped at 100, then the burst anomaly penalty.
        let (reputation, _) = contract.check_reputation(agent());
        assert!(reputation < 100, "reputation was {}", reputation);
    }

    // -- circuit breakers ---------------------------------------------------

    #[test]
    fn level1_reduces_limits_to_10_percent() {
        let mut contract = setup(100, 1000, 0);
        testing_env!(ctx(owner(), T0));
        contract.trigger_circuit_breaker(agent(), CB_LIMITED, "manual".to_string());
        testing_env!(ctx(agent(), T0 + 1_000_000_000));
        // Effective per-tx is 10, so 50 is denied even though the base limit is 100.
        assert_eq!(
            contract.check(
                agent(),
                USDC.to_string(),
                U128(50),
                alice(),
                "ft.transfer".to_string(),
                None,
                None
            ),
            "deny:PER_TX_LIMIT"
        );
        assert_eq!(
            contract.check(
                agent(),
                USDC.to_string(),
                U128(10),
                alice(),
                "ft.transfer".to_string(),
                None,
                None
            ),
            "allow"
        );
    }

    #[test]
    fn level2_pauses_agent() {
        let mut contract = setup(100, 1000, 0);
        testing_env!(ctx(owner(), T0));
        contract.trigger_circuit_breaker(agent(), CB_AGENT_PAUSED, "repeated anomalies".to_string());
        testing_env!(ctx(agent(), T0 + 1));
        assert_eq!(
            contract.check(
                agent(),
                USDC.to_string(),
                U128(1),
                alice(),
                "ft.transfer".to_string(),
                None,
                None
            ),
            "deny:AGENT_PAUSED"
        );
    }

    #[test]
    fn level4_freezes_entire_vault() {
        let mut contract = two_agent_vault();
        testing_env!(ctx(owner(), T0));
        contract.emergency_freeze();
        testing_env!(ctx(agent(), T0));
        assert_eq!(
            contract.check(
                agent(),
                USDC.to_string(),
                U128(1),
                alice(),
                "ft.transfer".to_string(),
                None,
                None
            ),
            "deny:EMERGENCY_FREEZE"
        );
        testing_env!(ctx(bob(), T0));
        assert_eq!(
            contract.check(
                bob(),
                USDC.to_string(),
                U128(1),
                alice(),
                "ft.transfer".to_string(),
                None,
                None
            ),
            "deny:EMERGENCY_FREEZE"
        );
    }

    #[test]
    fn emergency_freeze_by_guardian_works() {
        let mut contract = setup(100, 1000, 0);
        testing_env!(ctx(owner(), T0));
        contract.register_guardian(alice());
        testing_env!(ctx(alice(), T0));
        contract.emergency_freeze();
        assert_eq!(contract.get_vault_breaker().level, CB_EMERGENCY_FREEZE);
    }

    #[test]
    fn thaw_restores_spending() {
        let mut contract = setup(100, 1000, 0);
        testing_env!(ctx(owner(), T0));
        contract.emergency_freeze();
        testing_env!(ctx(owner(), T0));
        contract.thaw();
        spend_as_agent(&mut contract, USDC, 10, alice(), T0, None);
        assert_eq!(usage_as(&contract, USDC, T0).day_spent, U128(10));
    }

    // -- governance ---------------------------------------------------------

    #[test]
    fn timelock_cannot_execute_before_delay() {
        let mut contract = setup(100, 1000, 0);
        testing_env!(ctx(owner(), T0));
        let id = contract.propose_timelock("withdraw".to_string(), "{}".to_string(), None);
        testing_env!(ctx(owner(), T0 + 1));
        let message = panic_message(|| contract.execute_timelock(id.clone()));
        assert!(message.contains("not yet executable"), "{}", message);
    }

    #[test]
    fn watcher_can_cancel_timelock() {
        let mut contract = setup(100, 1000, 0);
        testing_env!(ctx(owner(), T0));
        contract.register_watcher(bob());
        let id = contract.propose_timelock("withdraw".to_string(), "{}".to_string(), None);
        testing_env!(ctx(bob(), T0 + 1));
        contract.cancel_timelock(id.clone());
        testing_env!(ctx(owner(), T0 + 2 * DEFAULT_TIMELOCK_DELAY_NS));
        let message = panic_message(|| contract.execute_timelock(id.clone()));
        assert!(message.contains("cancelled"), "{}", message);
    }

    #[test]
    fn owner_can_execute_timelock_after_delay() {
        let mut contract = setup(100, 1000, 0);
        testing_env!(ctx(owner(), T0));
        let id = contract.propose_timelock("withdraw".to_string(), "{}".to_string(), None);
        testing_env!(ctx(owner(), T0 + DEFAULT_TIMELOCK_DELAY_NS + 1));
        contract.execute_timelock(id);
        assert!(contract.get_timelocks().is_empty());
    }

    #[test]
    fn guardian_can_emergency_freeze_and_stranger_cannot() {
        let mut contract = setup(100, 1000, 0);
        testing_env!(ctx(owner(), T0));
        contract.register_guardian(alice());
        testing_env!(ctx(bob(), T0));
        let message = panic_message(|| contract.emergency_freeze());
        assert!(message.contains("only guardians"), "{}", message);
        testing_env!(ctx(alice(), T0));
        contract.emergency_freeze();
        assert_eq!(contract.get_vault_breaker().level, CB_EMERGENCY_FREEZE);
    }

    // -- attestation --------------------------------------------------------

    #[test]
    fn attestation_is_required_when_registered() {
        let mut contract = setup(100, 1000, 0);
        testing_env!(ctx(owner(), T0));
        contract.register_attestation(agent(), hex(&env::sha256(b"proof")));
        testing_env!(ctx(agent(), T0));
        assert_eq!(
            contract.check(
                agent(),
                USDC.to_string(),
                U128(10),
                alice(),
                "ft.transfer".to_string(),
                None,
                None
            ),
            "deny:ATTESTATION_REQUIRED"
        );
    }

    #[test]
    fn wrong_attestation_hash_is_rejected() {
        let mut contract = setup(100, 1000, 0);
        testing_env!(ctx(owner(), T0));
        contract.register_attestation(agent(), hex(&env::sha256(b"proof")));
        testing_env!(ctx(agent(), T0));
        assert_eq!(
            contract.check(
                agent(),
                USDC.to_string(),
                U128(10),
                alice(),
                "ft.transfer".to_string(),
                Some("forged".to_string()),
                None
            ),
            "deny:ATTESTATION_MISMATCH"
        );
        testing_env!(ctx(agent(), T0));
        assert_eq!(
            contract.check(
                agent(),
                USDC.to_string(),
                U128(10),
                alice(),
                "ft.transfer".to_string(),
                Some("proof".to_string()),
                None
            ),
            "allow"
        );
    }

    // -- approval queue -----------------------------------------------------

    #[test]
    fn approval_request_can_be_approved_and_executed() {
        let mut contract = setup(100, 1000, 0);
        testing_env!(ctx(agent(), T0));
        let id = contract.request_approval(USDC.to_string(), U128(40), alice());
        assert_eq!(contract.get_pending_approvals().len(), 1);
        testing_env!(ctx(owner(), T0 + 1));
        contract.approve_approval(id);
        assert!(contract.get_pending_approvals().is_empty());
        assert_eq!(usage_as(&contract, USDC, T0 + 1).day_spent, U128(40));
    }

    // -- check / spend agreement for every code -----------------------------

    #[test]
    fn check_agrees_with_spend_for_all_reason_codes() {
        let cases: Vec<(&str, Box<dyn Fn() -> String>)> = vec![
            ("PER_TX_LIMIT", Box::new(|| {
                let contract = setup(100, 150, 400);
                check_as_agent(&contract, USDC, 101, alice(), T0)
            })),
            ("DAILY_LIMIT", Box::new(|| {
                let mut contract = setup(100, 150, 400);
                spend_as_agent(&mut contract, USDC, 100, alice(), T0, None);
                check_as_agent(&contract, USDC, 60, bob(), T0 + 6_000_000_000)
            })),
            ("RECIPIENT_NOT_ALLOWED", Box::new(|| {
                let contract = setup(100, 150, 400);
                check_as_agent(&contract, USDC, 10, accounts(5), T0)
            })),
            ("RECIPIENT_DENIED", Box::new(|| {
                let contract = setup(100, 150, 400);
                check_as_agent(&contract, USDC, 10, stranger(), T0)
            })),
            ("NO_LIMIT", Box::new(|| {
                let contract = setup(100, 150, 400);
                check_as_agent(&contract, "dai.near", 10, alice(), T0)
            })),
            ("NON_POSITIVE_AMOUNT", Box::new(|| {
                let contract = setup(100, 150, 400);
                check_as_agent(&contract, USDC, 0, alice(), T0)
            })),
            ("ACTION_NOT_ALLOWED", Box::new(|| {
                let contract = setup(100, 150, 400);
                testing_env!(ctx(agent(), T0));
                contract.check(
                    agent(),
                    USDC.to_string(),
                    U128(10),
                    alice(),
                    "key.add".to_string(),
                    None,
                    None,
                )
            })),
            ("VAULT_PAUSED", Box::new(|| {
                let mut contract = setup(100, 150, 400);
                testing_env!(ctx(owner(), T0));
                contract.set_paused(true);
                check_as_agent(&contract, USDC, 10, alice(), T0)
            })),
            ("DESTINATION_NOT_ALLOWED", Box::new(|| {
                let mut contract = setup(100, 150, 400);
                testing_env!(ctx(owner(), T0));
                contract.set_intent_policy(
                    vec!["near-intents".to_string()],
                    100,
                    vec!["0xabc".to_string()],
                );
                testing_env!(ctx(agent(), T0));
                contract.check(
                    agent(),
                    USDC.to_string(),
                    U128(10),
                    alice(),
                    "intent.swap".to_string(),
                    None,
                    Some("0xdead".to_string()),
                )
            })),
        ];

        for (code, case) in cases {
            assert_eq!(case(), format!("deny:{}", code), "check() disagreed for {}", code);
        }
    }

    #[test]
    fn v1_set_agent_still_works() {
        testing_env!(ctx(owner(), T0));
        let mut contract = Contract::new(owner());
        contract.set_policy(
            "v1".to_string(),
            vec![alice()],
            vec![],
            true,
            limits(100, 150, 400),
            vec![],
            vec![],
        );
        contract.set_agent(agent());
        spend_as_agent(&mut contract, USDC, 10, alice(), T0, None);
        assert_eq!(usage_as(&contract, USDC, T0).day_spent, U128(10));
    }

    #[test]
    fn single_agent_mode_works_like_the_old_firewall() {
        let mut contract = setup(100, 150, 400);
        assert_eq!(check_as_agent(&contract, USDC, 100, alice(), T0), "allow");
        assert_eq!(
            check_as_agent(&contract, USDC, 101, alice(), T0),
            "deny:PER_TX_LIMIT"
        );
        assert_eq!(
            check_as_agent(&contract, USDC, 100, accounts(5), T0),
            "deny:RECIPIENT_NOT_ALLOWED"
        );
    }
}
