import { AppDataSource } from "data-source";
import { config } from "@/config/index";
import { BadRequestError, ConflictError } from "@/errors/index";
import { AppSettingRepository } from "@/repositories/AppSettingRepository";
import { AuditService } from "@/services/AuditService";
import { logger } from "@/utils/logger";
import type { EntityManager } from "typeorm";

export interface PlatformSettings {
  trialDurationDays: number;
  platformCurrency: string;
  spinAddonPriceUsd: number;
}

/** Guard rails on the trial length. Wide enough to be useful, narrow enough that a
 *  fat-fingered "700" cannot hand out a two-year free trial. */
export const TRIAL_DURATION_MIN = 1;
export const TRIAL_DURATION_MAX = 90;

export const SPIN_PRICE_MIN = 0.01;
export const SPIN_PRICE_MAX = 100;

/**
 * Currencies PayPal will actually settle in. A bare /^[A-Z]{3}$/ check let an admin
 * save "XYZ", create plans in it, and only discover the problem when a real customer
 * reached PayPal and the order was rejected.
 * Source: PayPal "Currency Codes" — currencies supported for online transactions.
 */
export const SUPPORTED_CURRENCIES = [
  "AUD",
  "BRL",
  "CAD",
  "CHF",
  "CNY",
  "CZK",
  "DKK",
  "EUR",
  "GBP",
  "HKD",
  "HUF",
  "ILS",
  "JPY",
  "MXN",
  "MYR",
  "NOK",
  "NZD",
  "PHP",
  "PLN",
  "RUB",
  "SEK",
  "SGD",
  "THB",
  "TWD",
  "USD",
  "ZAR",
] as const;

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
  private auditService = new AuditService();

  private static cache: PlatformSettings | null = null;
  private static cachedAt = 0;
  private static readonly CACHE_TTL_MS = 60_000;

  static invalidateCache(): void {
    SettingsService.cache = null;
  }

  /**
   * @param manager  Supplying one bypasses the cache and reads through the caller's
   *                 transaction. Required for read-then-write flows: stamping a plan
   *                 with the platform currency must not use a value up to CACHE_TTL_MS
   *                 stale, or a plan created moments after a currency change gets the
   *                 old one inside the very transaction meant to prevent that.
   */
  async getSettings(manager?: EntityManager): Promise<PlatformSettings> {
    const fresh =
      manager === undefined &&
      SettingsService.cache !== null &&
      Date.now() - SettingsService.cachedAt < SettingsService.CACHE_TTL_MS;
    if (fresh && SettingsService.cache) return SettingsService.cache;

    const settings: PlatformSettings = {
      trialDurationDays: config.TRIAL_DURATION_DAYS,
      platformCurrency: "USD",
      spinAddonPriceUsd: 3,
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
        } else if (row.key === "spin_addon_price_usd") {
          const parsed = Number.parseFloat(row.value);
          if (Number.isFinite(parsed) && parsed >= SPIN_PRICE_MIN && parsed <= SPIN_PRICE_MAX) {
            settings.spinAddonPriceUsd = parsed;
          } else {
            logger.warn(
              { value: row.value },
              "Invalid spin_addon_price_usd setting; using default",
            );
          }
        }
      }
    } catch (err) {
      // A settings read must not be able to break registration.
      logger.error({ err }, "Failed to read app settings; falling back to defaults");
      return settings;
    }

    // Only populate the cache from a non-transactional read; a value read inside
    // someone else's uncommitted transaction must not become the global answer.
    if (manager === undefined) {
      SettingsService.cache = settings;
      SettingsService.cachedAt = Date.now();
    }
    return settings;
  }

  async getTrialDurationDays(manager?: EntityManager): Promise<number> {
    return (await this.getSettings(manager)).trialDurationDays;
  }

  async getPlatformCurrency(manager?: EntityManager): Promise<string> {
    return (await this.getSettings(manager)).platformCurrency;
  }

  async getSpinAddonPriceUsd(manager?: EntityManager): Promise<number> {
    return (await this.getSettings(manager)).spinAddonPriceUsd;
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

  /**
   * Changing the platform currency is refused while any sellable plan still exists in
   * the old one.
   *
   * The alternative — silently switching the setting — leaves existing plans stamped
   * with the previous currency, so the billing page renders "USD 51.31" next to
   * "ZAR 249.00". The design's single-currency guarantee was previously enforced only
   * at plan-creation time, which is to say not enforced at all.
   *
   * Auto-converting the plans is worse: 51.31 USD is not 51.31 ZAR, so rewriting the
   * currency column would silently redenominate real prices. The admin must retire the
   * old plans and create new ones at the correct amounts — the only version of this
   * that can't mis-price something.
   */
  async setPlatformCurrency(
    currency: string,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<string> {
    const normalized = currency.trim().toUpperCase();
    if (!CURRENCY_PATTERN.test(normalized)) {
      throw BadRequestError("Enter a valid three-letter currency code, for example ZAR.");
    }
    if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(normalized)) {
      throw BadRequestError(
        `${normalized} isn't a currency we can take payments in. Supported: ${SUPPORTED_CURRENCIES.join(", ")}.`,
      );
    }

    const current = await this.getPlatformCurrency(manager);
    if (current !== normalized) {
      const blocking = await this.appSettingRepository.countSellablePlansNotIn(normalized, manager);
      if (blocking > 0) {
        throw ConflictError(
          `You still have ${blocking} plan${blocking === 1 ? "" : "s"} priced in ${current}. ` +
            `Hide them first, then create new plans at the right ${normalized} prices — ` +
            `switching currency can't convert amounts for you.`,
        );
      }
    }

    await this.appSettingRepository.upsert("platform_currency", normalized, actorUserId, manager);
    SettingsService.invalidateCache();
    logger.info({ currency: normalized, actorUserId }, "Platform currency updated");
    return normalized;
  }

  /** Price of one lucky draw spin add-on, stored to the cent. Only USD: PayPal cannot settle ZAR. */
  async setSpinAddonPriceUsd(
    price: number,
    actorUserId: string,
    manager?: EntityManager,
  ): Promise<number> {
    if (!Number.isFinite(price) || price < SPIN_PRICE_MIN || price > SPIN_PRICE_MAX) {
      throw BadRequestError(
        `The spin price must be between ${SPIN_PRICE_MIN} and ${SPIN_PRICE_MAX} USD.`,
      );
    }
    await this.appSettingRepository.upsert(
      "spin_addon_price_usd",
      price.toFixed(2),
      actorUserId,
      manager,
    );
    SettingsService.invalidateCache();
    logger.info({ price, actorUserId }, "Spin add-on price updated");
    return price;
  }

  /**
   * Atomic multi-setting update, audited in the same transaction.
   *
   * Both writes and the audit row commit together, so a rejected currency change can't
   * leave an already-saved trial length behind while the response reports a failure.
   */
  async updateSettings(
    input: { trialDurationDays?: number; platformCurrency?: string; spinAddonPriceUsd?: number },
    actor: { id: string; email: string },
  ): Promise<PlatformSettings> {
    const result = await AppDataSource.transaction(async (manager) => {
      const before = await this.getSettings(manager);
      if (input.trialDurationDays !== undefined) {
        await this.setTrialDurationDays(input.trialDurationDays, actor.id, manager);
      }
      if (input.platformCurrency !== undefined) {
        await this.setPlatformCurrency(input.platformCurrency, actor.id, manager);
      }
      if (input.spinAddonPriceUsd !== undefined) {
        await this.setSpinAddonPriceUsd(input.spinAddonPriceUsd, actor.id, manager);
      }
      const after = await this.getSettings(manager);

      await this.auditService.record(
        {
          actorUserId: actor.id,
          actorEmail: actor.email,
          action: "setting.update",
          entityType: "settings",
          entityId: "platform",
          before: before as unknown as Record<string, unknown>,
          after: after as unknown as Record<string, unknown>,
        },
        manager,
      );

      return after;
    });

    // The cache was invalidated mid-transaction; clear again now the writes are
    // visible, so the next read can't repopulate it from pre-commit state.
    SettingsService.invalidateCache();
    return result;
  }
}
