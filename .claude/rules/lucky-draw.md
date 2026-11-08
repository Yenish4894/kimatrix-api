# Lucky draw

Key files: `services/LuckyDrawService.ts`, `repositories/LuckyDrawRepository.ts`, `services/AdminCompService.ts`, entity `LuckyDraw`, migrations `1787198400000-spinPurchaseOnTrialAndComp`, `1787284800000-boughtSpinPools`.

## Periods and pools

A spin always belongs to a **period**. Entries are the company's non-voided purchases made inside that period; one purchase is one entry; a customer wins at most once per base period (`uq_lucky_draws_one_win_per_base_period`).

| Period key       | Source of free spins                   | Window                            |
| ---------------- | -------------------------------------- | --------------------------------- |
| paid plan window | none (plans include no spins)          | the plan's access window          |
| `trial:<ms>`     | `trial_draw_spins` app setting         | trial start to trial end          |
| `comp:<ms>`      | per-company comp grant                 | `compSpinWindowStart` to comp end |
| `buy:<key>`      | purchased spins for the period `<key>` | same as the base period           |

`FREE_PERIODS_SQL`, `freeDrawPeriod`, `freeDrawPeriodOpen` and `activePeriods` in the repository are the single source of these rules. `ELIGIBLE_WHERE` strips the `buy:` prefix so bought spins draw from the same entries as the base period.

## Why bought spins have their own pool

Paid spins used to be added to the free count. When the admin lowered the trial-spin setting, the subtraction ate spins a company had paid for. Bought spins now live in `buy:<key>`; free spins are used first, then bought ones.

## Who can buy spins

`LuckyDrawService.spinPurchaseOption(companyId)` is the only rule, returned to the frontend as `canBuySpins` on `GET /company/draws`:

- `paid` mode: during a USD paid plan, any time.
- `free` mode: on a trial or comp, **only after the free spins are used up**, until that period ends.
- `none` with a reason: `inactive`, `non_usd_plan`, `spins_left`.

Price is the admin setting (default 3.00 USD), 1 to 100 per order, repeatable. See `payments-paypal.md` for the order itself.

## Admin comps

`AdminCompService.compSpinWindowStart(company, grantingComp, now)`: a re-grant keeps the earlier window start so purchases made since the first grant stay eligible. Legacy comps were backfilled from the first grant after the last revoke.

## Winner selection

`LuckyDrawService.spin()` picks with `crypto.randomInt` over eligible entries in one transaction with an advisory lock, writes the `lucky_draws` row (with name and masked-mobile snapshots so it survives the purge), and decrements the right pool. The frontend only animates to the winner it is given.

## Frontend contract

`GET /company/draws` returns spins left per pool, `canBuySpins`, the period, and recent winners. The wheel spins for 15 s client-side; nothing about the outcome is decided there.
