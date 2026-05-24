/**
 * Tracks per-account request counts within a rolling window.
 * Used by BillingService to enforce per-account charge frequency limits.
 */
export class RateLimiter {
  private counters: Map<string, { count: number; windowStart: number }> =
    new Map();

  /** Returns true if the account is within the numeric limit, false if over. */
  isAllowed(accountId: string, limit: number): boolean {
    const now = Date.now();
    const entry = this.counters.get(accountId);

    if (!entry || now - entry.windowStart > 60_000) {
      // Start a fresh 1-minute window
      this.counters.set(accountId, { count: 1, windowStart: now });
      return true;
    }

    if (entry.count >= limit) {
      return false;
    }

    entry.count += 1;
    return true;
  }

  /** Resets the counter for an account (used in tests and admin tooling). */
  reset(accountId: string): void {
    this.counters.delete(accountId);
  }
}
