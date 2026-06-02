import "reflect-metadata";
import "dotenv/config";
import { validateConfig } from "@/config/index";
import { AppDataSource, initializeDatabase, closeDatabase } from "data-source";
import { User } from "@/entities/User";
import { PasswordService } from "@/services/PasswordService";
import { logger } from "@/utils/logger";

interface Args {
  email: string;
  password: string;
  skipHibp: boolean;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let email: string | undefined;
  let password: string | undefined;
  let skipHibp = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--email") {
      email = args[++i];
    } else if (arg === "--password") {
      password = args[++i];
    } else if (arg === "--skip-hibp") {
      skipHibp = true;
    }
  }

  if (!email || !password) {
    console.error(
      "Usage: tsx scripts/create-superadmin.ts --email <email> --password <password> [--skip-hibp]",
    );
    process.exit(1);
  }

  return { email, password, skipHibp };
}

async function main(): Promise<void> {
  const { email: rawEmail, password, skipHibp } = parseArgs();
  const email = rawEmail.trim().toLowerCase();

  validateConfig();
  await initializeDatabase();

  const passwordService = new PasswordService();

  if (!skipHibp) {
    const compromised = await passwordService.isCompromised(password);
    if (compromised) {
      logger.error("Password appears in a known data breach. Refusing to create super admin.");
      await closeDatabase();
      process.exit(2);
    }
  }

  const userRepo = AppDataSource.getRepository(User);

  const existing = await userRepo.findOne({ where: { email } });
  if (existing) {
    logger.error({ email }, "A user with this email already exists");
    await closeDatabase();
    process.exit(3);
  }

  const passwordHash = await passwordService.hash(password);

  const user = userRepo.create({
    email,
    username: null,
    password: passwordHash,
    userType: "super_admin",
    isActive: true,
    passwordChangedAt: new Date(),
  });
  const saved = await userRepo.save(user);

  logger.info({ userId: saved.id, email }, "Super admin created successfully");
  await closeDatabase();
}

main().catch(async (err) => {
  logger.error({ err }, "Failed to create super admin");
  await closeDatabase().catch((_err) => {
    // Ignore cleanup errors
  });
  process.exit(1);
});
