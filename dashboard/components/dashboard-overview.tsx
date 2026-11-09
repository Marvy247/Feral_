'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Shield, Zap, AlertTriangle, CheckCircle, Users, Activity, Lock,
  RefreshCw, Clock, Check, X, Link2,
} from 'lucide-react'
import {
  decideApproval, getSummary,
  type FeralAgent, type Summary, type AuditRecord,
} from '@/lib/feral-api'

const ease = [0.22, 1, 0.36, 1] as const
const POLL_MS = 4000

function timeLabel(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleTimeString([], { hour12: false })
}

function ageLabel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return '-'
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}

function num(value: string | undefined): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function pct(part: string | undefined, whole: string | undefined): number {
  const limit = num(whole)
  return limit > 0 ? Math.min(100, Math.max(0, (num(part) / limit) * 100)) : 0
}

function usdc(agent: FeralAgent) {
  return agent.effective.USDC ?? agent.effective.usdc
}

function ReputationBar({ rep }: { rep: number }) {
  const color = rep >= 80 ? 'bg-emerald-500' : rep >= 40 ? 'bg-amber-400' : 'bg-red-500'
  const text = rep >= 80 ? 'text-emerald-400' : rep >= 40 ? 'text-amber-400' : 'text-red-400'
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-slate-400">Reputation</span>
        <span className={`text-xs font-bold ${text}`}>{rep}</span>
      </div>
      <div className="h-1.5 rounded-full bg-white/[0.08] overflow-hidden">
        <motion.div className={`h-full rounded-full ${color}`} animate={{ width: `${rep}%` }}
          transition={{ duration: 0.6, ease: 'easeOut' }} />
      </div>
    </div>
  )
}

function BudgetBar({ used, limit, asset }: { used: string; limit: string; asset: string }) {
  const percentage = pct(used, limit)
  const color = percentage > 90 ? 'bg-red-500' : percentage > 70 ? 'bg-amber-400' : 'bg-sky-500'
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-slate-400">Daily {asset}</span>
        <span className="text-xs text-slate-400 font-mono">{used}/{limit}</span>
      </div>
      <div className="h-1.5 rounded-full bg-white/[0.08] overflow-hidden">
        <motion.div className={`h-full rounded-full ${color}`} animate={{ width: `${percentage}%` }}
          transition={{ duration: 0.5, ease: 'easeOut' }} />
      </div>
    </div>
  )
}

function VerdictChip({ record }: { record: AuditRecord }) {
  if (record.verdict === 'allow') return <span className="text-emerald-400 font-semibold text-xs">ALLOW</span>
  if (record.verdict === 'deny') {
    return <span className="text-red-400 font-semibold text-xs">DENY: {record.reasons[0] ?? 'POLICY'}</span>
  }
  return <span className="text-amber-400 font-semibold text-xs">NEEDS APPROVAL</span>
}

function verdictDot(verdict: AuditRecord['verdict']): string {
  if (verdict === 'allow') return 'bg-emerald-400'
  if (verdict === 'deny') return 'bg-red-400'
  return 'bg-amber-400'
}

function statusBadge(agent: FeralAgent): string {
  if (agent.status === 'active') return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
  if (agent.status === 'frozen') return 'bg-amber-500/15 text-amber-400 border-amber-500/30'
  return 'bg-red-500/15 text-red-400 border-red-500/30'
}

function tierBadge(tier: string): string {
  return tier === 'supervisor'
    ? 'bg-violet-500/20 text-violet-400 border-violet-500/30'
    : 'bg-sky-500/15 text-sky-400 border-sky-500/30'
}

function Panel({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay, ease }}
      className="rounded-2xl border border-white/[0.08] bg-white/[0.04] backdrop-blur-xl p-6"
    >
      {children}
    </motion.div>
  )
}

export function DashboardOverview() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setSummary(await getSummary())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), POLL_MS)
    return () => clearInterval(id)
  }, [refresh])

  const decide = async (id: string, decision: 'approve' | 'reject') => {
    setPending(id)
    try {
      await decideApproval(id, decision)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(null)
    }
  }

  if (!summary) {
    return (
      <div className="space-y-6 rounded-3xl bg-[#0b1220] p-6 md:p-8">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Feral Security Dashboard</h1>
          <p className="text-slate-500 mt-1 text-sm">Connecting to the Feral guard API…</p>
        </div>
        {error ? (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.06] p-6">
            <p className="text-sm text-amber-300 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" /> The dashboard could not reach the guard.
            </p>
            <p className="mt-2 text-xs text-slate-400 font-mono">{error}</p>
            <p className="mt-3 text-xs text-slate-500">
              Start it in the project root with <span className="font-mono text-slate-300">npm run serve</span>,
              then reload this page.
            </p>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <RefreshCw className="w-4 h-4 animate-spin" /> Loading policy state…
          </div>
        )}
      </div>
    )
  }

  const { policy, vault, agents, approvals, audit, anomalyFeed, auditHead, uptimeSeconds } = summary
  const recent = [...audit].reverse().slice(0, 10)
  const denials = audit.filter((record) => record.verdict === 'deny').length
  const activeCount = agents.filter((agent) => agent.status === 'active').length
  const breakerLevel = vault.breaker.level
  const aggregate = Object.entries(vault.aggregate)

  return (
    <div className="space-y-6 rounded-3xl bg-[#0b1220] p-6 md:p-8 text-white shadow-xl shadow-slate-900/20">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease }}
        className="flex flex-wrap items-start justify-between gap-4"
      >
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Feral Security Dashboard</h1>
          <p className="text-slate-500 mt-1 text-sm">
            {policy.name} v{policy.version} · {agents.length} agents · vault breaker level {breakerLevel} · up {Math.floor(uptimeSeconds / 60)}m
          </p>
          <p className="text-slate-600 mt-1 text-xs font-mono flex items-center gap-1.5">
            <Link2 className="w-3 h-3" /> policy {policy.hash.slice(0, 16)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs px-3 py-1.5 rounded-full border ${
            auditHead.ok
              ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
              : 'text-red-400 bg-red-500/10 border-red-500/30'
          }`}>
            {auditHead.ok ? `audit verified · ${auditHead.records}` : 'audit chain BROKEN'}
          </span>
          <div className={`flex items-center gap-1.5 text-xs rounded-full px-3 py-1.5 border ${
            error
              ? 'text-amber-400 bg-amber-500/10 border-amber-500/20'
              : 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
          }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${error ? 'bg-amber-400' : 'bg-emerald-400 animate-pulse'}`} />
            {error ? 'stale' : 'Live'}
          </div>
        </div>
      </motion.div>

      {error && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-3 text-xs text-amber-300">
          Last refresh failed: {error}
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Decisions', value: audit.length, icon: Activity, accent: 'sky' },
          { label: 'Denials', value: denials, icon: Shield, accent: 'red' },
          { label: 'Active agents', value: activeCount, icon: Users, accent: 'emerald' },
          { label: 'Vault status', value: breakerLevel === 0 ? 'Normal' : `Level ${breakerLevel}`, icon: Lock, accent: breakerLevel === 0 ? 'emerald' : 'red' },
        ].map((stat, i) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.08 + i * 0.05, ease }}
            className="rounded-2xl border border-white/[0.08] bg-white/[0.04] backdrop-blur-xl p-5 hover:border-sky-500/20 hover:bg-white/[0.06] transition-all duration-300"
          >
            <div className="flex items-center gap-2 mb-3">
              <stat.icon className={`w-4 h-4 ${stat.accent === 'red' ? 'text-red-400' : stat.accent === 'emerald' ? 'text-emerald-400' : 'text-sky-400'}`} />
              <p className="text-xs text-slate-400 font-medium uppercase tracking-wide">{stat.label}</p>
            </div>
            <motion.p
              key={String(stat.value)}
              initial={{ scale: 1.15, opacity: 0.6 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 400, damping: 25 }}
              className={`text-3xl font-black tracking-tight ${
                stat.accent === 'red' ? 'text-red-400' : stat.accent === 'emerald' ? 'text-emerald-400' : 'text-white'}`}
            >
              {stat.value}
            </motion.p>
          </motion.div>
        ))}
      </div>

      {/* Agent grid */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, delay: 0.28, ease }}
      >
        <h2 className="text-xs font-semibold text-slate-500 mb-3 uppercase tracking-wider">Agent Status</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {agents.map((agent, i) => {
            const budget = usdc(agent)
            return (
              <motion.div
                key={agent.account}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.32 + i * 0.07, ease }}
                className="rounded-2xl border border-white/[0.08] bg-white/[0.04] backdrop-blur-xl p-5 hover:border-sky-500/20 hover:bg-white/[0.06] transition-all duration-300"
              >
                <div className="flex items-center justify-between mb-4 gap-2">
                  <span className="font-mono text-sm text-white font-semibold truncate">{agent.account}</span>
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full border shrink-0 ${tierBadge(agent.tier)}`}>
                    {agent.tier}
                  </span>
                </div>

                <ReputationBar rep={agent.reputation} />
                {budget ? (
                  <BudgetBar used={budget.spentDay} limit={budget.daily} asset="USDC" />
                ) : (
                  <p className="mb-3 text-xs text-slate-500">no USDC limit in policy</p>
                )}

                <div className="flex items-center justify-between">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${statusBadge(agent)}`}>
                    {agent.status}
                  </span>
                  <span className={`text-xs font-mono ${
                    agent.anomaly.score > 50 ? 'text-red-400' : agent.anomaly.score > 20 ? 'text-amber-400' : 'text-slate-500'}`}>
                    anomaly {agent.anomaly.score}
                  </span>
                </div>

                <div className="mt-3 pt-3 border-t border-white/[0.06] flex items-center justify-between text-xs text-slate-500">
                  <span>{agent.txCount} allowed / {agent.denyCount} denied</span>
                  <span>{agent.knownCounterparties.length} counterparties</span>
                </div>

                {(agent.breaker.level > 0 || agent.anomaly.flags.length > 0) && (
                  <div className="mt-2 space-y-1">
                    {agent.breaker.level > 0 && (
                      <p className="text-xs text-amber-400/80 flex items-center gap-1.5">
                        <Zap className="w-3 h-3" /> breaker {agent.breaker.level}: {agent.breaker.reason}
                      </p>
                    )}
                    {agent.anomaly.flags.length > 0 && (
                      <p className="text-xs text-red-400/80 flex items-center gap-1.5">
                        <AlertTriangle className="w-3 h-3" /> {agent.anomaly.flags.join(', ')}
                      </p>
                    )}
                  </div>
                )}
              </motion.div>
            )
          })}
          {agents.length === 0 && (
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.04] p-6 text-sm text-slate-500">
              No agents are registered in this policy.
            </div>
          )}
        </div>
      </motion.div>

      {/* Transaction + anomaly feeds */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Panel delay={0.5}>
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-base font-bold text-white">Decision Feed</h2>
              <p className="text-xs text-slate-500 mt-0.5">Every verdict in the hash-chained audit log</p>
            </div>
            <RefreshCw className="w-3.5 h-3.5 text-slate-600 animate-spin" style={{ animationDuration: '3s' }} />
          </div>

          <div className="space-y-2 min-h-[280px]">
            <AnimatePresence initial={false}>
              {recent.map((record) => (
                <motion.div
                  key={record.seq}
                  layout
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3, ease: 'easeOut' }}
                  className="flex items-center justify-between p-3 rounded-xl border border-white/[0.06] bg-white/[0.02] hover:border-white/[0.12] hover:bg-white/[0.04]"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${verdictDot(record.verdict)}`} />
                    <div className="min-w-0">
                      <p className="text-xs font-mono text-slate-300 truncate">{record.agent}</p>
                      <p className="text-xs text-slate-500 truncate">
                        {record.kind} · {record.amount} {record.asset} · #{record.seq}
                      </p>
                    </div>
                  </div>
                  <div className="text-right shrink-0 ml-2">
                    <VerdictChip record={record} />
                    <div className="flex items-center justify-end gap-1.5 mt-0.5">
                      <span className={`text-xs font-mono ${
                        record.reputationAfter > record.reputationBefore ? 'text-emerald-400/70'
                          : record.reputationAfter < record.reputationBefore ? 'text-red-400/70' : 'text-slate-600'}`}>
                        {record.reputationBefore}→{record.reputationAfter}
                      </span>
                      <p className="text-xs text-slate-600">{ageLabel(record.at)}</p>
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
            {recent.length === 0 && (
              <div className="flex flex-col items-center justify-center h-40 gap-2 text-center">
                <Activity className="w-6 h-6 text-slate-600" />
                <p className="text-xs text-slate-500">No decisions yet. Submit an action through the API or CLI.</p>
              </div>
            )}
          </div>
        </Panel>

        <Panel delay={0.55}>
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-base font-bold text-white">Anomaly Feed</h2>
              <p className="text-xs text-slate-500 mt-0.5">Detectors run on every evaluation</p>
            </div>
            <AlertTriangle className="w-4 h-4 text-slate-500" />
          </div>

          <div className="space-y-3 min-h-[200px]">
            <AnimatePresence initial={false}>
              {anomalyFeed.map((event, i) => (
                <motion.div
                  key={`${event.agent}-${event.at}-${i}`}
                  layout
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3, ease: 'easeOut' }}
                  className={`p-4 rounded-xl border ${
                    event.severity === 'high' ? 'border-red-500/20 bg-red-500/[0.06]'
                      : event.severity === 'medium' ? 'border-amber-500/20 bg-amber-500/[0.06]'
                        : 'border-slate-500/20 bg-slate-500/[0.06]'}`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <AlertTriangle className={`w-3.5 h-3.5 shrink-0 ${event.severity === 'high' ? 'text-red-400' : 'text-amber-400'}`} />
                      <span className="text-xs font-bold text-slate-200 truncate">{event.flags.join(', ')}</span>
                      <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                        event.severity === 'high' ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/20 text-amber-400'}`}>
                        {event.severity}
                      </span>
                    </div>
                    <span className="text-xs text-slate-500 shrink-0">{ageLabel(event.at)}</span>
                  </div>
                  <p className="text-xs font-mono text-slate-300">{event.agent}</p>
                  <p className="text-xs text-slate-400 mt-0.5">anomaly score {event.score}</p>
                </motion.div>
              ))}
            </AnimatePresence>

            {anomalyFeed.length === 0 && (
              <div className="flex flex-col items-center justify-center h-32 gap-2">
                <CheckCircle className="w-6 h-6 text-emerald-400/50" />
                <p className="text-xs text-slate-500">No anomalies detected</p>
              </div>
            )}
          </div>

          <div className="mt-4 pt-4 border-t border-white/[0.06]">
            <div className="flex items-center gap-2 mb-1">
              <div className={`w-2 h-2 rounded-full ${breakerLevel === 0 ? 'bg-emerald-400' : 'bg-red-400 animate-pulse'}`} />
              <span className={`text-xs font-medium ${breakerLevel === 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                Vault circuit breaker: level {breakerLevel} ({breakerLevel === 0 ? 'normal' : 'ACTIVE'})
              </span>
            </div>
            <p className="text-xs text-slate-500">
              {agents.filter((agent) => agent.breaker.level > 0).length} agent(s) with an active breaker ·{' '}
              {agents.filter((agent) => agent.anomaly.score > 50).length} high anomaly score
            </p>
          </div>
        </Panel>
      </div>

      {/* Approvals + vault budget */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Panel delay={0.6}>
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-base font-bold text-white">Approval Queue</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Held actions are re-checked when approved
              </p>
            </div>
            <Clock className="w-4 h-4 text-slate-500" />
          </div>

          <div className="space-y-2">
            {approvals.map((approval) => (
              <div key={approval.id} className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.04]">
                <div className="min-w-0">
                  <p className="text-xs font-mono text-slate-200 truncate">{approval.action.actor}</p>
                  <p className="text-xs text-slate-400">
                    {approval.action.kind} · {approval.action.amount} {approval.action.asset}
                    {approval.action.to ? ` → ${approval.action.to}` : ''}
                  </p>
                  <p className="text-xs text-slate-600">expires {timeLabel(approval.expiresAt)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void decide(approval.id, 'approve')}
                    disabled={pending === approval.id}
                    className="inline-flex items-center gap-1 text-xs font-medium text-emerald-300 border border-emerald-500/30 bg-emerald-500/10 rounded-lg px-2.5 py-1.5 hover:bg-emerald-500/20 disabled:opacity-40"
                  >
                    <Check className="w-3 h-3" /> Approve
                  </button>
                  <button
                    onClick={() => void decide(approval.id, 'reject')}
                    disabled={pending === approval.id}
                    className="inline-flex items-center gap-1 text-xs font-medium text-red-300 border border-red-500/30 bg-red-500/10 rounded-lg px-2.5 py-1.5 hover:bg-red-500/20 disabled:opacity-40"
                  >
                    <X className="w-3 h-3" /> Reject
                  </button>
                </div>
              </div>
            ))}
            {approvals.length === 0 && (
              <div className="flex flex-col items-center justify-center h-28 gap-2">
                <CheckCircle className="w-6 h-6 text-emerald-400/50" />
                <p className="text-xs text-slate-500">Nothing waiting for a human</p>
              </div>
            )}
          </div>
        </Panel>

        <Panel delay={0.65}>
          <div className="flex items-center justify-between mb-5">
            <div>
              <h2 className="text-base font-bold text-white">Vault Daily Budget</h2>
              <p className="text-xs text-slate-500 mt-0.5">Aggregate cap across every agent</p>
            </div>
            <Shield className="w-4 h-4 text-sky-400" />
          </div>

          <div className="space-y-4">
            {aggregate.map(([asset, row]) => (
              <div key={asset}>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-sm font-semibold text-slate-200">{asset}</span>
                  <span className="text-xs font-mono text-slate-400">
                    {row.spent} / {row.limit}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-white/[0.08] overflow-hidden">
                  <motion.div
                    className={`h-full rounded-full ${pct(row.spent, row.limit) > 90 ? 'bg-red-500' : pct(row.spent, row.limit) > 70 ? 'bg-amber-400' : 'bg-sky-500'}`}
                    animate={{ width: `${pct(row.spent, row.limit)}%` }}
                    transition={{ duration: 0.5, ease: 'easeOut' }}
                  />
                </div>
                <div className="flex items-center justify-between mt-1 text-xs text-slate-500 font-mono">
                  <span>{row.remaining} remaining</span>
                  <span>{row.reserved} reserved</span>
                </div>
              </div>
            ))}
            {aggregate.length === 0 && <p className="text-xs text-slate-500">No aggregate limits in this policy.</p>}
          </div>

          <div className="mt-5 pt-4 border-t border-white/[0.06] space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-500">Policy owner</span>
              <span className="font-mono text-slate-300">{policy.owner}</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-500">Policy state</span>
              <span className={policy.paused ? 'text-red-400' : 'text-emerald-400'}>
                {policy.paused ? 'paused' : 'armed'}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-500">Policy hash</span>
              <span className="font-mono text-slate-300" title={policy.hash}>{policy.hash.slice(0, 20)}…</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-500">Audit head</span>
              <span className="font-mono text-slate-300" title={auditHead.head}>{auditHead.head.slice(0, 20)}…</span>
            </div>
          </div>
        </Panel>
      </div>

      <p className="text-xs text-slate-600 leading-relaxed">
        The Rust vault enforces 17 of the 20 checks on-chain (limits, allow/deny lists,
        velocity, destination pinning, reputation floor, breakers); venue allowlisting
        beyond <span className="font-mono">near-intents</span>, slippage and quote expiry
        are enforced by the off-chain engine before <span className="font-mono">spend()</span>.
        Reads refresh every {POLL_MS / 1000}s from the guard API.
      </p>
    </div>
  )
}
