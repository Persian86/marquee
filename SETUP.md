# Marquee: setup guide for FygoOS

Marquee is your own Plex/Jellyfin-style server. GitHub builds the image. FygoOS downloads it and runs it in Docker. It reads your movies, TV shows, music, photos and home videos (plus podcasts), and streams them to the Marquee Android/TV app, any browser, or a Chromecast.

**Plan for about 20 minutes.** Do the install once from a computer on your home Wi‑Fi.

---

## 1. Organise your media (recommended)

Marquee copes with messy file names, but this layout gives the best matches:

```
Movies/
  The Matrix (1999)/The Matrix (1999).mkv
  Big Buck Bunny (2008).mp4                 ← loose files are fine too
TV Shows/
  Bluey (2018)/Season 1/Bluey - S01E01.mp4
  The Office (US)/Season 2/The.Office.US.S02E03.720p.mkv
Music/
  Artist/Album/01 Song.mp3                  ← tags are read automatically; cover.jpg is used as album art
Photos/
  Beach Day/IMG_20240311_120001.jpg         ← each folder becomes an album, sorted by date taken
Home Videos/
  Zoey's Birthday 2023/VID_20230514_101500.mp4
```
- **Different versions of a film** can sit side by side, e.g. `Blade Runner (1982) {edition-Final Cut}.mkv` and `Blade Runner (1982).mkv`. Marquee asks which one to play.
- **Kodi/Jellyfin `.nfo` files** are read automatically if you have them.

- Put **TV shows in a folder per show**, with `S01E01` (or `1x01`) in each file name.
- Put **subtitles** next to the video with the same name: `The Matrix (1999).en.srt`. Text subtitles built into MKV files are picked up automatically.
- **Optional artwork:** `poster.jpg` or `fanart.jpg` in a movie or show folder overrides the downloaded art.

## 2. Let GitHub build Marquee (no SSH needed)

GitHub builds Marquee on its own computers and keeps it ready for your ZimaOS box to download, the same way App Store apps work. It's free, and it's the same GitHub you already use for FamilyNest.

1. On github.com, click **+ → New repository**. Name it `marquee`, choose **Private**, and click **Create repository**.
2. Unzip `marquee.zip` on your PC. Then put everything that's *inside* the `marquee` folder into the repo:
   - **Easiest: GitHub Desktop.** Choose **File → Clone repository** and pick `marquee`. Copy everything inside the unzipped `marquee` folder into the cloned folder, then **Commit to main → Push origin**.
   - **Or in the browser:** on the new repo's page, click **uploading an existing file**, drag in everything inside the unzipped folder, and click **Commit changes**. Check that `Dockerfile` and the `.github` folder are at the top level of the repo, not inside another `marquee` folder.
3. Open the repo's **Actions** tab. **Build Marquee for ZimaOS** starts by itself; if it doesn't, click it and then **Run workflow**. The first build takes 15–30 minutes, and later builds are quicker. Wait for the green tick ✅.
4. **One-time switch so ZimaOS can download it:**
   1. On GitHub, click your profile picture → **Your profile → Packages → marquee → Package settings**.
   2. At the bottom, click **Change visibility → Public**.

   The code repo stays private. Only the finished app can be downloaded, and it contains no passwords or keys: your settings live on the ZimaOS box.

## 3. Install it on FygoOS

1. Open `docker-compose.yml`. The image is already `ghcr.io/persian86/marquee:latest`. Change the left side of each volume to the real folder in Fygo **Files**. If your volume is not mounted at `/volume1`, use the path Fygo shows.
2. In Fygo, open **Docker → Compose → Add project**. Upload `docker-compose.yml`, or paste it. Create the config and transcode folders first if Fygo does not create them.
3. Start the project. Open `http://<your-fygo-ip>:8420`.

**If the install fails:**
- **"pull access denied" or "not found".** The GitHub package is still private, or the Actions build has no green tick yet.
- **"/dev/dri" error.** Delete the `devices:` block and set `HWACCEL: none`.
- **"port is already allocated".** Change `"8420:8420"` to `"8430:8420"` and use port 8430.

## 4. Updating Marquee later

When there's a new version, put the new files in the repo, replacing the old ones. Wait for the green tick in **Actions**. Then in Fygo, open **Docker → Compose**, pull the Marquee project, and recreate it. Do not delete the config folder.

Your profiles, history and settings are kept: they live in `/DATA/AppData/marquee/config`, not in the app.

*Prefer to build on the box itself?* Upload the folder to `/DATA/AppData/marquee/marquee` with ZimaOS Files. Then over SSH run `cd /DATA/AppData/marquee/marquee && docker build -t marquee:latest .`, and use `image: marquee:latest` in the compose file.

## 5. First-run setup in the app

1. **Create your admin profile** with a PIN.
2. In **Settings → Libraries**, your folders should already be listed and scanning. If one isn't, tap **Add library**, pick what's in it (Movies, TV Shows, Home Videos, Music or Photos), then choose the folder under `/media`.
3. **Posters & info:** get a free key from <https://www.themoviedb.org/settings/api>. Sign up, choose *Create → Developer*, and fill in the short form; "personal media server" is fine for the purpose. Paste the **API Key** into Settings and tap **Save**. Artwork, descriptions and age ratings then fill in over a few minutes.
4. **Family profiles:** tap **Add profile** for each person. For Zoey, turn on **Kids profile** and pick a rating limit (e.g. *Up to PG*). Kids profiles only see titles at or below that rating. To show everything in a library regardless of rating (e.g. a "Kids" folder), edit that library and turn on **Kids safe**. Music, photos and home videos are kids-safe by default.
5. If a title matched the wrong movie, open it, tap **⋯** → **Fix match**.

## 6. Watching away from home (Tailscale)

Tailscale creates a private network between your devices. Nothing is exposed to the internet, and you don't need to change your router.

1. **On ZimaOS:** App Store → search **Tailscale** → Install → open it and **sign in** (a free Google, Microsoft or Apple account works).
2. **On your phone and tablet:** install **Tailscale** from the App Store or Google Play and sign in with the **same account**. Turn it on.
3. Open the Tailscale admin page (<https://login.tailscale.com/admin/machines>) and note your Zima box's name, e.g. `zimaos`. **MagicDNS** is on by default.
4. On your phone, with Tailscale switched on, open:
   ```
   http://zimaos:8420
   ```
   (or the `100.x.x.x` address shown in Tailscale). This works on mobile data, at a friend's place, anywhere.
5. **Make it an app icon:**
   - **iPhone/iPad:** Safari → Share → **Add to Home Screen**
   - **Android:** Chrome → ⋮ → **Add to Home screen**

   Share the Tailscale invite with Hayley so her phone can join too: in the admin page, use **Share** on the machine, or add her as a user.

**Recommended: a proper `https://` address.** Downloads for offline, phone notifications and Chromecast all need it. In the Tailscale admin go to **DNS** and turn on **HTTPS Certificates**. Then over SSH run:
```
docker exec -it $(docker ps -qf name=tailscale) tailscale serve --bg 8420
```
Marquee is now at `https://zimaos.<your-tailnet>.ts.net`. Use that address everywhere (and add *it* to your home screen). Android then installs Marquee as a full app.

## 7. The Android app (phones, tablets, Android TV, Fire TV)

The `marquee-android` folder is an Android Studio project (package `com.adam.marquee`), set up like your other apps. There's one APK for every device.
1. **Build it:** open the folder in Android Studio and choose **Build → Build APK(s)**. Or push it to GitHub and let the included workflow build it (see its README).
2. **Phone/tablet:** install the APK and enter your server address (the `https://…ts.net` one works everywhere).
3. **Fire TV / Android TV:** copy the APK to `/DATA/AppData/marquee/config/marquee.apk` using ZimaOS Files. Then, on the TV, install the **Downloader** app and enter `http://<your-zima-ip>:8420/app.apk`. Marquee appears with the other apps on the TV home screen. The remote's arrows, OK, Back, play/pause and fast-forward all work.

The app adds picture-in-picture, keeps the screen on, plays music in the background, and shows new arrivals as Android notifications. Casting from inside the app isn't possible, so use Chrome for that.

### The iPhone & iPad app

The `marquee-ios` folder is the iOS version. It works like the Android app and adds downloads that keep going in the background and play offline in Apple's player, poster notifications, background music, and AirPlay. You don't need a Mac:
1. **Build it:** push the folder to a private GitHub repo. Then go to **Actions → Build iOS app → Run workflow**, and download **Marquee-ipa** when the run finishes (about 5 minutes).
2. **Install it:** use **Sideloadly** on Windows, signed with your Apple ID. With a free Apple ID you have to re-sign the app every 7 days; a paid developer account lasts a year and lets you share it through TestFlight. The step-by-step guide is in `marquee-ios/README.md`.
3. **First launch:** enter your server address. When iOS asks about **local network** and **notifications**, tap Allow.

Prefer no install at all? In Safari, open your `https://…ts.net` address, then **Share → Add to Home Screen**. That gives you most of the same experience.

## 8. Using it

**Watching**
- **Quality:** **Auto** (the default) tests your connection, picks a quality, drops it if the picture starts buffering, and raises it again when things improve. You can also pick a fixed quality in the player (sliders icon). The badge in the top corner says what's happening: *Direct* (the file plays as-is), *Ready copy* (a pre-converted copy), or *Converting* (the box is converting live).
- **Skip intro:** a **Skip intro** button appears during TV theme songs. Marquee finds them by matching the audio at the start of episodes in the same season. Turn on **Skip intros automatically** in Settings if you never want to see them.
- **Subtitles:** `.srt` files next to the video, subtitles inside MKV files, and picture-style Blu-ray/DVD subtitles (these are drawn onto the video, so the box converts while they're on).
- **Next episode** starts automatically, with an "Up next" card near the end. Double-tap the left or right of the screen to skip 10 seconds.

- **Scrub previews:** drag along the progress bar and little pictures show where you'll land. They're made in the background after each scan.
- **Skip recap & skip credits:** "Previously on…" and end credits are found the same way as intros. A **Skip recap** button appears, and the next episode is offered when the credits start.
- **Versions:** films with more than one copy (4K and 1080p, or Director's Cut and Theatrical) ask which to play.
- **Night mode** (player menu): quietens explosions and lifts voices, for late nights.
- **Subtitles online:** in the player menu, **Find subtitles online…** searches OpenSubtitles, once the admin adds a free key. Each person can also turn on **Get subtitles automatically** in Settings.
- **Play on another device:** send what you're watching to the TV (or anything else running Marquee) from the player menu or a title's **⋯** menu. **More → Remote control** turns your phone into a remote for any screen.

**Your stuff**
- **My List:** tap the bookmark on any movie or show. It appears on your home screen.
- **Collections:** film series (e.g. all the Toy Story films) are grouped automatically once posters & info are on. **Family lists** like "Friday movie night" are made from **⋯ → Add to a family list**.
- **Cast & crew:** tap an actor on a movie page to see everything else of theirs you own.
- **Trailers:** a **Trailer** button appears on movies and shows that have one.
- **Search** covers titles, actors, songs, albums, podcasts and home videos.
- **Home rows** that learn: *Because you watched…*, *Short enough for tonight*, *Unwatched comedies*, *Films from the 90s*, *Your favourites*, and **On this day** photos and videos from past years.
- **Ratings:** tap the stars on any movie or show (half stars too). Ratings improve the suggestions.
- **Trakt & Letterboxd:** link Trakt in Settings and everything you finish (and rate) syncs, or import your Trakt history. **Export** makes a file Letterboxd can import.
- **Your year:** **More → Your year** shows hours watched, top titles, favourite genres, the biggest binge and top artists. The admin can see the whole family's **Family Wrapped**.
- **Requests:** **More → Request a movie or show** searches everything that exists. Grown-ups' requests go straight to Radarr/Sonarr (if you turn that on), and kids' requests wait for you. The person gets a notification when it's ready.

**Music & podcasts**
- **Playlists** (from any song's **⋯**), plus **smart playlists**: *Most played*, *Recently added*, *Forgotten favourites*, *Never played*, and genre mixes.
- **Artist radio / song radio:** your music, mixed by similar genres and what you play most.
- **Lyrics:** tap the player bar, then **Lyrics**. Lyrics come from a `.lrc` file next to the song, from the song file itself, or free from LRCLIB. Synced lyrics follow along.
- Songs flow from one to the next with **no gap**.
- **Podcasts:** **Podcasts → search** to follow a show (or paste any RSS link). New episodes appear every few hours, your place is saved, and there's 0.8–2× speed and a sleep timer.

**Photos**
- **Map:** photos with a location appear on a map. **On this day** shows the same date in earlier years.

**Away from home**
- **Downloads:** **⋯ → Download for offline** on a movie, or the **↓** next to an episode. The box makes a phone-sized copy, then it's saved inside Marquee (with the https address) and plays with no internet. Find them under **More → Downloads**.
- **Watch together:** **⋯ → Start a watch party** (or in the player menu), then share the code. Everyone who joins stays in sync: pause, play and skip happen for all, and there are emoji reactions. Others join from **More → Join a watch party**.

**On the TV**
- **Chromecast:** in Settings → *Notifications & casting*, enter your box's home address, e.g. `http://192.168.1.50:8420`. Then, using Chrome on Android or a computer with the https address, tap the cast icon in the player. It only works at home, because the TV can't reach Tailscale.
- **AirPlay:** on iPhone/iPad, the AirPlay icon appears in the player when an Apple TV is nearby.
- **TV browser:** Marquee works with a TV remote. Use the arrow keys to move, OK to select, and Back to go back.

**Friends & grandparents**
- Make a profile and turn on **Guest**. It's hidden from "Who's watching?". You can choose which libraries it can use, and cap its quality (e.g. 480p for slow connections).
- In that profile, tap **Make an invite link** and send it. It signs their device straight in, and that device can't switch to your family profiles.
- They also need to reach your server. In the Tailscale admin page, use **Share** on your Zima machine and send them the link. They install Tailscale (free) and accept it, and they only see that one machine, nothing else on your network.
- **Any profile** can be limited to certain libraries. For example, Zoey gets *Kids Movies*, *Music* and *Home Videos* only.

**For the kids**
- **Kids profiles** get a simple, big-picture home screen with no search or settings.
- **Screen time:** set daily minutes for school days and weekends. When it's used up, playback stops with a friendly message. Need to make an exception? Tap **+30m** next to their name in Settings.
- **Bedtime:** set a window (e.g. 19:30 to 06:30) when watching is switched off.

**For you (the admin)**
- **More → Activity** shows who's watching what, on which device, and whether it's being converted. You can **Stop** a stream with a message. It also shows how busy the box is, viewing history for each person, and a screen-time chart.
- **Prepared copies:** turn on *Prepare the next episodes automatically* so the next couple of episodes of whatever the family is watching are converted ahead of time. They then start instantly and don't load the box during playback. Anything can also be prepared by hand from **⋯ → Prepare phone-friendly copy**.
- **What's new:** the bell lists new arrivals. Turn on **Notify this device** in Settings for a phone notification (with the https address; iPhone needs Marquee added to the home screen first). For **JARVIS** or Discord/ntfy, paste a webhook URL in Settings. Marquee POSTs JSON like `{"event":"new_media","title":"New on Marquee","body":"2 new episodes of Bluey just arrived","items":[…]}`.
- **Duplicate finder** (Settings) lists films you have more than one copy of. Only the best copy shows in the library.
- **Storage warnings:** you get a notification if a drive is nearly full, and Settings shows how much space is left.
- **Requests setup:** install **Radarr** and **Sonarr** from the ZimaOS App Store and connect them to your download client. Then, in Marquee **Settings → Requests**, paste each address and API key (found in their Settings → General), tap **Save & test**, and pick the folder and quality.
- **OpenSubtitles:** make a free account at opensubtitles.com and create an API key under *API consumers*. Paste it into **Settings → Subtitles**. Adding your username and password raises the daily limit.
- **Trakt:** create an app at trakt.tv/oauth/applications (redirect URI `urn:ietf:wg:oauth:2.0:oob`) and paste its Client ID and Secret into Settings. Each person then links their own account.
- **Edit details & artwork:** on any title, tap **⋯ → Edit details** to change the title, description, rating or edition. **⋯ → Choose poster & background** picks from the alternatives or uploads your own picture. Your changes stick even when info refreshes.
- **Backups:** profiles, PINs, watch history and lists are backed up every night to `/DATA/AppData/marquee/config/backups` (7 kept). **Download backup** and **Restore from file** are in Settings.
- New files are noticed straight away and checked again every 30 minutes. **Settings → Scan now** forces a scan.

### Extras that need a little setup

- **Guest share links** (send one movie to someone outside the family):
  - Share links live on their own port, 8421, which only knows about share links. The rest of Marquee is never exposed.
  - To make links work for people without Tailscale, run this once on the ZimaOS box (in SSH, or the Tailscale app's terminal):
    ```
    tailscale funnel --bg --https=8443 8421
    ```
    This uses port 8443, so your private `https://…ts.net` address for the main app is left alone.
  - Paste the address into **Settings → Share links**. It's your `https://zimaos.<tailnet>.ts.net:8443`.
- **Space saver** (shrinks big old videos overnight):
  - It needs permission to change your files. Remove `:ro` from the media lines you want it to work on, then reinstall.
  - Originals are kept in a hidden `.marquee-originals` folder for a few days, in case you want one back.
- **AI subtitles:** the first time they're used, Marquee downloads the speech model (about 150 MB) to your config folder. Everything after that runs on the box; nothing is uploaded.
- **Face grouping in photos:** runs by itself in the background, pausing while anyone is watching. Name people under **Photos → People**.
- **FamilyNest, JARVIS and widgets:** make a key in **Settings → Connected apps**, and paste it into the other app.

## Troubleshooting

| Problem | Fix |
|---|---|
| App won't start, error mentions `/dev/dri` | Remove the `devices:` lines from the compose file and set `HWACCEL: none`. |
| Settings shows "GPU not working, using CPU" | Set `HWACCEL: none`. Everything still works, but 4K conversion will be slow on small Zima boards. |
| Library shows "Folder missing" | The left side of a media line in the compose file is wrong. Fix it and reinstall or restart the app. |
| Nothing in a kids profile | Titles need posters & info (TMDB key) to get an age rating. Or mark the library **Kids safe**. |
| Can't connect away from home | Make sure Tailscale is **on** on the phone, and use the Tailscale name or `100.x` address, not `192.168.x.x`. |
| Wrong poster | Open the title → ⋯ → Fix match → search and pick the right one. |
| Download, notifications or cast button missing | These need the `https://…ts.net` address from step 6. Plain `http://` addresses can't use them. |
| Chromecast says it can't reach the server | Set the home network address in Settings, and make sure the phone and TV are on the home Wi‑Fi. |
| Skip intro never appears | It needs at least two episodes of the same season, and finds intros a few minutes after a scan. Use **Look again** in Settings. |
| Requests say "Radarr: …" | Check Radarr/Sonarr are running and the folder/quality are chosen in Settings → Requests. |
| Podcast search doesn't work | The box needs internet access to reach Apple's podcast directory. You can also paste a podcast's RSS link directly. |
| The map is blank | The map tiles come from OpenStreetMap, so the device needs internet. |
| New files take a while to appear | Marquee waits about 20 seconds after files stop changing, so half-copied files aren't picked up. |

**Updating Marquee later:** upload the new files over the old folder, run `docker build -t marquee:latest .` again, then restart the Marquee app in the dashboard. Your profiles, watch history and artwork are kept in `/DATA/AppData/marquee/config`.
