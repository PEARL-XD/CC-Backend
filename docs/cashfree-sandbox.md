# Cashfree sandbox rollout

This guide covers the isolated **authenticated payment test API**, not real
customer checkout. For the new production checkout, see [cashfree-production.md](cashfree-production.md).
Older clients keep the same Razorpay/COD contracts. Do not remove Razorpay settings.

## Configuration

Set these privately in the backend `.env` and in each Render backend service:

```dotenv
CASHFREE_APP_ID=<sandbox Payment Gateway App ID>
CASHFREE_SECRET_KEY=<sandbox Payment Gateway secret>
CASHFREE_ENV=sandbox
```

Use Payment Gateway credentials, not Payouts credentials. No secret belongs in
Flutter, React/Vite variables, Git, logs, or chat. Missing credentials disable
only Cashfree tests. Setting `CASHFREE_ENV=production` also disables these test
routes. Production checkout is a separate explicit client flow, not an upgrade
of these INR 1 sandbox test sessions.

The backend pins Cashfree API version `2026-01-01`, calls only
`https://sandbox.cashfree.com/pg`, and uses a 15-second request deadline.

## Test endpoints

Base path: `/api/payments/cashfree/sandbox`.
All except the signed webhook require the existing `Authorization: Bearer ...`
access token and an existing account. Regular users and admins may both test;
verification is restricted to the account that created the test. Guest requests
are rejected. Build flags hide the UI, but are not a security boundary: any
authenticated account can call these sandbox-only endpoints while configured.

| Method/path | Purpose |
| --- | --- |
| `GET /status` | Check configuration presence without exposing credentials. This does not test whether Cashfree accepts them. |
| `POST /orders` | Create a fixed INR 1 sandbox payment session. Body: `{ "requestId": "<UUID v4>" }`. |
| `POST /orders/:orderId/verify` | Fetch the order from Cashfree and report its verified status. |
| `POST /webhook` | Accept signed Cashfree callbacks and reconcile the sandbox order with Cashfree. |

Use a new UUID for a new test and **reuse the same UUID after any timeout or
failure**. The record and Cashfree idempotency key are preserved across retries,
restarts, and backend instances sharing the same MongoDB. The signed-in profile must
have a real mobile number. The backend does not generate placeholder numbers.
Client-supplied amounts, phone numbers, and payment-success flags are ignored.

A create response contains `orderId`, `paymentSessionId`, `amount`, `currency`,
`status`, `paid`, `provider`, `environment`, and `testOnly`. The Flutter test UI
passes the session to Cashfree's **sandbox** checkout SDK. Never treat opening
or closing checkout as payment confirmation; call the verify endpoint afterward.

For callbacks, configure the full HTTPS URL in Cashfree's **sandbox** dashboard:

```text
https://<your-backend-host>/api/payments/cashfree/sandbox/webhook
```

The webhook checks the HMAC signature against the exact raw JSON body, then
fetches the order from Cashfree. Only a matching order ID, amount and currency
can update the record. Repeated callbacks cannot downgrade a PAID test order.
Provider/network errors return a non-2xx response so callbacks can be retried.

All records are isolated in `cashfree_sandbox_orders`. They do not touch real
orders, stock, carts, coupons, accounts, customer notifications, admin order
reminders, or fulfillment. A sandbox PAID result is never a real purchase.

## Deployment and remaining work

Deploy the backend code and set the variables on both primary/fallback services.
No app-store or React release is required to keep current checkout working.
Already-published apps do not show Cashfree checkout. Updated Flutter debug
builds expose it in Profile and Payment options; release-mode internal builds
must opt in using `--dart-define=CASHFREE_SANDBOX=true`. Ordinary release builds
hide it. The test screen uses INR 1, not a cart total, and keeps the cart intact.
The updated React checkout uses the separate production flow, not this test API.

For production, follow cashfree-production.md, configure approved credentials and
webhooks, and deploy the updated clients. Keep older Razorpay apps and in-flight
Razorpay orders supported during the rollout. Sandbox success is not a real order.

## Automated verification

Run `node --test`. Cashfree tests mock the provider and database; they never use
local credentials, make charges, or connect to a live MongoDB instance.
These tests do not replace a real sandbox checkout or deployment smoke test.

References:
- https://www.cashfree.com/docs/api-reference/payments/latest/orders/create-order
- https://www.cashfree.com/docs/api-reference/payments/latest/orders/get-order
- https://www.cashfree.com/devstudio/preview/pg/tools/webhookVerification
