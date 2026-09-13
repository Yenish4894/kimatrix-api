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
    max: config.DB_POOL_MAX,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    // Sent as startup parameters on every pooled connection. Without them one runaway
    // query, or a transaction left open by a bug, held its connection indefinitely and
    // a handful of those starved the whole pool (every request then waits the 5s
    // connectionTimeout and 500s). Migrations lift both — see withoutStatementTimeout.
    ...(config.DB_STATEMENT_TIMEOUT_MS > 0
      ? { statement_timeout: config.DB_STATEMENT_TIMEOUT_MS }
      : {}),
    idle_in_transaction_session_timeout: 60_000,
  },
});

/**
 * Lifts the app's statement and idle-transaction timeouts. For the migration scripts
 * only: an index build or a backfill can legitimately take longer than any request
 * should. Must be called before `initialize()` — the pool reads `extra` when it is built.
 */
export function withoutStatementTimeout(): void {
  AppDataSource.setOptions({
    extra: {
      ...(AppDataSource.options.extra as Record<string, unknown>),
      statement_timeout: 0,
      idle_in_transaction_session_timeout: 0,
    },
  });
}

export async function initializeDatabase(): Promise<void> {
  if (AppDataSource.isInitialized) return;
  await AppDataSource.initialize();
}

export async function closeDatabase(): Promise<void> {
  if (AppDataSource.isInitialized) {
    await AppDataSource.destroy();
  }
}
