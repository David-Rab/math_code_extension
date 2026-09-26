// Bundles the extension host (Node, CommonJS) and the webview (browser, IIFE).
import * as esbuild from 'esbuild';
import fs from 'node:fs';

const watch = process.argv.includes('--watch');
const prod = process.argv.includes('--production');

fs.rmSync('dist/webview', { recursive: true, force: true });
if (prod) for (const f of fs.readdirSync('dist', { withFileTypes: true })) if (f.isFile() && f.name.endsWith('.map')) fs.rmSync(`dist/${f.name}`);
fs.mkdirSync('dist/webview', { recursive: true });
// KaTeX stylesheet and fonts, served to the webview from disk.
fs.cpSync('node_modules/katex/dist/katex.min.css', 'dist/webview/katex.min.css');
fs.cpSync('node_modules/katex/dist/fonts', 'dist/webview/fonts', { recursive: true });
fs.cpSync('webview/style.css', 'dist/webview/style.css');

// The claude.exe that matches the installed SDK version, shipped inside the
// extension so it never depends on another install.
const sdkPkg = JSON.parse(fs.readFileSync('node_modules/@anthropic-ai/claude-agent-sdk/package.json', 'utf8'));
const exe = 'node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe';
fs.mkdirSync('dist/bin', { recursive: true });
const same = (a, b) => fs.existsSync(b) && fs.statSync(a).size === fs.statSync(b).size && fs.statSync(a).mtimeMs <= fs.statSync(b).mtimeMs;
// One file per Claude Code version: an update adds the new binary next to the
// one running sessions still use (Windows cannot overwrite a running exe).
const exeName = `claude-${sdkPkg.claudeCodeVersion}.exe`;
if (!same(exe, `dist/bin/${exeName}`)) fs.copyFileSync(exe, `dist/bin/${exeName}`); // 240 MB: copy only when it changed
for (const f of fs.readdirSync('dist/bin')) {
  if (f === exeName || !/^claude.*\.exe$/.test(f)) continue;
  try {
    fs.rmSync(`dist/bin/${f}`); // older versions, once nothing runs them
  } catch {
    /* still in use; removed by a later build */
  }
}
fs.writeFileSync(
  'dist/build-info.json',
  JSON.stringify({ sdkVersion: sdkPkg.version, claudeCodeVersion: sdkPkg.claudeCodeVersion, exe: `bin/${exeName}`, sourceDir: process.cwd(), builtAt: new Date().toISOString() }, null, 2),
);

const common = { bundle: true, minify: prod, sourcemap: !prod, logLevel: 'info' };
const host = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.cjs',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  // The SDK is ESM and uses import.meta.url; give it a CommonJS equivalent.
  define: { 'import.meta.url': 'importMetaUrl' },
  banner: { js: "const importMetaUrl = require('url').pathToFileURL(__filename).href;" },
};
const view = {
  ...common,
  entryPoints: ['webview/main.tsx'],
  outfile: 'dist/webview/main.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'preact',
};

if (watch) {
  for (const o of [host, view]) await (await esbuild.context(o)).watch();
} else {
  await Promise.all([esbuild.build(host), esbuild.build(view)]);
}
