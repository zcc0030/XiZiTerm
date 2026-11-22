import * as React from 'react';
import { Check, FileCode2, Loader2, Save, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface SftpFileEditorDialogProps {
  open: boolean;
  sessionId: string;
  filePath: string | null;
  initialContent: string;
  onClose: () => void;
  onSaved: () => void;
}

export function SftpFileEditorDialog({
  open,
  sessionId,
  filePath,
  initialContent,
  onClose,
  onSaved,
}: SftpFileEditorDialogProps) {
  const [content, setContent] = React.useState(initialContent);
  const [savedSnapshot, setSavedSnapshot] = React.useState(initialContent);
  const [saving, setSaving] = React.useState(false);
  const [savedNotice, setSavedNotice] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (open) {
      setContent(initialContent);
      setSavedSnapshot(initialContent);
      setError(null);
      setSavedNotice(false);
    }
  }, [open, initialContent, filePath]);

  const isDirty = content !== savedSnapshot;
  const lineCount = React.useMemo(
    () => Math.max(1, content.split('\n').length),
    [content]
  );

  const handleSave = React.useCallback(async () => {
    if (!filePath || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await window.xiziterm.sftp.writeText(
        sessionId,
        filePath,
        content
      );
      if (!res.ok) {
        setError(res.error ?? '保存失败');
        return;
      }
      setSavedSnapshot(content);
      setSavedNotice(true);
      onSaved();
      window.setTimeout(() => setSavedNotice(false), 2000);
    } finally {
      setSaving(false);
    }
  }, [content, filePath, onSaved, saving, sessionId]);

  const handleClose = React.useCallback(() => {
    if (isDirty) {
      const ok = window.confirm('当前文件有未保存的修改，确定放弃并关闭吗？');
      if (!ok) return;
    }
    onClose();
  }, [isDirty, onClose]);

  React.useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void handleSave();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, handleSave, handleClose]);

  const handleTextareaKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement>
  ) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const target = e.currentTarget;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const next = `${content.slice(0, start)}  ${content.slice(end)}`;
      setContent(next);
      requestAnimationFrame(() => {
        target.selectionStart = target.selectionEnd = start + 2;
      });
    }
  };

  const handleScroll = () => {
    if (textareaRef.current && gutterRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  if (!open || !filePath) return null;

  const fileName = filePath.split('/').pop() || filePath;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm">
      <div
        style={{ boxShadow: 'var(--panel-shadow)' }}
        className="flex h-[82vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-theme-border bg-theme-sidebar"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-theme-border bg-theme-elevated/65 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <FileCode2 className="h-4 w-4 shrink-0 text-theme-accent" />
            <span className="truncate text-sm font-semibold text-theme-primary">
              {fileName}
            </span>
            {isDirty && (
              <span className="rounded bg-theme-warn-soft px-1.5 py-0.5 text-[10px] font-medium text-theme-warn">
                未保存
              </span>
            )}
            {savedNotice && (
              <span className="inline-flex items-center gap-1 rounded bg-theme-online-soft px-1.5 py-0.5 text-[10px] font-medium text-theme-online">
                <Check className="h-3 w-3" />
                已保存至远程服务器
              </span>
            )}
            <span
              className="hidden truncate font-mono text-[11px] text-theme-muted md:inline"
              title={filePath}
            >
              {filePath}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => void handleSave()}
              disabled={saving || !isDirty}
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              保存 (Ctrl+S)
            </Button>
            <button
              type="button"
              onClick={handleClose}
              className="rounded-md p-1.5 text-theme-muted hover:bg-theme-hover hover:text-theme-primary"
              title="关闭编辑器"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {error && (
          <div className="border-b border-theme-error/40 bg-theme-error-soft px-4 py-2 text-xs text-theme-error">
            {error}
          </div>
        )}

        {/* Monospace Editor with synced line-number gutter */}
        <div className="flex min-h-0 flex-1 overflow-hidden bg-theme-base">
          <div
            ref={gutterRef}
            aria-hidden="true"
            className="w-12 shrink-0 select-none overflow-hidden border-r border-theme-border bg-theme-sidebar py-3 pr-2.5 text-right font-mono text-xs leading-6 text-theme-muted"
          >
            {Array.from({ length: lineCount }, (_, idx) => (
              <div key={idx}>{idx + 1}</div>
            ))}
          </div>
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleTextareaKeyDown}
            onScroll={handleScroll}
            spellCheck={false}
            className="h-full flex-1 resize-none bg-transparent p-3 font-mono text-xs leading-6 text-theme-primary outline-none"
          />
        </div>

        {/* Status Footer */}
        <div className="flex items-center justify-between border-t border-theme-border bg-theme-elevated/65 px-4 py-1.5 font-mono text-[11px] text-theme-muted">
          <span>UTF-8 · LF · 2 空格缩进</span>
          <span>
            {lineCount} 行 · {content.length} 字符
          </span>
        </div>
      </div>
    </div>
  );
}
