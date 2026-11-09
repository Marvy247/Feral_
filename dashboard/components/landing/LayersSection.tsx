"use client"

import { useEffect, useRef } from "react"

const layers = [
  {
    num: "01",
    title: "Vault enforcement",
    subtitle: "custody, spending limits and agent identity inside the contract",
    tag: "On-chain",
    tagStyle: "bg-sky-500/15 text-sky-700 border-sky-500/25",
    dim: false,
    desc: "Per-transaction, daily, monthly and cross-agent budgets are recomputed from contract storage on every spend. Allow and deny lists, destination pinning, velocity limits, the reputation floor and circuit breakers live there too. A compromised client can call spend(); it cannot call a different policy.",
  },
  {
    num: "02",
    title: "Fleet coordination",
    subtitle: "one vault, many agents, one shared ceiling",
    tag: "Multi-agent",
    tagStyle: "bg-violet-500/15 text-violet-700 border-violet-500/25",
    dim: false,
    desc: "Each agent carries its own limits, reputation and breaker state. Aggregate daily and monthly caps bound what the fleet can spend together, while burst and drainage detectors flag behaviour that only looks wrong across transactions.",
  },
  {
    num: "03",
    title: "Governance and recovery",
    subtitle: "human authority without a single point of failure",
    tag: "Operational",
    tagStyle: "bg-emerald-500/15 text-emerald-700 border-emerald-500/25",
    dim: false,
    desc: "Multisig ownership, timelocked administrative actions, watcher cancellation and guardian emergency freezes provide a recovery path no single key can abuse. Every decision is written to a hash-chained audit log and can be anchored on-chain.",
  },
]

export function LayersSection() {
  const sectionRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("in-view")
            observer.unobserve(entry.target)
          }
        })
      },
      { threshold: 0.12 }
    )

    const items = sectionRef.current?.querySelectorAll(".reveal-item")
    items?.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [])

  return (
    <section id="layers" className="bg-slate-50 py-24 md:py-32">
      <style>{`
        .reveal-item {
          opacity: 0;
          transform: translateY(24px);
          transition: opacity 0.6s ease-out, transform 0.6s ease-out;
        }
        .reveal-item.in-view {
          opacity: 1;
          transform: translateY(0);
        }
        .reveal-item:nth-child(2) { transition-delay: 0.08s; }
        .reveal-item:nth-child(3) { transition-delay: 0.16s; }
        .reveal-item:nth-child(4) { transition-delay: 0.24s; }
      `}</style>

      <div ref={sectionRef} className="container mx-auto px-8 max-w-5xl">
        <div className="reveal-item mb-16">
          <p className="text-xs font-mono text-sky-400/70 tracking-[0.2em] uppercase mb-5">
            / Platform
          </p>
          <h2 className="text-5xl md:text-6xl font-light text-slate-900 tracking-tight">
            Three layers of control.
          </h2>
        </div>

        <div className="divide-y divide-white/[0.08]">
          {layers.map((layer) => (
            <div
              key={layer.num}
              className={`reveal-item group py-10 flex items-start gap-8 transition-opacity duration-300 ${
                layer.dim ? "opacity-60 hover:opacity-100" : ""
              }`}
            >
              <span className="text-xs font-mono text-sky-400 mt-1.5 w-8 shrink-0">
                {layer.num}
              </span>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 flex-wrap mb-2">
                  <h3 className="text-2xl md:text-3xl font-light text-slate-900">
                    {layer.title}
                  </h3>
                  <span
                    className={`inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full border ${layer.tagStyle}`}
                  >
                    {layer.tag}
                  </span>
                </div>
                <p className="text-slate-500 text-sm font-medium tracking-wide mb-3">
                  {layer.subtitle}
                </p>
                <p className="text-slate-600 text-sm leading-relaxed max-w-2xl">
                  {layer.desc}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
