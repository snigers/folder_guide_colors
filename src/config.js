'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { parse, parseTree, modify, applyEdits, createScanner, SyntaxKind } = require('jsonc-parser');

const PORT_KEY = 'remote-debugging-port';

function resolveArgvPath({ home, dataFolderName, portable, platform = process.platform }) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (portable) return paths.join(portable, 'argv.json');
  if (!home || !dataFolderName || paths.basename(dataFolderName) !== dataFolderName) {
    throw new Error('Cannot locate VS Code runtime configuration.');
  }
  return paths.join(home, dataFolderName, 'argv.json');
}

function validPort(port) {
  return typeof port === 'string' && /^\d+$/.test(port) && Number(port) >= 1024 && Number(port) <= 65535;
}

function readDocument(content) {
  const errors = [];
  const tree = parseTree(content, errors, { allowTrailingComma: true });
  if (errors.length || tree?.type !== 'object') throw new Error('Runtime configuration must be a valid JSONC object.');
  const occurrences = tree.children.filter(node => node.children[0].value === PORT_KEY);
  if (occurrences.length > 1) throw new Error('Runtime configuration contains duplicate debug ports.');
  const value = parse(content, [], { allowTrailingComma: true });
  if (Object.hasOwn(value, PORT_KEY) && !validPort(value[PORT_KEY])) {
    throw new Error('remote-debugging-port must be a string containing a port between 1024 and 65535.');
  }
  return value;
}

function editPort(content, value) {
  if (value === undefined) {
    // jsonc-parser's property deletion also consumes adjacent comments. Delete
    // only syntax tokens, keeping every comment/whitespace token in place.
    const tree = parseTree(content, [], { allowTrailingComma: true });
    const property = tree.children.find(node => node.children[0].value === PORT_KEY);
    if (!property) return content;
    const scanner = createScanner(content, true);
    const tokens = [];
    for (let kind = scanner.scan(); kind !== SyntaxKind.EOF; kind = scanner.scan()) {
      tokens.push({ kind, offset: scanner.getTokenOffset(), length: scanner.getTokenLength() });
    }
    const start = property.offset;
    const end = property.offset + property.length;
    const removed = tokens.filter(token => token.offset >= start && token.offset < end);
    const next = tokens.find(token => token.offset >= end);
    const previous = tokens.filter(token => token.offset < start).pop();
    if (next?.kind === SyntaxKind.CommaToken) removed.push(next);
    else if (previous?.kind === SyntaxKind.CommaToken) removed.push(previous);
    return applyEdits(content, removed.map(({ offset, length }) => ({ offset, length, content: '' })));
  }
  return applyEdits(content, modify(content, [PORT_KEY], value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: content.includes('\r\n') ? '\r\n' : '\n' }
  }));
}

async function atomicWrite(file, content) {
  // Preserve a user-managed symlink and permissions instead of replacing the link.
  let mode = 0o600;
  try {
    file = await fs.realpath(file);
    mode = (await fs.stat(file)).mode & 0o777;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = `${file}.${process.pid}.${require('node:crypto').randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, content, { mode, flag: 'wx' });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

class ConfigStore {
  constructor(argvPath) {
    this.argvPath = argvPath;
    this.statePath = path.join(path.dirname(argvPath), 'folder-guide-colors.json');
  }

  async read() {
    let content;
    try { content = await fs.readFile(this.statePath, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return { enabled: false, port: null, ownedPort: null };
      throw error;
    }
    const state = JSON.parse(content);
    if (!state || typeof state.enabled !== 'boolean' ||
        (state.port !== null && (!Number.isInteger(state.port) || state.port < 1024 || state.port > 65535)) ||
        (state.ownedPort !== null && !validPort(state.ownedPort)) || (state.enabled && state.port === null)) {
      throw new Error('Folder Guide Colors state is invalid.');
    }
    return state;
  }

  async writeState(state) {
    await atomicWrite(this.statePath, JSON.stringify(state, null, 2) + '\n');
  }

  async withLock(operation) {
    await fs.mkdir(path.dirname(this.argvPath), { recursive: true });
    const lockPath = this.statePath + '.lock';
    let lock;
    try { lock = await fs.open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error(`Another Folder Guide Colors operation is in progress. If VS Code previously crashed, remove ${lockPath} and retry.`);
      throw error;
    }
    try { return await operation(); }
    finally {
      await lock.close();
      await fs.rm(lockPath, { force: true });
    }
  }

  async enable(preferredPort) {
    if (!validPort(String(preferredPort))) throw new Error('Invalid debug port.');
    return this.withLock(async () => {
      const previous = await this.read();
      let content;
      try { content = await fs.readFile(this.argvPath, 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') content = '{}\n'; else throw error; }
      const config = readDocument(content);
      const existing = config[PORT_KEY];
      const port = existing ?? String(preferredPort);
      const ownedPort = existing === undefined || previous.ownedPort === port ? port : null;
      const state = { enabled: true, port: Number(port), ownedPort };
      const edited = existing === undefined ? editPort(content, port) : content;
      if (edited !== content) await atomicWrite(this.argvPath, edited);
      try { await this.writeState(state); }
      catch (error) {
        // Do not overwrite a concurrent user edit while rolling back our addition.
        if (edited !== content && await fs.readFile(this.argvPath, 'utf8') === edited) {
          await atomicWrite(this.argvPath, content);
        }
        throw error;
      }
      return state;
    });
  }

  async disable() {
    return this.withLock(async () => {
      const previous = await this.read();
      const state = { ...previous, enabled: false };
      // Other windows must stop applying CSS even when argv.json has become invalid.
      await this.writeState(state);
      if (previous.ownedPort !== null) {
        let content;
        try { content = await fs.readFile(this.argvPath, 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (content !== undefined && readDocument(content)[PORT_KEY] === previous.ownedPort) {
          await atomicWrite(this.argvPath, editPort(content, undefined));
        }
        state.ownedPort = null;
        await this.writeState(state);
      }
      return state;
    });
  }
}

module.exports = { ConfigStore, resolveArgvPath };
