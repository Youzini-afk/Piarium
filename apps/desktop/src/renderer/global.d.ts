import type { DesktopApi } from "../shared/desktop-api.js";

declare global {
  interface Window {
    piarium: DesktopApi;
  }
}
