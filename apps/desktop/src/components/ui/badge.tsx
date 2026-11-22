import * as React from 'react';
import { cn } from '@/lib/utils';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'cyan' | 'emerald' | 'amber' | 'rose';
}

const variantClasses: Record<NonNullable<BadgeProps['variant']>, string> = {
  default: 'bg-theme-elevated text-theme-muted border-theme-border',
  cyan: 'bg-theme-accent-soft text-theme-accent border-theme-accent/35',
  emerald: 'bg-theme-online-soft text-theme-online border-theme-online/35',
  amber: 'bg-theme-warn-soft text-theme-warn border-theme-warn/35',
  rose: 'bg-theme-error-soft text-theme-error border-theme-error/35',
};

export function Badge({
  className,
  variant = 'default',
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium tracking-wide',
        variantClasses[variant],
        className
      )}
      {...props}
    />
  );
}
