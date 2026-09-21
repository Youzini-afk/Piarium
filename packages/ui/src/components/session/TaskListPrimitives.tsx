import type { ReactNode } from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export function TaskSearch({ value, onChange, label }: { value: string; onChange(value: string): void; label: string }) {
  return <div className="relative">
    <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
    <Input value={value} onChange={(event) => onChange(event.target.value)} placeholder={label} aria-label={label} className="h-9 rounded-full bg-muted/40 pl-9 shadow-none" />
  </div>;
}

export function TaskListRow({ title, subtitle, status, icon = 'time', muted, children }: {
  title: string; subtitle: ReactNode; status?: ReactNode; icon?: IconName; muted?: boolean; children: ReactNode;
}) {
  return <details className="group rounded-lg open:bg-muted/20">
    <summary className={cn('flex cursor-pointer list-none items-start gap-3 rounded-lg px-3 py-3.5 hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden', muted && 'text-muted-foreground')}>
      <Icon name={icon} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate typography-ui-label font-medium">{title}</span>
        <span className="mt-0.5 block truncate typography-meta text-muted-foreground">{subtitle}</span>
      </span>
      {status ? <span className="shrink-0 typography-micro text-muted-foreground">{status}</span> : null}
      <Icon name="arrow-down-s" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-transform group-hover:opacity-100 group-open:rotate-180 group-open:opacity-100 group-focus-within:opacity-100" />
    </summary>
    <div className="space-y-3 px-3 pb-4 pl-10 typography-meta">{children}</div>
  </details>;
}
