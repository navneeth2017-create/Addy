/**
 * Boot shim — run this instead of server.js (package.json "start" points here).
 *
 * server.js is a large single file; rather than editing it in place, this shim
 * wraps the express() factory so every app created gets our patches installed
 * FIRST (as early middleware + extra admin routes), then loads server.js
 * unchanged. Removing this file + reverting package.json's start script fully
 * reverts every patch.
 */
const express = require('express');
const { installServerPatches, installPgHotfixes } = require('./server_patches');
const { installMonarchIntegration } = require('./monarch_integration');

// Node exits the process on an unhandled rejection, so one stray async error
// anywhere (a background sync, a mail retry, a handler that escaped its
// try/catch) would take the whole site down mid-order. Log loudly and stay up
// — the same guard Monarch already runs.
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION (kept alive):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION (kept alive):', err);
});

// SQL-level hotfixes must be in place before server.js creates its pool.
installPgHotfixes();

const realExpress = express;
function patchedExpress(...args) {
  const app = realExpress(...args);
  try {
    installServerPatches(app);
  } catch (e) {
    console.error('server patches failed to install (continuing unpatched):', e.message);
  }
  try {
    installMonarchIntegration(app);
  } catch (e) {
    console.error('monarch integration failed to install (continuing without it):', e.message);
  }
  return app;
}
// Preserve express statics (json, urlencoded, static, Router, ...).
Object.setPrototypeOf(patchedExpress, realExpress);
Object.assign(patchedExpress, realExpress);

require.cache[require.resolve('express')].exports = patchedExpress;

require('./server.js');
