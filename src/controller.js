'use strict';
const { CdpConnection, discoverTargets, isWorkbenchTarget, localSocketUrl } = require('./cdp');
const { styleExpression } = require('./style');

class Controller {
  constructor({ store, appRoot, platform = process.platform, log = () => {}, interval = 2000 }) {
    this.store = store;
    this.appRoot = appRoot;
    this.platform = platform;
    this.log = log;
    this.interval = interval;
    this.connections = new Map();
    this.disposed = false;
    this.port = null;
    this.disabledCleanup = null;
    this.lastStatus = '';
  }

  start() {
    if (this.timer || this.disposed) return;
    const tick = () => this.sync().catch(error => this.report(error.message));
    this.timer = setInterval(tick, this.interval);
    this.timer.unref?.();
    tick();
  }

  report(message) {
    if (message !== this.lastStatus) {
      this.lastStatus = message;
      this.log(message);
    }
  }

  sync() {
    if (this.disposed) return Promise.resolve({ enabled: false, windows: 0, applied: 0 });
    if (!this.inFlight) this.inFlight = this.reconcile().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async evaluate(entry, enabled) {
    const result = await entry.connection.call('Runtime.evaluate', {
      expression: styleExpression(enabled, entry.target.url), returnByValue: true
    });
    if (result?.exceptionDetails) throw new Error('VS Code rejected the style script.');
    return result?.result?.value === true;
  }

  async clearConnections(removeStyle) {
    const entries = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(entries.map(async entry => {
      try { if (removeStyle && !entry.connection.closed) await this.evaluate(entry, false); }
      catch { /* A closed/reloaded window no longer owns the old document. */ }
      finally { entry.connection.close(); }
    }));
  }

  async reconcile() {
    let state;
    try { state = await this.store.read(); }
    catch (error) { await this.clearConnections(true); throw error; }
    if (this.disposed) return { enabled: false, windows: 0, applied: 0 };
    if (state.port !== this.port) {
      await this.clearConnections(true);
      this.port = state.port;
    }
    const cleanupKey = JSON.stringify(state);
    if (!state.enabled && (!state.port || this.disabledCleanup === cleanupKey)) {
      await this.clearConnections(true);
      return { enabled: false, windows: 0, applied: 0 };
    }
    let targets;
    try { targets = await discoverTargets(state.port); }
    catch (error) {
      if (state.enabled) throw error;
      await this.clearConnections(true);
      this.disabledCleanup = null;
      return { enabled: false, windows: 0, applied: 0 };
    }
    const accepted = targets.filter(target => isWorkbenchTarget(target, this.appRoot, this.platform));
    const live = new Set();
    let applied = 0;
    const failures = [];
    await Promise.all(accepted.map(async target => {
      let entry;
      try {
        const key = localSocketUrl(target.webSocketDebuggerUrl, state.port);
        live.add(key);
        entry = this.connections.get(key);
        if (entry && (entry.connection.closed || entry.target.url !== target.url)) {
          entry.connection.close();
          this.connections.delete(key);
          entry = null;
        }
        if (!entry) {
          const connection = await CdpConnection.open(key);
          if (this.disposed) { connection.close(); return; }
          entry = { target, connection };
          this.connections.set(key, entry);
        }
        if (this.disposed) return;
        if (await this.evaluate(entry, state.enabled)) applied++;
        // An Enable snapshot must not win a race against another window's Disable.
        if (state.enabled && !(await this.store.read()).enabled) await this.evaluate(entry, false);
      } catch (error) {
        entry?.connection.close();
        failures.push(error.message);
      }
    }));
    for (const [key, entry] of this.connections) {
      if (!live.has(key)) { entry.connection.close(); this.connections.delete(key); }
    }
    if (!state.enabled) {
      await this.clearConnections(false);
      // Retry removal after a transient protocol failure.
      this.disabledCleanup = failures.length ? null : cleanupKey;
    } else {
      this.disabledCleanup = null;
    }
    if (failures.length) throw new Error(failures[0]);
    this.report(state.enabled ? `Styles applied to ${applied}/${accepted.length} VS Code window(s).` : 'Styles disabled.');
    return { enabled: state.enabled, windows: accepted.length, applied };
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    for (const entry of this.connections.values()) entry.connection.close();
    this.connections.clear();
  }
}

module.exports = { Controller };
