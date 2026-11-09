"use client"

import Link from "next/link"

export function HeroSection() {
  return (
    <section
      id="home"
      className="relative z-10 min-h-screen flex flex-col justify-center overflow-hidden bg-gradient-to-br from-[#ffffff]/95 via-[#f8fafc]/90 to-[#f1f5f9]/95"
    >
      <style>{`
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(28px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .hero-fade-1 { animation: fadeUp 0.75s ease-out 0.10s both; }
        .hero-fade-2 { animation: fadeUp 0.75s ease-out 0.25s both; }
        .hero-fade-3 { animation: fadeUp 0.75s ease-out 0.42s both; }
        .hero-fade-4 { animation: fadeUp 0.75s ease-out 0.58s both; }
        .hero-fade-5 { animation: fadeUp 0.75s ease-out 1.40s both; }
        @keyframes bounceDot {
          0%, 100% { transform: translateY(0); }
          50%       { transform: translateY(8px); }
        }
        .bounce-dot { animation: bounceDot 1.5s ease-in-out infinite; }
      `}</style>

      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 50% 115%, rgba(2,132,199,0.10) 0%, transparent 68%)",
        }}
      />

      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            "linear-gradient(rgba(15,23,42,0.055) 1px, transparent 1px), linear-gradient(90deg, rgba(15,23,42,0.055) 1px, transparent 1px)",
          backgroundSize: "72px 72px",
          maskImage:
            "radial-gradient(ellipse 95% 80% at 50% 38%, black 30%, transparent 100%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 95% 80% at 50% 38%, black 30%, transparent 100%)",
        }}
      />

      <div className="relative z-10 container mx-auto px-5 sm:px-8 pt-24 sm:pt-28 pb-20 sm:pb-24 max-w-6xl">
        <div className="hero-fade-1 inline-flex items-center gap-2 bg-slate-100 border border-slate-200 rounded-full px-3.5 py-1.5 text-xs sm:text-sm text-slate-700 mb-8 sm:mb-10">
          <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />
Live on NEAR testnet · policy enforced on-chain
        </div>

        <h1
          className="hero-fade-2 font-light text-slate-900 leading-[1.05] tracking-tight mb-6 sm:mb-8 max-w-4xl"
          style={{ fontSize: "clamp(2.6rem, 9vw, 8rem)" }}
        >
          Agents can spend.
          <br />
          <span className="font-extralight text-slate-400">They cannot drain.</span>
        </h1>

        <p className="hero-fade-3 text-slate-600 text-base sm:text-lg leading-relaxed max-w-xl mb-10 sm:mb-12">
          Policy-enforced custody for autonomous agents on NEAR. Limits, reputation,
          anomaly detection and circuit breakers are recomputed inside the vault
          contract on every transaction — so a compromised agent process cannot
          move money outside the rules.
        </p>

        <div className="hero-fade-4 flex flex-col sm:flex-row items-stretch sm:items-center gap-3 sm:gap-4 max-w-xs sm:max-w-none">
          <Link
            href="/dashboard"
            className="inline-flex items-center justify-center gap-2 bg-sky-600 text-white font-semibold text-sm px-7 py-3.5 rounded-full hover:bg-sky-700 transition-all duration-200 shadow-lg shadow-sky-600/20"
          >
            Launch Dashboard
          </Link>
          <a
            href="#features"
            className="inline-flex items-center justify-center gap-2 border border-slate-300 text-slate-700 font-medium text-sm px-7 py-3.5 rounded-full hover:bg-slate-100 hover:border-slate-400 transition-all duration-200"
          >
            Explore the controls
          </a>
        </div>
      </div>

      <div className="hero-fade-5 absolute bottom-8 sm:bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-3">
        <span className="text-xs text-slate-500 tracking-widest uppercase font-medium">
          Scroll to explore
        </span>
        <div className="bounce-dot w-1.5 h-1.5 rounded-full bg-sky-400/60" />
      </div>
    </section>
  )
}
