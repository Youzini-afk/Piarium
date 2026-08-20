import React from 'react';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import { getDocumentRegistry } from '@/lib/documents/session';
import { useDocumentRecord } from '@/lib/documents/hooks';
import type { DocumentIdentity } from '@/lib/documents/types';

type DocumentCodeMirrorProps = Omit<React.ComponentProps<typeof CodeMirrorEditor>, 'value' | 'onChange'> & {
  identity: DocumentIdentity | undefined;
};

export const DocumentCodeMirror: React.FC<DocumentCodeMirrorProps> = ({
  identity,
  ...editorProps
}) => {
  const origin = React.useId();
  const record = useDocumentRecord(identity);
  const buffer = record?.buffer ?? '';

  const handleChange = React.useCallback((value: string) => {
    if (!identity) return;
    getDocumentRegistry().applyTransaction(identity, value, { origin });
  }, [identity, origin]);

  if (!identity) return null;

  return (
    <CodeMirrorEditor
      value={buffer}
      onChange={handleChange}
      {...editorProps}
    />
  );
};
