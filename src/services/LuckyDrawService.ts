import type { EntityManager } from "typeorm";
import { AppDataSource } from "data-source";
import { BadRequestError } from "@/errors/index";
import {
  LuckyDrawRepository,
  type DrawEntry,
  type DrawHistoryRow,
  type DrawPeriod,
  type FreeDrawPeriod,
} from "@/repositories/LuckyDrawRepository";
import { logger } from "@/utils/logger";
import { CompanyRepository } from "@/repositories/CompanyRepository";
import { PaymentRepository, type PaidWindow } from "@/repositories/PaymentRepository";
import type { Company } from "@/entities/Company";
import { SettingsService } from "@/services/SettingsService";
import { computeEntitlement } from "@/utils/entitlement";
import { trialSpinsFor } from "@/utils/spinAddon";
import { drawSeed } from "@/utils/luckyDraw";

export interface DrawPeriodStatus {
  source: "payment" | "comp" | "trial";
  periodStart: Date;
  periodEnd: Date | null;
  spins: number;
  used: number;
  remaining: number;
  /** Purchases currently in the pool — one entry each. */
  entries: number;
  /** Distinct customers behind those entries. */
  eligibleCustomers: number;
}

export interface DrawStatus {
  periods: DrawPeriodStatus[];
  totalRemaining: number;
  /**
   * Whether the company may buy spins right now: always while a paid plan runs; on a
   * trial or admin-granted free access, only once every free spin is used.
   */
  canBuySpins: boolean;
  history: DrawHistoryRow[];
}

/**
 * Whether, and into what, the company can buy spins right now. The ONE place this is
 * decided: GET /company/draws (canBuySpins) and the purchase itself both use it, so the
 * button can never offer what the server then refuses.
 */
export type SpinPurchaseOption =
  | { mode: "paid"; window: PaidWindow }
  | { mode: "free"; period: FreeDrawPeriod }
  | { mode: "none"; reason: "inactive" | "non_usd_plan" }
  | { mode: "none"; reason: "spins_left"; remaining: number };

export interface SpinResult {
  drawId: string;
  drawnAt: Date;
  winner: DrawEntry;
  entriesCount: number;
  eligibleCustomers: number;
  remaining: number;
}

/**
 * The lucky draw.
 *
 * The server picks the winner. The spinning wheel on the page is presentation only —
 * it animates towards a result that has already been chosen and recorded — so the
 * outcome cannot be influenced from the browser, re-rolled by refreshing, or
 * disputed as having been decided by the merchant.
 */
export class LuckyDrawService {
  constructor(
    private readonly repository = new LuckyDrawRepository(),
    private readonly companyRepository = new CompanyRepository(),
    private readonly settingsService = new SettingsService(),
    private readonly paymentRepository = new PaymentRepository(),
  ) {}

  /**
   * Free spins from the company's trial: the admin's current setting while the trial is
   * what grants access, otherwise 0. Read on every call, so changing the setting reaches
   * trials already running.
   */
  /**
   * @param manager REQUIRED, the caller's transaction. Reading the company outside it
   *   (as this used to) took a second pool connection and saw the company as it was
   *   BEFORE `spin` took its lock — so a spin could be granted against trial state that
   *   a concurrent change had already ended.
   */
  private async trialSpins(companyId: string, manager: EntityManager): Promise<number> {
    const company = await this.companyRepository.findById(companyId, manager);
    return company ? this.trialSpinsOf(company, manager) : 0;
  }

  private async trialSpinsOf(company: Company, manager: EntityManager): Promise<number> {
    return trialSpinsFor(
      computeEntitlement(company, new Date()).isTrial,
      await this.settingsService.getTrialDrawSpins(manager),
    );
  }

  /**
   * See SpinPurchaseOption. During a paid plan, always (unchanged). Otherwise on a
   * running comp or trial, but only once every free spin is used, so nobody pays for
   * spins they already have for free.
   *
   * @param known  the company and its periods when the caller already loaded them.
   */
  async spinPurchaseOption(
    companyId: string,
    manager: EntityManager,
    known: { company?: Company | null; periods?: DrawPeriod[] } = {},
  ): Promise<SpinPurchaseOption> {
    const now = new Date();
    const company =
      known.company !== undefined
        ? known.company
        : await this.companyRepository.findById(companyId, manager);
    if (!company || !computeEntitlement(company, now).hasAccess) {
      return { mode: "none", reason: "inactive" };
    }
    const window = await this.paymentRepository.findCurrentPaidWindow(companyId, manager);
    if (window) {
      // Spins are priced in USD; a plan billed in another currency cannot add them.
      return window.plan_currency === "USD"
        ? { mode: "paid", window }
        : { mode: "none", reason: "non_usd_plan" };
    }
    const period = await this.repository.freeDrawPeriod(companyId, now, manager);
    if (!period) return { mode: "none", reason: "inactive" };
    const periods =
      known.periods ??
      (await this.repository.activePeriods(
        companyId,
        now,
        manager,
        await this.trialSpinsOf(company, manager),
      ));
    const remaining = periods.reduce((n, p) => n + Math.max(0, p.spins - p.used), 0);
    if (remaining > 0) return { mode: "none", reason: "spins_left", remaining };
    return { mode: "free", period };
  }

  async getStatus(companyId: string): Promise<DrawStatus> {
    return AppDataSource.transaction(async (manager) => {
      const company = await this.companyRepository.findById(companyId, manager);
      const periods = await this.repository.activePeriods(
        companyId,
        new Date(),
        manager,
        company ? await this.trialSpinsOf(company, manager) : 0,
      );
      const withPools = await Promise.all(
        periods.map(async (p): Promise<DrawPeriodStatus> => {
          const pool = await this.repository.countEligible(companyId, p, manager);
          return {
            source: p.source,
            periodStart: p.periodStart,
            periodEnd: p.periodEnd,
            spins: p.spins,
            used: p.used,
            remaining: Math.max(0, p.spins - p.used),
            entries: pool.entries,
            eligibleCustomers: pool.customers,
          };
        }),
      );
      const totalRemaining = withPools.reduce((n, p) => n + p.remaining, 0);
      return {
        periods: withPools,
        totalRemaining,
        canBuySpins:
          (await this.spinPurchaseOption(companyId, manager, { company, periods })).mode !== "none",
        history: await this.repository.history(companyId, manager),
      };
    });
  }

  async spin(companyId: string, drawnByUserId: string): Promise<SpinResult> {
    return AppDataSource.transaction(async (manager) => {
      // Everything below re-reads under this lock, so a double click or a second tab
      // queues behind the first spin and then sees the spin already spent.
      await this.repository.lockCompany(companyId, manager);

      // After the lock and in this transaction, so the trial state is read as of now.
      const trialSpins = await this.trialSpins(companyId, manager);
      const periods = await this.repository.activePeriods(
        companyId,
        new Date(),
        manager,
        trialSpins,
      );
      // Soonest-ending window first: spins that are about to expire get used before
      // ones that will still be there next week.
      const period: DrawPeriod | undefined = periods.find((p) => p.spins - p.used > 0);
      if (!period) {
        throw BadRequestError(
          periods.length > 0
            ? "You've used every lucky draw spin in your current plan."
            : "Your current plan doesn't include lucky draw spins.",
        );
      }

      // Count and pick in ONE statement, so both see the same snapshot. The company lock
      // does not stop customers submitting or merchants voiding — neither takes it — and
      // as two statements a void landing between them shifted the pool under the pick.
      const pick = await this.repository.pickRandomEntry(companyId, period, drawSeed(), manager);
      const pool = { entries: pick.entries, customers: pick.customers };
      if (pool.entries === 0) {
        throw BadRequestError(
          "There are no eligible purchases in this plan period yet. Spins stay available until the plan ends.",
        );
      }
      const winner = pick.entry;
      if (!winner) {
        // Unreachable: the index is taken modulo the count of the same row set.
        throw new Error("Lucky draw pick found no entry in a non-empty pool");
      }

      const saved = await this.repository.insertDraw(
        {
          companyId,
          period,
          entry: winner,
          entriesCount: pool.entries,
          eligibleCustomers: pool.customers,
          drawnByUserId,
        },
        manager,
      );

      logger.info(
        {
          companyId,
          drawId: saved.id,
          periodKey: period.periodKey,
          entries: pool.entries,
          winnerCustomerId: winner.customerId,
        },
        "Lucky draw spun",
      );

      return {
        drawId: saved.id,
        drawnAt: saved.drawnAt,
        winner,
        entriesCount: pool.entries,
        eligibleCustomers: pool.customers,
        // Everything that was left across all open windows, minus the one just spent.
        remaining: periods.reduce((n, p) => n + Math.max(0, p.spins - p.used), 0) - 1,
      };
    });
  }
}
