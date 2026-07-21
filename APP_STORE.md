# ADDY — App Store submission kit

Everything to copy-paste into App Store Connect the day the Apple developer
account is live. Pair with MOBILE.md for the build steps.

## App information

| Field | Value |
|---|---|
| App name | **ADDY Distribution** |
| Subtitle (30 chars max) | `Your DSD partner portal` |
| Bundle ID | `com.addy.distribution` (already in capacitor.config.json) |
| Primary category | Business |
| Secondary category | Productivity |
| Age rating | 4+ (no objectionable content) |
| Price | Free |
| Privacy policy URL | `https://<your-domain>/privacy.html` |
| Support URL | `https://<your-domain>/` |

## Promotional text (170 chars max)

> Run your distribution business from your pocket — orders, stores,
> commissions, and inventory, with instant notifications when something needs
> you.

## Description

> ADDY is the partner portal for ADDY Distribution — built for DSD
> (direct-store-delivery) partners who live on the road, not at a desk.
>
> ORDERS — Place and track orders in a few taps, with your negotiated
> pricing built in.
>
> YOUR STORES — Your assigned and exclusive stores in one place: territory,
> claims, and store photos.
>
> COMMISSIONS — Watch your commission balance grow in real time and request
> payouts right from the app.
>
> INVENTORY — See product levels across your stores so you restock before
> the shelf goes empty.
>
> NOTIFICATIONS — Order updates and messages from HQ arrive as push
> notifications, so nothing waits until you're back at a laptop.
>
> An ADDY partner account is required to sign in.

## Keywords (100 chars max, comma-separated)

`DSD,distribution,wholesale,orders,inventory,commission,delivery,sales rep,route,B2B`

## App Review notes (paste into "Notes" + demo account fields)

> ADDY is a private business tool for our distribution partners; accounts
> are created by our team, so we've provided a demo login below. Sign in on
> the login screen, then the dashboard shows stores, orders, commissions and
> inventory. Push notifications are used for order updates and messages from
> the admin team.
>
> Demo account: `REVIEWER-EMAIL-HERE` / `REVIEWER-PASSWORD-HERE`

**Before submitting: create a real demo DSD account with a few stores and
orders in it so the reviewer sees a working app, then fill it in above.**

## Screenshots (required sizes)

Take these from the iOS Simulator once the app builds (Xcode → Simulator →
`Cmd+S`), signed in as the demo account so real data shows:

- 6.9" (iPhone 16 Pro Max, 1320×2868) — required
- 6.5" (iPhone 15 Plus, 1284×2778 or 1242×2688) — required
- Suggested shots: dashboard overview, an order screen, commissions tab,
  the shop, a push notification on the lock screen.

## Assets already in this repo

- `resources/icon.png` — 1024×1024 App Store icon (opaque, no alpha — as
  Apple requires; corners square, Apple applies its own mask).
- `resources/splash.png` / `resources/splash-dark.png` — 2732×2732 universal
  splash screens.
- Run `npx @capacitor/assets generate --ios` after `npx cap add ios` and
  every icon/splash size is produced automatically from these.
