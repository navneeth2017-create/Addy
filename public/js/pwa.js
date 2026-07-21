/**
 * ADDY PWA bootstrap — included on every page.
 *
 * 1. Registers the service worker (harmless if app.js's push flow already
 *    did — registration is idempotent).
 * 2. Android/desktop Chrome: captures beforeinstallprompt and shows a small
 *    "Install app" pill; tapping it opens the native install dialog.
 * 3. iOS Safari: no install API exists, so show a one-time hint pointing at
 *    Share → Add to Home Screen.
 *
 * This file is also the seam for the future native wrap: when the site runs
 * inside Capacitor, `window.Capacitor` exists and we skip install prompts.
 */
(function () {
  var reg = null;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(function (r) {
        reg = r;
        // New version notifier: when a fresh sw is installed while the old one
        // controls the page, offer a one-tap refresh instead of stale UI.
        r.addEventListener('updatefound', function () {
          var nw = r.installing;
          if (!nw) return;
          nw.addEventListener('statechange', function () {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              var bar = document.createElement('div');
              bar.style.cssText = 'position:fixed;top:calc(10px + env(safe-area-inset-top,0px));left:50%;transform:translateX(-50%);' +
                'z-index:9999;padding:10px 16px;border-radius:999px;cursor:pointer;background:#0f172a;color:#fff;' +
                'font:600 13px/1.2 "DM Sans",system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);';
              bar.textContent = '✨ ADDY was updated — tap to refresh';
              bar.addEventListener('click', function () { window.location.reload(); });
              document.body.appendChild(bar);
            }
          });
        });
      })
      .catch(function () {});
  }

  // Offline banner: on a phone in the field this is the difference between
  // "the app is broken" and "I have no signal".
  var offlineBar = null;
  function setOffline(off) {
    if (off && !offlineBar) {
      offlineBar = document.createElement('div');
      offlineBar.style.cssText = 'position:fixed;bottom:calc(16px + env(safe-area-inset-bottom,0px));left:50%;transform:translateX(-50%);' +
        'z-index:9999;padding:9px 16px;border-radius:999px;background:#b45309;color:#fff;' +
        'font:600 13px/1.2 "DM Sans",system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3);';
      offlineBar.textContent = '📴 Offline — changes will not save until you reconnect';
      document.body.appendChild(offlineBar);
    } else if (!off && offlineBar) {
      offlineBar.remove();
      offlineBar = null;
    }
  }
  window.addEventListener('online', function () { setOffline(false); });
  window.addEventListener('offline', function () { setOffline(true); });
  if (navigator.onLine === false) setOffline(true);

  if (window.Capacitor) return; // already a native app — nothing to install

  var DISMISS_KEY = 'addy_install_dismissed';
  var standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  if (standalone || localStorage.getItem(DISMISS_KEY)) return;

  function makePill(label, onClick) {
    var pill = document.createElement('div');
    pill.setAttribute('role', 'button');
    pill.style.cssText = 'position:fixed;bottom:calc(16px + env(safe-area-inset-bottom,0px));right:16px;z-index:9999;' +
      'display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:999px;cursor:pointer;' +
      'background:#2563eb;color:#fff;font:600 13px/1.2 "DM Sans",system-ui,sans-serif;' +
      'box-shadow:0 6px 24px rgba(37,99,235,.4);';
    pill.innerHTML = label +
      '<span data-close style="opacity:.8;padding-left:2px;font-size:15px;line-height:1;">×</span>';
    pill.addEventListener('click', function (e) {
      if (e.target.hasAttribute('data-close')) {
        localStorage.setItem(DISMISS_KEY, '1');
        pill.remove();
        return;
      }
      onClick(pill);
    });
    document.body.appendChild(pill);
    return pill;
  }

  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    makePill('📲 Install ADDY', function (pill) {
      pill.remove();
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice.finally(function () { deferredPrompt = null; });
    });
  });

  // iOS Safari: show the Add-to-Home-Screen hint once per device.
  var isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  var isSafari = /safari/i.test(navigator.userAgent) && !/crios|fxios|edgios/i.test(navigator.userAgent);
  if (isIos && isSafari) {
    makePill('📲 Install: Share → Add to Home Screen', function (pill) {
      localStorage.setItem(DISMISS_KEY, '1');
      pill.remove();
    });
  }
})();
