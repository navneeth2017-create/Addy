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

## Later: wrap it as a native app (Capacitor)

The architecture is a thin native shell loading the live site — the server
keeps doing everything, so the mobile app never lags behind the web app.

1. Fill in the real domain in `capacitor.config.json` → `server.url`
   (your Railway URL, e.g. `https://addy.up.railway.app`).
2. On a machine with Xcode / Android Studio:
   ```bash
   npm install @capacitor/core @capacitor/cli
   npx cap add ios && npx cap add android
   npx cap sync
   npx cap open ios      # or: npx cap open android
   ```
3. `public/js/pwa.js` already detects `window.Capacitor` and suppresses the
   browser install prompts inside the native app.
4. Push notifications: the web-push flow (`sw.js` + `/api/push/*`) works in
   the Android wrap as-is. iOS needs APNs via `@capacitor/push-notifications`
   — swap the subscribe call behind the same bell button when you get there.

## Rules the code already follows (keep it that way)

- No `/api` caching in the service worker — a stale order screen is worse
  than a spinner.
- Bump `VERSION` in `public/sw.js` whenever shell files change shape.
- Every page carries `viewport-fit=cover` + theme-color metas, so the app
  looks right behind notches and matches the brand in the task switcher.
