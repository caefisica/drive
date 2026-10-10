# drive

A website that browses several Google Drives under one address. It runs on
Cloudflare Workers, built with [Void](https://void.cloud) and Vue.

Open `/0/` for the first drive, `/1/` for the second. Folders list as a grid.
Files open in a viewer. Large files stream with range requests, so video and
audio seek. Search finds files by name across all drives.

```text
/0/                       first drive, root folder
/0/Lectures/week-1/       a folder
/0/Lectures/week-1/a.mp4  a file, shown in the video player
/api/search?q=week        files whose name contains "week"
```

## Run it

```sh
bun install
vp dev                       # needs .env with DRIVES and the two secrets
```

`vp` is Vite+; `mise install` provides the version pinned in
[mise.toml](mise.toml). The dev server applies the D1 migrations and prints its
local URL. [Configuration](docs/configuration.md) explains each variable.

## Features

- Several drives at once: a personal Drive, a shared (Team) drive, or a single
  shared folder.
- Viewers for video, audio, images, PDF, Markdown and highlighted code.
- Google Docs, Sheets, Slides and Drawings download as `.docx`, `.xlsx`, `.pptx`
  and `.svg`.
- Name search over metadata synced into D1. A cron job syncs on a schedule and a
  Drive push webhook can sync on change.
- Password-protected folders, unlocked with a cookie.
- Signed links for streaming and download that expire.

## Documentation

- [Manual](docs/README.md): configuration, browsing, sync, folder passwords,
  deploying.
- [Contributing](docs/development.md): layout, checks and tests.
- [Architecture](docs/architecture.md): how the code is organized.
