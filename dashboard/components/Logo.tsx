'use client'

export function Logo({ size = 40 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="feral-shield-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#0ea5e9" />
          <stop offset="100%" stopColor="#0284c7" />
        </linearGradient>
      </defs>
      {/* Shield shape */}
      <path
        d="M32 4 L54 14 L54 34 C54 46 44 56 32 60 C20 56 10 46 10 34 L10 14 Z"
        fill="url(#feral-shield-gradient)"
      />
      {/* Stylized F */}
      <text
        x="32"
        y="43"
        textAnchor="middle"
        fontFamily="system-ui, -apple-system, sans-serif"
        fontSize="28"
        fontWeight="800"
        fill="white"
      >
        F
      </text>
    </svg>
  )
}
