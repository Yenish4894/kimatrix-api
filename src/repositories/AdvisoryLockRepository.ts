import type { EntityManager, QueryRunner } from "typeorm";

/**
 * Postgres advisory locks, as used by the crons and the QR submission path.
 *
 * Two kinds, and they are not interchangeable:
 *
 *  - **Session locks** (`trySessionLock` / `sessionUnlock`) must be taken and released
 *    on the SAME connection, so they take a pinned `QueryRunner`, never the pool. Lock
 *    and unlock through the pool can land on different connections and leak the lock.
 *  - **Transaction locks** (`tryXactLock*`, `xactLockHashedPair`) are released on commit
 *    or rollback, so they take the caller's transaction `manager`.
 *
 * Each statement is an exported constant so it can be read and EXPLAINed on its own.
 */

/** $1 = lock key. Returns one row `{ locked }`. */
export const TRY_SESSION_LOCK_SQL = `SELECT pg_try_advisory_lock($1) AS locked`;
/** $1 = lock key. */
export const SESSION_UNLOCK_SQL = `SELECT pg_advisory_unlock($1)`;
/** $1 = lock key. Returns one row `{ locked }`. */
export const TRY_XACT_LOCK_SQL = "SELECT pg_try_advisory_xact_lock($1) AS locked";
/** $1, $2 = the two-int lock key. Returns one row `{ locked }`. */
export const TRY_XACT_LOCK_PAIR_SQL = "SELECT pg_try_advisory_xact_lock($1, $2) AS locked";
/** $1 = namespace, $2 = value; both hashed to the two-int key. Blocks until granted. */
export const XACT_LOCK_HASHED_PAIR_SQL = `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`;

export class AdvisoryLockRepository {
  /** Session-level try-lock on a pinned connection. */
  async trySessionLock(runner: QueryRunner, key: number): Promise<boolean> {
    const [{ locked }] = (await runner.query(TRY_SESSION_LOCK_SQL, [key])) as [{ locked: boolean }];
    return locked;
  }

  /** Releases a session lock. Must be the runner that took it. */
  async sessionUnlock(runner: QueryRunner, key: number): Promise<void> {
    await runner.query(SESSION_UNLOCK_SQL, [key]);
  }

  /** Transaction-scoped try-lock in the caller's transaction. */
  async tryXactLock(manager: EntityManager, key: number): Promise<boolean> {
    const [{ locked }] = (await manager.query(TRY_XACT_LOCK_SQL, [key])) as [{ locked: boolean }];
    return locked;
  }

  /** Transaction-scoped try-lock on a two-int key, in the caller's transaction. */
  async tryXactLockPair(manager: EntityManager, key1: number, key2: number): Promise<boolean> {
    const [{ locked }] = (await manager.query(TRY_XACT_LOCK_PAIR_SQL, [key1, key2])) as [
      { locked: boolean },
    ];
    return locked;
  }

  /** Blocking transaction-scoped lock on `hashtext(namespace), hashtext(value)`. */
  async xactLockHashedPair(
    manager: EntityManager,
    namespace: string,
    value: string,
  ): Promise<void> {
    await manager.query(XACT_LOCK_HASHED_PAIR_SQL, [namespace, value]);
  }
}
