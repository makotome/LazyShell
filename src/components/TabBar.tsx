import { useRef, useEffect } from 'react';
import type { ServerTab, LayoutMode } from '../types';

interface TabBarProps {
  tabs: ServerTab[];
  activeTabId: string;
  onTabSelect: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onNewTab: () => void;
  layoutMode: LayoutMode;
  onLayoutChange: (mode: LayoutMode) => void;
}

const layoutOptions: { mode: LayoutMode; title: string }[] = [
  { mode: 'sidebar-terminal', title: '侧边栏 + 终端' },
  { mode: 'all', title: '侧边栏 + 终端 + AI' },
  { mode: 'terminal-ai', title: '终端 + AI' },
  { mode: 'terminal-fullscreen', title: '终端全屏' },
];

function LayoutIcon({ mode }: { mode: LayoutMode }) {
  // Each icon is a 16x16 SVG showing a miniature layout preview
  switch (mode) {
    case 'sidebar-terminal':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="1" y="1" width="4" height="14" rx="0.5" fill="currentColor" opacity="0.8" />
          <rect x="6" y="1" width="9" height="14" rx="0.5" stroke="currentColor" strokeWidth="1" fill="currentColor" opacity="0.3" />
        </svg>
      );
    case 'all':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="1" y="1" width="3.5" height="14" rx="0.5" fill="currentColor" opacity="0.8" />
          <rect x="5.5" y="1" width="5" height="14" rx="0.5" stroke="currentColor" strokeWidth="1" fill="currentColor" opacity="0.3" />
          <rect x="11.5" y="1" width="3.5" height="14" rx="0.5" fill="currentColor" opacity="0.6" />
        </svg>
      );
    case 'terminal-ai':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="1" y="1" width="9" height="14" rx="0.5" stroke="currentColor" strokeWidth="1" fill="currentColor" opacity="0.3" />
          <rect x="11" y="1" width="4" height="14" rx="0.5" fill="currentColor" opacity="0.6" />
        </svg>
      );
    case 'terminal-fullscreen':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="1" y="1" width="14" height="14" rx="0.5" stroke="currentColor" strokeWidth="1" fill="currentColor" opacity="0.3" />
        </svg>
      );
  }
}

export function TabBar({ tabs, activeTabId, onTabSelect, onTabClose, onNewTab, layoutMode, onLayoutChange }: TabBarProps) {
  const tabsContainerRef = useRef<HTMLDivElement>(null);

  // Scroll active tab into view
  useEffect(() => {
    if (tabsContainerRef.current) {
      const activeTab = tabsContainerRef.current.querySelector('.tab-item.active');
      if (activeTab) {
        activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
      }
    }
  }, [activeTabId]);

  const handleKeyDown = (e: React.KeyboardEvent, tabId: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onTabSelect(tabId);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onTabClose(tabId);
    }
  };

  return (
    <div className="tab-bar">
      <div className="tabs-container" ref={tabsContainerRef}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab-item ${activeTabId === tab.id ? 'active' : ''}`}
            onClick={() => onTabSelect(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, tab.id)}
            tabIndex={0}
            role="tab"
            aria-selected={activeTabId === tab.id}
          >
            <span className="tab-icon">🖥️</span>
            <span className="tab-name" title={`${tab.serverName} (${tab.currentDir})`}>
              {tab.serverName}
            </span>
            {tab.currentDir && (
              <span className="tab-dir">:{tab.currentDir}</span>
            )}
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                onTabClose(tab.id);
              }}
              title="关闭标签"
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <button className="tab-new" onClick={onNewTab} title="新建标签 (Cmd+T)">
        +
      </button>
      <div className="layout-separator" />
      <div className="layout-buttons">
        {layoutOptions.map(({ mode, title }) => (
          <button
            key={mode}
            className={`layout-btn ${layoutMode === mode ? 'active' : ''}`}
            onClick={() => onLayoutChange(mode)}
            title={title}
          >
            <LayoutIcon mode={mode} />
          </button>
        ))}
      </div>
    </div>
  );
}
