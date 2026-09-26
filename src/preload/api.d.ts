import type { KitsuneApi } from './index';

declare global {
  interface Window {
    kitsune: KitsuneApi;
  }
}

export {};
