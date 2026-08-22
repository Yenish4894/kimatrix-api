/**
 * How long a lapsed company's data survives.
 *
 * One constant, used by the expiry emails, the purge job and the UI copy alike. The
 * email tells the customer a number and the job acts on it — if those two ever
 * disagree, either data is deleted earlier than promised or it lingers past what was
 * stated. Neither is discoverable until it has already happened.
 */
export const EXPIRY_RETENTION_DAYS = 15;
