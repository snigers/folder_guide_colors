'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const manifest = require('../package.json');
fs.mkdirSync('dist', { recursive: true });
const args = [require.resolve('@vscode/vsce/vsce'), 'package', '--allow-missing-repository'];
// Keep local README assets usable before the project has a public repository URL.
// Once a repository is configured, vsce can rewrite links for its hosted README.
if (!manifest.repository) args.push('--no-rewrite-relative-links');
args.push('--out', `dist/folder-guide-colors-${manifest.version}.vsix`);
execFileSync(process.execPath, args, { stdio: 'inherit' });
