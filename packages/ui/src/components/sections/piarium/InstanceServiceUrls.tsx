import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { openExternalUrl } from '@/lib/url';

interface InstanceServiceInfo {
  port: number | null;
  tunnelUrl: string | null;
}

export const InstanceServiceUrls: React.FC = () => {
  const [info, setInfo] = React.useState<InstanceServiceInfo | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    void runtimeFetch('/api/system/info', {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) return;
      const data = await response.json().catch(() => null) as { port?: unknown; tunnelUrl?: unknown } | null;
      if (!data) return;
      setInfo({
        port: typeof data.port === 'number' && Number.isFinite(data.port) && data.port > 0 ? data.port : null,
        tunnelUrl: typeof data.tunnelUrl === 'string' && data.tunnelUrl.trim() ? data.tunnelUrl.trim() : null,
      });
    }).catch(() => undefined);
    return () => controller.abort();
  }, []);

  const urls = [
    ...(info?.port ? [`http://localhost:${info.port}/`] : []),
    ...(info?.tunnelUrl ? [info.tunnelUrl] : []),
  ];
  if (urls.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {urls.map((url) => (
        <Button
          key={url}
          type="button"
          variant="outline"
          size="sm"
          title={url}
          className="max-w-full gap-1.5 px-2.5"
          onClick={() => { void openExternalUrl(url); }}
        >
          <Icon name="external-link" className="size-3.5 shrink-0" />
          <span className="max-w-64 truncate font-mono typography-micro">{url}</span>
        </Button>
      ))}
    </div>
  );
};
