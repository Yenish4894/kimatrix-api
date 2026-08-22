/**
 * Currency formatting for PDF output.
 *
 * jsPDF's built-in Helvetica is a WinAnsi font. Hand it one character outside that set
 * and it silently switches the whole string to UTF-16 against a font with no such
 * encoding — the amount comes out as a wrong glyph followed by null-byte-separated
 * digits. "₣" (U+20A3) is the CFA franc, so every Total Spend in the platform's
 * primary market rendered unreadable until this was added on the frontend.
 *
 * Kept in step with the frontend module of the same name; a test asserts every country
 * the platform knows about survives the encoding.
 */

const COUNTRY_CURRENCY: Record<string, string> = {
  "South Africa": "R",
  Nigeria: "₦",
  Kenya: "KSh",
  Ghana: "GH₵",
  Ethiopia: "Br",
  Tanzania: "TSh",
  Uganda: "USh",
  Rwanda: "FRw",
  Zambia: "ZK",
  Zimbabwe: "Z$",
  Botswana: "P",
  Namibia: "N$",
  Mozambique: "MT",
  Angola: "Kz",
  Senegal: "₣",
  Niger: "₣",
  Mali: "₣",
  "Burkina Faso": "₣",
  "Ivory Coast": "₣",
  Cameroon: "₣",
  Egypt: "E£",
  Morocco: "MAD",
  Tunisia: "DT",
  Algeria: "DA",
  "United States": "$",
  Canada: "CA$",
  Mexico: "$",
  Brazil: "R$",
  Argentina: "$",
  Colombia: "$",
  Chile: "$",
  Peru: "S/",
  "United Kingdom": "£",
  Germany: "€",
  France: "€",
  Italy: "€",
  Spain: "€",
  Netherlands: "€",
  Belgium: "€",
  Portugal: "€",
  Sweden: "kr",
  Norway: "kr",
  Denmark: "kr",
  Switzerland: "Fr",
  Poland: "zł",
  Turkey: "₺",
  India: "₹",
  China: "¥",
  Japan: "¥",
  "South Korea": "₩",
  Singapore: "S$",
  Malaysia: "RM",
  Indonesia: "Rp",
  Thailand: "฿",
  Philippines: "₱",
  Vietnam: "₫",
  Bangladesh: "৳",
  Pakistan: "₨",
  "Sri Lanka": "Rs",
  Myanmar: "K",
  "United Arab Emirates": "AED",
  "Saudi Arabia": "SAR",
  Qatar: "QR",
  Kuwait: "KD",
  Israel: "₪",
  Australia: "A$",
  "New Zealand": "NZ$",
};

/** ASCII stand-ins for the symbols a WinAnsi font cannot encode. */
const PDF_SYMBOL_OVERRIDES: Record<string, string> = {
  "₣": "FCFA", // XOF / XAF — what people in West Africa actually write
  "₦": "NGN",
  "GH₵": "GHS",
  "₹": "INR",
  "₩": "KRW",
  "฿": "THB",
  "₱": "PHP",
  "₫": "VND",
  "৳": "BDT",
  "₨": "PKR",
  "₪": "ILS",
  "₺": "TRY",
  zł: "PLN",
};

/** CP1252: printable ASCII, Latin-1, and the 0x80–0x9F typographic block. */
const CP1252_EXTRAS = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ" + "‘’“”•–—˜™š›œžŸ";

export function isPdfSafe(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x20 && code <= 0x7e) continue;
    if (code >= 0xa0 && code <= 0xff) continue;
    if (CP1252_EXTRAS.includes(ch)) continue;
    return false;
  }
  return true;
}

export function pdfCurrencySymbol(country: string): string {
  const symbol = COUNTRY_CURRENCY[country] ?? "$";
  const mapped = PDF_SYMBOL_OVERRIDES[symbol] ?? symbol;
  // A symbol that is still unencodable would corrupt the amount beside it. A number
  // with no symbol is readable; a number of null bytes is not.
  return isPdfSafe(mapped) ? mapped : "";
}

export function formatPdfCurrency(
  amount: string | number | null | undefined,
  country = "",
): string {
  const symbol = pdfCurrencySymbol(country);
  const num = typeof amount === "string" ? Number.parseFloat(amount) : amount;
  const value =
    typeof num !== "number" || !Number.isFinite(num)
      ? "0.00"
      : num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return symbol ? `${symbol} ${value}` : value;
}

export const KNOWN_COUNTRIES = Object.keys(COUNTRY_CURRENCY);
