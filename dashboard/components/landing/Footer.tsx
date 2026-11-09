import Link from "next/link"
import { Logo } from "@/components/Logo"

export function Footer() {
  return (
    <footer
      className="border-t border-slate-200 py-10 px-8"
      style={{ background: "#f8fafc" }}
    >
      <div className="max-w-6xl mx-auto flex flex-col gap-6">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
          <Link href="/" className="flex items-center gap-2 group">
            <Logo size={28} />
            <span className="font-bold text-sm tracking-tight text-slate-900">Feral</span>
          </Link>

          <nav className="flex items-center gap-6 text-xs text-slate-500">
            <Link href="/dashboard" className="hover:text-slate-900 transition-colors">
              Dashboard
            </Link>
            <a href="#layers" className="hover:text-slate-900 transition-colors">
              Architecture
            </a>
            <a href="#features" className="hover:text-slate-900 transition-colors">
              Security
            </a>
            <a href="#how-it-works" className="hover:text-slate-900 transition-colors">
              Walkthrough
            </a>
          </nav>
        </div>

        <p className="text-[11px] leading-relaxed text-slate-500 max-w-4xl">
          © 2026 Feral. Open-source policy infrastructure for autonomous agents on
          NEAR. Released under the MIT licence.
        </p>
      </div>
    </footer>
  )
}
