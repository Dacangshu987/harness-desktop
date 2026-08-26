"use strict";

/*
 * progress-preload.js — tiny bridge for the transient install-progress window.
 * Exposes a single `onProgress` subscription so the HTML page can show the
 * download/extract percentage pushed from the main process.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("np", {
  onProgress: (callback) => ipcRenderer.on("prog", (_event, data) => callback(data)),
});
