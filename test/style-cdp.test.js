'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { JSDOM } = require('jsdom');
const { CSS, styleExpression, STYLE_ID } = require('../src/style');
const { CdpConnection, discoverTargets, isWorkbenchTarget, localSocketUrl } = require('../src/cdp');

const root = '/snap/code/278/usr/share/code/resources/app';
const targetUrl = 'vscode-file://vscode-app' + root + '/out/vs/code/electron-browser/workbench/workbench.html';

test('style injection is idempotent, removes its own style and leaves foreign styles alone', () => {
  const dom = new JSDOM('<html><head><style id="foreign">body{color:red}</style></head><body class="monaco-workbench"></body></html>', { url: targetUrl, runScripts: 'outside-only' });
  try {
    assert.equal(dom.window.eval(styleExpression(true, targetUrl)), true);
    assert.equal(dom.window.eval(styleExpression(true, targetUrl)), true);
    assert.equal(dom.window.document.querySelectorAll('#' + STYLE_ID).length, 1);
    assert.equal(dom.window.document.getElementById(STYLE_ID).textContent, CSS);
    assert.equal(dom.window.eval(styleExpression(false, targetUrl)), true);
    assert.equal(dom.window.document.getElementById(STYLE_ID), null);
    assert.ok(dom.window.document.getElementById('foreign'));
  } finally { dom.window.close(); }
});

test('injection refuses a page which navigated away after discovery', () => {
  const dom = new JSDOM('<html><head></head><body></body></html>', { url: 'https://example.test', runScripts: 'outside-only' });
  try {
    assert.equal(dom.window.eval(styleExpression(true, targetUrl)), false);
    assert.equal(dom.window.document.getElementById(STYLE_ID), null);
  } finally { dom.window.close(); }
});

test('only exact workbench and Agents document paths in this installation are accepted', () => {
  const target = url => ({ type: 'page', url });
  assert.equal(isWorkbenchTarget(target(targetUrl), root), true);
  assert.equal(isWorkbenchTarget(target('vscode-file://vscode-app' + root + '/out/vs/sessions/electron-browser/sessions.html'), root), true);
  for (const url of ['https://example.test/workbench.html', targetUrl + '/other', targetUrl.replace('/278/', '/999/'), targetUrl.replace('vscode-app', 'foreign-host'), 'devtools://devtools/bundled/inspector.html']) {
    assert.equal(isWorkbenchTarget(target(url), root), false, url);
  }
  assert.equal(isWorkbenchTarget({ type: 'iframe', url: targetUrl }, root), false);
  assert.equal(isWorkbenchTarget(target('vscode-file://vscode-app/c:/Program%20Files/Code/resources/app/out/vs/sessions/electron-browser/sessions.html'), 'C:\\Program Files\\Code\\resources\\app', 'win32'), true);
});

test('debugger URLs cannot redirect the client outside the configured local endpoint', () => {
  assert.equal(localSocketUrl('ws://localhost:19333/devtools/page/abc-12', 19333), 'ws://127.0.0.1:19333/devtools/page/abc-12');
  for (const url of ['ws://evil.test:19333/devtools/page/abc', 'ws://127.0.0.1:19334/devtools/page/abc', 'wss://127.0.0.1:19333/devtools/page/abc', 'ws://user@127.0.0.1:19333/devtools/page/abc', 'ws://127.0.0.1:19333/other']) {
    assert.throws(() => localSocketUrl(url, 19333));
  }
});

async function endpoint(t, onMessage) {
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([{ id: 'fixture', type: 'page', url: targetUrl, webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/page/fixture` }]));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', socket => socket.on('message', data => onMessage(socket, JSON.parse(data))));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const client of sockets.clients) client.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  return server.address().port;
}

test('real HTTP/WebSocket transport handles CDP events and out-of-order replies', async t => {
  const port = await endpoint(t, (socket, message) => {
    socket.send(JSON.stringify({ method: 'Runtime.executionContextCreated', params: {} }));
    setTimeout(() => socket.send(JSON.stringify({ id: message.id, result: { value: message.params.value } })), message.params.value === 'first' ? 20 : 0);
  });
  const targets = await discoverTargets(port);
  const connection = await CdpConnection.open(localSocketUrl(targets[0].webSocketDebuggerUrl, port));
  t.after(() => connection.close());
  assert.deepEqual(await Promise.all([connection.call('Fixture', { value: 'first' }), connection.call('Fixture', { value: 'second' })]), [{ value: 'first' }, { value: 'second' }]);
});

test('protocol errors, closed connections and missing replies reject instead of hanging', async t => {
  const port = await endpoint(t, (socket, message) => {
    if (message.method === 'Error') socket.send(JSON.stringify({ id: message.id, error: { message: 'denied' } }));
    if (message.method === 'Drop') socket.close();
  });
  const url = `ws://127.0.0.1:${port}/devtools/page/fixture`;
  const connection = await CdpConnection.open(url, { timeout: 80 });
  t.after(() => connection.close());
  await assert.rejects(connection.call('Error'), /denied/);
  await assert.rejects(connection.call('Timeout'), /timed out/i);
  await assert.rejects(connection.call('Drop'), /closed/i);
});

test('malformed CDP messages close the connection without crashing the extension host', async t => {
  const port = await endpoint(t, socket => socket.send('null'));
  const connection = await CdpConnection.open(`ws://127.0.0.1:${port}/devtools/page/fixture`);
  t.after(() => connection.close());
  await assert.rejects(connection.call('Fixture'), /closed/i);
});
