import { getRedisClient } from "@/config/redis.client";
import { logger } from "@/utils/logger";
import { parseOutcome, type SmtpHealthRecord, type SmtpSendOutcome } from "@/utils/smtpHealth";

/**
 * The outcome of real SMTP sends, kept in Redis so every process (and the admin status
 * endpoint) sees the same truth. Three small keys, not a history:
 *
 *   smtp:health:last          the most recent send, success or failure (JSON)
 *   smtp:health:last_success  when a send last succeeded (ISO string)
 *   smtp:health:last_failure  the most recent failure (JSON)
 *
 * Expire after 30 days so a long-dead record never outlives its relevance.
 */
const KEY_LAST = "smtp:health:last";
const KEY_LAST_SUCCESS = "smtp:health:last_success";
const KEY_LAST_FAILURE = "smtp:health:last_failure";
const TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Never throws. Recording is a side channel: a Redis blip must not turn a delivered
 * email into a failed job (and a retry would send it twice).
 */
export async function recordSmtpOutcome(outcome: SmtpSendOutcome): Promise<void> {
  try {
    const multi = getRedisClient().multi();
    multi.set(KEY_LAST, JSON.stringify(outcome), "EX", TTL_SECONDS);
    if (outcome.ok) {
      multi.set(KEY_LAST_SUCCESS, outcome.at, "EX", TTL_SECONDS);
    } else {
      multi.set(KEY_LAST_FAILURE, JSON.stringify(outcome), "EX", TTL_SECONDS);
    }
    await multi.exec();
  } catch (err) {
    logger.warn({ err }, "Could not record the SMTP send outcome");
  }
}

export async function readSmtpHealth(): Promise<SmtpHealthRecord> {
  const [last, lastSuccessAt, lastFailure] = await getRedisClient().mget(
    KEY_LAST,
    KEY_LAST_SUCCESS,
    KEY_LAST_FAILURE,
  );
  return {
    last: parseOutcome(last),
    lastSuccessAt: lastSuccessAt ?? null,
    lastFailure: parseOutcome(lastFailure),
  };
}
