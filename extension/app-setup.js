// The tabdriver app: how to install it. Shown by the popup and the setup page when the
// extension can't reach the app, and used to spot an app older than the extension.

const APP_GUIDE = 'https://github.com/trajche/tabdriver#install';

const APP_INSTALL = {
  mac: [
    {
      label: 'Terminal, with Homebrew',
      command: 'brew tap trajche/tabdriver https://github.com/trajche/tabdriver && brew trust trajche/tabdriver && brew install tabdriver',
    },
    { label: 'Terminal, without Homebrew', command: 'curl -fsSL https://raw.githubusercontent.com/trajche/tabdriver/main/install.sh | sh' },
  ],
  linux: [{ label: 'Terminal', command: 'curl -fsSL https://raw.githubusercontent.com/trajche/tabdriver/main/install.sh | sh' }],
  win: [{ label: 'PowerShell', command: 'irm https://raw.githubusercontent.com/trajche/tabdriver/main/install.ps1 | iex' }],
};

const APP_UPDATE = {
  mac: 'brew upgrade tabdriver, or run the install command again',
  linux: 'run the install command again',
  win: 'run the install command again',
};

const installCommands = (os) => APP_INSTALL[os] || APP_INSTALL.linux;
const updateHint = (os) => APP_UPDATE[os] || APP_UPDATE.linux;

/** Fill `el` with the install commands for `os`, each with a Copy button. */
const renderInstallCommands = (el, os) => renderCommands(el, installCommands(os));

/** Fill `el` with [{ label, command }] blocks, each with a Copy button. */
function renderCommands(el, commands) {
  el.textContent = '';
  for (const { label, command } of commands) {
    const block = document.createElement('div');
    block.className = 'command';
    const title = document.createElement('div');
    title.className = 'command-label';
    title.textContent = label;
    const row = document.createElement('div');
    row.className = 'command-row';
    const code = document.createElement('code');
    code.textContent = command;
    const copy = document.createElement('button');
    copy.textContent = 'Copy';
    copy.onclick = async () => {
      await navigator.clipboard.writeText(command);
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy'), 1500);
    };
    row.append(code, copy);
    block.append(title, row);
    el.append(block);
  }
}
