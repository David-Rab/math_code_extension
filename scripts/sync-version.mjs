// Before packaging: give the extension a version that follows the bundled
// Claude Code release (0.1.x -> 0.1.<Claude Code patch>). A new version installs
// into a new folder, so an update never has to overwrite a claude.exe in use.
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const sdk = JSON.parse(fs.readFileSync('node_modules/@anthropic-ai/claude-agent-sdk/package.json', 'utf8'));
const [major, minor] = pkg.version.split('.');
const patch = sdk.claudeCodeVersion.split('.')[2];
const next = `${major}.${minor}.${patch}`;
if (pkg.version !== next) {
  pkg.version = next;
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
}
console.log(`extension version ${next} (Claude Code ${sdk.claudeCodeVersion})`);
