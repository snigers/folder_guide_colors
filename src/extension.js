'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { ConfigStore, resolveArgvPath } = require('./config');
const { Controller } = require('./controller');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function activate(context) {
  const output = vscode.window.createOutputChannel('Folder Guide Colors');
  context.subscriptions.push(output);
  let controller;
  try {
    const product = JSON.parse(await fs.readFile(path.join(vscode.env.appRoot, 'product.json'), 'utf8'));
    const argvPath = resolveArgvPath({
      home: os.homedir(), dataFolderName: product.dataFolderName,
      portable: process.env.VSCODE_PORTABLE
    });
    const store = new ConfigStore(argvPath);
    controller = new Controller({ store, appRoot: vscode.env.appRoot, log: message => output.appendLine(message) });
    context.subscriptions.push(controller);
    const showError = async error => {
      output.appendLine(error.stack || error.message);
      await vscode.window.showErrorMessage(`Folder Guide Colors: ${error.message}`, 'Показать журнал').then(action => {
        if (action) output.show(true);
      });
    };
    context.subscriptions.push(vscode.commands.registerCommand('folderGuideColors.enable', async () => {
      try {
        const existing = await store.read();
        if (!existing.enabled) {
          const choice = await vscode.window.showWarningMessage(
            'Для цветных линий нужно включить локальный отладочный порт VS Code. Он позволяет другим локальным процессам управлять интерфейсом. Файлы установки не изменяются. После первого включения потребуется полностью перезапустить VS Code.',
            { modal: true }, 'Включить'
          );
          if (choice !== 'Включить') return;
        }
        await store.enable(await freePort());
        let applied = 0;
        try { applied = (await controller.sync()).applied; }
        catch (error) { output.appendLine(error.message); }
        if (applied > 0) {
          await vscode.window.showInformationMessage('Folder Guide Colors: цветные линии включены.');
        } else {
          await vscode.window.showInformationMessage('Folder Guide Colors настроен. Сохраните работу, полностью закройте все окна VS Code и запустите приложение снова. Reload Window не запускает отладочный порт.');
        }
      } catch (error) { await showError(error); }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('folderGuideColors.disable', async () => {
      try {
        try { await store.disable(); }
        finally { await controller.sync(); }
        await vscode.window.showInformationMessage('Folder Guide Colors: цветные линии отключены. Добавленный расширением порт закроется после полного выхода из VS Code.');
      } catch (error) { await showError(error); }
    }));
    output.appendLine(`Ready. Runtime configuration: ${argvPath}`);
    controller.start();
  } catch (error) {
    controller?.dispose();
    output.appendLine(error.stack || error.message);
    vscode.window.showErrorMessage(`Folder Guide Colors could not start: ${error.message}`);
  }
}

module.exports = { activate };
