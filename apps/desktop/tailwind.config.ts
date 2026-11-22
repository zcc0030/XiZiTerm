import type { Config } from 'tailwindcss';

function withAlpha(cssVar: string) {
  return ({ opacityValue }: { opacityValue?: string }): string => {
    if (
      opacityValue === undefined ||
      opacityValue === '1' ||
      opacityValue.startsWith('var(')
    ) {
      return `var(${cssVar})`;
    }
    const pct = Math.round(Number(opacityValue) * 100);
    if (Number.isFinite(pct)) {
      return `color-mix(in srgb, var(${cssVar}) ${pct}%, transparent)`;
    }
    return `color-mix(in srgb, var(${cssVar}) calc(${opacityValue} * 100%), transparent)`;
  };
}

const config: Config = {
  darkMode: ['class'],
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      borderColor: {
        DEFAULT: 'var(--border-color)',
      },
      colors: {
        theme: {
          base: withAlpha('--bg-base'),
          sidebar: withAlpha('--bg-sidebar'),
          elevated: withAlpha('--bg-elevated'),
          input: withAlpha('--bg-input'),
          hover: withAlpha('--bg-hover'),
          border: withAlpha('--border-color'),
          primary: withAlpha('--text-primary'),
          muted: withAlpha('--text-muted'),
          accent: withAlpha('--accent-primary'),
          'accent-2': withAlpha('--accent-secondary'),
          'accent-secondary': withAlpha('--accent-secondary'),
          'accent-contrast': withAlpha('--accent-contrast'),
          'accent-soft': withAlpha('--accent-soft'),
          online: withAlpha('--status-online'),
          'online-soft': withAlpha('--status-online-soft'),
          warn: withAlpha('--status-warn'),
          'warn-soft': withAlpha('--status-warn-soft'),
          error: withAlpha('--status-error'),
          'error-soft': withAlpha('--status-error-soft'),
        },
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', '-apple-system', 'sans-serif'],
        mono: [
          'JetBrains Mono',
          'Cascadia Code',
          'Fira Code',
          'Consolas',
          'monospace',
        ],
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [],
};

export default config;
