# ADDY on mobile

The portal is now a full PWA, and this repo carries the scaffold for a real
App Store / Play Store app when you're ready.

## Today: install as a PWA (zero extra work)

- **Android / desktop Chrome**: an "📲 Install ADDY" pill appears bottom-right
  (from `public/js/pwa.js`); tapping it opens the native install dialog.
- **iPhone**: Safari → Share → **Add to Home Screen** (the pill shows a
  one-time hint). Opens full-screen with the ADDY icon, no browser chrome.
- Works offline enough to open: `public/sw.js` caches the shell; `/api/*` is
  never cached, so live data stays live.
- Icons: `public/icon-192.png`, `public/icon-512.png`,
  `public/apple-touch-icon.png` — all rasterized from `public/favicon.svg`.
  Regenerate them if the logo changes.

## App Store: the full checklist

Everything below is prepped in this repo. The only prerequisites you must do
yourself: enroll at developer.apple.com ($99/yr, individual is fine — the app
is still named ADDY; only the fine-print "Seller" line shows your name), and
get access to a Mac with Xcode (or a cloud build service like Codemagic).

1. **Domain**: put your Railway URL in `capacitor.config.json` → `server.url`.
2. **Build** (on the Mac, in this repo):
   ```bash
   npm install @capacitor/core @capacitor/cli @capacitor/push-notifications
   npx cap add ios
   npx @capacitor/assets generate --ios   # icons+splash from resources/
   npx cap sync
   npx cap open ios
   ```
3. **Xcode**: select your team under Signing & Capabilities, add the Push
   Notifications capability, then Product → Archive → Distribute App.
4. **Listing**: copy everything from `APP_STORE.md` into App Store Connect
   (description, keywords, review notes). Create a demo DSD account for the
   reviewer first — they will log in.
5. **Push (APNs)**: in the Apple developer portal create an APNs key
   (Keys → +, enable Apple Push Notifications). Set on Railway:
   `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY` (the .p8 contents). The client
   side is already wired: inside the native app the bell button registers the
   device through `public/js/native-push.js` and the token lands in
   `push_subscriptions` shaped `{ native, token }`; `sendNativePush()` in
   server.js is the marked seam where APNs delivery plugs in.
6. Review usually takes 1–3 days. If Apple pushes back with guideline 4.2
   ("minimum functionality"), reply that it's a B2B tool for authenticated
   partners with native push — or switch the release to **unlisted
   distribution** (App Store link only your partners get), which fits this
   app perfectly.

`public/js/pwa.js` already detects `window.Capacitor` and suppresses the
browser install prompts inside the native app. Android/desktop web users
keep the one-tap PWA install — no Play Store needed.

## Rules the code already follows (keep it that way)

- No `/api` caching in the service worker — a stale order screen is worse
  than a spinner.
- Bump `VERSION` in `public/sw.js` whenever shell files change shape.
- Every page carries `viewport-fit=cover` + theme-color metas, so the app
  looks right behind notches and matches the brand in the task switcher.
