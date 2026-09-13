import type { EntityManager } from "typeorm";
import { affectedRows } from "@/utils/db";

export interface ErasedCustomerData {
  purchasesDeleted: number;
  customersDeleted: number;
}

/**
 * Erases one company's third-party personal data: its customers and their purchases.
 * The single copy of that SQL, shared by account deletion (AccountDeletionService) and
 * the expiry purge (ExpiredDataPurgeService) — it used to be pasted into both, and the
 * two copies were one edit away from disagreeing about what "erased" means.
 *
 * Must run inside the caller's transaction (pass its manager), after the caller has
 * locked the company row and re-checked eligibility.
 *
 * Lucky-draw history survives: `lucky_draws` points at the winner and the winning
 * purchase with ON DELETE SET NULL and carries a snapshot of the winner's name, a
 * masked mobile and the invoice, so a later prize dispute still has a record. A closed
 * account (`scrubDrawWinners`) also loses the winner name and mobile — there is no
 * company left to raise a dispute, and the customer asked for everything to go.
 */
export class CustomerDataErasureRepository {
  async eraseCompanyCustomerData(
    manager: EntityManager,
    companyId: string,
    opts: { scrubDrawWinners: boolean },
  ): Promise<ErasedCustomerData> {
    // Purchases first: they reference customers with ON DELETE RESTRICT.
    const purchases = await manager.query(`DELETE FROM "purchases" WHERE "company_id" = $1`, [
      companyId,
    ]);
    const customers = await manager.query(`DELETE FROM "customers" WHERE "company_id" = $1`, [
      companyId,
    ]);
    if (opts.scrubDrawWinners) {
      await manager.query(
        `UPDATE "lucky_draws"
          SET "winner_name" = NULL, "winner_mobile_masked" = NULL
        WHERE "company_id" = $1`,
        [companyId],
      );
    }
    return {
      purchasesDeleted: affectedRows(purchases),
      customersDeleted: affectedRows(customers),
    };
  }
}
