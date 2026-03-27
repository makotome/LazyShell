export type AppWindowKind = 'main' | 'file-browser' | 'file-editor';

export interface FileBrowserWindowContext {
  kind: 'file-browser';
  tabId: string;
  serverId: string;
  serverName: string;
  currentDir: string;
}

export interface FileEditorWindowContext {
  kind: 'file-editor';
  tabId: string;
  serverId: string;
  serverName: string;
  path: string;
}

export type RoutedWindowContext =
  | { kind: 'main' }
  | FileBrowserWindowContext
  | FileEditorWindowContext;

function getStringParam(params: URLSearchParams, key: string, fallback = ''): string {
  const value = params.get(key);
  return value ?? fallback;
}

export function getWindowContext(): RoutedWindowContext {
  const params = new URLSearchParams(window.location.search);
  const kind = params.get('window');

  if (kind === 'file-browser') {
    return {
      kind,
      tabId: getStringParam(params, 'tabId'),
      serverId: getStringParam(params, 'serverId'),
      serverName: getStringParam(params, 'serverName'),
      currentDir: getStringParam(params, 'currentDir', '/'),
    };
  }

  if (kind === 'file-editor') {
    return {
      kind,
      tabId: getStringParam(params, 'tabId'),
      serverId: getStringParam(params, 'serverId'),
      serverName: getStringParam(params, 'serverName'),
      path: getStringParam(params, 'path'),
    };
  }

  return { kind: 'main' };
}

export function createWindowUrl(params: Record<string, string>): string {
  const search = new URLSearchParams(params);
  return `/?${search.toString()}`;
}

export function hashLabel(input: string): string {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) - hash + input.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(16);
}
