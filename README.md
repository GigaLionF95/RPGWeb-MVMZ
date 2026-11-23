# rpgm-web

Самохостируемый веб-сервер, который запускает игры на **RPG Maker MV и MZ** в браузере, на компьютере и на телефоне.
Игра выглядит и работает как десктопная версия: те же текстуры, шейдеры и фильтры, Effekseer, звук, видео, плагины и сохранения.

Один процесс Node.js, без npm-зависимостей. Игры на диске не изменяются.

## Как это работает

Игры MV/MZ изначально написаны на HTML5 и упакованы в NW.js (Chromium + Node). rpgm-web убирает обёртку и отдаёт игру как сайт.
Вместе с игрой загружается небольшой рантайм, который подменяет то, чего в браузере нет:

| На десктопе (NW.js) | В rpgm-web |
|---|---|
| `fs`: сохранения в `save/` или `%LOCALAPPDATA%` | виртуальная ФС поверх IndexedDB, отдельная для каждой игры. Пути и логика те же, поэтому плагины, меняющие папку сохранений, работают как на десктопе |
| `require('nw.gui')`, `nw.Window`, `process`, `os`, `path`, `child_process` | совместимые заглушки: полноэкранный режим, открытие ссылок, буфер обмена; «выход из игры» возвращает в библиотеку |
| окно подогнано под размер игры | игра растягивается на окно браузера с сохранением пропорций, как в десктопе |
| MV на телефоне берёт `.m4a` и `.mp4` | при импорте недостающие `.m4a`/`.mp4` создаются через ffmpeg (с тем же шифрованием); в браузере выбирается формат, который он умеет играть |

Импортер понимает:
- обычные папки и архивы (`.zip`, включая zip64; `.tar(.gz)`; `.7z` и `.rar` через bsdtar);
- десктопные сборки MV с `www/`;
- NW.js с `package.nw` или с zip, дописанным в конец `.exe`;
- упаковку **Dragonhouse/Halva** (`GameConfig.sbcf` + `*.halva2`).

## Быстрый старт

### Docker

```bash
docker compose up -d --build
```

Сервер открывается на <http://localhost:8080/>. Токен администратора лежит в `data/config.json`, его можно вывести так:

```bash
docker compose exec rpgm-web node /app/bin/rpgm-web.js token
```

Добавить игру можно через веб-интерфейс («Admin» → вставить токен → «Add game» → перетащить архив) или из консоли:

```bash
mkdir -p imports && cp "~/Downloads/My Game.zip" imports/
docker compose exec rpgm-web node /app/bin/rpgm-web.js import "/imports/My Game.zip"
```

### Без Docker

Нужен Node.js 20+. Для мобильных медиа желательно поставить `ffmpeg`, для 7z/rar — `bsdtar`.

```bash
node bin/rpgm-web.js import "~/Downloads/My Game.zip"
node bin/rpgm-web.js serve --port 8080
```

## CLI

```
rpgm-web serve  [--port 8080] [--host 0.0.0.0] [--data ./data]
rpgm-web import <архив-или-папка> [--id my-game] [--title "Название"] [--transcode auto|off|audio|video]
rpgm-web list
rpgm-web info   <id>
rpgm-web remove <id>
rpgm-web token
```

Повторный `import` с тем же `--id` обновляет игру на месте. Сохранения игроков при этом остаются, а кеш браузеров обновится сам, потому что URL игры привязан к ревизии.

## HTTP API

Изменяющие запросы требуют заголовок `Authorization: Bearer <токен>`.

| Метод | Путь | Что делает |
|---|---|---|
| `GET` | `/api/games` | список игр (скрытые видит только администратор) |
| `POST` | `/api/games?filename=game.zip[&id=…][&title=…]` | тело запроса — архив, ответ `202 {job}` |
| `GET` | `/api/jobs/<job>` | статус импорта: фаза, прогресс, лог |
| `PATCH` | `/api/games/<id>` | `{"title": "…", "hidden": true}` |
| `DELETE` | `/api/games/<id>` | удалить игру |
| `GET` | `/play/<id>/` | играть |

```bash
curl -H "Authorization: Bearer $TOKEN" --data-binary @game.zip \
  "https://games.example.com/api/games?filename=game.zip&id=my-game"
```

## Переменные окружения

| Переменная | По умолчанию | |
|---|---|---|
| `RPGM_DATA` | `./data` | библиотека игр и `config.json` |
| `RPGM_PORT` / `RPGM_HOST` | `8080` / `0.0.0.0` | |
| `RPGM_ADMIN_TOKEN` | генерируется | токен администратора |
| `RPGM_PUBLIC_LIBRARY` | `1` | `0`: список игр виден только с токеном (ссылки `/play/…` при этом работают) |
| `RPGM_MAX_UPLOAD_GB` | `8` | предельный размер загружаемого архива |
| `RPGM_FFMPEG` | `ffmpeg` | путь к ffmpeg |

## systemd

Готовый юнит лежит в [`deploy/rpgm-web.service`](deploy/rpgm-web.service): отдельный пользователь `rpgm`, код в `/opt/rpgm-web/app`, данные в `/opt/rpgm-web/data`, порт `127.0.0.1:34210`.

```bash
useradd --system --home /opt/rpgm-web --shell /usr/sbin/nologin rpgm
mkdir -p /opt/rpgm-web/data && chown rpgm:rpgm /opt/rpgm-web/data
git clone https://github.com/GigaLionF95/RPGWeb-MVMZ /opt/rpgm-web/app
cp /opt/rpgm-web/app/deploy/rpgm-web.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now rpgm-web
```

## За reverse proxy (nginx)

Пример для сайта за Cloudflare: [`deploy/nginx.conf.example`](deploy/nginx.conf.example).

```nginx
server {
    server_name games.example.com;
    client_max_body_size 8g;          # загрузка больших архивов
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_request_buffering off;  # архив сразу пишется на диск сервера
        proxy_read_timeout 1h;
        proxy_set_header Host $host;
    }
}
```

**Cloudflare.** Сервер отдаёт `Cache-Control: no-transform` и помечает все скрипты игры `data-cfasync="false"`, поэтому Rocket Loader и прочие «оптимизации» HTML их не трогают. Если вы отключите эту защиту, игры будут висеть на чёрном экране. Бесплатный тариф пропускает запросы только до 100 МБ, поэтому большие архивы импортируйте через CLI на сервере.

Все ссылки относительные, поэтому сервер может жить и в подпапке (`location /games/ { proxy_pass http://127.0.0.1:8080/; }`).
Ресурсы игр отдаются с `Cache-Control: immutable`, а JS и JSON сжимаются Brotli или gzip.

## Сохранения

- Хранятся в браузере игрока (IndexedDB), отдельно для каждой игры, без лимита в 5 МБ, как у `localStorage`.
- Меню в левом верхнем углу (появляется при наведении мыши, на телефоне видно всегда):
  - **Export saves** — скачать JSON со всеми сейвами;
  - **Import saves** — загрузить этот JSON обратно или **файлы сейвов с десктопа** (`file1.rpgsave`, `global.rpgsave`, `config.rpgsave` или `*.rmmzsave`). Для MV выбирайте вместе с файлами слотов и `global.rpgsave`: по нему игра строит список сохранений.
- Если браузер чистит данные сайта, сейвы пропадут. Сервер запрашивает у браузера постоянное хранилище, но для важных прохождений лучше делать экспорт.

## Телефоны

- Управление касаниями встроено в сам движок.
- iPhone не поддерживает Fullscreen API для страниц. Для полноэкранной игры откройте её в Safari → «Поделиться» → «На экран Домой»: rpgm-web отдаёт манифест PWA с альбомной ориентацией.
- Звук на iOS включается после первого касания: это требование браузера.

## Ограничения

- Пока не поддерживаются игры, упакованные в один `.exe` через **Enigma Virtual Box** (импортер об этом сообщит). Распакуйте такую игру утилитой вроде `evbunpack` и импортируйте получившуюся папку.
- Halva-пакеты с паролем пока не поддерживаются.
- Плагины Steam (greenworks), запуск внешних программ и запись в произвольные места диска в браузере невозможны. Такие вызовы получают заглушки или аккуратную ошибку, но функции, полностью завязанные на Steam, работать не будут.
- MZ, как и на десктопе, ставит игру на паузу, когда у окна нет фокуса.

## Права

rpgm-web — это плеер. Публично размещать можно только игры, на которые у вас есть права, или с разрешения автора. Многие игры с itch.io разрешают распространение только через официальную страницу.

## Разработка

```bash
npm test                         # node --test, синтетические игры-фикстуры
node bin/rpgm-web.js serve       # http://localhost:8080
```

Добавьте `?mute=1` к URL игры, чтобы она запустилась без звука, и `?rpgm-debug`, чтобы видеть лог рантайма в консоли. `?storage=web` включает штатное веб-хранилище движка вместо десктопной эмуляции.
