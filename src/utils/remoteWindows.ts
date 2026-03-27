import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { createWindowUrl, hashLabel } from './windowRouting';

interface BrowserWindowOptions {
  tabId: string;
  serverId: string;
  serverName: string;
  currentDir: string;
}

interface EditorWindowOptions {
  tabId: string;
  serverId: string;
  serverName: string;
  path: string;
}

function fileNameFromPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

export function getFileBrowserWindowLabel(tabId: string): string {
  return `file-browser-${tabId}`;
}

export function getFileEditorWindowLabel(tabId: string, path: string): string {
  return `file-editor-${tabId}-${hashLabel(path)}`;
}

export async function openFileBrowserWindow(options: BrowserWindowOptions): Promise<void> {
  const label = getFileBrowserWindowLabel(options.tabId);
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.show();
    await existing.unminimize();
    await existing.setFocus();
    await existing.emit('file-browser:navigate', {
      currentDir: options.currentDir,
    });
    return;
  }

  const title = `${options.serverName} · 文件浏览器`;
  const windowUrl = createWindowUrl({
    window: 'file-browser',
    tabId: options.tabId,
    serverId: options.serverId,
    serverName: options.serverName,
    currentDir: options.currentDir,
  });

  const created = new WebviewWindow(label, {
    title,
    url: windowUrl,
    width: 1180,
    height: 760,
    minWidth: 920,
    minHeight: 620,
    resizable: true,
    center: true,
  });
  created.once('tauri://error', (event) => {
    console.error('Failed to create file browser window:', event.payload);
  }).catch(() => {});
}

export async function openFileEditorWindow(options: EditorWindowOptions): Promise<void> {
  const label = getFileEditorWindowLabel(options.tabId, options.path);
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.show();
    await existing.unminimize();
    await existing.setFocus();
    return;
  }

  const fileName = fileNameFromPath(options.path);
  const title = `${fileName} · 编辑器`;
  const windowUrl = createWindowUrl({
    window: 'file-editor',
    tabId: options.tabId,
    serverId: options.serverId,
    serverName: options.serverName,
    path: options.path,
  });

  const created = new WebviewWindow(label, {
    title,
    url: windowUrl,
    width: 980,
    height: 760,
    minWidth: 760,
    minHeight: 560,
    resizable: true,
    center: true,
  });
  created.once('tauri://error', (event) => {
    console.error('Failed to create file editor window:', event.payload);
  }).catch(() => {});
}
