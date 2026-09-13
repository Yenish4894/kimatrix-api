import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TURNSTILE_VERIFY_URL, verifyTurnstileToken, type TurnstileFetch } from "./turnstile";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("verifyTurnstileToken", () => {
  it("posts secret, response and remoteip to siteverify", async () => {
    let seenUrl = "";
    let seenBody = new URLSearchParams();
    const fetchImpl: TurnstileFetch = async (url, init) => {
      seenUrl = url;
      seenBody = init.body as URLSearchParams;
      return json({ success: true });
    };
    const verdict = await verifyTurnstileToken("tok", "198.51.100.4", "sekret", fetchImpl);
    assert.deepEqual(verdict, { ok: true });
    assert.equal(seenUrl, TURNSTILE_VERIFY_URL);
    assert.equal(seenBody.get("secret"), "sekret");
    assert.equal(seenBody.get("response"), "tok");
    assert.equal(seenBody.get("remoteip"), "198.51.100.4");
  });

  it("omits remoteip when the IP is unknown", async () => {
    let seenBody = new URLSearchParams();
    await verifyTurnstileToken("tok", undefined, "s", async (_url, init) => {
      seenBody = init.body as URLSearchParams;
      return json({ success: true });
    });
    assert.equal(seenBody.has("remoteip"), false);
  });

  it("reports a failed challenge as rejected, with Cloudflare's codes", async () => {
    const verdict = await verifyTurnstileToken("tok", undefined, "s", async () =>
      json({ success: false, "error-codes": ["invalid-input-response"] }),
    );
    assert.deepEqual(verdict, {
      ok: false,
      reason: "rejected",
      errorCodes: ["invalid-input-response"],
    });
  });

  it("reports a network failure or timeout as unreachable", async () => {
    const verdict = await verifyTurnstileToken("tok", undefined, "s", async () => {
      throw new DOMException("aborted", "AbortError");
    });
    assert.equal(!verdict.ok && verdict.reason, "unreachable");
  });

  it("reports a non-2xx response as unreachable", async () => {
    const verdict = await verifyTurnstileToken("tok", undefined, "s", async () => json({}, 503));
    assert.deepEqual(verdict, { ok: false, reason: "unreachable", errorCodes: ["http_503"] });
  });

  it("reports Cloudflare's internal-error as unreachable, not as a bot", async () => {
    const verdict = await verifyTurnstileToken("tok", undefined, "s", async () =>
      json({ success: false, "error-codes": ["internal-error"] }),
    );
    assert.equal(!verdict.ok && verdict.reason, "unreachable");
  });
});
