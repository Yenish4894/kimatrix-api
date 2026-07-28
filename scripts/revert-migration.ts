import "reflect-metadata";
import { AppDataSource } from "data-source";

async function main(): Promise<void> {
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
