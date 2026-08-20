import React from 'react';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import { getDocumentRegistry } from '@/lib/documents/session';
import { useDocumentRecord } from '@/lib/documents/hooks';
import { useDocumentLanguageExtensions } from '@/lib/codemirror/language-client';
import {
  acquireLanguageDocument,
  notifyLanguageDocumentChange,
  releaseLanguageDocument,
} from '@/lib/language-services/session';
import type { DocumentIdentity } from '@/lib/documents/types';

type DocumentCodeMirrorProps = Omit<React.ComponentProps<typeof CodeMirrorEditor>, 'value' | 'onChange'> & {
  identity: DocumentIdentity | undefined;
};

export const DocumentCodeMirror: React.FC<DocumentCodeMirrorProps> = ({
  identity,
  extensions,
  ...editorProps
}) => {
  const origin = React.useId();
  const record = useDocumentRecord(identity);
  const buffer = record?.buffer ?? '';
  const languageExtensions = useDocumentLanguageExtensions(identity);

  React.useEffect(() => {
    if (!identity) return undefined;
    acquireLanguageDocument(identity);
    return () => releaseLanguageDocument(identity);
  }, [identity]);

  const handleChange = React.useCallback((value: string) => {
    if (!identity) return;
    getDocumentRegistry().applyTransaction(identity, value, { origin });
    notifyLanguageDocumentChange(identity);
  }, [identity, origin]);

  if (!identity) return null;

  return (
    <CodeMirrorEditor
      value={buffer}
      onChange={handleChange}
      extensions={[...languageExtensions, ...(extensions ?? [])]}
      {...editorProps}
    />
  );
};
