# Fixed 1080p playback

All new online playback requests use the server's fixed 1080p policy, including old clients, native wrappers and casting. Auto quality, per-device quality choices and previous profile bandwidth limits no longer reduce resolution. Library visibility, age restrictions, PINs and screen-time rules remain enforced.

4K sources are converted to a maximum height of 1080 pixels while preserving aspect ratio. Sources below 1080p retain their original resolution; the policy does not manufacture missing detail. Codec recovery can switch packaging or convert the video, but cannot step down to 720p. Playback reports an error if recovery fails.

New downloads and prepared copies request 1080p. Existing lower-quality offline downloads remain available and must be removed and downloaded again for a new copy. Lower-quality prepared copies cannot replace a higher-quality source for online playback.

Merge and deploy the updated Marquee server/container, then reopen or refresh clients to load the new controls. The server enforces quality even before older clients refresh. No Ghost tablet APK update is required. Existing playback sessions should be stopped and restarted.

Tests cover server routing, direct-play decisions, conversion arguments, prepared-copy selection, casting, downloads, recovery and retained access checks. CI also runs FFmpeg on synthetic 4K and SD frames. Real NAS acceleration, concurrent-device performance and device playback require on-device verification. Fixed resolution can cause buffering on a connection or server that cannot sustain conversion and streaming.
