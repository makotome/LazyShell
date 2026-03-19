import { useRef, useEffect } from 'react';
import type { ServerTab } from '../types';

interface TabBarProps {
  tabs: ServerTab[];
  activeTabId: string;
  onTabSelect: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onNewTab: () => void;
}

export function TabBar({ tabs, activeTabId, onTabSelect, onTabClose, onNewTab }: TabBarProps) {
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
        {tabs.map((tab, index) => (
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
            {tabs.length > 1 && (
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
            )}
          </div>
        ))}
      </div>
      <button className="tab-new" onClick={onNewTab} title="新建标签 (Cmd+T)">
        +
      </button>
    </div>
  );
}
