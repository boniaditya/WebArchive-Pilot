# Changelog

## 33.0.0 - 2026-10-27

- Added a bulk converter in Archive History for multiple downloaded or locally chosen `.webarchive` files.
- Convert each selected archive into an individual MHTML, standalone HTML, or text file in `Downloads/WebArchive Pilot Converted`.
- Added a guided PDF queue that opens Chrome's Save to PDF dialog one archive at a time.
- Added selection controls, per-file progress and errors, and an option to stop after the current file.

## 32.0.0 - 2026-10-23

- Expanded the privacy policy to disclose local data handling, backup retention, and all recipients of optional feature requests.
- Added an explicit data-transfer acknowledgment before sending a feature request.

## 31.0.0 - 2026-10-23

- Added a Preview button to downloaded `.webarchive` cards in Archive History.
- Standalone archives now open in the existing resizable right-side preview without leaving the page; View still opens the full viewer.

## 30.0.0 - 2026-10-21

- Stopped creating or overwriting the automatic library backup whenever an archive is opened or Archive History is visited.
- The extension now records the existing backup's download ID and resolved local path in Chrome's internal extension storage.
- Automatic backup checks reuse the remembered file and search prior Chrome downloads before creating anything new.
- A new automatic backup is created only when no previous WebArchive Pilot library backup can be found.
- The manual Back up library button continues to create an updated backup when requested.

## 29.0.0 - 2026-10-21

- Made Archive History cards respond to the available width of the archive list while the page preview is open.
- Archive actions now move below archive details before titles and paths become cramped.
- Long local paths use a compact single-line treatment in split view.
- Embedded `.webarchive` rows and their actions reflow cleanly at narrow divider positions.
- The preview header now wraps its title, URL, and actions when the preview pane is narrow.

## 28.0.0 - 2026-10-21

- Fixed Archive History failing with `bundleContents is not defined`.
- Library metadata, opened-file history, folders, and folder assignments now create an automatic JSON backup in the local Downloads folder.
- Extension upgrades continue using Chrome's local extension data without resetting the library.
- Added Back up library and Restore backup controls for preserving the library across extension removal and reinstallation.
- A fresh installation attempts to restore the newest local WebArchive Pilot backup automatically when file access is available.

## 27.0.0 - 2026-10-21

- Added a collapsible folder sidebar to Archive History.
- Added a draggable divider between the archive list and the right-side page preview.
- The divider supports mouse, touch, and keyboard resizing.
- Folder-sidebar state and preview width persist between visits.

## 26.0.0 - 2026-10-21

- Added a plus icon immediately before every downloaded `.zarc` bundle title.
- Clicking the plus expands the bundle's individual `.webarchive` files in place.
- The icon changes to a minus while expanded and collapses the file list when clicked again.
- Removed the larger Expand contents action from the archive action grid.

## 25.0.0 - 2026-10-21

- Archive History and the page preview now use an equal 50/50 split-screen layout.
- Clicking an exact search result inside a `.zarc` opens the complete embedded page in the right half.
- Search results remain visible on the left while the selected archived page renders on the right.
- Removed the search-result text drawer from the normal result-opening flow.

## 24.0.0 - 2026-10-21

- Archived-page previews now open in a docked panel on the right side of Archive History.
- The archive list remains visible and usable on the left while a page is previewed.
- Removed the modal backdrop and centered overlay behavior from archive previews.

## 23.0.0 - 2026-10-21

- Added full archived-page previews directly inside Archive History.
- Expanded `.zarc` entries are now clickable and include a Preview button.
- The in-page preview renders the embedded `.webarchive` with its captured images, styles, and other resources.
- Previewed files can be extracted without closing the preview or navigating to another page.

## 22.0.0 - 2026-10-21

- Archive History search now automatically indexes captured pages inside downloaded `.zarc` bundles.
- Search results identify the exact embedded `.webarchive` pages that match without requiring the separate indexing action first.
- Matching bundle pages appear directly on the `.zarc` result and open their highlighted matching lines in the existing side panel.

## 21.0.0 - 2026-10-20

- Added a dedicated search engine inside the `.zarc` viewer.
- Bundle search finds pages by title, original URL, filename, and captured page text.
- Results update in the existing bundle sidebar with match counts, highlighted titles, and matching text snippets.
- Selecting a result opens that archived page directly in the current viewer.

## 20.0.0 - 2026-10-20

- Search results for `.zarc` bundles now identify every exact embedded `.webarchive` file that matched.
- Clicking an embedded result opens a right-side panel in Archive History without navigating to another tab.
- The panel shows the matching captured lines and highlights the search terms in context.
- The match panel can be dismissed with its Close button, the backdrop, or the Escape key.

## 19.0.0 - 2026-10-20

- Archive History now uses the full browser width instead of a centered fixed-width layout.
- Search, folder navigation, archive cards, and expanded bundle contents grow with the available window space.

## 18.0.0 - 2026-10-20

- Added inline expansion of `.zarc` bundles directly in Archive History.
- Bundle contents show each embedded page title, original URL, and archive size without opening a new tab.
- Added controls to extract one embedded `.webarchive` or every file in a bundle.
- Extracted archives retain their page metadata and inherit the source bundle's folder assignment.

## 17.0.0 - 2026-10-20

- Fixed downloaded archives failing to open from Download History even though the same local file opened successfully.
- Automatic opening now reads the completed file on disk before trying Chrome's temporary download source URL.
- Added file-size, binary-plist, ZIP-header, and ZIP-end-record validation so incomplete temporary data is rejected.
- Increased the local archive read timeout for large `.zarc` bundles and improved file-access error messages.

## 16.0.0 - 2026-10-20

- The archive search now shows only its search bar by default, with filters and content indexing in a collapsed Advanced options section.
- Added popup actions to save tabs on the left or right as separate `.webarchive` files.
- Existing left/right `.zarc` bundle actions remain available.
- Side-tab save summaries now count skipped tabs only within the selected side.

## 15.0.0 - 2026-10-20

- Added advanced search across downloaded `.webarchive` files and the pages contained inside `.zarc` bundles.
- Search can target titles, filenames, original URLs, folder names, and captured page text.
- Added all-word, any-word, exact-phrase, regular-expression, and case-sensitive matching.
- Added filters for archive type, folder, saved date range, and file-size range.
- Added relevance, date, title, and size sorting with live result counts and text-index progress.

## 14.0.0 - 2026-10-20

- Added persistent folders to the archive history for organizing downloaded and locally opened `.webarchive` and `.zarc` files.
- Added All archives and Unfiled views with per-folder archive counts.
- Archives can be moved with a folder selector or dragged directly onto a folder.
- Added folder creation, renaming, and deletion. Deleting a folder moves its archives to Unfiled without deleting files.

## 13.0.0 - 2026-10-20

- Added a Chrome Web Store rating prompt after a `.webarchive` download completes successfully.
- The prompt offers direct actions to rate the extension or leave a comment and appears only once per browser session.

## 12.0.0 - 2026-10-19

- Feature requests are now submitted directly to boni.aditya@gmail.com through FormSubmit instead of opening a local email draft.
- Added a required From email address field and uses it as the reply-to address.
- Pasted, dragged, or selected screenshots are uploaded with the request as email attachments.
- Added clear sending, success, and delivery-error states to the request form.

## 11.0.0 - 2026-10-19

- Added a Request a feature link to the extension popup.
- Added a feature-request form addressed to boni.aditya@gmail.com with page context and extension version details.
- Users can paste, drag, or select an image, preview it, and remove it before preparing the request.
- Pasted images are saved with a clear attachment filename before an addressed, prefilled email draft opens.

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
