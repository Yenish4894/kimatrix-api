import "reflect-metadata";
import { AppDataSource, withoutStatementTimeout } from "data-source";

async function main(): Promise<void> {
  // Same as run-migrations: a down() can be as heavy as its up().
  withoutStatementTimeout();
  console.log("[migrate:revert] Initializing data source...");
  await AppDataSource.initialize();

  console.log("[migrate:revert] Reverting last migration...");
  await AppDataSource.undoLastMigration({ transaction: "all" });
  console.log("[migrate:revert] Done.");

  await AppDataSource.destroy();
}

main().catch((err) => {
  console.error("[migrate:revert] FAILED:", err);
  process.exit(1);
});
