import * as React from 'react';
import { Check, Palette } from 'lucide-react';
import { THEMES, type ThemeDefinition } from '@/theme/themes';
import { useThemeStore } from '@/stores/theme.store';

function ThemeSwatchPill({
  swatches,
}: {
  swatches: ThemeDefinition['swatches'];
}) {
  return (
    <div className="flex h-4 w-12 shrink-0 overflow-hidden rounded border border-theme-border shadow-inner">
      {swatches.map((hex, idx) => (
        <span
          key={idx}
          className="h-full flex-1"
          style={{ backgroundColor: hex }}
        />
      ))}
    </div>
  );
}

export function ThemeDropdown({ compact = false }: { compact?: boolean }) {
  const themeId = useThemeStore((s) => s.themeId);
  const currentTheme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);

  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={`切换主题（当前：${currentTheme.name}）`}
        className={`flex h-7 items-center gap-1.5 rounded border px-2 text-xs font-medium transition-colors ${
          open
            ? 'border-theme-accent bg-theme-accent-soft text-theme-accent'
            : 'border-theme-border bg-theme-elevated/70 text-theme-primary hover:border-theme-accent/60 hover:text-theme-accent'
        }`}
      >
        <Palette className="h-3.5 w-3.5 text-theme-accent" />
        {!compact && (
          <span className="hidden sm:inline">{currentTheme.name}</span>
        )}
        <span
          className="h-2.5 w-2.5 rounded-full border border-black/20"
          style={{ backgroundColor: currentTheme.swatches[2] }}
        />
      </button>

      {open && (
        <div
          style={{ boxShadow: 'var(--panel-shadow)' }}
          className="absolute right-0 top-9 z-50 w-72 overflow-hidden rounded-xl border border-theme-border bg-theme-sidebar p-1.5"
        >
          <div className="px-2.5 py-1.5 text-[11px] font-semibold text-theme-muted">
            主题配色方案（UI 与终端同步）
          </div>
          <div className="space-y-0.5">
            {THEMES.map((item) => {
              const active = item.id === themeId;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setTheme(item.id);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
                    active
                      ? 'bg-theme-accent-soft text-theme-primary'
                      : 'text-theme-primary hover:bg-theme-hover'
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <ThemeSwatchPill swatches={item.swatches} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-xs font-medium">
                        <span>{item.name}</span>
                        <span className="font-mono text-[10px] text-theme-muted">
                          {item.badge}
                        </span>
                      </div>
                      <div className="truncate text-[10px] text-theme-muted">
                        {item.description}
                      </div>
                    </div>
                  </div>
                  {active && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-theme-accent" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function ThemeGridSelector() {
  const themeId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {THEMES.map((item) => {
        const active = item.id === themeId;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => setTheme(item.id)}
            className={`flex flex-col items-start gap-1.5 rounded-lg border p-2.5 text-left transition-all ${
              active
                ? 'border-theme-accent bg-theme-accent-soft ring-1 ring-inset ring-theme-accent/40'
                : 'border-theme-border bg-theme-elevated/60 hover:border-theme-accent/40 hover:bg-theme-hover'
            }`}
          >
            <div className="flex w-full items-center justify-between gap-1">
              <span className="text-xs font-semibold text-theme-primary">
                {item.name}
              </span>
              {active && (
                <Check className="h-3.5 w-3.5 shrink-0 text-theme-accent" />
              )}
            </div>
            <ThemeSwatchPill swatches={item.swatches} />
            <span className="line-clamp-2 text-[10px] leading-snug text-theme-muted">
              {item.description}
            </span>
          </button>
        );
      })}
    </div>
  );
}
