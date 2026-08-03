# Notifications module

Piarium notifications are driven by the Pi runtime broker. The web server does not
subscribe to OpenCode session or event endpoints.

## Runtime flow

1. `pi-session-runtime.js` consumes `session.snapshot` and `agent.event` envelopes
   from the in-process Pi runtime broker.
2. `emitter-runtime.js` projects notification payloads to the desktop callback and
   the authenticated UI SSE stream.
3. `routes.js` owns `GET /api/notifications/stream` plus push-registration,
   visibility, session activity, and attention endpoints.
4. `push-runtime.js` handles Web Push; `apns-runtime.js` handles native iOS push.

`createGlobalUiEventBroadcaster()` is deliberately SSE-only. Pi runtime WebSocket
traffic uses `/api/piarium/runtime/ws` and must not be mixed with notification
delivery.

## Files

- `routes.js`: HTTP and SSE route registration.
- `pi-session-runtime.js`: Pi session lifecycle and completion notification logic.
- `emitter-runtime.js`: SSE, desktop callback, and stdout fallback emission.
- `push-runtime.js`: Web Push persistence, VAPID, and visibility state.
- `apns-runtime.js`: APNs token persistence and delivery.
- `message.js`: plain-text normalization and truncation helpers.
- `APNS.md`: APNs-specific operational details.

## Tests

Run the focused notification and SSE tests with:

```sh
bun test packages/web/server/lib/notifications/*.test.js packages/web/server/sse-routes.test.js
```

Before release, also run the full Web tests, typecheck, lint, and production build.
