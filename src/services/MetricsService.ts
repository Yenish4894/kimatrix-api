import { SiteVisitRepository } from "@/repositories/SiteVisitRepository";
import { toVisitorStats, type VisitorStats } from "@/utils/visitorStats";

export class MetricsService {
  constructor(private readonly siteVisitRepository = new SiteVisitRepository()) {}

  /** One atomic upsert: concurrent visits on the same day never lose a count. */
  async recordVisit(): Promise<void> {
    await this.siteVisitRepository.recordVisit();
  }

  /**
   * Rolling windows ending today, inclusive: last7Days is today plus the six days before
   * it. One scan of a table that grows by a single row a day.
   */
  async getVisitorStats(): Promise<VisitorStats> {
    return toVisitorStats(await this.siteVisitRepository.visitorStatsRow());
  }
}
