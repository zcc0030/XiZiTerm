import * as React from 'react';
import { cn } from '@/lib/utils';

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          'flex min-h-[84px] w-full rounded-md border border-theme-border bg-theme-input px-3 py-2 text-sm text-theme-primary placeholder:text-theme-muted/70 focus:border-theme-accent focus:outline-none focus:ring-1 focus:ring-theme-accent/40 disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        {...props}
      />
    );
  }
);
Textarea.displayName = 'Textarea';
