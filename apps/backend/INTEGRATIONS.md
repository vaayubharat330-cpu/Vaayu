# Optional provider integrations

The local demo remains usable without external credentials. Configure provider secrets in the environment or a secret manager; do not commit them.

## Payments and refunds

Set `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`. `POST /api/payment/create-order` creates a Razorpay order; `POST /api/payment/verify-signature` verifies the provider HMAC and confirms the captured payment amount and currency before the local transaction becomes paid. Cancellation attempts a refund only when a captured payment is linked to the booking. RazorpayX disbursements are disabled by default. After enabling the account and payout controls, set `VAAYU_ENABLE_RAZORPAYX_PAYOUTS=true` and `RAZORPAYX_ACCOUNT_NUMBER`. An Admin's explicit **Approve for processing** action then submits a real UPI transfer using an idempotency key. Amount is capped at ₹10,000 per transfer. Provider acceptance is recorded separately from final settlement; signed RazorpayX payout webhooks update final status. **Keep live transfers disabled until a durable, audited driver earnings/payout ledger exists**; the current local payout table records requests and provider references but cannot independently establish withdrawable balance. Test this in RazorpayX test mode before enabling a live account.

## Driver document OCR

Set `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` and `AZURE_DOCUMENT_INTELLIGENCE_KEY`. Image uploads are sent to the Azure Document Intelligence `prebuilt-read` model. Extracted text is stored with the private document record; OCR never approves KYC. An OCR failure or timeout leaves the document for manual review.

## Campaign messaging

Set `MESSAGING_PROVIDER_WEBHOOK_URL` to an HTTPS endpoint and `MESSAGING_PROVIDER_WEBHOOK_SECRET` to a random secret of at least 32 characters. The endpoint receives a `vaayu.broadcast.requested` JSON event with the campaign ID as both its idempotency key and `Idempotency-Key` header. Verify `X-Vaayu-Signature` as the hex HMAC-SHA256 of `<X-Vaayu-Timestamp>.<raw request body>`. Successful HTTP acceptance means only that the provider accepted the request, not that a recipient received it. SMS, WhatsApp, email, and push channels can be routed by this provider endpoint.

## OTP delivery

The existing OTP adapter uses `OTP_DELIVERY_WEBHOOK_URL` over HTTPS and `OTP_DELIVERY_WEBHOOK_SECRET`. Its `X-VAAYU-Signature` is HMAC-SHA256 over the raw JSON body. In development without a webhook, OTPs are demo-delivered and may be returned to the local client; production rejects missing OTP configuration.

## Zones and rejection review

Zones without coordinates stay informational. Configure a circular geofence (center latitude/longitude and radius) to apply that zone's multiplier, toll fee, and pickup restriction. Driver rejection re-queues only trips in `DRIVER_ASSIGNED`; penalty outcomes are flagged for ledger reconciliation and do not debit a driver wallet.

## Cloud deployment status

Production deployment remains deliberately disabled in `src/server_production.js`. Although SQLite and a partial PostgreSQL repository exist, the broader admin, KYC, payment, and payout data methods still use the local state store and the project has no database migrations. Do not deploy this service to Azure Container Apps or another cloud runtime until the complete data model is migrated to a durable transactional adapter and verified against its schema. `GET /api/admin/integrations/status` exposes provider configuration without returning secrets.
