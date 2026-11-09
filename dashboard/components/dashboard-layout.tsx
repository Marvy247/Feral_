'use client'

import { useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { motion, AnimatePresence } from "framer-motion"
import { cn } from "@/lib/utils"
import { Menu, LayoutDashboard } from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Logo } from "@/components/Logo"

interface DashboardLayoutProps {
  children: React.ReactNode
  sidebarItems?: { id: string; name: string; icon: React.ElementType; badge?: string }[]
  logo?: React.ReactNode
  brandName?: string
  userName?: string
  userEmail?: string
  userAvatar?: string
  onNavigate?: (tab: string) => void
}

const defaultNavigation = [
  { id: "overview", name: "Dashboard", icon: LayoutDashboard },
]

export function DashboardLayout({
  children,
  sidebarItems = defaultNavigation,
  logo,
  brandName = "Feral",
  userName = "User",
  userEmail = "user@example.com",
  userAvatar,
  onNavigate,
}: DashboardLayoutProps) {
  const searchParams = useSearchParams()
  const router = useRouter()

  const [activeTab, setActiveTab] = useState(() => {
    const tab = searchParams.get("tab")
    return sidebarItems.some(n => n.id === tab) ? tab! : "overview"
  })
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  const navigateTo = (tab: string) => {
    setActiveTab(tab)
    setMobileMenuOpen(false)
    if (onNavigate) onNavigate(tab)
    router.replace(`/dashboard?tab=${tab}`, { scroll: false })
  }

  const initials = userName
    ? userName.split(" ").map((n: string) => n[0]).join("").toUpperCase().slice(0, 2)
    : "U"

  return (
    <TooltipProvider delayDuration={0}>
      <div className="min-h-screen bg-dashboard">
        <AnimatePresence>
          {mobileMenuOpen && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm md:hidden"
              onClick={() => setMobileMenuOpen(false)}
            />
          )}
        </AnimatePresence>

        <motion.aside
          className={cn(
            "fixed left-4 top-4 bottom-4 z-50 w-20",
            "flex flex-col gap-4",
            "max-md:transition-transform max-md:duration-300",
            mobileMenuOpen ? "max-md:translate-x-0" : "max-md:-translate-x-full max-md:left-0 max-md:top-0 max-md:bottom-0 max-md:w-64 max-md:rounded-none",
          )}
          initial={false}
        >
          <div className="bg-white/80 backdrop-blur-xl border border-slate-200/50 rounded-2xl p-3 flex flex-col items-center gap-3 shadow-lg shadow-slate-900/5">
            <button
              onClick={() => router.replace("/dashboard")}
              className="w-12 h-12 rounded-xl overflow-hidden shadow-lg shadow-sky-500/20 ring-1 ring-sky-500/20 hover:ring-sky-500/40 transition-all cursor-pointer flex items-center justify-center"
            >
              {logo || <Logo size={36} />}
            </button>
          </div>

          <nav className="flex-1 bg-white/80 backdrop-blur-xl border border-slate-200/50 rounded-2xl p-3 flex flex-col justify-center gap-2 shadow-lg shadow-slate-900/5">
            {sidebarItems.map((item) => {
              const isActive = activeTab === item.id
              const Icon = item.icon
              return (
                <Tooltip key={item.id}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => navigateTo(item.id)}
                      className={cn(
                        "relative w-12 h-12 rounded-xl flex items-center justify-center transition-all duration-150 group",
                        isActive
                          ? "bg-sky-500 text-white shadow-lg shadow-sky-500/25"
                          : "text-slate-500 hover:text-sky-600 hover:bg-sky-50/50",
                      )}
                      aria-current={isActive ? "page" : undefined}
                    >
                      <Icon className={cn("w-5 h-5 transition-transform group-hover:scale-110", isActive && "scale-110")} />
                      {item.badge && (
                        <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-sky-500 text-white text-[10px] font-bold flex items-center justify-center ring-2 ring-white">
                          {item.badge}
                        </span>
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    {item.name}
                  </TooltipContent>
                </Tooltip>
              )
            })}
          </nav>

          <div className="bg-white/80 backdrop-blur-xl border border-slate-200/50 rounded-2xl p-3 flex flex-col items-center gap-2 shadow-lg shadow-slate-900/5">
            <Tooltip>
              <TooltipTrigger asChild>
                <button className="w-12 h-12 rounded-full bg-sky-500/10 flex items-center justify-center text-sky-600 font-semibold text-sm ring-2 ring-sky-500/20 hover:ring-sky-500/40 transition-all cursor-pointer hover:scale-105">
                  {userAvatar ? (
                    <img src={userAvatar} alt="Avatar" className="w-full h-full object-cover" />
                  ) : initials}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                <div className="text-left">
                  <p className="font-semibold text-slate-900">{userName}</p>
                  <p className="text-xs text-slate-500">{userEmail}</p>
                </div>
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href="/"
                  className="w-10 h-10 rounded-xl text-slate-500 hover:text-sky-600 hover:bg-sky-500/10 transition-all flex items-center justify-center"
                >
                  <LayoutDashboard className="h-4 w-4" />
                </a>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={8}>
                Back to landing page
              </TooltipContent>
            </Tooltip>
          </div>
        </motion.aside>

        <div className="md:ml-28 flex flex-col min-h-screen">
          <header className="h-20 flex items-center justify-between px-6 md:px-8 sticky top-0 z-30 bg-white/80 backdrop-blur-xl border-b border-slate-200/50 shadow-sm shadow-slate-900/5">
            <div className="flex items-center gap-4">
              <button
                onClick={() => setMobileMenuOpen(true)}
                className="md:hidden p-2 rounded-xl text-slate-500 hover:text-slate-700 hover:bg-slate-100/50 transition-colors"
                aria-label="Open menu"
              >
                <Menu className="h-5 w-5" />
              </button>
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h1 className="text-xl font-bold text-slate-900 tracking-tight">
                    {sidebarItems.find(n => n.id === activeTab)?.name ?? "Dashboard"}
                  </h1>
                  {sidebarItems.find(n => n.id === activeTab)?.badge && (
                    <span className="px-2 py-0.5 text-[10px] font-bold bg-sky-50 text-sky-700 rounded-md border border-sky-200">
                      {sidebarItems.find(n => n.id === activeTab)?.badge}
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-500">
                  Welcome back, <span className="text-sky-600 font-medium">{userName.split(' ')[0] ?? 'User'}</span>
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button className="flex items-center gap-2 hover:bg-slate-100/50 rounded-xl px-3 py-2 transition-colors group">
                <div className="w-8 h-8 rounded-full bg-sky-500/10 flex items-center justify-center text-sky-600 font-semibold text-xs ring-2 ring-sky-500/20 group-hover:ring-sky-500/40 overflow-hidden transition-all">
                  {userAvatar ? (
                    <img src={userAvatar} alt="Avatar" className="w-full h-full object-cover" />
                  ) : initials}
                </div>
                <span className="text-sm font-medium text-slate-700 hidden md:block group-hover:text-slate-900 transition-colors">{userName}</span>
              </button>
            </div>
          </header>

          <main className="flex-1 p-6 md:p-8">
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
              >
                {children}
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </div>
    </TooltipProvider>
  )
}
