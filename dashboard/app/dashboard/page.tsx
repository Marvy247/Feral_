'use client'

import { Suspense } from 'react'

import { DashboardLayout } from '@/components/dashboard-layout'
import { DashboardOverview } from '@/components/dashboard-overview'
import { Logo } from '@/components/Logo'

export default function DashboardPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-dashboard">
          <div className="animate-pulse text-slate-500">Loading Feral dashboard…</div>
        </div>
      }
    >
      <DashboardLayout
        brandName="Feral"
        logo={<Logo size={36} />}
        userName="Vault Owner"
        userEmail="feral guard"
      >
        <DashboardOverview />
      </DashboardLayout>
    </Suspense>
  )
}
