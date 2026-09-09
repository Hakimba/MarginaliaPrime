import { isWebAppPlatform } from '@/services/environment';
import { AppService } from '@/types/system';

declare global {
  interface Window {
    OPEN_WITH_FILES?: string[] | null;
  }
}

const parseWindowOpenWithFiles = () => {
  const params = new URLSearchParams(window.location.search);
  const files = params.getAll('file');
  return files.length > 0 ? files : window.OPEN_WITH_FILES;
};

// Files passed on the command line (or via "open with") are injected by the
// Rust side as `window.OPEN_WITH_FILES` before the page loads (see lib.rs), and
// files from a second instance arrive through the `single-instance` event.
export const parseOpenWithFiles = async (_appService: AppService | null) => {
  if (isWebAppPlatform()) return [];
  return parseWindowOpenWithFiles() ?? [];
};
