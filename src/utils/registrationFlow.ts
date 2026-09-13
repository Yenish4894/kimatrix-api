import { createHash } from "node:crypto";
import { renderRegistrationAttemptEmail } from "@/templates/registrationAttempt.template";

/**
 * Public company registration, without the account-enumeration oracle (audit SEC-2/3).
 *
 * The response is the same constant whether an account was created or the login email
 * already belonged to someone. The difference only ever reaches the mailbox: a new
 * address gets the verification link, an existing one gets a "someone tried to sign
 * up with your email" notice. Both are sent AFTER the response is decided and are not
 * awaited, so neither the queue write nor the Redis dedupe shows up in response time.
 *
 * Kept free of the database, Redis and BullMQ so the rules are unit-testable;
 * AuthService supplies those as `deps`.
 */

/** The one and only success payload of POST /auth/register/company. */
export interface RegistrationAccepted {
  status: "check_email";
}

export const REGISTRATION_ACCEPTED: Readonly<RegistrationAccepted> = Object.freeze({
  status: "check_email",
});

export interface ExistingAccount {
  id: string;
  email: string;
  isActive: boolean;
  userType: string;
}

export interface RegistrationFlowDeps<Tx> {
  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Throws a conflict for the username and the registration number — neither is
   * personal data. Must NOT look at the login email.
   */
  assertOtherIdentifiersFree(tx: Tx): Promise<void>;
  findAccountByEmail(tx?: Tx): Promise<ExistingAccount | null>;
  insertAccount(tx: Tx): Promise<{ userId: string }>;
  /** Issues and enqueues the verification link. Not awaited by the flow. */
  sendVerification(userId: string): Promise<void>;
  /** See sendRegistrationAttemptNotice. Not awaited by the flow. */
  notifyExistingAccount(account: ExistingAccount): Promise<void>;
  logError(err: unknown, message: string): void;
}

type Attempt =
  | { kind: "created"; userId: string }
  | { kind: "email_taken"; account: ExistingAccount };

export async function runRegistration<Tx>(
  deps: RegistrationFlowDeps<Tx>,
): Promise<RegistrationAccepted> {
  let attempt: Attempt;
  try {
    attempt = await deps.transaction(async (tx) => {
      // Together, not in sequence, and the other-identifier conflict always wins.
      //
      // Ordering is the leak to avoid. If a taken email short-circuited to the neutral
      // answer before the username check ran, a prober could submit a known-taken
      // username with the target address: "username taken" would then mean the address
      // is free, and the neutral answer that it is not. With the username/registration
      // number decided first, their answer is the same whatever the email is.
      const [account] = await Promise.all([
        deps.findAccountByEmail(tx),
        deps.assertOtherIdentifiersFree(tx),
      ]);
      if (account) return { kind: "email_taken", account } as const;
      return { kind: "created", ...(await deps.insertAccount(tx)) } as const;
    });
  } catch (err) {
    // Two registrations for the same address racing past the check: the loser's insert
    // hits users.email's unique constraint. Its transaction has rolled back, so it
    // created nothing — answer it exactly like any other taken address.
    if (!isEmailUniqueViolation(err)) throw err;
    const account = await deps.findAccountByEmail();
    if (!account) throw err;
    attempt = { kind: "email_taken", account };
  }

  if (attempt.kind === "created") {
    const { userId } = attempt;
    void deps.sendVerification(userId).catch((err: unknown) => {
      deps.logError(err, "Failed to send the verification email after registration");
    });
  } else {
    const { account } = attempt;
    void deps.notifyExistingAccount(account).catch((err: unknown) => {
      deps.logError(err, "Failed to send the registration-attempt notice");
    });
  }

  return { ...REGISTRATION_ACCEPTED };
}

/** Postgres names this constraint in the initial schema migration. */
const USERS_EMAIL_UNIQUE = "UQ_97672ac88f789774dd47f7c8be3";

export function isEmailUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; detail?: string; driverError?: unknown };
  const pg = (e?.code ? e : e?.driverError) as
    | { code?: string; constraint?: string; detail?: string }
    | undefined;
  if (pg?.code !== "23505") return false;
  if (pg.constraint === USERS_EMAIL_UNIQUE) return true;
  // Belt and braces should the constraint ever be renamed. `detail` is read, never logged.
  return typeof pg.detail === "string" && pg.detail.startsWith("Key (email)=");
}

// ── The notice to an existing account ─────────────────────────────────────────────

/** At most one notice per address in this window, however often the form is submitted. */
export const REGISTRATION_NOTICE_TTL_SECONDS = 60 * 60;

/**
 * Redis key for the dedupe marker. Hashed so Redis holds no copy of the address.
 * No colons in the variable part; the prefix follows the other app keys.
 */
export function registrationNoticeKey(email: string): string {
  const digest = createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
  return `reg-attempt-notice:${digest}`;
}

export interface RegistrationNoticeDeps {
  /** SET key NX EX ttl. True only for the caller that created the key. */
  claimOnce(key: string, ttlSeconds: number): Promise<boolean>;
  release(key: string): Promise<void>;
  enqueue(to: string, rendered: { subject: string; html: string; text: string }): Promise<void>;
  frontendBaseUrl: string;
}

export type RegistrationNoticeOutcome = "sent" | "deduped" | "skipped";

/**
 * Tell an existing account that someone tried to register with its address.
 *
 * Only active company owners. A deactivated/deleted account can't log in, so the
 * links would be wrong; and the platform admin address is not a real mailbox, so
 * mail to it only bounces — bounces are what got the sending mailbox suspended.
 *
 * Deduped per address for an hour, so the registration form can't be used to flood a
 * stranger's inbox or run up our bounce rate. A Redis failure fails CLOSED (no mail):
 * a missed courtesy notice is harmless, an unthrottled one is not.
 */
export async function sendRegistrationAttemptNotice(
  account: ExistingAccount,
  deps: RegistrationNoticeDeps,
): Promise<RegistrationNoticeOutcome> {
  if (!account.isActive || account.userType !== "company") return "skipped";

  const key = registrationNoticeKey(account.email);
  if (!(await deps.claimOnce(key, REGISTRATION_NOTICE_TTL_SECONDS))) return "deduped";

  const base = deps.frontendBaseUrl.replace(/\/$/, "");
  const rendered = renderRegistrationAttemptEmail({
    loginUrl: `${base}/login`,
    resetUrl: `${base}/forgot-password`,
  });
  try {
    await deps.enqueue(account.email, rendered);
  } catch (err) {
    // Nothing was sent, so don't hold the window shut against the next genuine attempt.
    await deps.release(key).catch(() => undefined);
    throw err;
  }
  return "sent";
}
