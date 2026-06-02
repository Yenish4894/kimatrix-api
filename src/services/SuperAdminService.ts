import { AppDataSource } from "data-source";
import { BadRequestError, NotFoundError } from "@/errors/index";
import type { Company } from "@/entities/Company";
import { CompanyRepository } from "@/repositories/CompanyRepository";
import type {
  CompanyBusinessTypeFilter,
  CompanyStatusFilter,
  PlatformStats,
} from "@/repositories/CompanyRepository";
import { CustomerRepository } from "@/repositories/CustomerRepository";
import { TokenRepository } from "@/repositories/TokenRepository";
import { logger } from "@/utils/logger";

export interface ListCompaniesInput {
  page: number;
  limit: number;
  search?: string;
  status?: CompanyStatusFilter;
  businessType?: CompanyBusinessTypeFilter;
}

export interface PlatformStatsResult extends PlatformStats {
  totalCustomers: number;
  totalPurchases: number;
  totalSpend: string;
}

export class SuperAdminService {
  private companyRepository = new CompanyRepository();
  private customerRepository = new CustomerRepository();
  private tokenRepository = new TokenRepository();

  async listCompanies(input: ListCompaniesInput): Promise<{ items: Company[]; total: number }> {
    return this.companyRepository.listForAdmin(input);
  }

  async getCompany(companyId: string): Promise<Company> {
    const company = await this.companyRepository.findByIdWithOwner(companyId);
    if (!company) {
      throw NotFoundError("Company not found");
    }
    return company;
  }

  async deactivateCompany(companyId: string, adminUserId: string): Promise<void> {
    await AppDataSource.transaction(async (manager) => {
      const company = await this.companyRepository.findByIdWithOwner(companyId, manager);
      if (!company) {
        throw NotFoundError("Company not found");
      }
      if (!company.isActive) {
        throw BadRequestError("Company is already deactivated");
      }

      await this.companyRepository.setDeactivated(companyId, adminUserId, manager);
      await this.tokenRepository.revokeAllRefreshTokensForUser(company.owner.id, manager);

      logger.info(
        { companyId, adminUserId, ownerUserId: company.owner.id },
        "Company deactivated; owner refresh tokens revoked",
      );
    });
  }

  async activateCompany(companyId: string): Promise<void> {
    await AppDataSource.transaction(async (manager) => {
      const company = await this.companyRepository.findById(companyId, manager);
      if (!company) {
        throw NotFoundError("Company not found");
      }
      if (company.isActive) {
        throw BadRequestError("Company is already active");
      }

      await this.companyRepository.setActivated(companyId, manager);
      logger.info({ companyId }, "Company reactivated");
    });
  }

  async getPlatformStats(): Promise<PlatformStatsResult> {
    const [companyStats, aggregates] = await Promise.all([
      this.companyRepository.getPlatformStats(),
      this.customerRepository.getPlatformAggregates(),
    ]);
    return { ...companyStats, ...aggregates };
  }
}
