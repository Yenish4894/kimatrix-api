/**
 * How long a lapsed company's data survives.
 *
 * One constant, used by the expiry emails, the purge job and the UI copy alike. The
 * email tells the customer a number and the job acts on it — if those two ever
 * disagree, either data is deleted earlier than promised or it lingers past what was
 * stated. Neither is discoverable until it has already happened.
 */
// 7 since 2026-10-03 (was 15): data is kept a week after access ends, then removed.
export const EXPIRY_RETENTION_DAYS = 7;
