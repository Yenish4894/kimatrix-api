import "reflect-metadata";
import { DataSource } from "typeorm";
import { config, isDevelopment } from "@/config/index";

export const AppDataSource = new DataSource({
  type: "postgres",
  host: config.DB_HOST,
  port: config.DB_PORT,
  username: config.DB_USERNAME,
  password: config.DB_PASSWORD,
  database: config.DB_NAME,
  // `rejectUnauthorized: false` would encrypt the connection but not authenticate it —
  // anything able to answer on the DB address could present a self-signed certificate
  // and read every credential hash and payment row in transit, which makes TLS
  // decorative. Supply DB_CA_CERT when the provider uses a private CA.
  ssl: config.DB_SSL
    ? {
        rejectUnauthorized: true,
        ...(config.DB_CA_CERT ? { ca: config.DB_CA_CERT } : {}),
      }
    : false,
  synchronize: false,
  logging: isDevelopment ? ["error", "warn", "schema"] : ["error"],
  entities: isDevelopment ? ["src/entities/*.ts"] : ["dist/src/entities/*.js"],
  migrations: isDevelopment ? ["migrations/*.ts"] : ["dist/migrations/*.js"],
  migrationsRun: false,
  extra: {
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  },
});

export async function initializeDatabase(): Promise<void> {
  if (AppDataSource.isInitialized) return;
  await AppDataSource.initialize();
}

export async function closeDatabase(): Promise<void> {
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy();
  }
}
