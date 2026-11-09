import { ShaderBackground } from "@/components/landing/ShaderBackground"
import { Navbar } from "@/components/landing/Navbar"
import { HeroSection } from "@/components/landing/HeroSection"
import { LayersSection } from "@/components/landing/LayersSection"
import { FeaturesSection } from "@/components/landing/FeaturesSection"
import { AboutSection } from "@/components/landing/AboutSection"
import { DemoSection } from "@/components/landing/DemoSection"
import { Footer } from "@/components/landing/Footer"

export default function LandingPage() {
  return (
    <main>
      <ShaderBackground />
      <Navbar />
      <HeroSection />
      <LayersSection />
      <FeaturesSection />
      <AboutSection />
      <DemoSection />
      <Footer />
    </main>
  )
}
