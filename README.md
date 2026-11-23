# rpgm-web

A self-hosted web server that runs **RPG Maker MV and MZ** games in the browser, on desktop and on phones.
Games look and behave like the desktop build: same textures, shaders and filters, Effekseer, audio, video, plugins and saves.

One Node.js process, zero npm dependencies. Game files on disk are never modified.

- **Library or API-only server.** A small library page for players, or no public page at all: you drive it through the HTTP API and CLI.
- **Embeds, like itch.io.** Put any game on another website with an `<iframe>`. Visitors see a cover with a play button and the game starts on click.
- **Cloud saves on your side.** With the JS SDK, players sign in with *your* site's accounts and their saves are stored by *your* backend, so they follow the player to any device. rpgm-web never sees your users, cookies or tokens.

## How it works

MV/MZ games are HTML5 apps wrapped in NW.js (Chromium + Node). rpgm-web drops the wrapper and serves the game as a website, plus a small runtime that provides what the browser lacks:

| On the desktop (NW.js) | In rpgm-web |
|---|---|
| `fs`: saves in `save/` or `%LOCALAPPDATA%` | a virtual file system on top of IndexedDB, one per game. Same paths and same logic, so plugins that move the save folder behave as on the desktop |
| `require('nw.gui')`, `nw.Window`, `process`, `os`, `path`, `child_process` | compatible shims: fullscreen, opening links, clipboard; "quit game" returns to the library |
| the window is sized to the game | the game is stretched to the browser window, keeping its aspect ratio, as on the desktop |
| MV picks `.m4a`/`.mp4` on phones | missing `.m4a`/`.mp4` files are generated with ffmpeg at import time (keeping the game's encryption); the browser picks a format it can play |
| fullscreen and video autoplay just work | browser policies (Firefox, Safari) are handled: refused requests are retried on the first click instead of crashing MZ |

The importer understands:
- plain folders and archives (`.zip` including zip64, `.tar(.gz)`; `.7z` and `.rar` through bsdtar);
- MV desktop builds with `www/`;
- NW.js `package.nw` or a zip appended to the `.exe`;
- **Dragonhouse/Halva** packaging (`GameConfig.sbcf` + `*.halva2`).

## Quick start

### Docker

```bash
docker compose up -d --build
```

The server listens on <http://localhost:8080/>. The admin token is stored in `data/config.json`; print it with:

```bash
docker compose exec rpgm-web node /app/bin/rpgm-web.js token
```

Add a game from the web page (**Admin** → paste the token → **Add game** → drop an archive) or from the command line:

```bash
mkdir -p imports && cp "$HOME/Downloads/My Game.zip" imports/
docker compose exec rpgm-web node /app/bin/rpgm-web.js import "/imports/My Game.zip"
```

### Without Docker

Requires Node.js 20+. Install `ffmpeg` for mobile audio/video and `bsdtar` for 7z/rar.

```bash
node bin/rpgm-web.js import "$HOME/Downloads/My Game.zip"
node bin/rpgm-web.js serve --port 8080
```

## CLI

```
rpgm-web serve   [--port 8080] [--host 0.0.0.0] [--data ./data] [--api-only]
rpgm-web import  <archive-or-folder> [--id my-game] [--title "Title"] [--transcode auto|off|audio|video]
rpgm-web list
rpgm-web info    <id>
rpgm-web remove  <id>
rpgm-web refresh <id> | --all                 re-detect resolution, cover art, media
rpgm-web cover   <id> <image.png|jpg|webp> | --remove
rpgm-web token
```

Running `import` again with the same `--id` updates the game in place. Players keep their saves, and browser caches refresh on their own because game URLs are tied to a revision.

## Embedding on other websites

Every game has an embed page at `/embed/<id>/`: a cover, the title and a play button. The game starts in the same frame when the visitor clicks, the way itch.io does it. The library page (**Admin** → the `</>` button on a game) generates the code for you.

Responsive:

```html
<div style="position:relative;width:100%;max-width:1280px;aspect-ratio:1280/720">
  <iframe src="https://games.example.com/embed/my-game/" title="My Game"
          allow="fullscreen; autoplay; gamepad" allowfullscreen loading="lazy"
          style="position:absolute;inset:0;width:100%;height:100%;border:0"></iframe>
</div>
```

Fixed size:

```html
<iframe src="https://games.example.com/embed/my-game/" title="My Game" width="960" height="540"
        allow="fullscreen; autoplay; gamepad" allowfullscreen loading="lazy" style="border:0"></iframe>
```

- Add `?mute=1` to the iframe URL to start without sound.
- Inside an embed, the in-game menu shows **Open in new tab** and **Exit game**; exiting returns to the cover.
- The cover is the game's title screen art (decrypted on the fly when the game is encrypted). Replace it with your own image with `rpgm-web cover <id> cover.png`, from the library page, or with `PUT /api/games/<id>/cover`. Without art, the game icon is shown.
- Saves in a plain embed stay in the visitor's browser and are partitioned by the embedding site (browser privacy rules), so they are not shared with the same game opened directly on your server. Use cloud saves to make them follow the player.
- Restrict which sites may embed your games with `RPGM_FRAME_ANCESTORS="https://blog.example.com https://*.example.org"`. The library/admin page itself can never be framed.

## Cloud saves (for site owners)

Keep saves on your own backend, under your own accounts. Load the SDK from your rpgm-web server and tell it how to read and write saves for the signed-in player:

```html
<div id="game"></div>
<script src="https://games.example.com/sdk/rpgm-embed.js"></script>
<script>
  RPGMWeb.embed('#game', {
    server: 'https://games.example.com',
    game: 'my-game',
    cloudSaves: {
      // Return what you stored last time, or null for a new player.
      load: (game) => fetch('/api/saves/' + game, { credentials: 'include' })
        .then((r) => (r.status === 404 ? null : r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))),
      // `data` is a JSON-safe object: store it as-is for the signed-in user.
      save: (game, data) => fetch('/api/saves/' + game, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      }),
    },
    onEvent: (type, detail) => console.log('game event', type, detail), // hello, loaded, started, saved, exit, error
  });
</script>
```

Your backend needs two endpoints for the current user, for example `GET /api/saves/:game` and `PUT /api/saves/:game`, storing one JSON document per user and game. Authentication is entirely yours (cookies, sessions, OAuth, anything).

How it works:
1. The game frame (`?cloud=1`) asks your page for the player's saves over `postMessage` before the game boots.
2. Your `load()` result becomes the game's storage. Nothing from the visitor's browser is mixed in, so two accounts on one computer never see each other's saves.
3. After the game writes anything (a save slot, options, plugin data), it sends a full snapshot to your `save()`, debounced to ~1 s and flushed when the page is closed. Writes are delivered in order.
4. If `load()` throws or does not answer within 10 s (for example the visitor is not signed in), the game falls back to saving in the browser and shows a notice.

Snapshot format (what `save()` receives and `load()` returns):

```json
{
  "format": "rpgm-web-saves", "version": 1,
  "game": "my-game", "title": "My Game", "engine": "mz", "savedAt": "2026-11-23T01:23:45.000Z",
  "entries": {
    "fs:/game/save/file1.rmmzsave": { "$file": { "path": "/game/save/file1.rmmzsave", "mtime": 1795398114749, "b64": "…" } },
    "ls:SomePluginKey": "plain string value"
  }
}
```

Treat it as an opaque blob. It is the same format as **Export saves** in the in-game menu, so players can also move progress between devices by hand.

Already have an iframe? `RPGMWeb.attach(iframe, { cloudSaves })` wires it up; add `?cloud=1` to its `/embed/<id>/` URL.

## API-only mode

Run without the public library page: `rpgm-web serve --api-only` or `RPGM_MODE=api`.

- `/` and the library assets return 404;
- `GET /api/games` requires the admin token;
- games stay reachable at `/play/<id>/` and `/embed/<id>/`, and so does the SDK.

Manage games through the CLI or the HTTP API below.

## HTTP API

Write requests need `Authorization: Bearer <token>`.

| Method | Path | |
|---|---|---|
| `GET` | `/api/games` | list games (hidden ones only for the admin; admin-only in API mode) |
| `POST` | `/api/games?filename=game.zip[&id=…][&title=…]` | body is the archive; replies `202 {job}` |
| `GET` | `/api/jobs/<job>` | import status: phase, progress, log |
| `GET` | `/api/games/<id>` | game info, including `url`, `embedUrl`, `coverUrl`, `screen` |
| `PATCH` | `/api/games/<id>` | `{"title": "…", "hidden": true}` |
| `DELETE` | `/api/games/<id>` | remove the game |
| `GET` / `PUT` / `DELETE` | `/api/games/<id>/cover` | cover image (PUT body: PNG/JPEG/WebP, ≤ 10 MB) |
| `GET` | `/play/<id>/` | play |
| `GET` | `/embed/<id>/` | embed page (click to play) |
| `GET` | `/sdk/rpgm-embed.js` | embed + cloud saves SDK |

```bash
curl -H "Authorization: Bearer $TOKEN" --data-binary @game.zip \
  "https://games.example.com/api/games?filename=game.zip&id=my-game"
```

## Environment

| Variable | Default | |
|---|---|---|
| `RPGM_DATA` | `./data` | game library and `config.json` |
| `RPGM_PORT` / `RPGM_HOST` | `8080` / `0.0.0.0` | |
| `RPGM_ADMIN_TOKEN` | generated | admin token |
| `RPGM_MODE` | `library` | `api` for API-only mode (same as `--api-only`) |
| `RPGM_PUBLIC_LIBRARY` | `1` | `0`: the game list needs the token (`/play/…` links still work) |
| `RPGM_FRAME_ANCESTORS` | `*` | sites allowed to embed games, space-separated |
| `RPGM_MAX_UPLOAD_GB` | `8` | maximum archive upload size |
| `RPGM_FFMPEG` | `ffmpeg` | path to ffmpeg |

## systemd

A ready-made unit lives in [`deploy/rpgm-web.service`](deploy/rpgm-web.service): a dedicated `rpgm` user, code in `/opt/rpgm-web/app`, data in `/opt/rpgm-web/data`, listening on `127.0.0.1:34210`.

```bash
useradd --system --home /opt/rpgm-web --shell /usr/sbin/nologin rpgm
mkdir -p /opt/rpgm-web/data && chown rpgm:rpgm /opt/rpgm-web/data
git clone https://github.com/GigaLionF95/RPGWeb-MVMZ /opt/rpgm-web/app
cp /opt/rpgm-web/app/deploy/rpgm-web.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now rpgm-web
```

## Behind a reverse proxy (nginx)

Example for a site behind Cloudflare: [`deploy/nginx.conf.example`](deploy/nginx.conf.example).

```nginx
server {
    server_name games.example.com;
    client_max_body_size 8g;          # large archive uploads
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_request_buffering off;  # stream uploads straight to disk
        proxy_read_timeout 1h;
        proxy_set_header Host $host;
    }
}
```

**Cloudflare.** The server sends `Cache-Control: no-transform` and marks every game script `data-cfasync="false"`, so Rocket Loader and other HTML "optimizations" leave them alone. Without this, games hang on a black screen. The free plan only proxies request bodies up to 100 MB, so import large archives with the CLI on the server.

All links are relative, so the server can also live in a sub-path (`location /games/ { proxy_pass http://127.0.0.1:8080/; }`).
Game assets are served with `Cache-Control: immutable`; JS and JSON are compressed with Brotli or gzip.

## Saves

- Stored in the player's browser (IndexedDB), separately for each game, without the 5 MB `localStorage` limit. With cloud saves, stored by the embedding site instead.
- The in-game menu (top-left corner; appears on mouse hover, always visible on phones):
  - **Export saves** downloads a JSON file with every save;
  - **Import saves** accepts that JSON or **desktop save files** (`file1.rpgsave`, `global.rpgsave`, `config.rpgsave`, or `*.rmmzsave`). For MV, include `global.rpgsave` together with the slot files: the game builds its save list from it.
- If the browser clears site data, local saves are gone. The server asks the browser for persistent storage, but export important progress.

## Phones

- Touch controls are built into the engine itself.
- iPhone does not support the Fullscreen API for pages. To play fullscreen, open the game in Safari → Share → **Add to Home Screen**: rpgm-web serves a PWA manifest with landscape orientation.
- Sound starts after the first tap (a browser requirement).

## Limitations

- Games packed into a single `.exe` with **Enigma Virtual Box** are not supported yet (the importer says so). Unpack them with a tool such as `evbunpack` and import the folder.
- Password-protected Halva packages are not supported yet.
- Steam plugins (greenworks), launching external programs and writing to arbitrary disk locations are impossible in a browser. Such calls get shims or a clean error, but features that depend entirely on Steam will not work.
- Like on the desktop, MZ pauses the game while its window (or frame) does not have focus.

## Rights

rpgm-web is a player. Host publicly only games you have the rights to, or with the author's permission. Many itch.io games allow distribution only through their official page.

## Development

```bash
npm test                         # node --test, synthetic fixture games
node bin/rpgm-web.js serve       # http://localhost:8080
```

Add `?mute=1` to a game URL to start it without sound, and `?rpgm-debug` to log runtime activity in the console. `?storage=web` uses the engine's built-in web storage instead of the desktop emulation.
