# Source

This directory contains TypeScript source for the Zotero plugin.

## Structure

```text
src/
```

## Extending

1. Add domain modules with narrow public interfaces.
2. Keep Zotero integration code separate from provider and conversation logic.
3. Export behavior through source-level public interfaces that tests can exercise without depending
   on implementation details.
