import { AppDataSource } from "data-source";

/** Liveness probe for /ready and the admin system status. */
export class DatabaseHealthRepository {
  /** Resolves when the database answers; rejects otherwise. */
  ping(): Promise<unknown> {
    return AppDataSource.query("SELECT 1");
  }
}
