import * as React from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Columns2,
  Loader2,
  RefreshCw,
  Rows2,
  Search,
  X,
} from 'lucide-react';
import type { SplitDirection } from '@xiziterm/shared';
import { Button } from '@/components/ui/button';
import { useVaultStore } from '@/stores/vault.store';
import { useTerminalStore } from '@/stores/terminal.store';
import { useThemeStore } from '@/stores/theme.store';
import { TERMINAL_THEMES } from '@/theme/themes';

interface XTermPaneProps {
  tabId: string;
  paneId: string;
  sessionId: string;
  hostId: string;
  hostName: string;
  hostAddress: string;
  isActiveTab: boolean;
  isActivePane: boolean;
  canClosePane: boolean;
  onFocusPane: () => void;
  onSplit: (direction: SplitDirection) => void;
  onClose: () => void;
}

export function XTermPane({
  paneId,
  sessionId,
  hostId,
  hostName,
  hostAddress,
  isActiveTab,
  isActivePane,
  canClosePane,
  onFocusPane,
  onSplit,
  onClose,
}: XTermPaneProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const termRef = React.useRef<XTerm | null>(null);
  const fitAddonRef = React.useRef<FitAddon | null>(null);
  const searchAddonRef = React.useRef<SearchAddon | null>(null);
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);

  const preferences = useVaultStore((s) => s.preferences);
  const prefsRef = React.useRef(preferences);
  prefsRef.current = preferences;

  const themeId = useThemeStore((s) => s.themeId);
  const themeIdRef = React.useRef(themeId);
  themeIdRef.current = themeId;

  const sessionStatus = useTerminalStore((s) => s.sessionStatuses[sessionId]);
  const setSessionStatus = useTerminalStore((s) => s.setSessionStatus);

  const [searchOpen, setSearchOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [reconnecting, setReconnecting] = React.useState(false);

  const connectSession = React.useCallback(async () => {
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) return;

    try {
      fitAddon.fit();
    } catch {
      // ignore if hidden
    }

    const cols = term.cols || 80;
    const rows = term.rows || 24;

    setSessionStatus(sessionId, 'connecting', `正在连接 ${hostAddress} ...`);
    term.writeln(
      `\x1b[36m[XiZiTerm]\x1b[0m 正在连接 \x1b[1m${hostAddress}\x1b[0m ...`
    );

    const result = await window.xiziterm.ssh.connect({
      sessionId,
      hostId,
      cols,
      rows,
    });

    if (!result.ok) {
      const msg = result.error ?? 'SSH 连接失败';
      setSessionStatus(sessionId, 'error', msg);
      term.writeln(`\r\n\x1b[31m[连接失败]\x1b[0m ${msg}`);
    }
  }, [hostAddress, hostId, sessionId, setSessionStatus]);

  const handleReconnect = React.useCallback(async () => {
    setReconnecting(true);
    try {
      termRef.current?.writeln('\r\n\x1b[33m[XiZiTerm]\x1b[0m 正在尝试重新连接...');
      await connectSession();
      termRef.current?.focus();
    } finally {
      setReconnecting(false);
    }
  }, [connectSession]);

  // Initialize xterm.js and subscribe to SSH IPC streams
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const initialPrefs = prefsRef.current;
    const term = new XTerm({
      theme: { ...TERMINAL_THEMES[themeIdRef.current] },
      fontFamily: initialPrefs.fontFamily,
      fontSize: initialPrefs.fontSize,
      lineHeight: initialPrefs.lineHeight,
      cursorStyle: initialPrefs.cursorStyle,
      cursorBlink: initialPrefs.cursorBlink,
      scrollback: initialPrefs.scrollback,
      allowProposedApi: true,
      macOptionIsMeta: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const searchAddon = new SearchAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.loadAddon(searchAddon);
    term.open(container);

    termRef.current = term;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    const safeFitAndResize = () => {
      if (!container || container.clientWidth === 0 || container.clientHeight === 0) {
        return;
      }
      try {
        fitAddon.fit();
        window.xiziterm.ssh.resize({
          sessionId,
          cols: term.cols,
          rows: term.rows,
        });
      } catch {
        // ignore transient layout errors
      }
    };

    requestAnimationFrame(() => {
      safeFitAndResize();
      term.focus();
    });

    // Keyboard shortcuts: Ctrl+Shift+C (copy), Ctrl+Shift+V (paste), Ctrl+Shift+F (search)
    term.attachCustomKeyEventHandler((ev) => {
      const key = ev.key.toLowerCase();

      if (ev.ctrlKey && ev.shiftKey && key === 'c') {
        ev.preventDefault();
        if (ev.type === 'keydown') {
          const selected = term.getSelection();
          if (selected) {
            void navigator.clipboard.writeText(selected);
          }
        }
        return false;
      }

      if (ev.ctrlKey && ev.shiftKey && key === 'v') {
        // Prevent Electron/Chromium native Ctrl+Shift+V pasteAndMatchStyle from double-pasting
        ev.preventDefault();
        if (ev.type === 'keydown') {
          void navigator.clipboard.readText().then((text) => {
            if (text) {
              term.paste(text);
            }
          });
        }
        return false;
      }

      if (ev.type !== 'keydown') return true;

      if (ev.ctrlKey && ev.shiftKey && key === 'f') {
        ev.preventDefault();
        setSearchOpen((prev) => {
          const next = !prev;
          if (next) {
            setTimeout(() => searchInputRef.current?.focus(), 20);
          }
          return next;
        });
        return false;
      }

      return true;
    });

    const dataDisposable = term.onData((data) => {
      window.xiziterm.ssh.write(sessionId, data);
    });

    const selectionDisposable = term.onSelectionChange(() => {
      if (prefsRef.current.copyOnSelect) {
        const selected = term.getSelection();
        if (selected) {
          void navigator.clipboard.writeText(selected);
        }
      }
    });

    const offSshData = window.xiziterm.ssh.onData((ev) => {
      if (ev.sessionId === sessionId) {
        term.write(ev.data);
      }
    });

    const offSshState = window.xiziterm.ssh.onState((ev) => {
      if (ev.sessionId === sessionId) {
        setSessionStatus(ev.sessionId, ev.state, ev.message);
        if (ev.state === 'disconnected') {
          term.writeln(
            `\r\n\x1b[33m[XiZiTerm]\x1b[0m ${ev.message ?? '会话已断开'}`
          );
        }
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      safeFitAndResize();
    });
    resizeObserver.observe(container);

    // Initiate SSH connection
    void connectSession();

    return () => {
      resizeObserver.disconnect();
      offSshData();
      offSshState();
      dataDisposable.dispose();
      selectionDisposable.dispose();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [connectSession, sessionId, setSessionStatus]);

  // Apply live theme updates across all terminal instances
  React.useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = { ...TERMINAL_THEMES[themeId] };
  }, [themeId]);

  // Apply live preference updates to active terminal
  React.useEffect(() => {
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term) return;

    term.options.fontFamily = preferences.fontFamily;
    term.options.fontSize = preferences.fontSize;
    term.options.lineHeight = preferences.lineHeight;
    term.options.cursorStyle = preferences.cursorStyle;
    term.options.cursorBlink = preferences.cursorBlink;
    term.options.scrollback = preferences.scrollback;

    if (fitAddon && isActiveTab) {
      requestAnimationFrame(() => {
        try {
          fitAddon.fit();
          window.xiziterm.ssh.resize({
            sessionId,
            cols: term.cols,
            rows: term.rows,
          });
        } catch {
          // ignore
        }
      });
    }
  }, [preferences, isActiveTab, sessionId]);

  // Refit and focus when becoming active tab/pane
  React.useEffect(() => {
    if (!isActiveTab) return;
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term || !fitAddon) return;

    const timer = window.setTimeout(() => {
      try {
        fitAddon.fit();
        window.xiziterm.ssh.resize({
          sessionId,
          cols: term.cols,
          rows: term.rows,
        });
        if (isActivePane) {
          term.focus();
        }
      } catch {
        // ignore
      }
    }, 30);

    return () => window.clearTimeout(timer);
  }, [isActiveTab, isActivePane, sessionId]);

  const handleContextMenu = (e: React.MouseEvent) => {
    if (!preferences.rightClickPaste) return;
    e.preventDefault();
    void navigator.clipboard.readText().then((text) => {
      if (text) {
        termRef.current?.paste(text);
        termRef.current?.focus();
      }
    });
  };

  const runSearch = (direction: 'next' | 'prev') => {
    if (!searchQuery || !searchAddonRef.current) return;
    if (direction === 'next') {
      searchAddonRef.current.findNext(searchQuery);
    } else {
      searchAddonRef.current.findPrevious(searchQuery);
    }
  };

  const state = sessionStatus?.state ?? 'connecting';
  const showReconnectBanner =
    preferences.autoReconnectPrompt &&
    (state === 'disconnected' || state === 'error');

  const dotColor =
    state === 'connected'
      ? 'bg-theme-online'
      : state === 'connecting'
        ? 'bg-theme-warn animate-pulse'
        : 'bg-theme-error';

  return (
    <div
      data-pane-id={paneId}
      onMouseDown={onFocusPane}
      className={`nt-pane-card relative flex h-full w-full flex-col overflow-hidden bg-theme-base ${
        canClosePane
          ? isActivePane
            ? 'nt-active-pane border border-theme-accent/45'
            : 'border border-theme-border/70'
          : 'border-0'
      }`}
    >
      {/* Pane Mini Header */}
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-theme-border bg-theme-sidebar px-2.5 text-[11px]">
        <div className="flex min-w-0 items-center gap-2">
          <span className={`h-2 w-2 shrink-0 rounded-full ${dotColor}`} />
          <span className="truncate font-medium text-theme-primary">
            {hostName}
          </span>
          <span className="hidden truncate font-mono text-[10px] text-theme-muted sm:inline">
            {hostAddress}
          </span>
        </div>

        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setSearchOpen((v) => {
                const next = !v;
                if (next) setTimeout(() => searchInputRef.current?.focus(), 20);
                return next;
              });
            }}
            title="终端搜索 (Ctrl+Shift+F)"
            className="rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-primary"
          >
            <Search className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSplit('horizontal');
            }}
            title="左右分屏"
            className="rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-accent"
          >
            <Columns2 className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onSplit('vertical');
            }}
            title="上下分屏"
            className="rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-accent"
          >
            <Rows2 className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void handleReconnect();
            }}
            title="重新连接"
            className="rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-online"
          >
            <RefreshCw
              className={`h-3 w-3 ${reconnecting ? 'animate-spin' : ''}`}
            />
          </button>
          {canClosePane && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
              title="关闭当前分屏"
              className="rounded p-1 text-theme-muted hover:bg-theme-error-soft hover:text-theme-error"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {/* Disconnect / Error Reconnect Banner */}
      {showReconnectBanner && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-theme-warn/35 bg-theme-warn-soft px-3 py-1.5 text-xs text-theme-primary">
          <div className="flex min-w-0 items-center gap-2">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-theme-warn" />
            <span className="truncate">
              {sessionStatus?.message || 'SSH 会话已断开，是否立即重新连接？'}
            </span>
          </div>
          <Button
            size="sm"
            variant="default"
            onClick={() => void handleReconnect()}
            disabled={reconnecting}
            className="h-6 shrink-0 px-2.5 text-[11px]"
          >
            {reconnecting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            一键重连
          </Button>
        </div>
      )}

      {/* Terminal Search Bar */}
      {searchOpen && (
        <div
          style={{ boxShadow: 'var(--panel-shadow)' }}
          className="absolute right-3 top-9 z-20 flex items-center gap-1 rounded-lg border border-theme-border bg-theme-sidebar p-1.5"
        >
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              if (e.target.value) {
                searchAddonRef.current?.findNext(e.target.value);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                runSearch(e.shiftKey ? 'prev' : 'next');
              } else if (e.key === 'Escape') {
                setSearchOpen(false);
                termRef.current?.focus();
              }
            }}
            placeholder="搜索终端输出..."
            className="h-6 w-44 rounded border border-theme-border bg-theme-input px-2 text-xs text-theme-primary outline-none focus:border-theme-accent"
          />
          <button
            type="button"
            onClick={() => runSearch('prev')}
            className="rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-primary"
            title="上一个"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => runSearch('next')}
            className="rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-primary"
            title="下一个"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              setSearchOpen(false);
              termRef.current?.focus();
            }}
            className="rounded p-1 text-theme-muted hover:bg-theme-hover hover:text-theme-primary"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* XTerm Mount Target */}
      <div
        ref={containerRef}
        onContextMenu={handleContextMenu}
        className="min-h-0 flex-1 overflow-hidden bg-theme-base"
      />
    </div>
  );
}
