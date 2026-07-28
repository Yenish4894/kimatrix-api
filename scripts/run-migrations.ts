import "reflect-metadata";
import { AppDataSource } from "data-source";

async function main(): Promise<void> {
  console.log("[migrate] Initializing data source...");
  await AppDataSource.initialize();

  const hasPending = await AppDataSource.showMigrations();
  if (!hasPending) {
    console.log("[migrate] No pending migrations.");
    await AppDataSource.destroy();
    return;
  }

  console.log("[migrate] Running pending migrations...");
  const executed = await AppDataSource.runMigrations({ transaction: "all" });
  console.log(
    "[migrate] Done. Executed:",
    executed.length ? executed.map((m) => m.name).join(", ") : "(none)",
  );

  await AppDataSource.destroy();
}

main().catch((err) => {
  console.error("[migrate] FAILED:", err);
  process.exit(1);
});
