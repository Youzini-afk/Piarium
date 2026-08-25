import React from 'react';
import { CodeMirrorEditor, type CodeMirrorTextChange } from '@/components/ui/CodeMirrorEditor';
import { getDocumentRegistry } from '@/lib/documents/session';
import { useDocumentRecord } from '@/lib/documents/hooks';
import { useDocumentLanguageExtensions } from '@/lib/codemirror/language-client';
import {
  acquireLanguageDocument,
  notifyLanguageDocumentChange,
  notifyLanguageDocumentSave,
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
  const previousBaseRevisionRef = React.useRef<string | null | undefined>(record?.baseRevision);
  const previousSavingRef = React.useRef(record?.saving ?? false);
  const previousIdentityRef = React.useRef(identity ? `${identity.workspaceId}\0${identity.resourceId}` : '');
  const buffer = record?.buffer ?? '';
  const languageExtensions = useDocumentLanguageExtensions(identity);

  React.useEffect(() => {
    if (!identity) return undefined;
    acquireLanguageDocument(identity);
    return () => releaseLanguageDocument(identity);
  }, [identity]);

  React.useEffect(() => {
    const identityKey = identity ? `${identity.workspaceId}\0${identity.resourceId}` : '';
    if (identityKey !== previousIdentityRef.current) {
      previousIdentityRef.current = identityKey;
      previousBaseRevisionRef.current = record?.baseRevision;
      previousSavingRef.current = record?.saving ?? false;
      return;
    }
    const previous = previousBaseRevisionRef.current;
    const wasSaving = previousSavingRef.current;
    previousBaseRevisionRef.current = record?.baseRevision;
    previousSavingRef.current = record?.saving ?? false;
    if (!identity || !wasSaving || record?.saving || previous === undefined || previous === record?.baseRevision) return;
    notifyLanguageDocumentSave(identity);
  }, [identity, record?.baseRevision, record?.saving]);

  const handleChange = React.useCallback((value: string, changes?: CodeMirrorTextChange[]) => {
    if (!identity) return;
    getDocumentRegistry().applyTransaction(identity, value, { origin, changes });
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
