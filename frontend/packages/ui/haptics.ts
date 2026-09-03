/**
 * EdgePay Tactile Haptic Engine
 * Provides subtle, reassuring physical feedback on mobile devices for payment interactions.
 * Respects prefers-reduced-motion and gracefully degrades to no-op on non-supporting devices.
 */

function isHapticSupported(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const prefersReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  return 'vibrate' in navigator && !prefersReduced;
}

export const haptic = {
  /** Light 8ms click on interactive buttons, tab selectors, or copy actions */
  tap(): void {
    if (isHapticSupported()) {
      navigator.vibrate(8);
    }
  },

  /** Double-tick on gateway selection or filter change */
  select(): void {
    if (isHapticSupported()) {
      navigator.vibrate([10, 30, 12]);
    }
  },

  /** Reassuring cadence on verified payment confirmation or completed webhook */
  success(): void {
    if (isHapticSupported()) {
      navigator.vibrate([12, 40, 20]);
    }
  },

  /** Warning vibration on validation error or failed payment corroboration */
  error(): void {
    if (isHapticSupported()) {
      navigator.vibrate([60, 40, 60]);
    }
  }
};
