# WebArchive Pilot

WebArchive Pilot is a Manifest V3 Chrome extension that lets you:

- save the current tab as a `.webarchive` file
- save all open tabs, or only the tabs to the left or right of the active tab
- open and view `.webarchive` files directly inside Chrome

The project is built as a lightweight, dependency-free browser extension. It uses Chrome's built-in page capture API to snapshot a fully loaded page, converts that capture into Safari-compatible `.webarchive` format, and includes a local viewer for reopening saved archives later.

## What The Project Does

Traditional "save page" tools usually export raw HTML, incomplete assets, or browser-specific formats. WebArchive Pilot is designed to preserve a page more faithfully by:

1. capturing the page with `chrome.pageCapture.saveAsMHTML()`
2. parsing the captured MHTML into individual resources
3. rebuilding those resources as a binary property list (`bplist00`)
4. downloading the result as a `.webarchive` file

That makes the extension useful for:

- personal archiving
- saving research pages for later reference
- preserving authenticated or dynamically rendered pages after they are fully loaded
- moving `.webarchive` files between Safari and Chrome workflows

The project also ships with a built-in viewer so Chrome can open `.webarchive` files that would otherwise only be easy to inspect in Safari.

## Main Features

- Save the active page from the popup.
- Save all open tabs in the current window.
- Save only tabs on the left or right of the active tab.
- Save pages from the right-click context menu.
- Show progress in the popup while a capture is running.
- Show system notifications for background saves and bulk saves.
- Open `.webarchive` files created by Safari or by this extension.
- Render archived HTML, CSS, images, fonts, scripts, and other captured resources inside a sandboxed viewer.
- Run entirely client-side with no backend, build pipeline, or external service.

## How Saving Works

When you save a page, the extension follows this pipeline:

1. Chrome serializes the live tab into MHTML using the `pageCapture` API.
2. `mhtml.js` parses the multipart MIME payload into resource records.
3. `background.js` turns those records into the standard `.webarchive` object tree:
   - `WebMainResource`
   - `WebSubresources`
4. `bplist.js` encodes that object tree as a binary plist.
5. The extension downloads the finished archive with a sanitized filename based on the tab title.

Because the source capture comes from Chrome after the page has loaded, the archive can include:

- HTML after client-side rendering
- CSS and imported stylesheets
- images and responsive image candidates
- JavaScript files already fetched by the page
- fonts
- inline data URLs
- authenticated assets already available in the browser session

## How Viewing Works

The included viewer is a local HTML page inside the extension:

1. The user picks or drags in a `.webarchive` file.
2. `bplist_decoder.js` decodes the binary plist.
3. `viewer.js` extracts the main HTML resource and all subresources.
4. Every archived resource is converted into a blob URL.
5. CSS `url(...)` references are rewritten to those blob URLs.
6. HTML `src`, `href`, `srcset`, inline styles, and `<style>` blocks are patched.
7. The final result is rendered inside a sandboxed iframe.

This allows the extension to reopen archived pages directly in Chrome without relying on Safari.

## Installation

There is no build step.

1. Download or clone this project to your machine.
2. Open Chrome and go to `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select this project folder: `Web Archive Chrome Plugin`.
6. Optionally pin **WebArchive Pilot** from the Chrome toolbar.

## Usage

### Save the current page

1. Open the page you want to archive.
2. Click the WebArchive Pilot extension icon.
3. Click **Save as .webarchive**.
4. Wait for the progress bar to finish.

### Save multiple tabs

From the popup you can choose:

- **Save all open tabs**
- **Tabs on left**
- **Tabs on right**

The extension will skip browser-internal tabs that cannot be archived.

### Save from the context menu

After installation, right-click on a page and use:

- **Save as .webarchive**
- **Save all open tabs as .webarchive**

These flows report completion through Chrome notifications.

### Open a `.webarchive` file

1. Open the extension popup.
2. Click **Open .webarchive file...**
3. Drag in a file or browse for one.
4. The viewer will decode and render the archive in a new tab.

## Permissions

The extension requests the following permissions:

- `activeTab`: access the currently focused page when saving from the popup
- `downloads`: write the generated `.webarchive` file to disk
- `pageCapture`: capture the current page as MHTML
- `tabs`: query open tabs, read titles and URLs, and support bulk-save actions
- `contextMenus`: add right-click save commands
- `notifications`: show progress and completion messages outside the popup

## Project Structure

- `manifest.json`: extension manifest and permission declarations
- `background.js`: service worker, save pipeline, bulk-save flows, notifications, and context menus
- `popup.html`: popup interface for save and open actions
- `popup.js`: popup behavior, progress UI, and background messaging
- `viewer.html`: standalone `.webarchive` viewer page
- `viewer.js`: decode, patch, and render logic for archived pages
- `mhtml.js`: parser for Chrome's MHTML output
- `bplist.js`: binary plist encoder used to create `.webarchive` files
- `bplist_decoder.js`: binary plist decoder used by the viewer
- `icons/`: extension icons in multiple sizes
- `archive.png`: project artwork/logo

## Limitations And Tradeoffs

WebArchive Pilot captures pages very well, but it is still constrained by how browsers load and replay web content.

- Browser-internal pages such as `chrome://`, `chrome-extension://`, `about:`, and `edge://` cannot be archived.
- Only resources available to the browser at capture time can be included.
- Some highly interactive sites may not behave exactly the same after replay.
- Pages that depend on live APIs, service workers, or server-side state may render partially or lose functionality offline.
- If a resource was not captured, the viewer injects a `<base href>` pointing to the original page so unresolved relative URLs can still resolve against the original site.
- The viewer is designed for binary plist `.webarchive` files, especially ones produced by Safari or this extension.

## Development Notes

- The codebase is plain JavaScript with no package manager or bundler.
- The extension targets Chrome Manifest V3 and uses a service worker background script.
- To test local changes, edit the files and then click **Reload** on the extension in `chrome://extensions`.
- Most verification is manual: save a few real pages, test multi-tab capture, and reopen the produced files in the viewer.

## Why This Project Is Interesting

This project combines a few pieces that are not usually found together in a small extension:

- Chrome page capture
- MIME multipart parsing
- Safari-compatible `.webarchive` generation
- binary plist encoding and decoding
- in-browser archive replay with URL rewriting

That makes it both a useful tool and a compact reference implementation for anyone interested in browser archiving formats.
