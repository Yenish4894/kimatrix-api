/**
 * Money rules for lucky draw spin add-ons, kept pure so they can be tested without
 * PayPal or a database.
 */

/**
 * What PayPal is asked to charge, rounded to the cent once. Float sums such as
 * 29.99 + 3 come out as 32.989999…, and the same figure must reach both PayPal and the
 * stored payment row.
 */
export function orderAmount(basePrice: number, spinQuantity: number, spinPriceUsd: number): number {
  return Math.round((basePrice + spinQuantity * spinPriceUsd) * 100) / 100;
}

/**
 * True once the plan window a spin add-on belongs to has closed. Capturing after that
 * would charge the buyer for spins they can no longer use, so capture refuses.
 */
export function spinWindowClosed(windowEndsAt: Date | string | null, now: Date): boolean {
  return windowEndsAt !== null && new Date(windowEndsAt).getTime() <= now.getTime();
}
