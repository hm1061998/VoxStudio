# 0010 — Optional billing by bank transfer, with a payment gateway left open

- Status: accepted (owner decision, 2026-11-01: sell to Vietnamese users, build everything that does not need a provider account, leave a gateway for later)
- Date/owner: 2026-11-01, product owner; recorded by the VoxStudio coding agent
- Extends ADR 0009 (plans were assigned by an administrator only)

## Context

Plans (free, pro, business) set limits but nobody can buy one. The owner sells only in Vietnam and has not registered with any payment provider yet. Vietnamese users commonly pay by bank transfer with a QR code. Providers that confirm such transfers automatically (for example payOS or SePay) call a webhook; their account terms, fees and exact payloads are not known yet. `AGENTS.md` forbids a mandatory external runtime API.

## Decision

1. **Billing is optional and off by default.** It is enabled only when `PLAN_PRICES_VND_JSON` is set (a price per month for each paid plan). Without it the product behaves exactly as before: administrators assign plans.
2. **Plans get an expiry.** `workspaces.plan_expires_at` (null = no expiry, used for plans assigned by an administrator without a date). The plan in force is computed on every read: a paid plan past its expiry counts as `free`. Nothing is deleted when a plan lapses; existing audio stays, and new jobs are limited by the free allowances.
3. **Orders.** A user creates an order for a paid plan and 1, 3, 6 or 12 months. The order has a unique payment code (`VOX` plus 8 letters or digits) that the payer writes in the transfer note, an amount in VND, and a status: `pending`, `paid`, `review`, `cancelled`, `expired`. The amount is fixed when the order is created (later price changes do not affect it).
4. **Confirmation.** Either an administrator confirms an order by hand, or a provider calls the webhook. Both paths use the same function, which is idempotent and writes an audit event.
5. **Provider gateway.** `POST /api/v1/payments/webhook/:provider` is public (no session, no CSRF) and authenticated by a shared secret that is compared in constant time. A provider is a small adapter that checks the secret and turns the provider's payload into one normalized event (event id, direction, amount, transfer note). The only adapter shipped is `generic`, a normalized JSON format used by tests and by any bridge the owner writes. **Adapters for payOS or SePay are not written**: their payloads were not verified, and adding one means one adapter file plus a registry entry. Every event is stored once (unique provider and event id) so a repeated delivery changes nothing.
6. **Safety rules.** A payment code that matches no order is stored as unmatched and shown to administrators; it never changes a plan. An amount below the order amount puts the order in `review` (no plan change). If the workspace already has an active paid plan that differs from the order's plan, the order goes to `review` instead of silently replacing it. An overpayment is accepted and recorded. A late payment for an expired order is accepted (money was received). Same plan and still active: the period is added to the current expiry.
7. **No card data, no payment API call from the server.** The application only receives webhooks and shows bank details; it never holds card numbers and calls no outside service.

## Alternatives

Card gateway with hosted checkout (needs a business account and does not match how the target users pay); writing the payOS or SePay adapter now (would be unverified code against an unknown payload); expiring plans with a background job (a read-time rule cannot miss a run and needs no worker).

## Consequences

- Until a provider is connected, payments are confirmed by hand by an administrator who sees the bank statement.
- Receipts and electronic invoices (hóa đơn điện tử) are not produced. Tax and invoicing duties must be settled with an accountant before selling.
- The VietQR image is not generated yet; the page shows bank, account, holder, amount and code.
- Verified only with fake events in tests; nothing has been tested with real money or a real provider.

## Security/license/performance impact

The webhook is an unauthenticated entry point protected by a shared secret, rate limiting and strict payload validation; the secret is read from the environment and never logged. No new dependency.
