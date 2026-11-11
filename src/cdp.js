'use strict';
const http = require('node:http');
const path = require('node:path');
const WebSocket = require('ws');

const DOCUMENTS = new Set([
  '/out/vs/code/electron-browser/workbench/workbench.html',
  '/out/vs/code/electron-sandbox/workbench/workbench.html',
  '/out/vs/code/electron-sandbox/workbench/workbench.esm.html',
  '/out/vs/sessions/electron-browser/sessions.html'
]);

function isWorkbenchTarget(target, appRoot, platform = process.platform) {
  if (target?.type !== 'page' || typeof target.url !== 'string') return false;
  try {
    const url = new URL(target.url);
    if (!['vscode-file:', 'file:'].includes(url.protocol) || url.username || url.password || url.port) return false;
    if (url.protocol === 'vscode-file:' ? url.hostname !== 'vscode-app' : url.hostname !== '') return false;
    let actual = path.posix.normalize(decodeURIComponent(url.pathname));
    let root = appRoot.replace(/\\/g, '/').replace(/\/$/, '');
    if (platform === 'win32') {
      actual = actual.replace(/^\/(?=[a-z]:)/i, '').toLowerCase();
      root = root.toLowerCase();
    }
    if (!actual.startsWith(root + '/')) return false;
    return DOCUMENTS.has(actual.slice(root.length));
  } catch { return false; }
}

function localSocketUrl(value, port) {
  const url = new URL(value);
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      Number(url.port) !== port || url.username || url.password || url.search || url.hash ||
      !/^\/devtools\/page\/[a-z0-9_-]+$/i.test(url.pathname)) {
    throw new Error('Refusing a debugger URL outside the local VS Code endpoint.');
  }
  url.hostname = '127.0.0.1';
  return url.toString();
}

function discoverTargets(port, timeout = 1200) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return Promise.reject(new Error('Invalid debug port.'));
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/json/list', agent: false }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Debug endpoint returned HTTP ${response.statusCode}.`));
        return;
      }
      let content = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        content += chunk;
        if (content.length > 1024 * 1024) request.destroy(new Error('Debug target list is too large.'));
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const targets = JSON.parse(content);
          if (!Array.isArray(targets)) throw new Error('Invalid debug target list.');
          resolve(targets);
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('Debug discovery timed out.')), timeout);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
  });
}

class CdpConnection {
  constructor(socket, timeout) {
    this.socket = socket;
    this.timeout = timeout;
    this.sequence = 0;
    this.pending = new Map();
    this.closed = false;
    socket.on('message', data => {
      let message;
      try { message = JSON.parse(data); } catch { this.close(); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { this.close(); return; }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || 'CDP request failed.'));
      else pending.resolve(message.result);
    });
    const fail = () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('CDP connection closed.'));
      }
      this.pending.clear();
    };
    socket.on('close', fail);
    socket.on('error', fail);
  }

  static open(url, { timeout = 1500 } = {}) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { handshakeTimeout: timeout, maxPayload: 1024 * 1024, followRedirects: false });
      const connection = new CdpConnection(socket, timeout);
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('CDP connection timed out.')); }, timeout);
      const fail = error => { clearTimeout(timer); reject(error); };
      socket.once('error', fail);
      socket.once('close', () => fail(new Error('CDP connection closed before ready.')));
      socket.once('open', () => { clearTimeout(timer); socket.removeListener('error', fail); resolve(connection); });
    });
  }

  call(method, params = {}) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP connection closed.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out.`)); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close() {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('CDP connection closed.'));
    }
    this.pending.clear();
    this.socket.terminate();
  }
}

module.exports = { CdpConnection, discoverTargets, isWorkbenchTarget, localSocketUrl };
