import type { EntityManager } from "typeorm";
import { AppDataSource } from "data-source";
import { BadRequestError } from "@/errors/index";
import {
  LuckyDrawRepository,
  type DrawEntry,
  type DrawHistoryRow,
  type DrawPeriod,
} from "@/repositories/LuckyDrawRepository";
import { logger } from "@/utils/logger";
import { CompanyRepository } from "@/repositories/CompanyRepository";
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
  history: DrawHistoryRow[];
}

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
  private repository = new LuckyDrawRepository();
  private companyRepository = new CompanyRepository();
  private settingsService = new SettingsService();

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
    if (!company) return 0;
    return trialSpinsFor(
      computeEntitlement(company, new Date()).isTrial,
      await this.settingsService.getTrialDrawSpins(manager),
    );
  }

  async getStatus(companyId: string): Promise<DrawStatus> {
    return AppDataSource.transaction(async (manager) => {
      const periods = await this.repository.activePeriods(
        companyId,
        new Date(),
        manager,
        await this.trialSpins(companyId, manager),
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
      return {
        periods: withPools,
        totalRemaining: withPools.reduce((n, p) => n + p.remaining, 0),
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
