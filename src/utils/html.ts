/**
 * Escape text for interpolation into an HTML email body.
 *
 * This existed as a private copy in three separate templates. The bulk-email body —
 * the one piece of email HTML built from free text an admin types — had no escaping
 * at all, so an ampersand in "Terms & Conditions" or a "<" in "under <500" would
 * corrupt the markup of a message going out to every company on the platform.
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
