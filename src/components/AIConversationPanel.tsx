import { memo, type RefObject } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { ChatMessage } from '../types';

interface AIConversationPanelProps {
  messages: ChatMessage[];
  isLoading: boolean;
  loadingMoreHistory: boolean;
  clarificationContext: string | null;
  chatContainerRef: RefObject<HTMLDivElement | null>;
  messagesEndRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
}

const markdownSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    a: [
      ...(defaultSchema.attributes?.a || []),
      ['target'],
      ['rel'],
    ],
  },
};

function parseLegacySource(content: string): { content: string; sourceLabel?: string } {
  const match = content.match(/^(.*)\s\[(.+)\]$/);
  if (!match) {
    return { content };
  }

  return {
    content: match[1].trim(),
    sourceLabel: match[2].trim(),
  };
}

export const AIConversationPanel = memo(function AIConversationPanel({
  messages,
  isLoading,
  loadingMoreHistory,
  clarificationContext,
  chatContainerRef,
  messagesEndRef,
  onScroll,
}: AIConversationPanelProps) {
  return (
    <div className="chat-messages" ref={chatContainerRef} onScroll={onScroll}>
      {loadingMoreHistory && (
        <div className="history-loading-indicator">加载更多历史...</div>
      )}
      {messages.map((msg) => (
        <div key={msg.id} className={`message message-${msg.role}${msg.id === 'history-divider' ? ' history-divider' : ''}`}>
          {(() => {
            const parsed = parseLegacySource(msg.content);
            const displayContent = msg.sourceLabel ? msg.content : parsed.content;
            const sourceLabel = msg.sourceLabel || parsed.sourceLabel;
            return (
              <>
                <div className="message-role">
                  <span>{msg.role === 'user' ? '你' : '智能助手'}</span>
                  {sourceLabel ? <span className="message-source-badge">{sourceLabel}</span> : null}
                </div>
                <div className="message-content">
                  {msg.role === 'ai' && msg.id !== 'history-divider' ? (
                    <ReactMarkdown
                      rehypePlugins={[[rehypeSanitize, markdownSchema]]}
                      components={{
                        a: ({ href, children }) => (
                          <a
                            href={href}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            {children}
                          </a>
                        ),
                      }}
                    >
                      {displayContent}
                    </ReactMarkdown>
                  ) : (
                    displayContent
                  )}
                  {msg.command && (
                    <div className="command-preview">
                      <code>{msg.command}</code>
                    </div>
                  )}
                  {msg.options && msg.options.length > 0 && (
                    <div className="message-option-list">
                      {msg.options.map((option, index) => (
                        <div key={`${option.command}-${index}`} className={`message-option-item danger-${option.isDangerous ? 'red' : 'green'}`}>
                          <div className="message-option-header">
                            <span className={`danger-badge danger-${option.isDangerous ? 'red' : 'green'}`}>
                              {option.isDangerous ? '危险' : '安全'}
                            </span>
                            <span className="message-option-title">{option.description}</span>
                          </div>
                          <div className="message-option-command">
                            <code>{option.command}</code>
                          </div>
                          {option.reason ? <div className="message-option-reason">{option.reason}</div> : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            );
          })()}
        </div>
      ))}
      {isLoading && (
        <div className="message message-ai loading">
          <div className="message-role">智能助手</div>
          <div className="message-content">思考中...</div>
        </div>
      )}
      {clarificationContext && (
        <div className="clarification-hint">
          需要更多信息，请在下方补充说明。
        </div>
      )}
      <div ref={messagesEndRef} />
    </div>
  );
});
