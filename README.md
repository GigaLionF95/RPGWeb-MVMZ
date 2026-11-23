# rpgm-web

A self-hosted web server that runs **RPG Maker MV and MZ** games in the browser, on desktop and on phones.
Games look and behave like the desktop build: same textures, shaders and filters, Effekseer, audio, video, plugins and saves.

One Node.js process, zero npm dependencies. Game files on disk are never modified.

- **Library or API-only server.** A small library page for players, or no public page at all: you drive it through the HTTP API and CLI.
- **Embeds, like itch.io.** Put any game on another website with an `<iframe>`. Visitors see a cover with a play button and the game starts on click.
- **Bring desktop saves.** Players who started on the downloaded `.exe` import their save folder (or a `.zip` of it) from the in-game menu and continue in the browser or on a phone.
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
- builds for every platform RPG Maker exports to: **Windows** (`Game.exe`), **Linux**, **macOS** (`Game.app/Contents/Resources/app.nw`) and **Android** (`.apk`, game in `assets/www/`);
- MV desktop builds with `www/`;
- NW.js `package.nw` or a zip appended to the `.exe`;
- **Dragonhouse/Halva** packaging (`GameConfig.sbcf` + `*.halva2`).

Desktop builds ship the NW.js runtime next to the game (`nw.dll`, `Game.exe`, `lib/libnw.so`, `locales/*.pak`…, 200–300 MB). A browser never uses it, so the importer leaves it out.

## Installation

You need a computer or server that stays on: a VPS, a home server, or your PC for testing. The steps below run commands in a terminal on that machine. Everything happens inside the project folder, so step 1 (getting the code) is not optional: `docker compose` alone does nothing without it.

### Option A: Docker (recommended)

**1. Install Docker.** On a Linux server: <https://docs.docker.com/engine/install/>. On Windows or macOS: Docker Desktop. Check that it works:

```bash
docker compose version
```

**2. Download rpgm-web** and go into its folder:

```bash
git clone https://github.com/GigaLionF95/RPGWeb-MVMZ.git
```

```bash
cd RPGWeb-MVMZ
```

No `git`? Download <https://github.com/GigaLionF95/RPGWeb-MVMZ/archive/refs/heads/main.zip>, unzip it, and open a terminal in the unzipped folder (`RPGWeb-MVMZ-main`).

**3. Start it** (still inside that folder). The first start takes a few minutes while Docker builds the image:

```bash
docker compose up -d --build
```

**4. Open the library** at `http://<your server's IP>:8080/` (on your own PC: <http://localhost:8080/>). Port 8080 taken? Create a file named `.env` in the folder with `RPGM_HTTP_PORT=9000` and run step 3 again.

**5. Get your admin token.** You need it to add games:

```bash
docker compose exec rpgm-web node /app/bin/rpgm-web.js token
```

**6. Add a game.** On the library page, click **Admin**, paste the token, then **Add game** and drop the game's archive (the `.zip` you downloaded from itch.io or similar). That's it: click the game to play.

For big archives (over 100 MB behind Cloudflare), copy them into the `imports` folder and import from the terminal:

```bash
docker compose exec rpgm-web node /app/bin/rpgm-web.js import "/imports/My Game.zip"
```

**Update to a new version** (games and saves are kept):

```bash
git pull
```

```bash
docker compose up -d --build
```

The library lives in a Docker volume named `rpgm-data`. `docker compose down` keeps it; `docker compose down -v` deletes it with every game in it.

#### Something went wrong?

| What you see | What to do |
|---|---|
| `no configuration file provided: not found` | You are not in the project folder. `cd RPGWeb-MVMZ` (step 2) and run the command again. |
| `docker: 'compose' is not a docker command` | Old Docker. Install the current version (step 1), or try `docker-compose` with a dash. |
| `permission denied ... docker.sock` | Run the commands with `sudo`, or add your user to the `docker` group. |
| `port is already allocated` | Something else uses 8080. Pick another port (step 4). |
| The page does not open from another computer | Open the port in your server's firewall, e.g. `sudo ufw allow 8080`. |
| Logs | `docker compose logs -f` |

### Option B: Node.js, without Docker

**1. Install Node.js 20 or newer** from <https://nodejs.org/> and check it with `node -v`. Optional: `ffmpeg` (converts audio/video for phones at import) and `bsdtar` (opens `.7z` and `.rar`).

**2. Download rpgm-web** (step 2 of Option A) and go into its folder. There is nothing to `npm install`: rpgm-web has no dependencies.

**3. Import a game and start the server:**

```bash
node bin/rpgm-web.js import "$HOME/Downloads/My Game.zip"
```

```bash
node bin/rpgm-web.js serve --port 8080
```

Open <http://localhost:8080/>. The server stops when you close the terminal. To keep it running on a server, use the [systemd unit](#systemd).

## CLI

```
rpgm-web serve   [--port 8080] [--host 0.0.0.0] [--data ./data] [--api-only]
rpgm-web import  <archive-or-folder> [--id my-game] [--title "Title"] [--transcode auto|off|audio|video]
                 [--no-precompress]
rpgm-web list
rpgm-web info    <id>
rpgm-web remove  <id>
rpgm-web refresh <id> | --all                 re-detect resolution, cover art, media; rebuild precompressed files
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
      save: (game, data, info) => {
        const body = JSON.stringify(data);
        return fetch('/api/saves/' + game, {
          method: 'PUT', credentials: 'include',
          headers: { 'Content-Type': 'application/json' }, body,
          // Let the request finish if the tab is closing. Browsers cap keepalive bodies at 64 KB.
          keepalive: body.length < 60000,
        });
      },
    },
    onEvent: (type, detail) => console.log('game event', type, detail), // hello, loaded, started, saved, exit, error
  });
</script>
```

Your backend needs two endpoints for the current user, for example `GET /api/saves/:game` and `PUT /api/saves/:game`, storing one JSON document per user and game. Authentication is entirely yours (cookies, sessions, OAuth, anything).

How it works:
1. The game frame (`?cloud=1`) asks your page for the player's saves over `postMessage` before the game boots.
2. Your `load()` result becomes the game's storage. Nothing from the visitor's browser is mixed in, so two accounts on one computer never see each other's saves.
3. After the game writes anything (a save slot, options, plugin data), it sends a full snapshot to your `save()` within ~150 ms. Writes are delivered in order. The third argument is `{ seq, final }`. `final` is true when the game or your page is being hidden or closed. Send that request with `keepalive` (or `navigator.sendBeacon`) so the browser does not cancel it. Save as soon as `save()` is called: a message sent while the tab is closing may never arrive.
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
| `PATCH` | `/api/games/<id>` | `{"title": "…", "hidden": true}`. `hidden` means *unlisted*: the game leaves the public list, but `/play/<id>/`, `/embed/<id>/` and `GET /api/games/<id>` keep working for anyone with the link |
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
| `RPGM_MAX_UNPACKED_GB` | `20` | an archive that unpacks to more is rejected (zip bombs) |
| `RPGM_MAX_FILES` | `200000` | maximum number of files in an archive |
| `RPGM_IMPORT_CONCURRENCY` | `1` | imports running at once; the rest wait in a queue |
| `RPGM_GAME_SANDBOX` | `1` | `0`: run games without the opaque-origin sandbox (debugging only, see Security) |
| `RPGM_UPSTREAM` | — | makes this server a replica of that primary (see [Several servers](#several-servers)) |
| `RPGM_SYNC_INTERVAL` | `60` | replica: seconds between checks for changes on the primary |
| `RPGM_PRECOMPRESS` | `1` | `0`: skip making `.br`/`.gz` copies at import (compress on the fly only) |

## Several servers

One server is usually enough: game files are cached by the browser and by a CDN, and the server mostly streams static files. Add servers when one machine runs out of bandwidth or disk, or for redundancy. You do not copy anything by hand:

- **One primary** keeps the library. It is an ordinary rpgm-web server.
- **Replicas** mirror it. Each replica checks the primary every minute and downloads new or changed games: only the files that differ. Games deleted on the primary are deleted on the replicas.
- **Admin actions work on any server.** A replica forwards uploads, renames, cover changes and deletions to the primary. An upload made through a replica is already on that replica when the admin page says *Done*, and on the other replicas within a minute.
- **Players can land on any server.** Saves live in the player's browser, so no sticky sessions are needed. Every node sends identical files with identical `ETag`s.

Set up a replica: a fresh rpgm-web install with **the same admin token** as the primary, plus the primary's address:

```bash
RPGM_ADMIN_TOKEN=<the primary's token> RPGM_UPSTREAM=http://10.0.0.1:8080 node bin/rpgm-web.js serve
```

With Docker, put both lines in the replica's `.env` file:

```
RPGM_ADMIN_TOKEN=<the primary's token>
RPGM_UPSTREAM=http://10.0.0.1:8080
```

and run `docker compose up -d`. Use the primary's direct or private address when you can, not a Cloudflare-proxied hostname. Cloudflare limits request bodies to 100 MB, and uploads forwarded by a replica would hit that limit. Import from the command line on the primary only: a replica refuses CLI imports, because the next sync would remove them.

`/healthz` shows each node's role and the replica's last sync: `{"role":"replica","sync":{"lastSync":"…","lastError":null,"games":12}}`. Point your load balancer's health check at it.

**Spreading players over the servers.** Pick one:

- **Cloudflare, free:** add several proxied `A` records with the same name, one per server. Cloudflare spreads visitors between them. Use Cloudflare Load Balancing (paid) if you also want health checks and automatic failover.
- **nginx in front:**

  ```nginx
  upstream rpgm {
      server 10.0.0.1:8080;            # primary
      server 10.0.0.2:8080;            # replica
      server 10.0.0.3:8080;            # replica
  }
  server {
      server_name games.example.com;
      client_max_body_size 8g;
      location / {
          proxy_pass http://rpgm;
          proxy_request_buffering off;
          proxy_read_timeout 1h;
          proxy_set_header Host $host;
      }
  }
  ```

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

All links are relative, so the server can also live in a sub-path (`location /games/ { proxy_pass http://127.0.0.1:8080/; }`).

Optional: let nginx keep its own copy of game files, so Node only serves each file once. Worth it without a CDN in front, or when the data disk is slow.

```nginx
# in http { }
proxy_cache_path /var/cache/nginx/rpgm levels=1:2 keys_zone=rpgm:50m
                 max_size=20g inactive=30d use_temp_path=off;

# in server { }, next to location /
location /play/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_cache rpgm;                  # follows the server's Cache-Control:
    proxy_cache_lock on;               # immutable assets are kept, no-cache pages are not
    proxy_cache_use_stale error timeout updating;
    add_header X-Cache $upstream_cache_status;
}
```

## Caching and compression

What the server sends:

| URL | `Cache-Control` | Why |
|---|---|---|
| `/play/<id>/` | `no-cache` | host page: keeps saves, frames the sandboxed game from the current revision, `/play/<id>/r<rev>/` |
| `/play/<id>/r<rev>/` (index.html), engine scripts `rpg_*.js` / `rmmz_*.js` / `plugins.js` | `no-cache` + `ETag` | patched at serve time with the runtime; revalidated, usually a `304` |
| every other file under `/play/<id>/r<rev>/` | `public, max-age=31536000, immutable` | the revision is in the URL: re-importing a game bumps it, so a cached file is never stale |
| `/api/…` | `no-store` | |

Text files (JS, JSON, CSS, SVG…) go out with Brotli or gzip. Compression never blocks the server:

- **At import**, rpgm-web writes max-quality Brotli and gzip copies of every text file to `data/games/<id>/precompressed/`. Requests stream them straight from disk with no CPU work. They are usually ~10× smaller than the originals and add about 1% to the game's size on disk (Haven: 47 MB of JSON/JS → 2.8 MB). Run `rpgm-web refresh --all` once to add them to games imported by older versions.
- **Anything else** (a game without copies, files changed by hand) is compressed on the fly in the thread pool. The result is kept in a 256 MB in-memory cache. Parallel requests for the same file share one compression.

Images, audio and video are already compressed and go out as-is, with byte-range support.

### Cloudflare

By default Cloudflare caches files by extension only. It skips game data (`.json`) and encrypted assets (`.rpgmvp`, `.png_`, `.ogg_`, `.m4a_`…), so every player pulls those from your server. One Cache Rule fixes this.

**Dashboard:** *Caching → Cache Rules → Create rule*

- **If incoming requests match:** custom filter expression

  ```
  starts_with(http.request.uri.path, "/play/")
  ```
- **Cache eligibility:** Eligible for cache.
- **Edge TTL:** *Use cache-control header if present, bypass cache if not*. Immutable files stay at the edge. Pages and engine scripts marked `no-cache` are revalidated with the server, which answers `304`.
- **Browser TTL:** *Respect origin TTL*.

Then *Caching → Configuration → Browser Cache TTL* → **Respect Existing Headers**. Any other value makes Cloudflare replace `no-cache` with its own `max-age`. Players would then keep an old `index.html` and runtime for up to that long after you upgrade rpgm-web.

Also recommended:

- *Caching → Tiered Cache → Smart Tiered Caching*: on (free). Edge locations fill from one another instead of all asking your server.
- *Speed → Optimization*: nothing to turn off. Rocket Loader would hang games on a black screen by reordering their scripts. The server prevents that: every game script is marked `data-cfasync="false"` and responses carry `no-transform`. That also keeps Polish and Mirage off the game files.

**The same through the API** (token with *Zone → Cache Rules → Edit* and *Zone Settings → Edit*):

```bash
ZONE=your-zone-id; TOKEN=your-api-token
API=https://api.cloudflare.com/client/v4/zones/$ZONE

# Cache rule. PUT replaces the zone's cache rules: if you already have some,
# add this rule in the dashboard instead.
curl -X PUT "$API/rulesets/phases/http_request_cache_settings/entrypoint" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data '{
    "rules": [{
      "description": "rpgm-web: cache game files",
      "expression": "starts_with(http.request.uri.path, \"/play/\")",
      "action": "set_cache_settings",
      "action_parameters": {
        "cache": true,
        "edge_ttl": { "mode": "bypass_by_default" },
        "browser_ttl": { "mode": "respect_origin" }
      }
    }]
  }'

# Browser Cache TTL: respect existing headers
curl -X PATCH "$API/settings/browser_cache_ttl" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"value":0}'

# Smart Tiered Caching
curl -X PATCH "$API/cache/tiered_cache_smart_topology_enable" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"value":"on"}'
```

Check it: request a JSON file twice and look for `cf-cache-status: HIT`:

```bash
curl -sI https://games.example.com/play/<id>/r1/data/System.json | grep -i cf-cache-status
```

Limits: the free plan caches files up to 512 MB and accepts uploads up to 100 MB. Import larger archives with the CLI on the server.

### What players download

Not the whole game. Like the desktop build, the engine loads each image, sound and map when it first needs it. The browser keeps them in its cache, so the next session starts almost instantly.

- **Haven** (MZ, 437 MB on disk): about **4.4 MB** to reach the title screen (27 MB before compression).
- **Starscribed** (MV, 1.3 GB on disk): about **36 MB**. Most of that is images that one of its plugins preloads on purpose.

After that, each new map, battle or cutscene pulls only its own files. A game can preload more through its plugins, exactly as it would on the desktop.

## Saves

- Stored in the player's browser (IndexedDB), separately for each game, without the 5 MB `localStorage` limit. With cloud saves, stored by the embedding site instead.
- The in-game menu (top-left corner; appears on mouse hover, always visible on phones):
  - **Export saves** downloads a JSON file with every save;
  - **Import saves** restores that JSON, or brings over progress from the **desktop version** of the game.
- If the browser clears site data, local saves are gone. The server asks the browser for persistent storage, but export important progress.

### Continue a desktop playthrough in the browser

Played the downloaded `.exe` version and want to carry on in the browser (or on a phone)? Open the game, then the menu (top-left) → **Import saves…**. The dialog shows where this game keeps its saves on Windows, worked out from the game's own code and plugins. For example, `<game folder>\save` (MZ), `<game folder>\www\save` (MV), or `%LOCALAPPDATA%\<Game>\save` for games that move it. Then do one of these:

- **Choose folder**, and pick that save folder;
- **Choose files**, and select every file in it;
- drag the folder, or a `.zip` of it, onto the game (handy for moving saves to a phone: zip the folder, send it over, import it there).

The whole folder is copied, including `global.rpgsave` / `global.rmmzsave` (without it the save list looks empty) and any extra files plugins keep there. Slots that already exist in the browser are replaced only after a confirmation. The game then reloads with the imported saves. It works the other way round too: **Export saves** produces a file you can import on another device.

## Phones

- Touch controls are built into the engine itself.
- iPhone does not support the Fullscreen API for pages. To play fullscreen, open the game in Safari → Share → **Add to Home Screen**: rpgm-web serves a PWA manifest with landscape orientation.
- Sound starts after the first tap (a browser requirement).

## Security

Only the admin can import games (token-protected API and CLI). The importer still treats every archive as hostile:

- member paths are normalised: no `..`, no absolute paths, no drive letters, including inside nested NW.js and Halva packages;
- symlinks, hard links and device entries are never created;
- unpacking stops at `RPGM_MAX_UNPACKED_GB` / `RPGM_MAX_FILES` (zip, tar and Brotli bombs), and a zip entry that inflates past its declared size is rejected;
- 7z/rar never touch the disk through bsdtar directly: bsdtar re-packs them into a tar stream, and rpgm-web's own extractor applies the same checks;
- imports run one at a time with low CPU priority (ffmpeg, bsdtar), so a big upload does not slow down people who are playing.

### Games run in a sandbox

A game is someone else's JavaScript, so it never runs with your site's origin. That holds on a single domain, with no extra setup:

- `/play/<id>/` is a small host page (ours). It frames the game from `/play/<id>/r<rev>/`.
- Every file under `/play/<id>/r<rev>/` is sent with `Content-Security-Policy: sandbox allow-scripts …` (no `allow-same-origin`), and the frame carries the same `sandbox` attribute. The browser gives the game an **opaque origin**, even when a game file is opened directly or in a popup.
- From there, game code cannot read the library's `localStorage` (the admin token), cookies or IndexedDB. It cannot script the library page in a frame or popup, and it cannot read API responses.
- Saves stay where they were. The host page keeps them in the site's IndexedDB and hands each game only its own, over `postMessage`. Saves made before the sandbox carry over.
- Cloud saves work as before: the host page relays the SDK messages between the game and the embedding site.

The runtime smooths over what the opaque origin changes:
- game files are served with CORS and loaded in CORS mode (WebGL needs it);
- workers, such as MZ's audio decoder, start from a blob;
- `document.cookie` and `sessionStorage` get in-memory stand-ins.

Both test games (MV and MZ) run unchanged in Chrome and Firefox. If a game still misbehaves, `RPGM_GAME_SANDBOX=0` turns the sandbox off for debugging. Do not run like that with games you do not trust.

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
