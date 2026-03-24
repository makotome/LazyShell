import { useState, useCallback, useRef, useEffect } from 'react';

interface ResizablePanelsProps {
  left: React.ReactNode;
  center: React.ReactNode;
  right: React.ReactNode;
  defaultLeftWidth?: number;
  defaultRightWidth?: number;
  minLeftWidth?: number;
  maxLeftWidth?: number;
  minRightWidth?: number;
  maxRightWidth?: number;
}

export function ResizablePanels({
  left,
  center,
  right,
  defaultLeftWidth = 280,
  defaultRightWidth = 350,
  minLeftWidth = 200,
  maxLeftWidth = 400,
  minRightWidth = 280,
  maxRightWidth = 500,
}: ResizablePanelsProps) {
  const [leftWidth, setLeftWidth] = useState(defaultLeftWidth);
  const [rightWidth, setRightWidth] = useState(defaultRightWidth);
  const [isLeftCollapsed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isDraggingLeft = useRef(false);
  const isDraggingRight = useRef(false);

  const handleMouseDownLeft = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingLeft.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleMouseDownRight = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRight.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();

      if (isDraggingLeft.current) {
        const newWidth = e.clientX - rect.left;
        if (newWidth >= minLeftWidth && newWidth <= maxLeftWidth) {
          setLeftWidth(newWidth);
        }
      }

      if (isDraggingRight.current) {
        const newWidth = rect.right - e.clientX;
        if (newWidth >= minRightWidth && newWidth <= maxRightWidth) {
          setRightWidth(newWidth);
        }
      }
    };

    const handleMouseUp = () => {
      isDraggingLeft.current = false;
      isDraggingRight.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [minLeftWidth, maxLeftWidth, minRightWidth, maxRightWidth]);

  return (
    <div className="resizable-panels" ref={containerRef}>
      {!isLeftCollapsed && (
        <>
          <div className="panel-left" style={{ width: leftWidth }}>
            {left}
          </div>
          <div
            className="resize-handle resize-handle-left"
            onMouseDown={handleMouseDownLeft}
          />
        </>
      )}
      <div className="panel-center">{center}</div>
      <div
        className="resize-handle resize-handle-right"
        onMouseDown={handleMouseDownRight}
      />
      <div className="panel-right" style={{ width: rightWidth }}>
        {right}
      </div>
    </div>
  );
}
