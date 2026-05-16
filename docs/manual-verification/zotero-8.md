# Zotero 8 Manual Verification

## Environment

- Zotero version:
- Plugin build artifact:
- Operating system:
- Provider profile tested:

## Checks

- Build the plugin with `npm run build`.
- Package the `addon/` directory into an XPI-compatible archive.
- Install the plugin in Zotero 8.
- Confirm Zotero accepts the extension manifest with `strict_min_version` set to `8.0`.
- Confirm Zotero loads `bootstrap.js` without startup console errors.
- Open a PDF reader tab, select text, and verify the explain command entry point is visible.
- Trigger an explanation and confirm the popup anchors near the selected text.
- Move the explanation into the sidebar and confirm the same conversation can continue.
- Save a provider profile and confirm only secret references are stored in preferences.
- Restart Zotero and confirm the provider profile list reloads.
- Disable or uninstall the plugin and confirm shutdown completes without console errors.

## Reader API Notes

- Reader selection event/API used:
- Popup container element:
- Sidebar container element:
- Any Zotero 8 console warnings:
