// Loads the production bundle with a stub `vscode` module and runs activate(),
// to catch load-time errors (e.g. the import.meta shim) before installing.
// Keep the real %TEMP%/mathpanel.log free of test runs.
process.env.TEMP = process.env.TMP = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'cp-smoke-'));
const Module = require('node:module');
const path = require('node:path');
const registered = [];
const noop = () => ({ dispose() {} });
const vscode = new Proxy(
  {
    commands: { registerCommand: (id) => (registered.push(id), noop()), executeCommand: async () => {} },
    window: {
      registerTreeDataProvider: noop,
      registerWebviewPanelSerializer: noop,
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      createOutputChannel: () => ({ appendLine() {}, show() {} }),
      activeTextEditor: undefined,
    },
    workspace: {
      onDidChangeConfiguration: noop,
      onDidGrantWorkspaceTrust: noop,
      isTrusted: true,
      getConfiguration: () => ({ get: (k, d) => (k === 'prewarm' || k === 'checkForUpdates' ? false : d) }),
      workspaceFolders: undefined,
      getWorkspaceFolder: () => undefined,
    },
    EventEmitter: class { event = () => noop(); fire() {} },
    StatusBarAlignment: { Right: 2 },
    Uri: { joinPath: (...p) => ({ fsPath: p.join('/') }) },
  },
  { get: (t, k) => (k in t ? t[k] : {}) },
);
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'vscode' ? vscode : load.call(this, request, ...rest);
};
const ext = require(path.resolve('dist/extension.cjs'));
ext.activate({ subscriptions: [], extensionUri: { fsPath: process.cwd() }, extensionPath: process.cwd() });
console.log('activated OK; commands:', registered.join(', '));
ext.deactivate();
process.exit(0);
