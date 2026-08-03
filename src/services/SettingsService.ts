import { config } from "@/config/index";
import { BadRequestError } from "@/errors/index";
import { AppSettingRepository } from "@/repositories/AppSettingRepository";
import { logger } from "@/utils/logger";
import type { EntityManager } from "typeorm";

export interface PlatformSettings {
  trialDurationDays: number;
  platformCurrency: string;
}

/** Guard rails on the trial length. Wide enough to be useful, narrow enough that a
 *  fat-fingered "700" cannot hand out a two-year free trial. */
export const TRIAL_DURATION_MIN = 1;
export const TRIAL_DURATION_MAX = 90;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Platform settings, read from the DB with the env values as fallback.
 *
 * Cached in memory because the trial length is read on every registration and the
 * currency on every plan write, and neither changes more than a few times a year.
 * The cache is invalidated on write; a multi-instance deployment therefore converges
 * within `CACHE_TTL_MS` rather than instantly, which is acceptable for values with
 * these semantics — a company registering during that window simply gets the previous
 * trial length, and `trial_ends_at` is stamped once so nothing shifts underneath them.
 */
export class SettingsService {
  private appSettingRepository = new AppSettingRepository();

  private static cache: PlatformSettings | null = null;
  private static cachedAt = 0;
  private static readonly CACHE_TTL_MS = 60_000;

  static invalidateCache(): void {
    SettingsService.cache = null;
  }

  async getSettings(manager?: EntityManager): Promise<PlatformSettings> {
    const fresh =
      SettingsService.cache !== null &&
      Date.now() - SettingsService.cachedAt < SettingsService.CACHE_TTL_MS;
    if (fresh && SettingsService.cache) return SettingsService.cache;

    const settings: PlatformSettings = {
      trialDurationDays: config.TRIAL_DURATION_DAYS,
      platformCurrency: "USD",
    };

    try {
      const rows = await this.appSettingRepository.findAll(manager);
      for (const row of rows) {
        if (row.key === "trial_duration_days") {
          const parsed = Number.parseInt(row.value, 10);
          if (
            Number.isFinite(parsed) &&
            parsed >= TRIAL_DURATION_MIN &&
            parsed <= TRIAL_DURATION_MAX
          ) {
            settings.trialDurationDays = parsed;
          } else {
            // Never let a bad stored value take the platform down — fall back to env.
            logger.warn({ value: row.value }, "Invalid trial_duration_days setting; using default");
          }
        } else if (row.key === "platform_currency" && CURRENCY_PATTERN.test(row.value)) {
          settings.platformCurrency = row.value;
        }
      }
    } catch (err) {
      // A settings read must not be able to break registration.
      logger.error({ err }, "Failed to read app settings; falling back to defaults");
      return settings;
    }

    SettingsService.cache = settings;
    SettingsService.cachedAt = Date.now();
    return settings;
  }

  async getTrialDurationDays(manager?: EntityManager): Promise<number> {
    return (await this.getSettings(manager)).trialDurationDays;
  }

  async getPlatformCurrency(manager?: EntityManager): Promise<string> {
    return (await this.getSettings(manager)).platformCurrency;
  }

  async setTrialDurationDays(
    days: number,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<number> {
    if (!Number.isInteger(days) || days < TRIAL_DURATION_MIN || days > TRIAL_DURATION_MAX) {
      throw BadRequestError(
        `The free trial must be between ${TRIAL_DURATION_MIN} and ${TRIAL_DURATION_MAX} days.`,
      );
    }
    await this.appSettingRepository.upsert(
      "trial_duration_days",
      String(days),
      actorUserId,
      manager,
    );
    SettingsService.invalidateCache();
    logger.info({ days, actorUserId }, "Trial duration updated");
    return days;
  }

  async setPlatformCurrency(
    currency: string,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<string> {
    const normalized = currency.trim().toUpperCase();
    if (!CURRENCY_PATTERN.test(normalized)) {
      throw BadRequestError("Enter a valid three-letter currency code, for example ZAR.");
    }
    await this.appSettingRepository.upsert("platform_currency", normalized, actorUserId, manager);
    SettingsService.invalidateCache();
    logger.info({ currency: normalized, actorUserId }, "Platform currency updated");
    return normalized;
  }
}
