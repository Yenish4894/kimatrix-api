import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAllowedOrigins } from "@/utils/origins";

describe("buildAllowedOrigins", () => {
  it("accepts the www form alongside the apex", () => {
    // The exact production value, and the exact bug: a visitor on www.kimates.com was
    // refused by CORS and could not log in at all.
    assert.deepEqual(buildAllowedOrigins("https://kimates.com"), [
      "https://kimates.com",
      "https://www.kimates.com",
    ]);
  });

  it("accepts the apex when configured the other way round", () => {
    assert.deepEqual(buildAllowedOrigins("https://www.kimates.com"), [
      "https://www.kimates.com",
      "https://kimates.com",
    ]);
  });

  it("keeps the port, so local development still matches", () => {
    assert.deepEqual(buildAllowedOrigins("http://localhost:5173"), [
      "http://localhost:5173",
      "http://www.localhost:5173",
    ]);
  });

  it("drops a trailing path — an Origin header is scheme + host only", () => {
    // A browser never sends a path in Origin, so a configured trailing slash must not
    // leak into the allowlist or nothing would ever match.
    assert.deepEqual(buildAllowedOrigins("https://kimates.com/"), [
      "https://kimates.com",
      "https://www.kimates.com",
    ]);
  });

  it("does not lock everyone out when the env var is malformed", () => {
    // Failing closed here would take the whole site down over a typo.
    assert.deepEqual(buildAllowedOrigins("not a url"), ["not a url"]);
  });
});
