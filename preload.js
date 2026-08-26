"use strict";

/*
 * preload.js — minimal, safe bridge. The DSH UI is a normal web app served over
 * HTTP; we expose nothing the UI doesn't need. Kept intentionally tiny.
 */

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("dshDesktop", {
  version: process.env.DSH_CLIENT_VERSION ?? "0.3.2",
});
