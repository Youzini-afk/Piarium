/**
 * Piarium tree-sitter queries for TypeScript / TSX.
 *
 * Adapted from Apache-2.0 query sets in Aider (paul-gauthier/aider,
 * `aider/repomap.py` language queries) and nvim-treesitter
 * (`queries/typescript/locals.scm` / `highlights.scm`). Captures and
 * grouping are Piarium's; node names follow tree-sitter-typescript.
 *
 * `@unit` marks a candidate outline span. The provider keeps it as a slice
 * unit only when it is a container or a definition binding (D-098):
 * `const foo = () => {}` / `const C = class {}` stay units; `const needle = 1`
 * is a name for classification, not a slice unit.
 *
 * Covered: function/generator/class/abstract class (including named export
 * default and anonymous `export default class {}`), interface, type alias,
 * enum, method_definition (including object-literal methods),
 * function_signature (`declare function`), internal_module/module
 * (`namespace` / `declare namespace` / `module`), lexical and var declarators,
 * public fields (unit only when the initializer is a definition).
 *
 * Not covered (on purpose): JS/JSX language ids, import aliases, enum members
 * as their own units, interface/type method signatures as units, parameters,
 * decorators, unnamed `export default abstract class {}` (grammar error node),
 * and a full grammar-node census. Arrow bindings (`const beta = () => {}`,
 * `export const gamma = () => {}`) and `export default function` are covered.
 */

export const TYPESCRIPT_DEFINITION_QUERY = `
(function_declaration
  name: (identifier) @name) @unit

(generator_function_declaration
  name: (identifier) @name) @unit

(class_declaration
  name: (type_identifier) @name) @unit

(class_declaration) @unit

(export_statement
  (class) @unit)

(abstract_class_declaration
  name: (type_identifier) @name) @unit

(abstract_class_declaration) @unit

(interface_declaration
  name: (type_identifier) @name) @unit

(type_alias_declaration
  name: (type_identifier) @name) @unit

(enum_declaration
  name: (identifier) @name) @unit

(method_definition
  name: (_) @name) @unit

(method_signature
  name: (_) @name)

(abstract_method_signature
  name: (_) @name)

(public_field_definition
  name: (_) @name) @unit

(function_signature
  name: (identifier) @name) @unit

(internal_module
  name: (_) @name) @unit

(module
  name: (_) @name) @unit

(lexical_declaration
  (variable_declarator
    name: (identifier) @name)) @unit

(variable_declaration
  (variable_declarator
    name: (identifier) @name)) @unit
`;

export const TYPESCRIPT_LITERAL_CALL_QUERY = `
(call_expression
  function: [
    (identifier) @fn
    (member_expression
      property: (property_identifier) @fn)
  ]
  arguments: (arguments
    (string) @literal)) @call
`;

export const TYPESCRIPT_IMPORT_QUERY = `
(import_statement
  source: (string) @source) @import

(call_expression
  function: (identifier) @fn
  arguments: (arguments
    (string) @source)
  (#eq? @fn "require")) @import

(call_expression
  function: (import) @fn
  arguments: (arguments
    (string) @source)) @import
`;
