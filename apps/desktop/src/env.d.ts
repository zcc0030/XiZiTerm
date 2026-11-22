/// <reference types="vite/client" />
import type { XiZiTermApi } from '@xiziterm/shared';

declare global {
  interface Window {
    xiziterm: XiZiTermApi;
  }
}

export {};
