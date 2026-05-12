# Addon

This directory contains Zotero extension assets and browser-facing files.

## Structure

```text
addon/
  manifest.json        # Zotero/WebExtension manifest
```

## Extending

1. Keep generated build output out of this directory unless the build process explicitly owns it.
2. Keep browser-facing UI assets separate from provider and conversation logic in `src/`.
3. Update the manifest when plugin permissions, entry points, or metadata change.
