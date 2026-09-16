import React from 'react';
import { Input } from '@/components/ui/input';

interface AutoSaveInputProps extends Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange'> {
  value: string;
  onCommit: (value: string) => void;
  validate?: (value: string) => string | null;
}

/** Keep text while typing; commit on pause, Enter, blur, or leaving the page. */
export function AutoSaveInput({ value, onCommit, validate, onBlur, onKeyDown, ...props }: AutoSaveInputProps) {
  const [draft, setDraft] = React.useState(value);
  const [issue, setIssue] = React.useState<string | null>(null);
  const ref = React.useRef({ draft: value, dirty: false, onCommit, validate });
  ref.current.onCommit = onCommit;
  ref.current.validate = validate;
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const issueId = React.useId();

  const commit = React.useCallback(() => {
    clearTimeout(timer.current);
    const current = ref.current;
    if (!current.dirty) return;
    const error = current.validate?.(current.draft) ?? null;
    setIssue(error);
    if (error) return;
    current.dirty = false;
    current.onCommit(current.draft);
  }, []);

  React.useEffect(() => {
    if (!ref.current.dirty) {
      ref.current.draft = value;
      setDraft(value);
    }
  }, [value]);
  React.useEffect(() => () => {
    clearTimeout(timer.current);
    const current = ref.current;
    if (current.dirty && !current.validate?.(current.draft)) {
      current.dirty = false;
      current.onCommit(current.draft);
    }
  }, []);

  return <div className="min-w-0 flex-1">
    <Input {...props} value={draft} aria-invalid={Boolean(issue)} aria-describedby={issue ? issueId : props['aria-describedby']}
      onChange={(event) => {
        const next = event.target.value;
        ref.current.draft = next;
        ref.current.dirty = true;
        setDraft(next);
        setIssue(null);
        clearTimeout(timer.current);
        // A typing debounce, not a network timeout or a persistence deadline.
        if (!(event.nativeEvent as InputEvent).isComposing) timer.current = setTimeout(commit, 650);
      }}
      onCompositionEnd={() => { clearTimeout(timer.current); timer.current = setTimeout(commit, 650); }}
      onBlur={(event) => { commit(); onBlur?.(event); }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); commit(); }
        onKeyDown?.(event);
      }} />
    {issue ? <p id={issueId} role="alert" className="mt-1 typography-meta text-destructive">{issue}</p> : null}
  </div>;
}
