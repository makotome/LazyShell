import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { EditorView, lineNumbers, highlightActiveLine, keymap } from '@codemirror/view';
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
import type { Extension } from '@codemirror/state';
import type { RemoteFileContent } from '../types';

interface FileEditorWindowProps {
  serverId: string;
  serverName: string;
  path: string;
}

function fileNameFromPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
}

function getLanguageExtensions(path: string): Extension[] {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith('.json')) {
    return [json()];
  }
  if (lowerPath.endsWith('.yaml') || lowerPath.endsWith('.yml')) {
    return [yaml()];
  }
  if (lowerPath.endsWith('.sh') || lowerPath.endsWith('.bash') || lowerPath.endsWith('.zsh') || lowerPath.endsWith('.env')) {
    return [StreamLanguage.define(shell)];
  }
  return [];
}

const macDarkEditorTheme = EditorView.theme({
  '&': {
    backgroundColor: '#1b1d21',
    color: '#d7dce2',
  },
  '.cm-content': {
    caretColor: '#f5f7fa',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: '#f5f7fa',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(255, 255, 255, 0.045)',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(88, 138, 214, 0.42)',
  },
  '.cm-gutters': {
    backgroundColor: '#16181b',
    color: '#7d8794',
  },
}, { dark: true });

export function FileEditorWindow({ serverId, serverName, path }: FileEditorWindowProps) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [fileSize, setFileSize] = useState(0);

  const fileName = useMemo(() => fileNameFromPath(path), [path]);
  const isDirty = content !== originalContent;
  const editorExtensions = useMemo<Extension[]>(() => ([
    lineNumbers(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    highlightActiveLine(),
    EditorView.lineWrapping,
    macDarkEditorTheme,
    ...getLanguageExtensions(path),
  ]), [path]);

  useEffect(() => {
    let mounted = true;

    const loadFile = async () => {
      setLoading(true);
      setError(null);

      try {
        const payload = await invoke<RemoteFileContent>('read_remote_file', {
          serverId,
          path,
        });

        if (!mounted) return;
        setContent(payload.content);
        setOriginalContent(payload.content);
        setFileSize(payload.size);
        await getCurrentWindow().setTitle(`${fileName} · ${serverName}`);
      } catch (err) {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    void loadFile();

    return () => {
      mounted = false;
    };
  }, [fileName, path, serverId, serverName]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    void getCurrentWindow().onCloseRequested(async (event) => {
      if (!isDirty) {
        return;
      }

      const confirmed = window.confirm('这个文件还有未保存修改，确定要关闭编辑器吗？');
      if (!confirmed) {
        event.preventDefault();
      }
    }).then((handler) => {
      unlisten = handler;
    });

    return () => {
      unlisten?.();
    };
  }, [isDirty]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);

    try {
      await invoke('write_remote_file', {
        serverId,
        path,
        content,
      });
      setOriginalContent(content);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="window-shell window-shell-editor">
      <div className="editor-window">
        <div className="editor-window-toolbar">
          <div className="editor-window-meta">
            <span className="editor-window-kicker">Text Editor</span>
            <span className="editor-window-path" title={path}>{path}</span>
          </div>
          <div className="editor-window-actions">
            <span className={`editor-window-status ${isDirty ? 'dirty' : ''}`}>
              {isDirty ? '未保存修改' : '已保存'}
            </span>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => { void getCurrentWindow().close(); }}>
              关闭
            </button>
            <button type="button" className="btn btn-primary btn-small" onClick={() => { void handleSave(); }} disabled={!isDirty || saving || loading}>
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>

        {error && <div className="error-message editor-window-message">{error}</div>}
        {loading && <div className="editor-window-empty">正在读取文件内容...</div>}

        {!loading && !error && (
          <>
            <div className="editor-window-subbar">
              <span>{fileName}</span>
              <span>{fileSize} B</span>
            </div>
            <div className="editor-window-body">
              <CodeMirror
                value={content}
                height="100%"
                width="100%"
                style={{ width: '100%', height: '100%' }}
                basicSetup={{
                  foldGutter: false,
                  highlightActiveLine: true,
                  highlightActiveLineGutter: true,
                }}
                extensions={editorExtensions}
                onChange={(value) => setContent(value)}
                theme="dark"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
