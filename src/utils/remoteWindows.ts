import { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window';
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

interface WindowPlacement {
  x: number;
  y: number;
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

async function getWindowPlacement(width: number, height: number): Promise<WindowPlacement | null> {
  try {
    const appWindow = getCurrentWindow();
    const [position, size, scaleFactor, monitor] = await Promise.all([
      appWindow.outerPosition(),
      appWindow.outerSize(),
      appWindow.scaleFactor(),
      currentMonitor(),
    ]);

    const logicalX = position.x / scaleFactor;
    const logicalY = position.y / scaleFactor;
    const logicalWidth = size.width / scaleFactor;
    const logicalHeight = size.height / scaleFactor;

    const centeredX = logicalX + Math.max(0, (logicalWidth - width) / 2);
    const centeredY = logicalY + Math.max(0, (logicalHeight - height) / 2);

    if (!monitor) {
      return {
        x: Math.round(centeredX),
        y: Math.round(centeredY),
      };
    }

    const monitorScaleFactor = monitor.scaleFactor || scaleFactor;
    const workAreaX = monitor.workArea.position.x / monitorScaleFactor;
    const workAreaY = monitor.workArea.position.y / monitorScaleFactor;
    const workAreaWidth = monitor.workArea.size.width / monitorScaleFactor;
    const workAreaHeight = monitor.workArea.size.height / monitorScaleFactor;
    const maxX = Math.max(workAreaX, workAreaX + workAreaWidth - width);
    const maxY = Math.max(workAreaY, workAreaY + workAreaHeight - height);

    return {
      x: Math.round(Math.min(Math.max(centeredX, workAreaX), maxX)),
      y: Math.round(Math.min(Math.max(centeredY, workAreaY), maxY)),
    };
  } catch {
    return null;
  }
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
  const width = 1180;
  const height = 760;
  const placement = await getWindowPlacement(width, height);

  const created = new WebviewWindow(label, {
    title,
    url: windowUrl,
    width,
    height,
    minWidth: 920,
    minHeight: 620,
    resizable: true,
    ...(placement ? placement : { center: true }),
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
  const width = 980;
  const height = 760;
  const placement = await getWindowPlacement(width, height);

  const created = new WebviewWindow(label, {
    title,
    url: windowUrl,
    width,
    height,
    minWidth: 760,
    minHeight: 560,
    resizable: true,
    ...(placement ? placement : { center: true }),
  });
  created.once('tauri://error', (event) => {
    console.error('Failed to create file editor window:', event.payload);
  }).catch(() => {});
}
