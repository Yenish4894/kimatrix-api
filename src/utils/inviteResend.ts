/**
 * Whether an admin may re-send a company's set-password invite, and if not, why.
 *
 * Pure so the rule is testable without a database. The order is the contract the
 * admin frontend relies on (it hides the button unless `createdByAdmin`):
 *
 *  1. Self-registered → 400. It never had an invite, and a set-password link would
 *     verify the address through confirmPasswordReset, which does not start the free
 *     trial that confirmEmailVerification would.
 *  2. Admin-created but the owner already verified → 409. Setting a password from the
 *     invite verifies the email, so the invite has done its job.
 */
export type InviteResendBlock = { status: 400 | 409; message: string } | null;

export function inviteResendBlock(input: {
  createdByAdmin: boolean;
  ownerEmailVerified: boolean;
}): InviteResendBlock {
  if (!input.createdByAdmin) {
    return {
      status: 400,
      message:
        "This company signed up by itself, so it has no invite to resend. The owner can resend the verification email from their dashboard.",
    };
  }
  if (input.ownerEmailVerified) {
    return {
      status: 409,
      message:
        "The owner has already set up their account, so there is no invite to resend. They can use Forgot password on the sign-in page.",
    };
  }
  return null;
}
