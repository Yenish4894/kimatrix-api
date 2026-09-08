/**
 * Settings for companies an admin onboards directly, rather than self-signup.
 */

/**
 * How long an invite link stays valid.
 *
 * Deliberately not `PASSWORD_RESET_TTL_MIN`, which is 15 minutes. That is right for a
 * reset the user just asked for and is sitting waiting on; it is useless for an invite
 * sent to someone who does not yet know the account exists and may not check email
 * until tomorrow. The token row carries its own expiry, so a longer window here needs
 * no change to the confirm endpoint.
 */
export const INVITE_TTL_HOURS = 72;

/**
 * Default length of the complimentary period offered in the onboarding form.
 *
 * A year, and editable. Perpetual comp (`compedUntil = null`) is still supported by
 * `computeEntitlement` and an admin can switch to it later; the default is dated so
 * that free access resurfaces for a decision instead of quietly becoming permanent.
 */
export const DEFAULT_COMP_DAYS = 365;
