import React from 'react';
import { json } from '@codemirror/lang-json';
import { Icon } from '@/components/icon/Icon';
import { SettingsControlGroup } from '@/components/sections/shared/SettingsSection';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { useI18n } from '@/lib/i18n';
import type { PluginObjectDraft } from './usePluginConfigDraft';

interface PluginAdvancedDraftEditorProps {
  blocked?: boolean;
  controller: PluginObjectDraft;
}

export const PluginAdvancedDraftEditor: React.FC<PluginAdvancedDraftEditorProps> = ({
  blocked = false,
  controller,
}) => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const editorExtensions = React.useMemo(() => [json()], []);
  const editorOpen = open || controller.rawError !== null;

  return (
    <SettingsControlGroup
      className="border-t border-border/60 pt-5"
      title={t('settings.piarium.pluginSettings.advanced.sectionTitle')}
      info={t('settings.piarium.pluginSettings.advanced.sameDraftDescription')}
    >
      <Collapsible open={editorOpen} onOpenChange={setOpen}>
        <CollapsibleTrigger
          disabled={controller.rawError !== null}
          className="border border-border/60 px-3 py-2.5"
        >
          <span className="typography-ui-label text-foreground">
            {editorOpen
              ? t('settings.piarium.pluginSettings.advanced.hide')
              : t('settings.piarium.pluginSettings.advanced.show')}
          </span>
          <Icon
            name={editorOpen ? 'arrow-up-s' : 'arrow-down-s'}
            className="size-4 text-muted-foreground"
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 pt-3">
          <p className="break-all font-mono typography-micro text-muted-foreground">
            {controller.path || t('settings.piarium.pluginSettings.loadingPath')}
          </p>
          <div className="h-80 overflow-hidden rounded-md border border-border/60 bg-background">
            <CodeMirrorEditor
              value={controller.rawContent}
              onChange={controller.setRawContent}
              extensions={editorExtensions}
              className="h-full"
              enableSearch
              readOnly={controller.loading || controller.saving || blocked}
            />
          </div>
          {controller.rawError ? (
            <p className="typography-meta text-[var(--status-error)]">
              {t('settings.piarium.recovery.pluginSettings.invalidJson')}
            </p>
          ) : null}
        </CollapsibleContent>
      </Collapsible>
    </SettingsControlGroup>
  );
};
