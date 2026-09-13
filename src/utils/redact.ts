/**
 * The domain of an email address, for logs that must not hold the address itself.
 *
 * Unauthenticated endpoints log what they were asked about. Logging the full address
 * turned the log into a list of every email anyone ever typed into the reset form —
 * customers and strangers alike. The domain keeps the useful signal (one domain being
 * hammered) without keeping anyone's address.
 */
export function emailDomainForLog(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return "(invalid)";
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .slice(0, 255);
}
