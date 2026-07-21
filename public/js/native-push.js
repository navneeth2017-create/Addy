/**
 * Native push bridge — only active inside the Capacitor app (App Store /
 * Play Store build). On the web it defines nothing and the existing
 * web-push flow in app.js runs unchanged.
 *
 * Inside the native app, Safari's WKWebView has no PushManager, so the bell
 * button routes here instead: Capacitor's PushNotifications plugin registers
 * with APNs (iOS) / FCM (Android) and we store the device token through the
 * SAME /api/push/subscribe endpoint, shaped as:
 *     { native: 'ios' | 'android', token: '<device token>' }
 * The server routes native-shaped subscriptions to APNs/FCM and web-push
 * subscriptions to web-push (see sendNativePush in server.js).
 *
 * Setup steps for the native build live in MOBILE.md (the plugin can only be
 * installed once the iOS project exists, and APNs keys require the Apple
 * developer account).
 */
(function () {
  var cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return;

  var Push = cap.Plugins && cap.Plugins.PushNotifications;

  window.AddyNativePush = {
    available: function () { return !!Push; },

    // Resolves true when enabled, false when permission was denied.
    enable: function () {
      if (!Push) return Promise.resolve(false);
      return Push.requestPermissions().then(function (perm) {
        if (perm.receive !== 'granted') return false;
        return new Promise(function (resolve) {
          Push.addListener('registration', function (t) {
            apiFetch('/api/push/subscribe', {
              method: 'POST',
              body: JSON.stringify({
                subscription: { native: cap.getPlatform(), token: t.value },
              }),
            }).then(function () { resolve(true); }, function () { resolve(false); });
          });
          Push.addListener('registrationError', function () { resolve(false); });
          Push.register();
        });
      });
    },

    disable: function () {
      return apiFetch('/api/push/unsubscribe', { method: 'DELETE' }).then(
        function () { return true; },
        function () { return false; }
      );
    },
  };

  // Foreground notifications: surface them as the app's own toast.
  if (Push) {
    Push.addListener('pushNotificationReceived', function (n) {
      if (typeof showToast === 'function' && n && (n.title || n.body)) {
        showToast((n.title ? n.title + ': ' : '') + (n.body || ''), 'success');
      }
    });
    Push.addListener('pushNotificationActionPerformed', function (a) {
      var url = a && a.notification && a.notification.data && a.notification.data.url;
      if (url) window.location.href = url;
    });
  }
})();
