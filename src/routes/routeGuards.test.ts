import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Which guard sits on which route, pinned.
 *
 * Paywall and admin protection are attached route by route, so whether a route is
 * protected depends on its position in the file and on each route remembering its
 * guard. A new company route that forgets `requireActiveSubscription` is free access;
 * an export route that gains it holds a lapsed customer's data hostage. Nothing tested
 * either, so this reads the route files and fails on both.
 *
 * Deliberately static (source text, not an imported router): importing the routers
 * pulls in controllers, services and the Redis-backed queues, which a unit test
 * shouldn't need to start.
 */
function source(file: string): string {
  return readFileSync(path.join(process.cwd(), "src", "routes", file), "utf8");
}

interface RouteDecl {
  key: string;
  args: string;
  index: number;
}

function routes(src: string): RouteDecl[] {
  const out: RouteDecl[] = [];
  const re = /router\.(get|post|put|patch|delete)\(\s*"([^"]+)"([\s\S]*?)\);/g;
  for (const m of src.matchAll(re)) {
    out.push({ key: `${m[1]!.toUpperCase()} ${m[2]}`, args: m[3]!, index: m.index ?? 0 });
  }
  return out;
}

describe("company routes", () => {
  const src = source("company.route.ts");
  const all = routes(src);

  // Reachable whatever the subscription state: the profile, the QR off switch (pausing
  // grants nothing, and a lapsed company must be able to stop its poster), and payment
  // history with its invoices (receipts for money already paid grant nothing either).
  const OPEN = new Set([
    "GET /profile",
    "PUT /profile",
    "PATCH /qr/paused",
    // Killing a leaked code grants nothing either, and must work after a plan lapses.
    "POST /qr/regenerate",
    "GET /payments",
    "GET /payments/:paymentId/invoice.pdf",
  ]);
  // "Download your data and leave": must survive a lapsed plan, so it is gated on
  // canExport and must never pick up the paywall.
  const isExportLike = (key: string) =>
    /\s\/export\//.test(key) ||
    /\s\/reports\/[^/]+\.pdf$/.test(key) ||
    key.endsWith("/deletion-request");

  it("finds the routes (guards against the parser silently matching nothing)", () => {
    assert.ok(all.length >= 15, `only parsed ${all.length} routes`);
  });

  it("puts companyMiddleware in front of every route", () => {
    const use = src.indexOf("router.use(companyMiddleware)");
    assert.ok(use >= 0, "router.use(companyMiddleware) is missing");
    assert.ok(
      all.every((r) => r.index > use),
      "a route is declared before companyMiddleware",
    );
  });

  for (const r of all) {
    it(`${r.key} has the right guard`, () => {
      if (OPEN.has(r.key)) return;
      if (isExportLike(r.key)) {
        assert.match(r.args, /requireExportAllowed/, `${r.key} must be gated on canExport`);
        assert.doesNotMatch(
          r.args,
          /requireActiveSubscription/,
          `${r.key} must stay reachable after a plan lapses`,
        );
        return;
      }
      assert.match(r.args, /requireActiveSubscription/, `${r.key} is missing the paywall`);
    });
  }
});

describe("admin routes", () => {
  const src = source("admin.route.ts");
  const all = routes(src);

  it("requires super_admin before any route is declared", () => {
    const use = src.indexOf("router.use(superAdminMiddleware)");
    assert.ok(use >= 0, "router.use(superAdminMiddleware) is missing");
    assert.ok(all.length >= 20, `only parsed ${all.length} admin routes`);
    assert.ok(
      all.every((r) => r.index > use),
      "an admin route is declared before the guard",
    );
  });

  it("declares the payments ledger, invoices and system status behind that guard", () => {
    const keys = new Set(all.map((r) => r.key));
    for (const key of [
      "GET /system-status",
      "GET /payments",
      "GET /payments/:paymentId/invoice.pdf",
      "GET /audit-log",
      "GET /companies/:companyId/customers",
      "GET /companies/:companyId/purchases",
      "GET /companies/:companyId/draws",
      "POST /companies/:companyId/resend-invite",
    ]) {
      assert.ok(keys.has(key), `${key} is missing from admin.route.ts`);
    }
  });

  it("validates :companyId on every company-scoped route", () => {
    for (const r of all) {
      if (!r.key.includes(":companyId")) continue;
      assert.match(r.args, /companyIdParamSchema/, `${r.key} does not validate :companyId`);
    }
  });
});

describe("company purchase void", () => {
  const all = routes(source("company.route.ts"));
  it("is paywalled and validates both the id and the reason", () => {
    const r = all.find((x) => x.key === "POST /purchases/:purchaseId/void");
    assert.ok(r, "POST /purchases/:purchaseId/void is missing");
    assert.match(r.args, /requireActiveSubscription/);
    assert.match(r.args, /purchaseIdParamSchema/);
    assert.match(r.args, /voidPurchaseSchema/);
  });
});

describe("auth email-change routes", () => {
  const all = routes(source("auth.route.ts"));
  const find = (key: string) => {
    const r = all.find((x) => x.key === key);
    assert.ok(r, `${key} is missing from auth.route.ts`);
    return r;
  };

  it("request needs a session, a rate limit and a validated body", () => {
    const r = find("POST /email-change/request");
    assert.match(r.args, /authMiddleware/);
    assert.match(r.args, /emailChangeRequestLimiter/);
    assert.match(r.args, /emailChangeRequestSchema/);
  });

  it("confirm is public but rate-limited and validated", () => {
    const r = find("POST /email-change/confirm");
    assert.doesNotMatch(r.args, /authMiddleware/);
    assert.match(r.args, /emailChangeConfirmLimiter/);
    assert.match(r.args, /emailChangeConfirmSchema/);
  });
});

describe("payment routes", () => {
  const all = routes(source("payment.route.ts"));
  // Public on purpose: the price list, the add-on price, and PayPal's signed webhook.
  const PUBLIC = new Set(["GET /plans", "GET /spin-addon", "POST /paypal/webhook"]);

  it("requires a company for everything except the public endpoints", () => {
    assert.ok(all.length >= 9, `only parsed ${all.length} payment routes`);
    for (const r of all) {
      if (PUBLIC.has(r.key)) continue;
      assert.match(r.args, /companyMiddleware/, `${r.key} is missing companyMiddleware`);
    }
  });
});
