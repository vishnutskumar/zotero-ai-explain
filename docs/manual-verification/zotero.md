# Zotero Manual Verification

## Environment

- Zotero version:
- Plugin build artifact:
- Operating system:
- Provider profile tested:

## Checks

- Build the plugin with `npm run build`.
- Package the plugin with `node scripts/package-xpi.mjs v0.1.0`.
- Install `zotero-ai-explain.xpi` in Zotero.
- Confirm Zotero accepts the extension manifest.
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
- Any Zotero console warnings:

## Compatibility Troubleshooting

If Zotero reports that the add-on is incompatible after rebuilding:

- Confirm the XPI manifest with `unzip -p zotero-ai-explain.xpi manifest.json`.
- Confirm the manifest contains `strict_min_version` and `strict_max_version` under
  `applications.zotero`.
- Confirm release compatibility is stated as Zotero 8.0 through 9.99.99.
- Confirm the manifest id is email-style, such as `zotero-ai-explain@vishnutskumar.github.io`, not a
  local placeholder id.
- Close Zotero, remove the stale add-on entry from the Plugins window if present, and restart
  Zotero.
- If Zotero still reports stale compatibility, close Zotero and remove cached add-on state from the
  active Zotero profile before reinstalling: `extensions.json`, `addonStartup.json.lz4`, and
  `extensions.lastAppVersion` / `extensions.lastAppBuildId` lines in `prefs.js`.
