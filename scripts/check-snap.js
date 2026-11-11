'use strict';
// Runs the packaged VSIX in a temporary portable profile. Never uses the user's profile.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require('playwright-core');
const { discoverTargets, CdpConnection, localSocketUrl } = require('../src/cdp');
const { STYLE_ID } = require('../src/style');
const { parse } = require('jsonc-parser');
const { ConfigStore } = require('../src/config');

const run = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await delay(250);
  }
  throw new Error(`Timed out: ${label}${last ? ': ' + last.message : ''}`);
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function command(page, name) {
  await page.bringToFront();
  if (page.url().includes('/sessions/')) {
    const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
    if (await cancel.isVisible()) await cancel.click();
    const without = page.getByText('Continue Without Signing In', { exact: true });
    try { await without.waitFor({ timeout: 1500 }); await without.click(); } catch { /* Not signing in. */ }
  }
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+p');
  const input = page.locator('.quick-input-widget input');
  await input.waitFor({ state: 'visible', timeout: 15000 });
  await input.fill('>' + name);
  await page.locator('.quick-input-list .monaco-list-row').filter({ hasText: name }).first().waitFor({ timeout: 10000 });
  await input.press('Enter');
}

async function checkExplorerColors(page) {
  await page.bringToFront();
  const tree = page.locator('.explorer-folders-view:visible');
  await tree.first().waitFor({ state: 'visible', timeout: 15000 });
  for (const name of ['level1', 'level2', 'level3']) {
    const row = tree.locator('.monaco-list-row').filter({ hasText: name }).first();
    await row.waitFor({ timeout: 15000 });
    if (await row.getAttribute('aria-expanded') !== 'true') {
      if (page.url().includes('/sessions/')) {
        // The native tree is rendered behind the fresh-profile sign-in overlay.
        // Dispatch its normal twistie event to test CSS without authenticating.
        await row.locator('.monaco-tl-twistie').dispatchEvent('click');
      } else {
        await row.click();
        if (await row.getAttribute('aria-expanded') === 'false') await row.press('ArrowRight');
      }
    }
  }
  const colors = await tree.locator('.indent-guide').evaluateAll(nodes => [...new Set(nodes.map(node => getComputedStyle(node).borderLeftColor))]);
  assert.ok(colors.includes('rgb(255, 215, 0)') && colors.includes('rgb(227, 135, 255)'), JSON.stringify(colors));
}

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-guide-colors-snap-'));
  const portable = path.join(directory, 'portable');
  const userData = path.join(portable, 'user-data');
  const extensions = path.join(portable, 'extensions');
  const fixture = path.join(directory, 'fixture');
  await fs.mkdir(portable);
  await fs.mkdir(path.join(userData, 'User'), { recursive: true });
  await fs.writeFile(path.join(userData, 'User/settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false, 'workbench.startupEditor': 'none', 'explorer.compactFolders': false,
    'security.workspace.trust.enabled': false, 'window.title': 'Folder Guide Colors Test', 'window.dialogStyle': 'custom'
  }));
  await fs.mkdir(path.join(fixture, 'level1/level2/level3'), { recursive: true });
  for (const file of ['README.md', 'level1/one.txt', 'level1/level2/two.txt', 'level1/level2/level3/three.txt']) await fs.writeFile(path.join(fixture, file), 'test\n');
  const env = { ...process.env, VSCODE_PORTABLE: portable };
  delete env.ELECTRON_RUN_AS_NODE;
  const common = ['--user-data-dir', userData, '--extensions-dir', extensions, '--locale', 'en', '--skip-welcome', '--skip-release-notes'];
  const children = [];
  let browser;
  let currentPort;
  async function launch(extra) {
    const child = spawn('/snap/bin/code', [...common, ...extra], { env, detached: true, stdio: 'ignore' });
    children.push(child);
    child.unref();
    return child;
  }
  async function closeApp() {
    if (browser) { await browser.close(); browser = null; }
    if (currentPort) {
      try {
        const targets = await discoverTargets(currentPort);
        const target = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
        if (target) {
          const connection = await CdpConnection.open(localSocketUrl(target.webSocketDebuggerUrl, currentPort));
          try { await connection.call('Browser.close'); } catch { /* Closing the process can close the transport first. */ }
          finally { connection.close(); }
        }
      } catch { /* The test process may already have exited. */ }
    }
    for (const child of children.splice(0)) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
    }
    if (currentPort) await until(async () => {
      try { await discoverTargets(currentPort, 200); return false; } catch { return true; }
    }, 'test app exit', 10000);
  }
  try {
    const vsix = path.resolve(`dist/folder-guide-colors-${require('../package.json').version}.vsix`);
    await run('/snap/bin/code', [...common, '--install-extension', vsix, '--force'], { env, timeout: 30000 });
    console.log('VSIX installed into isolated test profile.');
    currentPort = await freePort();
    await launch(['--remote-debugging-port=' + currentPort, '--new-window', fixture]);
    await until(() => discoverTargets(currentPort), 'bootstrap debug endpoint');
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + currentPort);
    let classic = await until(() => browser.contexts()[0].pages().find(page => page.url().includes('/workbench/')), 'classic window');
    await classic.locator('.monaco-workbench').waitFor({ timeout: 30000 });
    await fs.access(path.join(portable, 'argv.json')); // Verify isolation before changing runtime arguments.
    await command(classic, 'Folder Guide Colors: Enable');
    const statePath = path.join(portable, 'folder-guide-colors.json');
    const state = await until(async () => {
      const enable = classic.getByRole('button', { name: /Включить/ });
      if (await enable.isVisible()) await enable.click();
      try {
        const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
        return state.enabled && state;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }, 'Enable saves portable runtime state');
    assert.equal(typeof parse(await fs.readFile(path.join(portable, 'argv.json'), 'utf8'))['remote-debugging-port'], 'string');
    console.log('Actual extension Enable command: PASS.');
    await closeApp();
    currentPort = state.port;
    await launch(['--new-window', fixture]); // No debug flag: argv.json must open the port.
    await until(() => discoverTargets(currentPort), 'persistent debug endpoint after full restart');
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + currentPort);
    classic = await until(() => browser.contexts()[0].pages().find(page => page.url().includes('/workbench/')), 'restarted classic window');
    await until(() => classic.locator('#' + STYLE_ID).count(), 'automatic startup CSS');
    await checkExplorerColors(classic);
    console.log('Full restart without CLI debug flag + native Explorer colors: PASS.');
    await run('/snap/bin/code', [...common, '--agents', fixture], { env, timeout: 15000 });
    const agents = await until(() => browser.contexts()[0].pages().find(page => page.url().includes('/sessions/')), 'Agents window');
    await until(() => agents.locator('#' + STYLE_ID).count(), 'Agents startup CSS');
    await checkExplorerColors(agents);
    console.log('Native Agents Explorer colors: PASS.');
    await classic.reload();
    await until(() => classic.locator('#' + STYLE_ID).count(), 'classic reload CSS');
    await agents.reload();
    await until(() => agents.locator('#' + STYLE_ID).count(), 'Agents reload CSS');
    console.log('Agents window + reload of both renderers: PASS.');
    await command(classic, 'Folder Guide Colors: Disable');
    await until(async () => !await classic.locator('#' + STYLE_ID).count() && !await agents.locator('#' + STYLE_ID).count(), 'Disable removes both styles');
    const disabled = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.equal(disabled.enabled, false);
    assert.equal(parse(await fs.readFile(path.join(portable, 'argv.json'), 'utf8'))['remote-debugging-port'], undefined);
    console.log('Actual Disable command + owned runtime flag cleanup: PASS.');
    // Listener must stay local even though argv.json exposes only the port switch.
    const sockets = await run('ss', ['-ltnp']);
    const listeners = sockets.stdout.split('\n').filter(line => line.includes(':' + currentPort + ' '));
    assert.ok(listeners.length > 0 && listeners.every(line => /127\.0\.0\.1:|\[::1\]:/.test(line)), listeners.join('\n'));
    console.log('Debug listener bound to loopback: PASS.');
    await closeApp();
    await new ConfigStore(path.join(portable, 'argv.json')).enable(currentPort);
    await launch(['--agents', fixture]);
    await until(() => discoverTargets(currentPort), 'Agents-only debug endpoint');
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + currentPort);
    const onlyAgents = await until(() => browser.contexts()[0].pages().find(page => page.url().includes('/sessions/')), 'Agents-only window');
    assert.equal(browser.contexts()[0].pages().some(page => page.url().includes('/workbench/')), false);
    await until(() => onlyAgents.locator('#' + STYLE_ID).count(), 'Agents-only extension activation');
    await checkExplorerColors(onlyAgents);
    await command(onlyAgents, 'Folder Guide Colors: Disable');
    await until(async () => !await onlyAgents.locator('#' + STYLE_ID).count(), 'Agents-only Disable');
    console.log('Agents-only startup, native colors and Disable command: PASS.');
  } catch (error) {
    if (browser) {
      for (const [index, page] of browser.contexts()[0].pages().entries()) {
        try {
          await page.screenshot({ path: path.join(directory, `failure-${index}.png`) });
          console.error('Window diagnostics:', await page.locator('.monaco-dialog-box,.quick-input-list .monaco-list-row').evaluateAll(nodes => nodes.map(node => node.textContent).filter(Boolean).slice(0, 8)));
        } catch { /* Page may have closed. */ }
      }
    }
    console.error('Test profile retained for diagnosis: ' + directory);
    process.exitCode = 1;
    throw error;
  } finally {
    await closeApp();
    if (!process.exitCode) await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
