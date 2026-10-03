# Updating Marquee on FygoOS

GitHub builds the image. Fygo only downloads it. Your profiles and watch history stay in the config folder you mounted, not in the image.

1. On [github.com/Persian86/marquee](https://github.com/Persian86/marquee), upload the new files onto `main` (Add file → Upload files, or GitHub Desktop: Commit to main → Push origin).
2. Open **Actions**. **Build Marquee for FygoOS** starts by itself. Wait for the green tick. The image is `ghcr.io/persian86/marquee:latest` for both Intel and ARM.
3. On Fygo, open **Docker → Compose**, open the Marquee project, and pull/recreate it so it uses the new image. Do not delete the config folder.

The package must be public once, or Fygo cannot pull it: GitHub profile → **Packages → marquee → Package settings → Change visibility → Public**.
