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

  // iOS Safari: Apple provides no install API — the ONLY way to install a web
  // app is manually via Share → Add to Home Screen. So tapping the pill opens
  // a clear step-by-step guide (a pill that does nothing reads as broken).
  var isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  var isSafari = /safari/i.test(navigator.userAgent) && !/crios|fxios|edgios/i.test(navigator.userAgent);
  if (isIos && isSafari) {
    makePill('📲 Get the app', function (pill) {
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(15,23,42,.6);display:flex;align-items:flex-end;justify-content:center;';
      overlay.innerHTML =
        '<div style="background:#fff;color:#0f172a;border-radius:16px 16px 0 0;padding:22px 20px calc(26px + env(safe-area-inset-bottom,0px));max-width:480px;width:100%;font-family:\'DM Sans\',system-ui,sans-serif;">' +
          '<div style="font-size:17px;font-weight:700;margin-bottom:4px;">Put ADDY on your home screen</div>' +
          '<div style="font-size:13px;color:#64748b;margin-bottom:16px;">iPhones install web apps through Safari’s Share menu — it takes three taps:</div>' +
          '<div style="display:flex;flex-direction:column;gap:12px;font-size:14px;line-height:1.45;">' +
            '<div><strong>1.</strong> Tap the <strong>Share</strong> button <span style="display:inline-block;border:1.5px solid #2563eb;color:#2563eb;border-radius:5px;padding:0 6px;font-weight:700;">&#x2191;</span> at the bottom of Safari</div>' +
            '<div><strong>2.</strong> Scroll down and tap <strong>Add to Home Screen</strong></div>' +
            '<div><strong>3.</strong> Tap <strong>Add</strong> — ADDY opens full-screen like any other app</div>' +
          '</div>' +
          '<button data-got-it style="margin-top:18px;width:100%;padding:13px;border:none;border-radius:10px;background:#2563eb;color:#fff;font:600 15px \'DM Sans\',system-ui,sans-serif;cursor:pointer;">Got it</button>' +
        '</div>';
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay || e.target.hasAttribute('data-got-it')) {
          localStorage.setItem(DISMISS_KEY, '1');
          overlay.remove();
          pill.remove();
        }
      });
      document.body.appendChild(overlay);
    });
  }
})();
