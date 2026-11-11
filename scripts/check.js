'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
for (const directory of ['src', 'scripts', 'test']) {
  for (const name of fs.readdirSync(directory)) {
    if (name.endsWith('.js')) execFileSync(process.execPath, ['--check', path.join(directory, name)], { stdio: 'inherit' });
  }
}
console.log('JavaScript syntax: PASS');
