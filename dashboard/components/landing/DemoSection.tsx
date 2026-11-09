"use client"

import { useState, useEffect, useRef } from "react"
import { motion, AnimatePresence, useInView } from "framer-motion"
import { ArrowRight, CheckCircle, XCircle, Zap, ShieldCheck } from "lucide-react"

const steps = [
  {
    id: 0,
    label: "Budgeted spend",
    icon: CheckCircle,
    content: {
      title: "Agent spends within policy",
      body: (
        <div className="space-y-4">
          <div className="flex items-center justify-between py-3 border-b border-slate-200">
            <span className="text-slate-500 text-sm">Action</span>
            <span className="text-slate-900 text-sm font-mono">near.transfer · 5 USDC</span>
          </div>
          <div className="flex items-center justify-between py-3 border-b border-slate-200">
            <span className="text-slate-500 text-sm">Verdict</span>
            <span className="text-emerald-600 text-sm font-semibold">ALLOW</span>
          </div>
          <div className="flex items-center justify-between py-3 border-b border-slate-200">
            <span className="text-slate-500 text-sm">Reputation</span>
            <span className="text-slate-900 text-sm font-mono">100 → 100 (at cap)</span>
          </div>
          <div className="flex items-center justify-between py-3">
            <span className="text-slate-500 text-sm">Budget used</span>
            <span className="text-slate-900 text-sm font-mono">5 of 100 USDC daily</span>
          </div>
        </div>
      ),
    },
  },
  {
    id: 1,
    label: "Limit breach",
    icon: XCircle,
    content: {
      title: "Agent tries to overspend",
      body: (
        <div className="space-y-4">
          <div className="flex items-center justify-between py-3 border-b border-slate-200">
            <span className="text-slate-500 text-sm">Action</span>
            <span className="text-slate-900 text-sm font-mono">near.transfer · 30 USDC</span>
          </div>
          <div className="flex items-center justify-between py-3 border-b border-slate-200">
            <span className="text-slate-500 text-sm">Wall hit</span>
            <span className="text-slate-900 text-sm font-mono">per-tx cap: 25 USDC</span>
          </div>
          <div className="flex items-center justify-between py-3 border-b border-slate-200">
            <span className="text-slate-500 text-sm">Verdict</span>
            <span className="text-red-500 text-sm font-semibold">DENY: PER_TX_LIMIT</span>
          </div>
          <div className="flex items-center justify-between py-3">
            <span className="text-slate-500 text-sm">Reputation</span>
            <span className="text-slate-900 text-sm font-mono">100 → 90 (−10 denial)</span>
          </div>
        </div>
      ),
    },
  },
  {
    id: 2,
    label: "Burst attempt",
    icon: Zap,
    content: {
      title: "Stolen key — burst detected",
      body: (
        <div className="space-y-4">
          <div className="flex items-center justify-between py-3 border-b border-slate-200">
            <span className="text-slate-500 text-sm">Pattern</span>
            <span className="text-slate-900 text-sm font-mono">6 transfers in 60 seconds</span>
          </div>
          <div className="flex items-center justify-between py-3 border-b border-slate-200">
            <span className="text-slate-500 text-sm">Detection</span>
            <span className="text-amber-600 text-sm font-semibold">ANOMALY_BURST</span>
          </div>
          <div className="flex items-center justify-between py-3 border-b border-slate-200">
            <span className="text-slate-500 text-sm">Auto-response</span>
            <span className="text-slate-900 text-sm">Agent limits reduced · 1 hour</span>
          </div>
          <div className="flex items-center justify-between py-3">
            <span className="text-slate-500 text-sm">Reputation</span>
            <span className="text-slate-900 text-sm font-mono">100 → 85 (−15 anomaly)</span>
          </div>
        </div>
      ),
    },
  },
  {
    id: 3,
    label: "Recovery",
    icon: ShieldCheck,
    content: {
      title: "Guardian freezes — watcher cancels withdrawal",
      body: (
        <div className="space-y-4">
          <div className="flex items-center justify-between py-3 border-b border-slate-200">
            <span className="text-slate-500 text-sm">Action</span>
            <span className="text-slate-900 text-sm">emergency_freeze()</span>
          </div>
          <div className="flex items-center justify-between py-3 border-b border-slate-200">
            <span className="text-slate-500 text-sm">Triggered by</span>
            <span className="text-slate-900 text-sm font-mono">guardian dave.near</span>
          </div>
          <div className="flex items-center justify-between py-3 border-b border-slate-200">
            <span className="text-slate-500 text-sm">Vault status</span>
            <span className="text-red-500 text-sm font-semibold">EMERGENCY FREEZE</span>
          </div>
          <div className="flex items-center justify-between py-3">
            <span className="text-slate-500 text-sm">Resolution</span>
            <span className="text-slate-900 text-sm">Watcher cancels · owner thaws</span>
          </div>
        </div>
      ),
    },
  },
]

export function DemoSection() {
  const [activeStep, setActiveStep] = useState(0)
  const sectionRef = useRef<HTMLDivElement>(null)
  const inView = useInView(sectionRef, { once: true, margin: "-200px" })
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!inView) return
    timerRef.current = setTimeout(() => {
      setActiveStep((s) => (s + 1) % steps.length)
    }, 2400)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [activeStep, inView])

  const step = steps[activeStep]

  return (
    <section
      id="how-it-works"
      ref={sectionRef}
      className="relative py-32 overflow-hidden"
      style={{
        background: "linear-gradient(180deg, #f1f5f9 0%, #ffffff 50%, #f8fafc 100%)",
      }}
    >
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 50% 40% at 50% 80%, rgba(2,132,199,0.06) 0%, transparent 70%)",
        }}
      />

      <div className="relative z-10 container mx-auto px-8 max-w-5xl">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.7, ease: "easeOut" }}
          className="text-center mb-16"
        >
          <p className="text-xs font-mono text-sky-400/70 tracking-[0.2em] uppercase mb-5">
            / Decision walkthrough
          </p>
          <h2 className="text-4xl md:text-5xl font-light text-slate-900 tracking-tight">
            Watch the policy hold.
          </h2>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 30 }}
          transition={{ duration: 0.8, delay: 0.2, ease: "easeOut" }}
          className="max-w-lg mx-auto"
        >
          <div className="flex gap-2 mb-6 p-1.5 bg-white/70 ring-1 ring-slate-200 rounded-2xl border border-slate-200">
            {steps.map((s, i) => (
              <button
                key={s.id}
                onClick={() => {
                  if (timerRef.current) clearTimeout(timerRef.current)
                  setActiveStep(i)
                }}
                className={`relative flex-1 flex items-center justify-center gap-1.5 py-2.5 px-2 rounded-xl text-xs font-medium transition-all duration-300 ${
                  activeStep === i
                    ? "bg-slate-200 text-slate-900 shadow-sm"
                    : "text-slate-500 hover:text-slate-500"
                }`}
              >
                {i < activeStep && (
                  <span className="w-1.5 h-1.5 rounded-full bg-sky-400 shrink-0" />
                )}
                <span className="hidden sm:inline">{s.label}</span>
                <span className="sm:hidden">{i + 1}</span>
              </button>
            ))}
          </div>

          <div className="h-0.5 bg-white/8 rounded-full mb-8 overflow-hidden">
            <motion.div
              className="h-full bg-sky-400 rounded-full"
              animate={{ width: `${((activeStep + 1) / steps.length) * 100}%` }}
              transition={{ duration: 0.5, ease: "easeInOut" }}
            />
          </div>

          <div className="bg-white shadow-sm border border-slate-200 rounded-2xl p-6 backdrop-blur-sm min-h-[280px]">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeStep}
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -15 }}
                transition={{ duration: 0.35, ease: "easeOut" }}
              >
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-9 h-9 rounded-xl bg-sky-500/15 flex items-center justify-center">
                    <step.icon className="w-4 h-4 text-sky-400" />
                  </div>
                  <h3 className="text-slate-900 font-medium">{step.content.title}</h3>
                </div>
                {step.content.body}
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="flex items-center justify-between mt-6">
            <button
              onClick={() => {
                if (timerRef.current) clearTimeout(timerRef.current)
                setActiveStep((s) => Math.max(0, s - 1))
              }}
              disabled={activeStep === 0}
              className="text-xs text-slate-500 hover:text-slate-500 disabled:opacity-0 transition-all duration-200"
            >
              ← Previous
            </button>
            <div className="flex gap-1.5">
              {steps.map((_, i) => (
                <button
                  key={i}
                  onClick={() => {
                    if (timerRef.current) clearTimeout(timerRef.current)
                    setActiveStep(i)
                  }}
                  className={`h-1.5 rounded-full transition-all duration-300 ${
                    i === activeStep ? "bg-sky-400 w-4" : "bg-slate-200 w-1.5"
                  }`}
                />
              ))}
            </div>
            <button
              onClick={() => {
                if (timerRef.current) clearTimeout(timerRef.current)
                setActiveStep((s) => Math.min(steps.length - 1, s + 1))
              }}
              disabled={activeStep === steps.length - 1}
              className="text-xs text-slate-500 hover:text-slate-500 disabled:opacity-0 transition-all duration-200 flex items-center gap-1"
            >
              Next <ArrowRight className="w-3 h-3" />
            </button>
          </div>
        </motion.div>
      </div>
    </section>
  )
}
