# Updating Marquee on your Zima

Your profiles, watch history and settings are safe: they live in `/DATA/AppData/marquee/config`, not inside the app.

## Preferred: let GitHub build it

1. Put the new files in your `marquee` repo, replacing the old ones (GitHub Desktop: copy over, **Commit**, **Push**). Wait for the green tick in **Actions**.
2. On the ZimaOS dashboard, open the Marquee tile's menu (⋯) → **Settings → Save** so it pulls `ghcr.io/<your-github-name>/marquee:latest`.
3. If that ZimaOS version does not fetch the new image, uninstall the tile and import `docker-compose.yml` again. Do not delete `/DATA/AppData/marquee/config`.

## Building on the box

Upload the folder to `/DATA/AppData/marquee/marquee`, then over SSH:

```
cd /DATA/AppData/marquee/marquee
docker build -t marquee:latest .
```

Restart the Marquee app from the dashboard (or `docker restart marquee` if you started it yourself). Do not `docker rm` and `docker run` with a hand-written command — that drops the volume lines in `docker-compose.yml` and can point the app at the wrong folders.

The image is built for both `linux/amd64` and `linux/arm64`. Whisper is compiled without CPU-specific flags so the same image runs on Intel and ARM boxes.
