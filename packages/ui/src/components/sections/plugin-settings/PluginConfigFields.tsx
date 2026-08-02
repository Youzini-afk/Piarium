import React from 'react';
import type { JsonValue } from '@piarium/protocol';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  SettingsFieldRow,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import {
  hasJsonPath,
  readJsonPath,
  validBoolean,
  validFiniteNumber,
  validStringArray,
  type JsonObject,
} from './plugin-config-model';

interface BaseFieldProps {
  description?: React.ReactNode;
  disabled?: boolean;
  draft: JsonObject;
  label: React.ReactNode;
  onRemove: (path: readonly string[]) => void;
  onSet: (path: readonly string[], value: JsonValue) => void;
  path: readonly string[];
}

const DefaultAction: React.FC<{
  disabled?: boolean;
  explicit: boolean;
  onReset: () => void;
}> = ({ disabled, explicit, onReset }) => {
  const { t } = useI18n();
  if (!explicit) {
    return (
      <span className="shrink-0 typography-micro text-muted-foreground">
        {t('settings.piarium.pluginSettings.field.pluginDefault')}
      </span>
    );
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      disabled={disabled}
      onClick={onReset}
      className="shrink-0 !font-normal text-muted-foreground"
    >
      {t('settings.piarium.pluginSettings.field.useDefault')}
    </Button>
  );
};

const useField = ({
  draft,
  onRemove,
  onSet,
  path,
}: Pick<BaseFieldProps, 'draft' | 'onRemove' | 'onSet' | 'path'>) => {
  const explicit = hasJsonPath(draft, path);
  return {
    explicit,
    raw: readJsonPath(draft, path),
    remove: () => onRemove(path),
    set: (value: JsonValue) => onSet(path, value),
  };
};

interface StringFieldProps extends BaseFieldProps {
  allowEmpty?: boolean;
  defaultValue?: string;
  placeholder?: string;
}

export const PluginStringField: React.FC<StringFieldProps> = ({
  allowEmpty = false,
  defaultValue = '',
  description,
  disabled,
  draft,
  label,
  onRemove,
  onSet,
  path,
  placeholder,
}) => {
  const field = useField({ draft, onRemove, onSet, path });
  const value = typeof field.raw === 'string' ? field.raw : defaultValue;
  return (
    <SettingsFieldRow label={label} description={description} controlClassName="w-full max-w-lg">
      <Input
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => {
          const next = event.target.value;
          if (!next && !allowEmpty) field.remove();
          else field.set(next);
        }}
        className="min-w-0 flex-1"
      />
      <DefaultAction disabled={disabled} explicit={field.explicit} onReset={field.remove} />
    </SettingsFieldRow>
  );
};

interface BooleanFieldProps extends BaseFieldProps {
  defaultValue: boolean;
}

export const PluginBooleanField: React.FC<BooleanFieldProps> = ({
  defaultValue,
  description,
  disabled,
  draft,
  label,
  onRemove,
  onSet,
  path,
}) => {
  const field = useField({ draft, onRemove, onSet, path });
  const checked = validBoolean(field.raw) ?? defaultValue;
  return (
    <SettingsFieldRow label={label} description={description} controlClassName="w-full max-w-lg">
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => field.set(Boolean(next))}
        aria-label={typeof label === 'string' ? label : undefined}
      />
      <DefaultAction disabled={disabled} explicit={field.explicit} onReset={field.remove} />
    </SettingsFieldRow>
  );
};

interface NumberFieldProps extends BaseFieldProps {
  defaultValue: number;
  max?: number;
  min?: number;
  step?: number;
  unit?: React.ReactNode;
}

export const PluginNumberField: React.FC<NumberFieldProps> = ({
  defaultValue,
  description,
  disabled,
  draft,
  label,
  max,
  min,
  onRemove,
  onSet,
  path,
  step,
  unit,
}) => {
  const field = useField({ draft, onRemove, onSet, path });
  const value = validFiniteNumber(field.raw) ?? defaultValue;
  return (
    <SettingsFieldRow label={label} description={description} controlClassName="w-full max-w-lg">
      <NumberInput
        value={value}
        fallbackValue={defaultValue}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        onValueChange={field.set}
        containerClassName="w-36"
      />
      {unit ? <span className="typography-meta text-muted-foreground">{unit}</span> : null}
      <DefaultAction disabled={disabled} explicit={field.explicit} onReset={field.remove} />
    </SettingsFieldRow>
  );
};

interface SelectOption {
  label: React.ReactNode;
  value: boolean | string;
}

interface SelectFieldProps extends BaseFieldProps {
  defaultValue: boolean | string;
  options: readonly SelectOption[];
}

const optionKey = (value: boolean | string): string => (
  typeof value === 'boolean' ? `boolean:${String(value)}` : `string:${value}`
);

export const PluginSelectField: React.FC<SelectFieldProps> = ({
  defaultValue,
  description,
  disabled,
  draft,
  label,
  onRemove,
  onSet,
  options,
  path,
}) => {
  const field = useField({ draft, onRemove, onSet, path });
  const current = typeof field.raw === 'boolean' || typeof field.raw === 'string'
    ? field.raw
    : defaultValue;
  return (
    <SettingsFieldRow label={label} description={description} controlClassName="w-full max-w-lg">
      <Select
        value={optionKey(current)}
        disabled={disabled}
        onValueChange={(key) => {
          const option = options.find((entry) => optionKey(entry.value) === key);
          if (option) field.set(option.value);
        }}
      >
        <SelectTrigger size="settings" className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={optionKey(option.value)} value={optionKey(option.value)}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <DefaultAction disabled={disabled} explicit={field.explicit} onReset={field.remove} />
    </SettingsFieldRow>
  );
};

interface StringListFieldProps extends BaseFieldProps {
  defaultValue?: readonly string[];
  placeholder?: string;
}

export const PluginStringListField: React.FC<StringListFieldProps> = ({
  defaultValue = [],
  description,
  disabled,
  draft,
  label,
  onRemove,
  onSet,
  path,
  placeholder,
}) => {
  const field = useField({ draft, onRemove, onSet, path });
  const value = typeof field.raw === 'string'
    ? [field.raw]
    : validStringArray(field.raw) ?? [...defaultValue];
  return (
    <SettingsFieldRow
      label={label}
      description={description}
      alignEnd={false}
      controlClassName="w-full max-w-lg items-start"
    >
      <Textarea
        value={value.join('\n')}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => {
          const next = event.target.value
            .split(/\r?\n/)
            .map((entry) => entry.trim())
            .filter(Boolean);
          if (next.length === 0) field.remove();
          else field.set(next);
        }}
        className="min-h-20 min-w-0 flex-1 font-mono"
      />
      <DefaultAction disabled={disabled} explicit={field.explicit} onReset={field.remove} />
    </SettingsFieldRow>
  );
};
