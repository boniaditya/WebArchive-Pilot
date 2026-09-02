# Changelog

## 10.0.0 - 2026-09-02

- Added local archive exports from the viewer.
- Added per-file export controls directly in the Downloads library.
- Added context-menu actions to save the tabs on the left or right of the current tab as one `.zarc` bundle.
- Updated the context-menu all-tabs action to create one `.zarc` bundle instead of separate archive files.
- Reworked the Downloads-library action area into a compact two-column layout.
- Added persistent history for `.webarchive` and `.zarc` files opened manually in the viewer.
- Added visual icons and a dropdown caret to Downloads-library export controls.
- Export a loaded `.webarchive` as a PDF through Chrome's Save to PDF dialog, standard `.mhtml`, standalone `.html`, plain-text `.txt`, or the original `.webarchive` file.
- MHTML and standalone HTML exports use only resources captured in the selected archive.

## 2.0.0 - 2026-08-12

- Added support for creating and opening bundled `.zarc` archive files.
- Added a tabbed bundle viewer so embedded `.webarchive` files can be opened from the left sidebar.
- Fixed bundled archive decoding so `.zarc` entries open correctly in the viewer.
- Added multi-select bundle creation from the downloaded archives library.
- Updated popup actions so:
  - `Save all tabs as .zarchive` creates one bundle for all open tabs.
  - `Save tabs on left as .zarchive` creates one bundle for all tabs to the left.
  - `Save tabs on right as .zarchive` creates one bundle for all tabs to the right.
- Updated popup labels and archive-management copy for the new bundle workflow.
- Updated extension metadata and plugin branding to credit `Boni Aditya`.
