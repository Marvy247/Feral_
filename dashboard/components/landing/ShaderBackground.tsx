/**
 * Static landing backdrop.
 *
 * This used to be an animated particle canvas. The dashboard is a security
 * console, not a shader demo, and the effect cost a requestAnimationFrame loop
 * on every landing visit for no information. The gradients below give the same
 * depth in CSS, with no client JS and no canvas context.
 */
export function ShaderBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[11]"
      style={{
        opacity: 0.75,
        background:
          "radial-gradient(ellipse 55% 45% at 18% 12%, rgba(2,132,199,0.16) 0%, transparent 65%)," +
          "radial-gradient(ellipse 45% 40% at 82% 30%, rgba(14,165,233,0.12) 0%, transparent 70%)," +
          "radial-gradient(ellipse 60% 50% at 50% 95%, rgba(3,105,161,0.10) 0%, transparent 70%)",
      }}
    />
  );
}
