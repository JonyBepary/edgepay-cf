/**
 * EdgePay Motion Language & Timeline Sequences
 * Built on GSAP with strict performance budgets and prefers-reduced-motion gates.
 */

interface GsapTimeline {
  to: (targets: unknown, vars: Record<string, unknown>) => GsapTimeline;
  fromTo: (targets: unknown, fromVars: Record<string, unknown>, toVars: Record<string, unknown>) => GsapTimeline;
  call: (callback: () => void) => GsapTimeline;
}

declare const gsap: {
  from: (targets: unknown, vars: Record<string, unknown>) => unknown;
  to: (targets: unknown, vars: Record<string, unknown>) => unknown;
  set: (targets: unknown, vars: Record<string, unknown>) => unknown;
  timeline: (vars?: Record<string, unknown>) => GsapTimeline;
};

export function hasReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
}

/**
 * Clean entrance stagger for cards, list rows, and gateway pills.
 */
export function animateEntrance(targets: string | Element | Element[], staggerMs: number = 45): void {
  if (typeof gsap === 'undefined' || hasReducedMotion()) return;
  gsap.from(targets, {
    y: 14,
    opacity: 0,
    duration: 0.28,
    ease: 'power2.out',
    stagger: staggerMs / 1000,
    clearProps: 'all',
  });
}

/**
 * Animated SVG stroke-draw for payment verified success checkmark.
 */
export function animateSuccessCheckmark(pathSelector: string | SVGPathElement): void {
  if (typeof gsap === 'undefined' || hasReducedMotion()) return;
  const path = typeof pathSelector === 'string' ? document.querySelector(pathSelector) as SVGPathElement : pathSelector;
  if (!path) return;

  const length = path.getTotalLength?.() || 80;
  gsap.set(path, { strokeDasharray: length, strokeDashoffset: length });
  gsap.to(path, {
    strokeDashoffset: 0,
    duration: 0.42,
    ease: 'power3.out',
    delay: 0.05,
  });
}

/**
 * Smooth tabular numeric count-up animation for financial amounts and KPI values.
 */
export function animateCountUp(element: HTMLElement, target: number, decimals: number = 2, duration: number = 0.6): void {
  if (typeof gsap === 'undefined' || hasReducedMotion()) {
    element.textContent = target.toFixed(decimals);
    return;
  }

  const obj = { val: 0 };
  gsap.to(obj, {
    val: target,
    duration,
    ease: 'power2.out',
    onUpdate: () => {
      element.textContent = obj.val.toFixed(decimals);
    },
    onComplete: () => {
      element.textContent = target.toFixed(decimals);
    },
  });
}

/**
 * Seamless cross-fade state transition between active panels or wizard steps.
 */
export function animateStateTransition(outgoing: HTMLElement, incoming: HTMLElement, onComplete?: () => void): void {
  if (typeof gsap === 'undefined' || hasReducedMotion()) {
    outgoing.style.display = 'none';
    incoming.style.display = 'block';
    onComplete?.();
    return;
  }

  const tl = gsap.timeline({
    onComplete: () => {
      outgoing.style.display = 'none';
      onComplete?.();
    }
  });

  tl.to(outgoing, { opacity: 0, y: -8, duration: 0.14, ease: 'power1.in' })
    .call(() => {
      outgoing.style.display = 'none';
      incoming.style.display = 'block';
      incoming.style.opacity = '0';
    })
    .fromTo(incoming, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.22, ease: 'power2.out' });
}
