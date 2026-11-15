# Ghost tablet handoff

Ghost uses the existing authenticated `/ext/v1/assistant` endpoint with `targetClientId`, `targetConnectionId` and `voiceCallId`. `/ext/v1/assistant/capabilities` advertises protocol support. Unknown, disconnected, replaced or unauthorized screen connections fail without choosing a default screen. Title search and playback limits use the target screen's current profile, including when the assistant key belongs to an admin.

The signed-in frontend exposes `window.GhostMarquee` version 1 for an embedded native host. It exposes no credentials. `hold()` pauses current media; `status()` reports readiness and the exact SSE connection. Correlated commands are held in memory with a receipt. The host polls `result(requestId)`, calls `commit(requestId)` while its owning voice request is active, then calls `release()` when the conversation ends. Unconfirmed, cancelled or expired commands never release. `cancel(tokens)` also rejects late SSE deliveries. Receipts and cancellation history are bounded to 64 entries; pending playback expires after two minutes.

Other browsers work as before unless a host explicitly calls hold. Existing named-device assistant calls retain their behavior. Rollout order: Marquee, Ghost Server, tablet APK. Old combinations fail with an update/sign-in message rather than treating an ignored targeting field as success. No new credential endpoint or autoplay permission bypass is added; embedded playback uses the tablet's existing WebView settings.

Run `node --test tests/ghost.test.js` and the syntax checks in the pull-request workflow. Real playback and profile switching must still be checked on the tablet.
