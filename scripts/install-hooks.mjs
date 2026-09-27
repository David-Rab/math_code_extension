// Installs the git pre-commit hook that runs the privacy check (run by `npm install`).
import fs from 'node:fs';
import path from 'node:path';

if (!fs.existsSync('.git')) process.exit(0); // not a git checkout (e.g. installed from a package)
const hook = path.join('.git', 'hooks', 'pre-commit');
fs.mkdirSync(path.dirname(hook), { recursive: true });
fs.writeFileSync(hook, '#!/bin/sh\n# Installed by scripts/install-hooks.mjs: blocks commits that would publish personal data or secrets.\nexec node scripts/privacy-check.mjs\n');
console.log('pre-commit privacy check installed');
