import * as React from 'react';
import type { SplitDirection, TerminalSplitNode } from '@xiziterm/shared';
import { XTermPane } from './XTermPane';

interface SplitPaneRendererProps {
  tabId: string;
  node: TerminalSplitNode;
  isActiveTab: boolean;
  activePaneId: string;
  isRootSinglePane: boolean;
  onFocusPane: (paneId: string) => void;
  onSplitPane: (paneId: string, hostId: string, direction: SplitDirection) => void;
  onClosePane: (paneId: string) => void;
  onResizeSplit: (splitId: string, ratio: number) => void;
}

export function SplitPaneRenderer({
  tabId,
  node,
  isActiveTab,
  activePaneId,
  isRootSinglePane,
  onFocusPane,
  onSplitPane,
  onClosePane,
  onResizeSplit,
}: SplitPaneRendererProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  if (node.type === 'pane') {
    return (
      <XTermPane
        key={node.sessionId}
        tabId={tabId}
        paneId={node.paneId}
        sessionId={node.sessionId}
        hostId={node.hostId}
        hostName={node.hostName}
        hostAddress={node.hostAddress}
        shellId={node.shellId}
        isActiveTab={isActiveTab}
        isActivePane={activePaneId === node.paneId}
        canClosePane={!isRootSinglePane}
        onFocusPane={() => onFocusPane(node.paneId)}
        onSplit={(dir) => onSplitPane(node.paneId, node.hostId, dir)}
        onClose={() => onClosePane(node.paneId)}
      />
    );
  }

  const isHorizontal = node.direction === 'horizontal';

  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const onMove = (moveEvent: MouseEvent) => {
      if (isHorizontal) {
        const nextRatio = (moveEvent.clientX - rect.left) / rect.width;
        onResizeSplit(node.id, nextRatio);
      } else {
        const nextRatio = (moveEvent.clientY - rect.top) / rect.height;
        onResizeSplit(node.id, nextRatio);
      }
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
    };

    document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      ref={containerRef}
      className={`flex h-full w-full min-h-0 min-w-0 ${
        isHorizontal ? 'flex-row' : 'flex-col'
      }`}
    >
      <div
        style={{ flexBasis: `${node.ratio * 100}%` }}
        className="min-h-0 min-w-0 flex-shrink-0 flex-grow-0 overflow-hidden"
      >
        <SplitPaneRenderer
          tabId={tabId}
          node={node.first}
          isActiveTab={isActiveTab}
          activePaneId={activePaneId}
          isRootSinglePane={false}
          onFocusPane={onFocusPane}
          onSplitPane={onSplitPane}
          onClosePane={onClosePane}
          onResizeSplit={onResizeSplit}
        />
      </div>

      {/* Resizable Divider */}
      <div
        onMouseDown={handleDragStart}
        className={`shrink-0 bg-theme-border/60 transition-colors hover:bg-theme-accent ${
          isHorizontal ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize'
        }`}
      />

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <SplitPaneRenderer
          tabId={tabId}
          node={node.second}
          isActiveTab={isActiveTab}
          activePaneId={activePaneId}
          isRootSinglePane={false}
          onFocusPane={onFocusPane}
          onSplitPane={onSplitPane}
          onClosePane={onClosePane}
          onResizeSplit={onResizeSplit}
        />
      </div>
    </div>
  );
}
