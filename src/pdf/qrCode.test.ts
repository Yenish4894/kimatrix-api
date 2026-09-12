import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildQrCodePdf, qrPngDataUrl } from "@/pdf/qrCode";

describe("QR code PDF", () => {
  it("renders the qrcode package's output as a PNG data URL (ESM default import works)", async () => {
    const url = await qrPngDataUrl("https://kimates.com/qr/abc123");
    assert.match(url, /^data:image\/png;base64,/);
  });

  it("produces a real PDF, even for a company name jsPDF cannot encode", async () => {
    const { filename, body } = await buildQrCodePdf(
      "Łódź Fuel & Go — 加油站",
      "https://kimates.com/qr/abc123",
    );
    assert.equal(filename, "kimates-qr-code.pdf");
    assert.equal(body.subarray(0, 5).toString("latin1"), "%PDF-");
    assert.ok(body.length > 5_000, "suspiciously small; the QR image is probably missing");
  });
});
