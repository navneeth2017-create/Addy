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
