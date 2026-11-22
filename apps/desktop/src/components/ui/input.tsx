import * as React from 'react';
import { cn } from '@/lib/utils';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      className,
      type = 'text',
      spellCheck = false,
      autoComplete = 'off',
      autoCorrect = 'off',
      autoCapitalize = 'off',
      ...props
    },
    ref
  ) => {
    return (
      <input
        ref={ref}
        type={type}
        spellCheck={spellCheck}
        autoComplete={autoComplete}
        autoCorrect={autoCorrect}
        autoCapitalize={autoCapitalize}
        className={cn(
          'flex h-9 w-full rounded-md border border-theme-border bg-theme-input px-3 py-1.5 text-sm text-theme-primary placeholder:text-theme-muted/70 focus:border-theme-accent focus:outline-none focus:ring-1 focus:ring-theme-accent/40 disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';
