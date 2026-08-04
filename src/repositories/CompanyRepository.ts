import type { EntityManager, Repository } from "typeorm";
import { AppDataSource } from "data-source";
import { returningRows } from "@/utils/db";
import { Company } from "@/entities/Company";

export type CompanyStatusFilter = "all" | "active" | "inactive";
export type CompanyBusinessTypeFilter = "all" | "fuel_station" | "shop";

export interface ListCompaniesOptions {
  page: number;
  limit: number;
  search?: string;
  status?: CompanyStatusFilter;
  businessType?: CompanyBusinessTypeFilter;
}

export interface PlatformStats {
  totalCompanies: number;
  activeCompanies: number;
  inactiveCompanies: number;
  totalFuelStations: number;
  totalShops: number;
}

export const EXPIRY_NOTICE_KINDS = ["trial_ending", "trial_ended", "subscription_ended"] as const;
export type ExpiryNoticeKind = (typeof EXPIRY_NOTICE_KINDS)[number];

export interface ExpiryNoticeTarget {
  company_id: string;
  company_name: string;
  country: string;
  owner_email: string;
  deadline: Date;
}

/**
 * Column and predicate per notice. Kept as a lookup rather than three near-identical
 * methods so the guard logic exists in exactly one place — the three differ only in
 * which deadline they watch.
 *
 * Interpolated into SQL, so every value here must stay a hard-coded literal; none of
 * it is ever caller-supplied.
 */
const EXPIRY_NOTICE_SQL: Record<
  ExpiryNoticeKind,
  { column: string; deadline: string; due: string }
> = {
  // Two days out, and only while the trial is still live.
  trial_ending: {
    column: "trial_ending_notice_for",
    deadline: "trial_ends_at",
    due: `c."trial_ends_at" IS NOT NULL
          AND c."trial_ends_at" > now()
          AND c."trial_ends_at" <= now() + interval '48 hours'
          AND c."subscription_expires_at" IS NULL`,
  },
  // The moment it lapses. `subscription_expires_at IS NULL` skips anyone who converted.
  trial_ended: {
    column: "trial_ended_notice_for",
    deadline: "trial_ends_at",
    due: `c."trial_ends_at" IS NOT NULL
          AND c."trial_ends_at" <= now()
          AND c."subscription_expires_at" IS NULL`,
  },
  // A paid subscription running out.
  subscription_ended: {
    column: "subscription_ended_notice_for",
    deadline: "subscription_expires_at",
    due: `c."subscription_expires_at" IS NOT NULL
          AND c."subscription_expires_at" <= now()`,
  },
};

export class CompanyRepository {
  private getRepo(manager?: EntityManager): Repository<Company> {
    return manager ? manager.getRepository(Company) : AppDataSource.getRepository(Company);
  }

  async findById(id: string, manager?: EntityManager): Promise<Company | null> {
    return this.getRepo(manager).findOne({ where: { id } });
  }

  async findByIdWithOwner(id: string, manager?: EntityManager): Promise<Company | null> {
    return this.getRepo(manager)
      .createQueryBuilder("c")
      .leftJoinAndSelect("c.owner", "owner")
      .where("c.id = :id", { id })
      .getOne();
  }

  async findByOwnerUserId(ownerUserId: string, manager?: EntityManager): Promise<Company | null> {
    return this.getRepo(manager)
      .createQueryBuilder("c")
      .leftJoinAndSelect("c.currentPlan", "currentPlan")
      .where("c.owner_user_id = :ownerUserId", { ownerUserId })
      .getOne();
  }

  async findByRegistrationNumber(
    registrationNumber: string,
    manager?: EntityManager,
  ): Promise<Company | null> {
    return this.getRepo(manager).findOne({ where: { registrationNumber } });
  }

  async findByQrToken(qrToken: string, manager?: EntityManager): Promise<Company | null> {
    return this.getRepo(manager).findOne({ where: { qrToken } });
  }

  async create(data: Partial<Company>, manager?: EntityManager): Promise<Company> {
    const repo = this.getRepo(manager);
    return repo.save(repo.create(data));
  }

  async updateProfile(
    id: string,
    data: Partial<
      Pick<
        Company,
        | "streetAddress"
        | "city"
        | "state"
        | "country"
        | "postalCode"
        | "contactEmail"
        | "contactPhone"
        | "whatsappNumber"
        | "promoEmailOptIn"
      >
    >,
    manager?: EntityManager,
  ): Promise<void> {
    await this.getRepo(manager).update({ id }, data);
  }

  async setDeactivated(
    companyId: string,
    deactivatedByUserId: string,
    manager?: EntityManager,
  ): Promise<void> {
    await this.getRepo(manager).update(
      { id: companyId },
      {
        isActive: false,
        deactivatedAt: new Date(),
        deactivatedBy: { id: deactivatedByUserId } as never,
      },
    );
  }

  async setActivated(companyId: string, manager?: EntityManager): Promise<void> {
    await this.getRepo(manager).update(
      { id: companyId },
      { isActive: true, deactivatedAt: null, deactivatedBy: null },
    );
  }

  async listForAdmin(
    opts: ListCompaniesOptions,
    manager?: EntityManager,
  ): Promise<{ items: Company[]; total: number }> {
    const qb = this.getRepo(manager).createQueryBuilder("c").leftJoinAndSelect("c.owner", "owner");

    if (opts.search && opts.search.trim() !== "") {
      qb.andWhere(
        "(c.name ILIKE :search OR c.registration_number ILIKE :search OR c.contact_email ILIKE :search OR c.contact_phone ILIKE :search OR owner.email ILIKE :search OR owner.username ILIKE :search)",
        { search: `%${opts.search.trim()}%` },
      );
    }

    if (opts.status === "active") {
      qb.andWhere("c.is_active = true");
    } else if (opts.status === "inactive") {
      qb.andWhere("c.is_active = false");
    }

    if (opts.businessType && opts.businessType !== "all") {
      qb.andWhere("c.business_type = :bt", { bt: opts.businessType });
    }

    qb.orderBy("c.createdAt", "DESC")
      .addOrderBy("c.id", "ASC")
      .take(opts.limit)
      .skip((opts.page - 1) * opts.limit);

    const [items, total] = await qb.getManyAndCount();
    return { items, total };
  }

  async getPlatformStats(manager?: EntityManager): Promise<PlatformStats> {
    const raw = await this.getRepo(manager)
      .createQueryBuilder("c")
      .select("COUNT(c.id)", "total")
      .addSelect("SUM(CASE WHEN c.is_active = true THEN 1 ELSE 0 END)", "active")
      .addSelect("SUM(CASE WHEN c.is_active = false THEN 1 ELSE 0 END)", "inactive")
      .addSelect(
        "SUM(CASE WHEN c.business_type = 'fuel_station' THEN 1 ELSE 0 END)",
        "fuel_stations",
      )
      .addSelect("SUM(CASE WHEN c.business_type = 'shop' THEN 1 ELSE 0 END)", "shops")
      .getRawOne<{
        total: string;
        active: string | null;
        inactive: string | null;
        fuel_stations: string | null;
        shops: string | null;
      }>();

    return {
      totalCompanies: Number(raw?.total ?? 0),
      activeCompanies: Number(raw?.active ?? 0),
      inactiveCompanies: Number(raw?.inactive ?? 0),
      totalFuelStations: Number(raw?.fuel_stations ?? 0),
      totalShops: Number(raw?.shops ?? 0),
    };
  }

  /**
   * Extend the subscription by `durationDays`, stacking onto any time remaining, and
   * activate the company. Returns the resulting window.
   *
   * Deliberately a single atomic UPDATE rather than read-compute-write. The previous
   * code read `subscription_expires_at` from an unlocked LEFT JOIN, added the plan
   * duration in JS, and wrote the result — so two payments captured concurrently (two
   * tabs, or the capture racing its own webhook) both read the same expiry, both
   * computed the same new one, and both wrote it. The customer was charged twice and
   * received one period.
   *
   * Referencing the column on the right-hand side of SET is the standard atomic
   * increment pattern: under READ COMMITTED, Postgres re-reads the row and
   * re-evaluates the expression if a concurrent transaction updated it first, so the
   * second payment stacks on the first instead of overwriting it.
   */
  async extendSubscription(
    params: {
      companyId: string;
      planId: string;
      durationDays: number;
      now: Date;
    },
    manager: EntityManager,
  ): Promise<{ subscriptionStartsAt: Date; subscriptionEndsAt: Date }> {
    const result = await manager.query(
      `UPDATE "companies"
          SET "subscription_expires_at" =
                GREATEST(COALESCE("subscription_expires_at", $2::timestamptz), $2::timestamptz)
                + make_interval(days => $3::int),
              "is_active" = true,
              "current_plan_id" = $4,
              "deactivated_at" = NULL,
              "deactivated_by_user_id" = NULL
        WHERE "id" = $1
          AND "deleted_at" IS NULL
        RETURNING
          "subscription_expires_at" - make_interval(days => $3::int) AS starts_at,
          "subscription_expires_at" AS ends_at`,
      [params.companyId, params.now, params.durationDays, params.planId],
    );

    const row = returningRows<{ starts_at: Date; ends_at: Date }>(result)[0];
    if (!row) {
      throw new Error(`extendSubscription: company ${params.companyId} not found`);
    }
    return { subscriptionStartsAt: row.starts_at, subscriptionEndsAt: row.ends_at };
  }

  /**
   * Atomically claims the companies due one of the three expiry notices and stamps the
   * send-once marker in the same statement.
   *
   * Claim-then-send, never select-then-send: the UPDATE ... RETURNING is what makes
   * two app instances (or two overlapping ticks) unable to both email the same
   * customer. Whoever's UPDATE lands first gets the rows back; the other gets none.
   *
   * The guard is `notice_for IS DISTINCT FROM <deadline>` rather than `IS NULL`, so
   * moving the deadline re-arms the notice automatically. `IS DISTINCT FROM` and not
   * `<>` because both sides are nullable and `NULL <> x` evaluates to NULL, which
   * would match nothing and silently stop all mail.
   *
   * Guards on `is_comped = false` and `deactivated_at IS NULL`: a comped company has
   * no expiry to warn about, and telling a company an admin just banned that its
   * trial is ending is noise at best.
   *
   * Callers MUST enqueue outside the surrounding transaction, and call
   * `releaseExpiryNotice` if the enqueue fails — see the cron for why.
   */
  async claimExpiryNotices(
    kind: ExpiryNoticeKind,
    manager: EntityManager,
  ): Promise<ExpiryNoticeTarget[]> {
    const spec = EXPIRY_NOTICE_SQL[kind];
    const result = await manager.query(
      `UPDATE "companies" c
          SET "${spec.column}" = c."${spec.deadline}"
         FROM "users" u
        WHERE u."id" = c."owner_user_id"
          AND c."deleted_at" IS NULL
          AND c."deactivated_at" IS NULL
          AND c."is_comped" = false
          AND u."is_active" = true
          AND ${spec.due}
          AND c."${spec.column}" IS DISTINCT FROM c."${spec.deadline}"
      RETURNING c."id"            AS company_id,
                c."name"          AS company_name,
                c."country"       AS country,
                u."email"         AS owner_email,
                c."${spec.deadline}" AS deadline`,
    );
    return returningRows<ExpiryNoticeTarget>(result);
  }

  /**
   * Puts a claimed notice back so the next tick retries it.
   *
   * Used when the enqueue fails after the claim committed. Without it a Redis blip
   * would permanently consume the customer's only warning email — the marker would be
   * set, so the cron would never look at that company again.
   */
  async releaseExpiryNotice(
    kind: ExpiryNoticeKind,
    companyId: string,
    manager?: EntityManager,
  ): Promise<void> {
    const spec = EXPIRY_NOTICE_SQL[kind];
    await (manager ?? AppDataSource.manager).query(
      `UPDATE "companies" SET "${spec.column}" = NULL WHERE "id" = $1`,
      [companyId],
    );
  }
}
