import type { EntityManager, Repository } from "typeorm";
import { AppDataSource } from "data-source";
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
}
