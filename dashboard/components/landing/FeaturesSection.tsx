"use client"

import { useRef } from "react"
import { motion, useScroll, useTransform } from "framer-motion"
import { Shield, TrendingDown, Users, Zap } from "lucide-react"

const features = [
  {
    num: "01",
    icon: Shield,
    title: "Policy enforced at the vault",
    desc: "Seventeen checks run inside the contract on every spend(): per-tx, daily, monthly, cross-agent, velocity, allow and deny lists, destination pinning, reputation and breakers. The pure engine mirrors all twenty before submission, adding venue, slippage and quote-expiry checks. If the off-chain process is compromised, the on-chain walls still hold.",
  },
  {
    num: "02",
    icon: TrendingDown,
    title: "Reputation that tightens limits",
    desc: "Every agent starts at 100. A clean spend earns 1, an approval 2, a denial costs 10 and an anomaly 15. Effective limit = base × reputation / 100, rounded down. At 0 the agent is frozen; a 30-day clean window restores 20 points. Reputation can reduce exposure, never widen it beyond the owner's ceiling.",
  },
  {
    num: "03",
    icon: Users,
    title: "One vault, many agents",
    desc: "Each agent has independent limits, reputation and breaker state. Aggregate daily and monthly caps bound the fleet as a whole, so no combination of agents can drain the vault. Burst and drainage detectors evaluate behaviour across transactions, not just the last payment.",
  },
  {
    num: "04",
    icon: Zap,
    title: "Circuit breakers with clear authority",
    desc: "Level 1 reduces an agent's limits after an anomaly for one hour. Level 2 pauses the agent. Level 3 pauses the vault and level 4 is a guardian emergency freeze. Lower levels escalate automatically; the higher levels require an explicit administrative action, and every transition is audited.",
  },
]

export function FeaturesSection() {
  const containerRef = useRef<HTMLDivElement>(null)
  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ["start start", "end end"],
  })

  const headerY = useTransform(scrollYProgress, [0, 0.1], [30, 0])
  const headerOp = useTransform(scrollYProgress, [0, 0.1], [0, 1])

  const y0 = useTransform(scrollYProgress, [0.04, 0.18], [45, 0])
  const op0 = useTransform(scrollYProgress, [0.04, 0.18], [0, 1])

  const y1 = useTransform(scrollYProgress, [0.22, 0.36], [45, 0])
  const op1 = useTransform(scrollYProgress, [0.22, 0.36], [0, 1])

  const y2 = useTransform(scrollYProgress, [0.42, 0.56], [45, 0])
  const op2 = useTransform(scrollYProgress, [0.42, 0.56], [0, 1])

  const y3 = useTransform(scrollYProgress, [0.62, 0.76], [45, 0])
  const op3 = useTransform(scrollYProgress, [0.62, 0.76], [0, 1])

  const itemStyles = [
    { y: y0, opacity: op0 },
    { y: y1, opacity: op1 },
    { y: y2, opacity: op2 },
    { y: y3, opacity: op3 },
  ]

  return (
    <div ref={containerRef} id="features" className="relative h-[450vh] bg-[#ffffff]">
      <div className="sticky top-0 h-screen flex flex-col justify-center px-8 md:px-16 lg:px-24 overflow-hidden">
        <div className="max-w-5xl w-full mx-auto">
          <motion.div style={{ y: headerY, opacity: headerOp }} className="mb-12">
            <p className="text-xs font-mono text-sky-400/70 tracking-[0.2em] uppercase mb-5">
              / Security Capabilities
            </p>
            <h2 className="text-5xl md:text-6xl font-light text-slate-900 tracking-tight">
              Controls that hold.
            </h2>
          </motion.div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {features.map((feature, i) => (
              <motion.div
                key={feature.num}
                style={itemStyles[i]}
                className="group relative"
              >
                <div className="flex items-start gap-6 p-8 rounded-2xl border border-slate-200 hover:border-sky-500/30 bg-slate-50 hover:bg-slate-50 transition-all duration-500">
                  <div className="shrink-0">
                    <span className="text-xs font-mono text-slate-400 block mb-4">{feature.num}</span>
                    <div className="w-12 h-12 rounded-xl bg-sky-500/10 flex items-center justify-center group-hover:bg-sky-500/20 transition-colors duration-300">
                      <feature.icon className="w-5 h-5 text-sky-400" />
                    </div>
                  </div>
                  <div>
                    <h3 className="text-xl font-light text-slate-900 mb-3">{feature.title}</h3>
                    <p className="text-slate-600 text-sm leading-relaxed">{feature.desc}</p>
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
