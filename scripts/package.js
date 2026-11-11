'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
fs.mkdirSync('dist', { recursive: true });
execFileSync(process.execPath, [require.resolve('@vscode/vsce/vsce'), 'package', '--allow-missing-repository', '--out', `dist/folder-guide-colors-${require('../package.json').version}.vsix`], { stdio: 'inherit' });
