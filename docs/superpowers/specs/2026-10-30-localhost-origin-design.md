# Accept both loopback origins (localhost and 127.0.0.1)

Date: 2026-10-30
Status: approved (user, 2026-10-30)

## 1. Problem
Opening the runtime at `http://localhost:3484` shows a blank page. The HTML loads (200), but every `/assets/*.js|css` request returns 403 "Origin not allowed." Vite emits `<script type="module" crossorigin>`, so the browser sends `Origin: http://localhost:3484`, and the CORS gate (`evaluateCors`, `src/server/middleware.ts:23`) accepts only one origin: `getKanbanRuntimeOrigin()` (`src/core/runtime-endpoint.ts:104`), built from the bound host, default `127.0.0.1` (`src/core/runtime-endpoint.ts:5`).
Reproduced with curl: `Origin: http://localhost:3484` → 403, `Origin: http://127.0.0.1:3484` → 200.

The Host gate already allows both `localhost:<port>` and `127.0.0.1:<port>` in local mode (`getAllowedHostHeaders`, `src/server/middleware.ts:63-83`). The Origin gate is just inconsistent with it.

## 2. Goals
- G1. In local mode (host is loopback, `isKanbanRemoteHost()` false), the Origin gate accepts `<scheme>://localhost:<port>` and `<scheme>://127.0.0.1:<port>`, with `<scheme>` from `isKanbanRuntimeHttps()`. Same for the websocket upgrade gate (`handleSocketUpgrade`).
- G2. Remote mode is unchanged: only the configured runtime origin is accepted.
- G3. The dev-server exception (`localhost:4173` / `127.0.0.1:4173` when `NODE_ENV=development`) is unchanged.

## 3. How (decided)
- Add `getAllowedOrigins(): ReadonlySet<string>` next to `getAllowedHostHeaders()` and mirror its local/remote split. **[assistant's call]** `evaluateCors` takes `allowedOrigins: ReadonlySet<string>` instead of `allowedOrigin: string`; both call sites (`handleHttpRequest`, `handleSocketUpgrade`) pass `getAllowedOrigins()`.
- Security: no new trust. Both names are loopback and already pass the Host gate (DNS-rebinding protection stays on the Host gate). Different port or scheme is still rejected.

## 4. Non-goals
- `[::1]` origin (Host gate does not allow it today either).
- Changing the default bind host or the URL the desktop app opens.

## 5. Verification
- `test/runtime/server/middleware.test.ts`: existing cases updated to the set; new cases: in local mode `http://localhost:<port>` and `http://127.0.0.1:<port>` are allowed for HTTP and websocket upgrade; a different port or scheme is still rejected; in remote mode `localhost` is rejected.
- `npm run typecheck`, `npm run lint`, `npm run test:fast`.
- Manual: rebuild/restart, open `http://localhost:3484` → board renders, no 403 in the network log.
