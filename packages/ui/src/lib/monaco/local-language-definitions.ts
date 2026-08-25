import type { MonacoRuntime } from './runtime';

const JSON_LANGUAGE_ID = 'json';

export const registerPiariumTokenizationLanguages = (monaco: MonacoRuntime): void => {
  if (monaco.languages.getLanguages().some((language) => language.id === JSON_LANGUAGE_ID)) return;
  monaco.languages.register({
    id: JSON_LANGUAGE_ID,
    aliases: ['JSON', 'json', 'JSON with Comments'],
    extensions: ['.json', '.jsonc', '.json5', '.jsonl', '.ndjson', '.geojson'],
    filenames: ['.babelrc', '.eslintrc', '.prettierrc', 'composer.lock'],
  });
  monaco.languages.setLanguageConfiguration(JSON_LANGUAGE_ID, {
    brackets: [['{', '}'], ['[', ']']],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"', notIn: ['string'] },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ],
  });
  monaco.languages.setMonarchTokensProvider(JSON_LANGUAGE_ID, {
    defaultToken: 'invalid',
    tokenizer: {
      root: [
        [/\s+/, 'white'],
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key'],
        [/"(?:[^"\\]|\\.)*"/, 'string.value'],
        [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
        [/\b(?:true|false|null)\b/, 'keyword'],
        [/[{}[\],:]/, 'delimiter'],
      ],
      comment: [
        [/[^*/]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[*/]/, 'comment'],
      ],
    },
  });
};
