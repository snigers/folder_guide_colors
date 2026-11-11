'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ConfigStore, resolveArgvPath } = require('../src/config');

async function fixture(t, content) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-guides-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const argvPath = path.join(dir, 'argv.json');
  if (content !== undefined) await fs.writeFile(argvPath, content);
  return { dir, argvPath, store: new ConfigStore(argvPath) };
}

test('enabling then disabling preserves foreign JSONC and an existing port byte for byte', async t => {
  const content = '// keep\r\n{ "remote-debugging-port": "19221", "locale": "ru", }\r\n';
  const { store, argvPath } = await fixture(t, content);
  assert.deepEqual(await store.enable(19333), { enabled: true, port: 19221, ownedPort: null });
  assert.equal(await fs.readFile(argvPath, 'utf8'), content);
  await store.disable();
  assert.equal(await fs.readFile(argvPath, 'utf8'), content);
  assert.equal((await store.read()).enabled, false);
});

test('only removes its own port and keeps edits made while enabled', async t => {
  const { store, argvPath } = await fixture(t, '// user\n{ "locale": "ru", }\n');
  await store.enable(19333);
  let content = await fs.readFile(argvPath, 'utf8');
  assert.match(content, /"remote-debugging-port": "19333"/);
  await fs.writeFile(argvPath, content.replace('"ru"', '"en"'));
  await store.disable();
  content = await fs.readFile(argvPath, 'utf8');
  assert.match(content, /\/\/ user/);
  assert.match(content, /"locale": "en"/);
  assert.doesNotMatch(content, /remote-debugging-port/);
});

test('preserves a port changed by the user and does not reclaim it on re-enable', async t => {
  const { store, argvPath } = await fixture(t, '{}');
  await store.enable(19333);
  await fs.writeFile(argvPath, '{"remote-debugging-port":"19444", "other":true}');
  const state = await store.enable(19333);
  assert.equal(state.ownedPort, null);
  await store.disable();
  assert.equal(await fs.readFile(argvPath, 'utf8'), '{"remote-debugging-port":"19444", "other":true}');
});

test('repeated enable retains ownership so disable still cleans the port', async t => {
  const { store, argvPath } = await fixture(t);
  await store.enable(19333);
  assert.equal((await store.enable(19444)).ownedPort, '19333');
  await store.disable();
  assert.doesNotMatch(await fs.readFile(argvPath, 'utf8'), /remote-debugging-port/);
});

test('invalid JSONC, ambiguous duplicate ports and invalid port types remain untouched', async t => {
  for (const content of ['{broken', '[]', 'null', '{"remote-debugging-port":19333}', '{"remote-debugging-port":"0"}', '{"remote-debugging-port":"19333","remote-debugging-port":"19444"}']) {
    const { store, argvPath } = await fixture(t, content);
    await assert.rejects(store.enable(19333));
    assert.equal(await fs.readFile(argvPath, 'utf8'), content);
    assert.equal((await store.read()).enabled, false);
  }
});

test('failure saving state rolls back an inserted port', async t => {
  const { store, argvPath } = await fixture(t, '{"locale":"ru"}');
  store.writeState = async () => { throw new Error('disk full'); };
  await assert.rejects(store.enable(19333));
  assert.doesNotMatch(await fs.readFile(argvPath, 'utf8'), /remote-debugging-port/);
});

test('argv path respects product data folder and portable Windows paths', () => {
  assert.equal(resolveArgvPath({ home: '/home/person', dataFolderName: '.vscode-insiders' }), '/home/person/.vscode-insiders/argv.json');
  assert.equal(resolveArgvPath({ home: 'C:\\Users\\Person', dataFolderName: '.vscode', platform: 'win32' }), 'C:\\Users\\Person\\.vscode\\argv.json');
  assert.equal(resolveArgvPath({ portable: 'D:\\Code\\data', platform: 'win32' }), 'D:\\Code\\data\\argv.json');
});

test('runtime configuration symlinks and existing permissions survive enable and disable', { skip: process.platform === 'win32' }, async t => {
  const { store, argvPath, dir } = await fixture(t);
  const target = path.join(dir, 'real-argv.json');
  await fs.writeFile(target, '{"locale":"ru"}', { mode: 0o640 });
  await fs.symlink('real-argv.json', argvPath);
  await store.enable(19333);
  assert.equal((await fs.lstat(argvPath)).isSymbolicLink(), true);
  assert.match(await fs.readFile(target, 'utf8'), /remote-debugging-port/);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o640);
  await store.disable();
  assert.equal((await fs.lstat(argvPath)).isSymbolicLink(), true);
  assert.doesNotMatch(await fs.readFile(target, 'utf8'), /remote-debugging-port/);
});

test('removing an owned port preserves comments beside following and preceding user properties', async t => {
  for (const content of [
    '{"remote-debugging-port":"19333",\n// keep locale comment\n"locale":"ru"}',
    '{"locale":"ru",\n// keep trailing comment\n"remote-debugging-port":"19333"}',
    '{/* keep before */"remote-debugging-port"/* keep key */:/* keep value */"19333"/* keep after */,"locale":"ru"}'
  ]) {
    const { store, argvPath } = await fixture(t, '{}');
    await store.enable(19333);
    await fs.writeFile(argvPath, content);
    await store.disable();
    const result = await fs.readFile(argvPath, 'utf8');
    for (const comment of content.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g)) assert.ok(result.includes(comment), comment);
    assert.doesNotMatch(result, /remote-debugging-port/);
    assert.equal(require('jsonc-parser').parse(result).locale, 'ru');
  }
});
