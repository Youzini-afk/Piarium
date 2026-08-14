# @piarium/extension-react

Optional React 19 adapter for Piarium Surface extensions. React is a peer dependency and is bundled by
the extension artifact build rather than inherited from the Piarium workbench. The adapter associates
React roots and contribution descriptors with the framework-neutral owner lifecycle.

Using React is optional; managed and isolated extensions may use any framework or direct DOM/Canvas.
See the complete [authoring guide](https://github.com/Youzini-afk/Piarium/blob/main/docs/piarium-extension-authoring.md).
