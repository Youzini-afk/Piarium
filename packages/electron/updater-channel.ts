export const resolveUpdaterChannel = ({ platform, architecture }: {
  architecture: NodeJS.Architecture;
  platform: NodeJS.Platform;
}): 'latest-arm64' | null => (
  platform === 'win32' && architecture === 'arm64' ? 'latest-arm64' : null
);
