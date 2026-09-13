import type { Company } from "@/entities/Company";
import { NotFoundError } from "@/errors/index";
import type { CompanyRepository } from "@/repositories/CompanyRepository";

/**
 * Existence check shared by the admin services: the company with its owner, or a 404.
 * Skips the `createdByAdmin` lookup that only the detail endpoint needs.
 */
export async function requireCompany(
  companyRepository: CompanyRepository,
  companyId: string,
): Promise<Company> {
  const company = await companyRepository.findByIdWithOwner(companyId);
  if (!company) {
    throw NotFoundError("Company not found");
  }
  return company;
}
