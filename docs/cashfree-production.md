# Production Cashfree rollout

New Flutter and React checkout explicitly request Cashfree for ONLINE orders.
Older clients that omit paymentProvider still use Razorpay. COD and existing
Razorpay verification/refunds remain supported. Keep Razorpay credentials active.
No bulk account/address migration is required.

## Before deploying clients

1. Deploy this backend to BOTH Render services (primary and fallback).
2. Set the following privately on both services, using the approved **production
   Payment Gateway** credentials from Cashfree, not sandbox or Payouts credentials:

   ```dotenv
   CASHFREE_APP_ID=<production Payment Gateway App ID>
   CASHFREE_SECRET_KEY=<matching production Payment Gateway secret>
   CASHFREE_ENV=production
   ```

3. Both services must use the same MongoDB, Cashfree credentials and existing
   authentication configuration. Restart/redeploy after environment changes.
   A local .env does not configure Render, or vice versa. Never put the secret in
   Flutter, Vite, Git, logs or chat. Do not remove Razorpay environment variables.
4. In Cashfree's production dashboard, configure payment and refund webhooks to:

   `https://cc-backend-xpau.onrender.com/api/payments/cashfree/webhook`

   The fallback exposes the same path on cc-backend-veyp.onrender.com. If another
   endpoint is configured, repeated deliveries are safe. Verify deliveries in
   the dashboard; a GET request to this POST-only URL is not a webhook test.
5. Whitelist the deployed website https://cleanchops.in in Cashfree's production
   dashboard before React testing. Add any other actual checkout domain too.
6. Deploy the updated React build and distribute the new Flutter build for testing.
   A backend deploy alone cannot add Cashfree to old app binaries.

## Payment guarantees and limits

- Amounts, cart items, coupons, real phone numbers and delivery addresses are
  checked by the existing server checkout rules. Legacy addresses still work.
- The backend alone verifies payment against Cashfree's order ID, INR currency
  and full stored total. SDK success and webhook body claims cannot mark it paid.
- A per-user request UUID and deterministic provider order ID preserve the same
  order across retries, timeouts and multiple backend instances. Do not generate
  a new request ID just because a response was lost.
- Verified payment atomically confirms the order and invokes existing customer
  and admin notifications. Notification delivery is best-effort, as before.
- Cancellation is allowed before packing. A late payment never reopens a
  cancelled order: a full refund is requested using one stable refund reference.
- Refund status is visible in order history/admin. PENDING_APPROVAL and ONHOLD
  continue reconciling. REJECTED, FAILED and CANCELLED refunds require attention
  in the Cashfree dashboard; the app does not claim those are successful refunds
  or automatically issue a second refund. Review pending refunds operationally.
- Signed webhooks reconcile even when customers close checkout. A once-per-minute
  worker also reconciles up to 20 outstanding orders. It runs only while the
  service is awake: a sleeping/free service is not an always-on worker. Configure
  webhooks and monitor failures; app-open verification is not enough by itself.
- Live requests use https://api.cashfree.com/pg and API version 2026-01-01.
  Sandbox routes remain isolated and are disabled by production configuration.

## Acceptance tests before public rollout

Use a normal customer account with a real mobile number and valid delivery
address. Real checkout charges the actual cart total, not the sandbox INR 1 test.
Have the merchant perform the transactions; automated tests never charge money.

1. Complete one real payment on Android, iOS and the website. Confirm the amount,
   exactly one order, PAID/CONFIRMED status, cart refresh and admin notification.
2. Close payment without paying, then continue the same order from My Orders.
3. Interrupt the connection after payment and reopen/check status. Confirm no
   second order/charge and verify webhook delivery in the dashboard.
4. Cancel an eligible paid order. Check refund processing through to SUCCESS in
   both Cashfree and order history. Bank credit can take longer.
5. Check an old published app: Razorpay and COD must still work; old saved
   addresses must remain intact. Recheck normal profile/login and serviceability.
6. Use an iOS TestFlight build and an Android internal-test release; Windows
   build/tests cannot validate iOS native checkout or production UPI app handoffs.
   Install Android production tests through Google Play. Cashfree Integrity can
   reject both debug APKs and locally installed release APKs before checkout opens.
   See https://www.cashfree.com/docs/payments/online/mobile/misc/cashfree_integrity_prod_testing.

## Automated checks

`node --test` uses fake credentials and mocked database/provider calls, including
real Express router and Mongoose schema checks. It does not connect to production
MongoDB, validate live credentials, deploy to Render or replace real-device tests.

References:
- https://www.cashfree.com/docs/payments/online/mobile/flutter
- https://www.cashfree.com/docs/payments/online/web/redirect
- https://www.cashfree.com/docs/api-reference/payments/latest/refunds/get-refund
