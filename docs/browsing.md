# Browsing

What a visitor sees at each URL. The code path is in
[Architecture](architecture.md#viewing-a-path).

## URLs

A URL is the drive's index followed by one name per folder on the way down. A
URL that ends in `/` is a folder. Any other URL is a file. `/` shows the first
drive. `/api/search` is [search](#search).

## Listings

A folder page lists the folder's files in the order Drive returns for
`folder,name,modifiedTime desc`.

- A shortcut appears as its target.
- Trashed files do not appear.
- A file named `.password` does not appear, and no URL reaches it.
- The whole folder is listed, every page of Google's answer, so a name shared by
  two files is always noticed.
- Listings are cached in KV. Resolving a URL to a file is not. See
  [KV keys](architecture.md#kv-keys).

### Duplicate names

Drive allows many files of one name in a folder. Each file needs its own URL, so
a file gets its Drive file ID as a suffix, `name (dupID: 1AbC)`, when:

- a sibling in the same folder has the same name, or
- its own name already looks like a suffixed one.

The plain name of such files is not a URL. It answers 404. A file whose name no
sibling shares keeps its plain name.

## Viewers

The viewer follows the file's MIME type.

| MIME type                                             | Viewer                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `video/*`, `audio/*`                                  | Player. The stream answers `Range` requests, so seeking works. |
| `image/*`, `application/pdf`                          | Image, PDF viewer.                                             |
| `text/markdown`, `text/x-markdown`                    | Rendered Markdown. Raw HTML inside it is escaped.              |
| other `text/*`, `application/json`, `application/xml` | Highlighted code. The language comes from the file extension.  |
| Google Docs, Sheets, Slides, Drawings                 | An export button: `.docx`, `.xlsx`, `.pptx`, `.svg`.           |
| anything else                                         | The file name and a download button.                           |

Stream and export links expire after one hour. See
[Folder passwords](folder-passwords.md#signed-links).

## Search

The search box in the page header calls `GET /api/search?q=<text>`. It returns
an HTML page of links.

- It matches file and folder names that contain the text, ignoring ASCII case.
- It searches the index in D1, so a file shows up after [sync](sync.md) has seen
  it.
- It returns at most 50 results, in no set order.
- `d=<drive index>` limits it to one drive. A `d` that is not a plain
  non-negative integer answers 400.
- A file named `.password` never appears.
- Without `q` it answers 400.
- A result links to the file through every folder name on the way, in the
  suffixed form of [duplicate names](#duplicate-names).
- Locked folders hide their contents. See
  [Folder passwords](folder-passwords.md#search).
