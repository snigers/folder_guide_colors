'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { JSDOM } = require('jsdom');
const { ConfigStore } = require('../src/config');
const { Controller } = require('../src/controller');
const { STYLE_ID } = require('../src/style');

test('restores both windows after reload and all controllers observe a shared disable', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-guides-controller-'));
  const appRoot = '/app';
  const pages = new Map();
  const targets = [
    { id: 'classic', type: 'page', url: 'vscode-file://vscode-app/app/out/vs/code/electron-browser/workbench/workbench.html' },
    { id: 'agents', type: 'page', url: 'vscode-file://vscode-app/app/out/vs/sessions/electron-browser/sessions.html' },
    { id: 'foreign', type: 'page', url: 'https://example.test' }
  ];
  const reset = id => {
    pages.get(id)?.window.close();
    pages.set(id, new JSDOM('<html><head></head><body></body></html>', { url: targets.find(target => target.id === id).url, runScripts: 'outside-only' }));
  };
  targets.forEach(target => reset(target.id));
  let failDiscovery = false;
  const server = http.createServer((req, res) => {
    if (failDiscovery) { res.writeHead(503); res.end(); return; }
    res.end(JSON.stringify(targets.map(target => ({ ...target, webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/${target.id}` }))));
  });
  const sockets = new WebSocketServer({ server });
  let foreignRequests = 0;
  sockets.on('connection', (socket, request) => {
    const id = request.url.split('/').pop();
    socket.on('message', raw => {
      if (id === 'foreign') foreignRequests++;
      const message = JSON.parse(raw);
      const value = pages.get(id).window.eval(message.params.expression);
      socket.send(JSON.stringify({ id: message.id, result: { result: { type: 'boolean', value } } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const store = new ConfigStore(path.join(dir, 'argv.json'));
  const first = new Controller({ store, appRoot });
  const second = new Controller({ store: new ConfigStore(store.argvPath), appRoot });
  t.after(async () => {
    first.dispose(); second.dispose();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
    for (const dom of pages.values()) dom.window.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await store.enable(server.address().port);
  assert.equal((await first.sync()).applied, 2);
  assert.ok(pages.get('classic').window.document.getElementById(STYLE_ID));
  assert.ok(pages.get('agents').window.document.getElementById(STYLE_ID));
  reset('agents');
  await first.sync();
  assert.ok(pages.get('agents').window.document.getElementById(STYLE_ID));
  await second.sync();
  // Both extension hosts lose their old renderer sockets just as Disable runs.
  for (const controller of [first, second]) for (const entry of controller.connections.values()) entry.connection.close();
  failDiscovery = true;
  await store.disable();
  await first.sync();
  failDiscovery = false;
  await first.sync();
  assert.equal(pages.get('agents').window.document.getElementById(STYLE_ID), null);
  await second.sync();
  await first.sync();
  for (const dom of pages.values()) assert.equal(dom.window.document.getElementById(STYLE_ID), null);
  assert.equal(foreignRequests, 0);
});
