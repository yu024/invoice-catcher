'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const handler = (event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  saveSettings: (payload) => ipcRenderer.invoke('settings:save', payload),
  testConnection: (payload) => ipcRenderer.invoke('settings:test', payload),
  chooseDir: () => ipcRenderer.invoke('settings:chooseDir'),
  start: (options) => ipcRenderer.invoke('fetch:start', options || {}),
  stop: () => ipcRenderer.invoke('fetch:stop'),
  resetCycle: () => ipcRenderer.invoke('cycle:reset'),
  open: (target) => ipcRenderer.invoke('shell:open', target),
  onLog: (callback) => subscribe('fetch:log', callback),
  onState: (callback) => subscribe('fetch:state', callback),
  onInvoice: (callback) => subscribe('fetch:invoice', callback),
  onCycle: (callback) => subscribe('cycle:updated', callback),
  onSettings: (callback) => subscribe('settings:updated', callback),
});
