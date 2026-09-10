import { randomInt } from "node:crypto";
import { AppDataSource } from "data-source";
import { BadRequestError } from "@/errors/index";
import {
  LuckyDrawRepository,
  type DrawEntry,
  type DrawHistoryRow,
  type DrawPeriod,
} from "@/repositories/LuckyDrawRepository";
import { logger } from "@/utils/logger";

export interface DrawPeriodStatus {
  source: "payment" | "comp";
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

  async getStatus(companyId: string): Promise<DrawStatus> {
    return AppDataSource.transaction(async (manager) => {
      const periods = await this.repository.activePeriods(companyId, new Date(), manager);
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

      const periods = await this.repository.activePeriods(companyId, new Date(), manager);
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

      const pool = await this.repository.countEligible(companyId, period, manager);
      if (pool.entries === 0) {
        throw BadRequestError(
          "There are no eligible purchases in this plan period yet. Spins stay available until the plan ends.",
        );
      }

      // crypto.randomInt, not Math.random: unbiased over the range, and not
      // predictable from earlier outputs. It is a prize draw; it should be defensible.
      const offset = randomInt(pool.entries);
      const winner = await this.repository.pickEntry(companyId, period, offset, manager);
      if (!winner) {
        // The company lock does not stop customers submitting — QR submissions never
        // take it. That is fine for inserts: a new purchase sorts last, beyond every
        // offset the count allowed, so it cannot shift the pick. Only a purchase being
        // deleted in this exact instant could empty the slot; fail rather than record
        // a draw nobody can explain.
        throw new Error("Lucky draw pool changed between count and pick");
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
