"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { X, Menu } from "lucide-react"
import { Logo } from "@/components/Logo"

export function Navbar() {
  const [scrolled, setScrolled] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  useEffect(() => {
    setMounted(true)
    const handleScroll = () => setScrolled(window.scrollY > 40)
    window.addEventListener("scroll", handleScroll, { passive: true })
    return () => window.removeEventListener("scroll", handleScroll)
  }, [])

  function closeMenu() {
    setMenuOpen(false)
  }

  return (
    <>
      <header
        className={`fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-5 sm:px-8 py-4 transition-all duration-500 ${
          scrolled || menuOpen
            ? "bg-white/95 backdrop-blur-md border-b border-slate-200"
            : "bg-transparent"
        } ${mounted ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-3"}`}
        style={{ transitionProperty: "background-color, border-color, opacity, transform" }}
      >
        <Link href="/" className="flex items-center gap-2.5 shrink-0 group" onClick={closeMenu}>
          <Logo size={32} />
          <span className="font-semibold text-slate-900 text-lg leading-none">Feral</span>
        </Link>

        <nav className="hidden md:flex items-center gap-8 text-sm text-slate-500">
          {[
            { label: "Overview", href: "#home" },
            { label: "Architecture", href: "#layers" },
            { label: "Capabilities", href: "#features" },
            { label: "Walkthrough", href: "#how-it-works" },
          ].map((item) => (
            <a
              key={item.label}
              href={item.href}
              className="hover:text-slate-900 transition-colors duration-200 relative group"
            >
              {item.label}
              <span className="absolute -bottom-0.5 left-0 w-0 h-px bg-sky-400 group-hover:w-full transition-all duration-300" />
            </a>
          ))}
        </nav>

        <div className="hidden md:flex items-center gap-3 shrink-0">
          <Link
            href="/dashboard"
            className="text-slate-600 hover:text-slate-900 text-sm font-medium transition-colors duration-200"
          >Dashboard</Link>
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 bg-slate-200 hover:bg-slate-200 border border-slate-300 hover:border-slate-400 text-slate-900 text-sm font-medium px-5 py-2 rounded-full transition-all duration-200"
          >
            Launch app
          </Link>
        </div>

        <button
          className="md:hidden p-2 text-slate-600 hover:text-slate-900 transition-colors"
          onClick={() => setMenuOpen((o) => !o)}
          aria-label="Toggle menu"
        >
          {menuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </header>

      {menuOpen && (
        <div className="fixed inset-0 z-40 flex flex-col pt-[64px] bg-[#f8fafc]/97 backdrop-blur-xl md:hidden">
          <nav className="flex flex-col px-6 py-8 gap-1">
            {[
              { label: "Overview", href: "#home" },
              { label: "Architecture", href: "#layers" },
              { label: "Capabilities", href: "#features" },
              { label: "Walkthrough", href: "#how-it-works" },
            ].map((item) => (
              <a
                key={item.label}
                href={item.href}
                onClick={closeMenu}
                className="py-4 text-xl font-light text-slate-700 hover:text-slate-900 border-b border-slate-200 last:border-0 transition-colors"
              >
                {item.label}
              </a>
            ))}
          </nav>
          <div className="px-6 mt-4 flex flex-col gap-3">
            <Link
              href="/dashboard"
              onClick={closeMenu}
              className="w-full text-center py-3.5 rounded-full bg-sky-600 text-white font-semibold text-sm"
            >
              Launch app
            </Link>
            <Link
              href="/dashboard"
              onClick={closeMenu}
              className="w-full text-center py-3.5 rounded-full border border-slate-300 text-slate-700 text-sm font-medium"
            >Dashboard</Link>
          </div>
        </div>
      )}
    </>
  )
}
