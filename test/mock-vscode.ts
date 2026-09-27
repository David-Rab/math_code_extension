// Minimal stand-in for the `vscode` module, enough to run ChatSession and
// WarmPool in plain Node against the real claude.exe.
export const settings: Record<string, unknown> = {};

export const workspace = {
  isTrusted: true,
  onDidGrantWorkspaceTrust: () => ({ dispose() {} }),
  getConfiguration: () => ({
    get: <T>(key: string, def: T): T => (key in settings ? (settings[key] as T) : def),
    update: async (key: string, value: unknown) => void (settings[key] = value),
  }),
  findFiles: async () => [],
  openTextDocument: async () => ({}),
};

/** Everything shown to the user through VS Code messages, for assertions. */
export const shown: { level: string; text: string }[] = [];
export const window = {
  state: { focused: false },
  createOutputChannel: () => ({ appendLine: (l: string) => process.env.E2E_LOG && console.log('  log:', l), show() {} }),
  showTextDocument: async () => undefined,
  showErrorMessage: async (text: string) => void shown.push({ level: 'error', text }),
  showInformationMessage: async (text: string) => void shown.push({ level: 'info', text }),
  // Modal confirmations: answer with the first offered button.
  showWarningMessage: async (text: string, ...rest: any[]) => {
    shown.push({ level: 'warn', text });
    return rest.find((r) => typeof r === 'string');
  },
  onDidCloseTerminal: () => ({ dispose() {} }),
  showInputBox: async () => (settings.__inputBox as string | undefined),
};

export const commands = { executeCommand: async () => undefined };
export const version = 'test';
export const env = { openExternal: async () => true };
export const ConfigurationTarget = { Global: 1 };
export const ViewColumn = { One: 1, Beside: -2 };
export class Range {
  constructor(..._a: number[]) {}
}
export class RelativePattern {
  constructor(..._a: unknown[]) {}
}
export const Uri = { file: (p: string) => ({ fsPath: p }), parse: (s: string) => ({ toString: () => s }) };

type Listener<T> = (v: T) => void;

/** A fake webview panel that records what the session posts and lets the test reply. */
export class FakePanel {
  posted: any[] = [];
  title = 'Claude';
  visible = true;
  active = true;
  private onMsg: Listener<any>[] = [];
  private onDispose: Listener<void>[] = [];
  private onPost: Listener<any>[] = [];
  webview = {
    postMessage: async (m: any) => {
      this.posted.push(m);
      for (const l of this.onPost) l(m);
      return true;
    },
    onDidReceiveMessage: (l: Listener<any>) => void this.onMsg.push(l),
  };
  onDidChangeViewState(_l: Listener<any>) {
    return { dispose() {} };
  }
  onDidDispose(l: Listener<void>) {
    this.onDispose.push(l);
  }
  reveal() {}
  dispose() {
    for (const l of this.onDispose) l();
  }
  /** Simulate the webview sending a message to the extension. */
  fromView(m: any) {
    for (const l of this.onMsg) l(m);
  }
  watch(l: Listener<any>) {
    this.onPost.push(l);
  }
}
