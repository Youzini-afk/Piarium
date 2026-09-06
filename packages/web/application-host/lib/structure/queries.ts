/**
 * Piarium tree-sitter queries for TypeScript / TSX.
 *
 * Adapted from Apache-2.0 query sets in Aider (paul-gauthier/aider,
 * `aider/repomap.py` language queries) and nvim-treesitter
 * (`queries/typescript/locals.scm` / `highlights.scm`). Captures and
 * grouping are Piarium's; node names follow tree-sitter-typescript.
 */

export const TYPESCRIPT_DEFINITION_QUERY = `
(function_declaration
  name: (identifier) @name) @unit

(generator_function_declaration
  name: (identifier) @name) @unit

(class_declaration
  name: (type_identifier) @name) @unit

(abstract_class_declaration
  name: (type_identifier) @name) @unit

(interface_declaration
  name: (type_identifier) @name) @unit

(type_alias_declaration
  name: (type_identifier) @name) @unit

(enum_declaration
  name: (identifier) @name) @unit

(method_definition
  name: (_) @name) @unit

(method_signature
  name: (_) @name) @unit

(public_field_definition
  name: (_) @name) @unit

(lexical_declaration
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
