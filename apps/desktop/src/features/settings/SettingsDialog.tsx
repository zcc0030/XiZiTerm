import * as React from 'react';
import { Palette, ShieldCheck } from 'lucide-react';
import type { TerminalCursorStyle } from '@xiziterm/shared';
import { ModalDialog } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useVaultStore } from '@/stores/vault.store';
import { ThemeGridSelector } from '@/features/theme/ThemeSwitcher';

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

const FONT_PRESETS = [
  "'JetBrains Mono', 'Cascadia Code', 'Fira Code', Consolas, monospace",
  "'Cascadia Code', Consolas, monospace",
  "'Fira Code', Consolas, monospace",
  "Consolas, 'Courier New', monospace",
];

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const preferences = useVaultStore((s) => s.preferences);
  const status = useVaultStore((s) => s.status);
  const updatePreferences = useVaultStore((s) => s.updatePreferences);

  const [fontFamily, setFontFamily] = React.useState(preferences.fontFamily);
  const [fontSize, setFontSize] = React.useState(preferences.fontSize);
  const [lineHeight, setLineHeight] = React.useState(preferences.lineHeight);
  const [cursorStyle, setCursorStyle] = React.useState<TerminalCursorStyle>(
    preferences.cursorStyle
  );
  const [cursorBlink, setCursorBlink] = React.useState(preferences.cursorBlink);
  const [copyOnSelect, setCopyOnSelect] = React.useState(
    preferences.copyOnSelect
  );
  const [rightClickPaste, setRightClickPaste] = React.useState(
    preferences.rightClickPaste
  );
  const [autoReconnectPrompt, setAutoReconnectPrompt] = React.useState(
    preferences.autoReconnectPrompt
  );
  const [scrollback, setScrollback] = React.useState(preferences.scrollback);

  React.useEffect(() => {
    if (!open) return;
    setFontFamily(preferences.fontFamily);
    setFontSize(preferences.fontSize);
    setLineHeight(preferences.lineHeight);
    setCursorStyle(preferences.cursorStyle);
    setCursorBlink(preferences.cursorBlink);
    setCopyOnSelect(preferences.copyOnSelect);
    setRightClickPaste(preferences.rightClickPaste);
    setAutoReconnectPrompt(preferences.autoReconnectPrompt);
    setScrollback(preferences.scrollback);
  }, [open, preferences]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await updatePreferences({
      fontFamily,
      fontSize: Math.min(28, Math.max(10, Number(fontSize) || 14)),
      lineHeight: Math.min(2.0, Math.max(1.0, Number(lineHeight) || 1.25)),
      cursorStyle,
      cursorBlink,
      copyOnSelect,
      rightClickPaste,
      autoReconnectPrompt,
      scrollback: Math.min(50000, Math.max(500, Number(scrollback) || 5000)),
    });
    onClose();
  };

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      title="主题外观与终端偏好设置"
      description="主题切换实时同步至应用 UI 与所有终端窗格；终端参数加密保存于本地保险库"
      className="max-w-2xl"
    >
      <form onSubmit={handleSave} className="space-y-4">
        {/* 7-Theme Visual Switcher */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-1.5 text-xs font-semibold text-theme-primary">
              <Palette className="h-3.5 w-3.5 text-theme-accent" />
              界面与终端主题配色（7 套内置方案）
            </label>
            <span className="text-[11px] text-theme-muted">点击立即预览生效</span>
          </div>
          <ThemeGridSelector />
        </div>

        <div className="border-t border-theme-border pt-3 space-y-1.5">
          <label className="text-xs font-medium text-theme-primary">
            终端字体
          </label>
          <Input
            value={fontFamily}
            onChange={(e) => setFontFamily(e.target.value)}
            className="font-mono text-xs"
          />
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {FONT_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setFontFamily(preset)}
                className="rounded border border-theme-border bg-theme-elevated px-2 py-0.5 text-[11px] text-theme-muted transition-colors hover:border-theme-accent/60 hover:text-theme-accent"
              >
                {preset.split(',')[0].replace(/'/g, '')}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-theme-primary">
              字号 (px)
            </label>
            <Input
              type="number"
              min={10}
              max={28}
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
              className="font-mono"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-theme-primary">
              行高
            </label>
            <Input
              type="number"
              step={0.05}
              min={1.0}
              max={2.0}
              value={lineHeight}
              onChange={(e) => setLineHeight(Number(e.target.value))}
              className="font-mono"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-theme-primary">
              历史缓冲行数
            </label>
            <Input
              type="number"
              min={500}
              max={50000}
              step={500}
              value={scrollback}
              onChange={(e) => setScrollback(Number(e.target.value))}
              className="font-mono"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-theme-primary">
            光标样式
          </label>
          <div className="flex gap-2">
            {(['bar', 'block', 'underline'] as TerminalCursorStyle[]).map(
              (style) => (
                <button
                  key={style}
                  type="button"
                  onClick={() => setCursorStyle(style)}
                  className={`flex-1 rounded-md border py-1.5 text-xs font-medium capitalize transition-colors ${
                    cursorStyle === style
                      ? 'border-theme-accent bg-theme-accent-soft text-theme-accent'
                      : 'border-theme-border bg-theme-elevated/60 text-theme-muted hover:text-theme-primary'
                  }`}
                >
                  {style === 'bar'
                    ? '竖线 (Bar)'
                    : style === 'block'
                      ? '方块 (Block)'
                      : '下划线 (Underline)'}
                </button>
              )
            )}
          </div>
        </div>

        <div className="space-y-2 rounded-lg border border-theme-border bg-theme-input p-3 text-xs">
          <label className="flex cursor-pointer items-center justify-between">
            <span className="text-theme-primary">光标闪烁</span>
            <input
              type="checkbox"
              checked={cursorBlink}
              onChange={(e) => setCursorBlink(e.target.checked)}
              className="h-4 w-4 accent-[var(--accent-primary)]"
            />
          </label>
          <label className="flex cursor-pointer items-center justify-between">
            <span className="text-theme-primary">终端内选中文本自动复制</span>
            <input
              type="checkbox"
              checked={copyOnSelect}
              onChange={(e) => setCopyOnSelect(e.target.checked)}
              className="h-4 w-4 accent-[var(--accent-primary)]"
            />
          </label>
          <label className="flex cursor-pointer items-center justify-between">
            <span className="text-theme-primary">鼠标右键快速粘贴</span>
            <input
              type="checkbox"
              checked={rightClickPaste}
              onChange={(e) => setRightClickPaste(e.target.checked)}
              className="h-4 w-4 accent-[var(--accent-primary)]"
            />
          </label>
          <label className="flex cursor-pointer items-center justify-between">
            <span className="text-theme-primary">断线时显示自动重连提示条</span>
            <input
              type="checkbox"
              checked={autoReconnectPrompt}
              onChange={(e) => setAutoReconnectPrompt(e.target.checked)}
              className="h-4 w-4 accent-[var(--accent-primary)]"
            />
          </label>
        </div>

        {status && (
          <div className="rounded-lg border border-theme-border bg-theme-input p-3 text-[11px] text-theme-muted">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-theme-online">
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>本地加密保险库信息</span>
            </div>
            <div className="space-y-0.5 font-mono">
              <div>
                KDF: {status.kdfAlgorithm} ({status.kdfIterations?.toLocaleString()}{' '}
                iterations)
              </div>
              <div className="truncate" title={status.vaultDir}>
                Vault 目录: {status.vaultDir}
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-theme-border pt-3">
          <Button type="button" variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button type="submit">保存设置</Button>
        </div>
      </form>
    </ModalDialog>
  );
}
