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
  info?: React.ReactNode;
  label: React.ReactNode;
  onRemove: (path: readonly string[]) => void;
  onSet: (path: readonly string[], value: JsonValue) => void;
  path: readonly string[];
  settingsItem?: string;
}

function optionKey(value: boolean | string): string {
  return typeof value === 'boolean' ? `boolean:${String(value)}` : `string:${value}`;
}

function fieldAriaLabel(label: React.ReactNode, path: readonly string[]): string {
  return typeof label === 'string' ? label : path.join('.');
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
  autoComplete?: string;
  defaultValue?: string;
  inputType?: React.HTMLInputTypeAttribute;
  placeholder?: string;
}

export const PluginStringField: React.FC<StringFieldProps> = ({
  allowEmpty = false,
  autoComplete,
  defaultValue = '',
  description,
  disabled,
  draft,
  info,
  label,
  onRemove,
  onSet,
  path,
  inputType = 'text',
  placeholder,
  settingsItem,
}) => {
  const field = useField({ draft, onRemove, onSet, path });
  const value = typeof field.raw === 'string' ? field.raw : defaultValue;
  return (
    <SettingsFieldRow
      label={label}
      description={description}
      info={info}
      settingsItem={settingsItem}
      controlClassName="w-full max-w-[24rem]"
    >
      <Input
        type={inputType}
        aria-label={fieldAriaLabel(label, path)}
        value={value}
        disabled={disabled}
        autoComplete={autoComplete}
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
  info,
  label,
  onRemove,
  onSet,
  path,
  settingsItem,
}) => {
  const field = useField({ draft, onRemove, onSet, path });
  const checked = validBoolean(field.raw) ?? defaultValue;
  return (
    <SettingsFieldRow
      label={label}
      description={description}
      info={info}
      settingsItem={settingsItem}
      controlClassName="w-full max-w-[24rem]"
    >
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => field.set(Boolean(next))}
        aria-label={fieldAriaLabel(label, path)}
      />
      <DefaultAction disabled={disabled} explicit={field.explicit} onReset={field.remove} />
    </SettingsFieldRow>
  );
};

export const PluginOptionalBooleanField: React.FC<BaseFieldProps & {
  unsetLabel?: string;
}> = ({
  description,
  disabled,
  draft,
  info,
  label,
  onRemove,
  onSet,
  path,
  settingsItem,
  unsetLabel,
}) => {
  const { t } = useI18n();
  const field = useField({ draft, onRemove, onSet, path });
  const current = validBoolean(field.raw);
  const unsupported = field.explicit && current === undefined;
  const notSetLabel = unsetLabel ?? t('settings.piarium.pluginSettings.field.pluginDefault');
  const value = unsupported ? 'unsupported' : current === undefined ? 'default' : optionKey(current);
  const selectedLabel = unsupported
    ? t('settings.piarium.pluginSettings.field.unsupportedValue')
    : current === undefined
    ? notSetLabel
    : current
      ? t('settings.piarium.pluginSettings.field.enabled')
      : t('settings.piarium.pluginSettings.field.disabled');
  return (
    <SettingsFieldRow
      label={label}
      description={description}
      info={info}
      settingsItem={settingsItem}
      controlClassName="w-full max-w-[24rem]"
    >
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          if (next === 'default') field.remove();
          else if (next === optionKey(true)) field.set(true);
          else if (next === optionKey(false)) field.set(false);
        }}
      >
        <SelectTrigger
          size="settings"
          className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
          aria-label={fieldAriaLabel(label, path)}
        >
          <SelectValue>{selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {unsupported ? (
            <SelectItem value="unsupported" disabled>
              {t('settings.piarium.pluginSettings.field.unsupportedValue')}
            </SelectItem>
          ) : null}
          <SelectItem value="default">{notSetLabel}</SelectItem>
          <SelectItem value={optionKey(true)}>{t('settings.piarium.pluginSettings.field.enabled')}</SelectItem>
          <SelectItem value={optionKey(false)}>{t('settings.piarium.pluginSettings.field.disabled')}</SelectItem>
        </SelectContent>
      </Select>
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
  info,
  label,
  max,
  min,
  onRemove,
  onSet,
  path,
  step,
  unit,
  settingsItem,
}) => {
  const field = useField({ draft, onRemove, onSet, path });
  const value = validFiniteNumber(field.raw) ?? defaultValue;
  return (
    <SettingsFieldRow
      label={label}
      description={description}
      info={info}
      settingsItem={settingsItem}
      controlClassName="w-full max-w-[24rem]"
    >
      <NumberInput
        aria-label={fieldAriaLabel(label, path)}
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

interface OptionalNumberFieldProps extends BaseFieldProps {
  defaultValue?: number | null | string;
  emptyLabel?: string;
  emptyActionLabel?: React.ReactNode;
  emptyValue?: null | string;
  fallbackValue?: number;
  max?: number;
  min?: number;
  step?: number;
  unit?: React.ReactNode;
  unsetLabel?: React.ReactNode;
  preserveTypedPrecision?: boolean;
}

export const PluginOptionalNumberField: React.FC<OptionalNumberFieldProps> = ({
  defaultValue,
  description,
  disabled,
  draft,
  info,
  emptyLabel,
  emptyActionLabel,
  emptyValue,
  fallbackValue,
  label,
  max,
  min,
  onRemove,
  onSet,
  path,
  step,
  unit,
  settingsItem,
  unsetLabel,
  preserveTypedPrecision,
}) => {
  const { t } = useI18n();
  const field = useField({ draft, onRemove, onSet, path });
  const explicitNumber = validFiniteNumber(field.raw);
  const explicitEmpty = field.explicit
    && emptyValue !== undefined
    && field.raw === emptyValue;
  const unsupported = field.explicit && explicitNumber === undefined && !explicitEmpty;
  const value = explicitNumber ?? (!field.explicit && typeof defaultValue === 'number'
    ? defaultValue
    : undefined);
  return (
    <SettingsFieldRow
      label={label}
      description={description}
      info={info}
      settingsItem={settingsItem}
      controlClassName="w-full max-w-[24rem]"
    >
      <NumberInput
        aria-label={fieldAriaLabel(label, path)}
        value={unsupported ? undefined : value}
        fallbackValue={fallbackValue ?? (typeof defaultValue === 'number' ? defaultValue : undefined)}
        disabled={disabled}
        min={min}
        max={max}
        step={step}
        inputMode={step !== undefined && !Number.isInteger(step) ? 'decimal' : 'numeric'}
        preserveTypedPrecision={preserveTypedPrecision}
        emptyLabel={unsupported
          ? t('settings.piarium.pluginSettings.field.unsupportedValue')
          : explicitEmpty
            ? emptyLabel
            : undefined}
        placeholder={unsupported
          ? t('settings.piarium.pluginSettings.field.unsupportedValue')
          : field.explicit
            ? emptyLabel
            : undefined}
        onClear={() => {
          if (emptyValue === undefined) field.remove();
          else field.set(emptyValue);
        }}
        onValueChange={field.set}
        containerClassName="w-36"
      />
      {unit ? <span className="typography-meta text-muted-foreground">{unit}</span> : null}
      {emptyValue !== undefined && emptyActionLabel && !explicitEmpty ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={disabled}
          onClick={() => field.set(emptyValue)}
          className="shrink-0 !font-normal text-muted-foreground"
        >
          {emptyActionLabel}
        </Button>
      ) : null}
      {field.explicit ? (
        <DefaultAction disabled={disabled} explicit onReset={field.remove} />
      ) : unsetLabel ? (
        <span className="shrink-0 typography-micro text-muted-foreground">
          {unsetLabel}
        </span>
      ) : (
        <DefaultAction explicit={false} onReset={field.remove} />
      )}
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

export const PluginSelectField: React.FC<SelectFieldProps> = ({
  defaultValue,
  description,
  disabled,
  draft,
  info,
  label,
  onRemove,
  onSet,
  options,
  path,
  settingsItem,
}) => {
  const { t } = useI18n();
  const field = useField({ draft, onRemove, onSet, path });
  const current = typeof field.raw === 'boolean' || typeof field.raw === 'string'
    ? field.raw
    : defaultValue;
  const selectedOption = options.find((option) => option.value === current);
  const unsupported = selectedOption === undefined;
  return (
    <SettingsFieldRow
      label={label}
      description={description}
      info={info}
      settingsItem={settingsItem}
      controlClassName="w-full max-w-[24rem]"
    >
      <Select
        value={unsupported ? 'unsupported' : optionKey(current)}
        disabled={disabled}
        onValueChange={(key) => {
          const option = options.find((entry) => optionKey(entry.value) === key);
          if (option) field.set(option.value);
        }}
      >
        <SelectTrigger
          size="settings"
          className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
          aria-label={fieldAriaLabel(label, path)}
        >
          <SelectValue>
            {selectedOption?.label ?? t('settings.piarium.pluginSettings.field.unsupportedValue')}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {unsupported ? (
            <SelectItem value="unsupported" disabled>
              {t('settings.piarium.pluginSettings.field.unsupportedValue')}
            </SelectItem>
          ) : null}
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

interface OptionalSelectFieldProps extends BaseFieldProps {
  options: readonly SelectOption[];
  preserveUnsupportedUntilSelection?: boolean;
  unsupportedLabel?: React.ReactNode;
  unsetLabel?: string;
}

export const PluginOptionalSelectField: React.FC<OptionalSelectFieldProps> = ({
  description,
  disabled,
  draft,
  info,
  label,
  onRemove,
  onSet,
  options,
  path,
  preserveUnsupportedUntilSelection = false,
  settingsItem,
  unsupportedLabel,
  unsetLabel,
}) => {
  const { t } = useI18n();
  const field = useField({ draft, onRemove, onSet, path });
  const current = options.find((option) => option.value === field.raw);
  const unsupported = field.explicit && current === undefined;
  const value = current ? optionKey(current.value) : unsupported ? 'unsupported' : 'default';
  const notSetLabel = unsetLabel ?? t('settings.piarium.pluginSettings.field.pluginDefault');
  const unsupportedValueLabel = unsupportedLabel
    ?? t('settings.piarium.pluginSettings.field.unsupportedValue');
  const selectedLabel = current?.label ?? (unsupported
    ? unsupportedValueLabel
    : notSetLabel);
  return (
    <SettingsFieldRow
      label={label}
      description={description}
      info={info}
      settingsItem={settingsItem}
      controlClassName="w-full max-w-[24rem]"
    >
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(key) => {
          if (key === 'default') {
            if (unsupported && preserveUnsupportedUntilSelection) return;
            field.remove();
            return;
          }
          const option = options.find((entry) => optionKey(entry.value) === key);
          if (option) field.set(option.value);
        }}
      >
        <SelectTrigger
          size="settings"
          className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
          aria-label={fieldAriaLabel(label, path)}
        >
          <SelectValue>{selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {unsupported ? (
            <SelectItem value="unsupported" disabled>
              {unsupportedValueLabel}
            </SelectItem>
          ) : null}
          {!unsupported || !preserveUnsupportedUntilSelection ? (
            <SelectItem value="default">
              {notSetLabel}
            </SelectItem>
          ) : null}
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
  emptyArrayOnClear?: boolean;
  placeholder?: string;
}

export const PluginStringListField: React.FC<StringListFieldProps> = ({
  defaultValue = [],
  description,
  disabled,
  draft,
  info,
  emptyArrayOnClear = false,
  label,
  onRemove,
  onSet,
  path,
  placeholder,
  settingsItem,
}) => {
  const field = useField({ draft, onRemove, onSet, path });
  const value = typeof field.raw === 'string'
    ? [field.raw]
    : validStringArray(field.raw) ?? [...defaultValue];
  return (
    <SettingsFieldRow
      label={label}
      description={description}
      info={info}
      settingsItem={settingsItem}
      alignEnd={false}
      controlClassName="w-full max-w-[24rem] items-start"
    >
      <Textarea
        aria-label={fieldAriaLabel(label, path)}
        value={value.join('\n')}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => {
          const next = event.target.value
            .split(/\r?\n/)
            .map((entry) => entry.trim())
            .filter(Boolean);
          if (next.length === 0) {
            if (emptyArrayOnClear) field.set([]);
            else field.remove();
          }
          else field.set(next);
        }}
        className="min-h-20 min-w-0 flex-1 font-mono"
      />
      <DefaultAction disabled={disabled} explicit={field.explicit} onReset={field.remove} />
    </SettingsFieldRow>
  );
};
