# Changelog

## 29.0.0 - 2026-10-16

- Fixed database bundle rows so titles, metadata, and actions remain visible in a single row.
- Restored the bundle Add URLs and Save edited controls as readable full-width text buttons.

## 28.0.0 - 2026-10-16

- Website capture now crawls links first without saving files, then presents a selectable link list with a live preview pane.
- Only pages explicitly selected by the user are captured and saved as `.webarchive` files.

## 27.0.0 - 2026-10-16

- Added individual delete icons for saved website bundles and captured archive rows in the Archive Database.

## 26.0.0 - 2026-10-16

- Added a website-folder delete control that removes every archived file in the folder from disk and download history.
- Added an Add website URL control to start capturing another website from the Archive Database.

## 25.0.0 - 2026-10-16

- Restyled bundle page actions as small, borderless delete and open-in-new-tab icons.

## 24.0.0 - 2026-10-16

- Website crawling now saves individual `.webarchive` files in a website-named Downloads folder instead of creating a `.zarc` bundle.
- The Archive Database groups and previews these individual website captures.

## 23.0.0 - 2026-10-16

- Replaced the bundle page Open source and Delete actions with compact accessible icons.

## 22.0.0 - 2026-10-16

- Added a collapsible database sidebar with a remembered preference and a persistent expand control.
- Clarified the viewer sidebar toggle label as Collapse.

## 21.0.0 - 2026-10-16

- Added page deletion and URL capture controls in bundle previews, with Save edited .zarc to download the revised bundle.

## 20.0.0 - 2026-10-16

- Redesigned the Archive Database as a split view with website folders and bundle threads in the sidebar and an embedded preview pane.

## 19.0.0 - 2026-10-16

- Website capture now opens the Archive Database automatically after the `.zarc` bundle is saved.

## 18.0.1 - 2026-10-16

- Added host access required for the same-domain crawler to inspect links on pages it opens during a crawl.

## 18.0.0 - 2026-10-16

- Added an Archive database page that groups `.zarc` bundles by source website URL with nested bundle threads.

## 17.0.0 - 2026-10-16

- Moved crawler settings to an accessible gear icon in the popup header that opens the settings page.

## 16.0.0 - 2026-10-16

- Added live website-capture progress with a progress bar, current URL, page counter, and crawl log.

## 15.0.0 - 2026-10-16

- Added a settings page for the website crawler, including maximum page count and URL exception rules.

## 14.0.0 - 2026-10-16

- Added same-domain website capture, which discovers up to 100 pages from the current page and packages them into one `.zarc` bundle.

## 13.0.0 - 2026-10-16

- Archive-history search now indexes the contents of saved archives, including page text and embedded resource text, in addition to titles and URLs.

## 12.0.0 - 2026-10-16

- Added full archive-history search across titles, URLs, filenames, local paths, and archive metadata.
- Removed the previous 500-item download-history cap so search covers the complete available history.

## 11.0.0 - 2026-10-16

- Added a small “Request a feature” popup link that opens a dedicated request page.
- Feature requests open a prefilled email to boni.aditya@gmail.com with the installed extension version. Users review and send the email in their email app.
- Added image attachment support through file selection, paste, and drag-and-drop.

Major feature upgrades use the `x.0.0` version format and increment the major number.

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
