# Native bridge (app mode)

Homescape can run as the 3D scene layer inside a native shell (for example a
`WKWebView` in an iOS app). In **app mode** the page renders only the canvas, edge
to edge. All chrome (top bar, side panel, summary tiles, room bar, map controls,
build bar, cards) is hidden, and the shell draws native controls instead. The shell
and the page talk over a small, versioned, JSON bridge. Without the flag the page
is unchanged.

Bridge version: **1**.

## Turning it on

- Load the page with `?app=1`, or
- inject `window.webkit.messageHandlers.homescape` (WKWebView script message
  handler named `homescape`) before the page runs.

Safe areas: the canvas fills the viewport. The page applies `env(safe-area-inset-*)`
only for what the shell asks for with `setInsets`; by default it applies none.

No secrets cross the bridge. Tokens and URLs stay in the page.

## Web to native

Every message is `window.webkit.messageHandlers.homescape.postMessage(obj)` with a
plain JSON object `{ type, ... }`. The page coalesces state traffic to at most
about 4 messages per second.

| type | payload | when |
|---|---|---|
| `ready` | `bridge` (number), `app` (string, always `"homescape-web"`), `demo` (bool) | once, after the store is connected, a plan exists and the scene drew its first frames. Not posted while the page needs a login or connect screen (the page then shows its connect dialog full screen) |
| `state` | `seq`, `full: true`, `state` (see Snapshot) | on `requestState`, after `ready`, on home switch |
| `delta` | `seq`, `set` (partial Snapshot, top level keys replaced whole), `items` `{ upsert: Item[], remove: string[] }`, `people` (same shape, optional) | any change, coalesced |
| `select` | `kind` (`item` / `room` / `person`), `id` | the user tapped something in 3D |
| `result` | `cid`, `ok`, `error?` | answer to a dispatch that carried `cid` |
| `searchResults` | `cid`, `results: [{ itemId, name, roomId, domain }]` | answer to `search` |
| `notice` | `level` (`info` / `error`), `text` | toasts the page would have shown (`error` for a failed command, also for an unknown dispatch type) |

`seq` increases by one per `state` or `delta`. A shell that sees a gap calls
`requestState`.

### Snapshot

Notes on how the web side fills it:

- `connection.status`: `demo` (sample source), `live`, `connecting`, `error` (with `message`). `offline` is not produced yet.
- `levels` are sorted by elevation, bottom first, for the active home. `activeLevel` is always a level id (never `null`): the web scene shows one floor at a time.
- `rooms` and `items` cover **every level** of the active home (not only the active one). Street surfaces (road, sidewalk) are not rooms. Only items bound to an entity that currently exists are listed; unbound furniture is not. Two items may share one `entityId` (two blinds on one cover). `roomId` is `""` when an item stands outside every listed room.
- `prefs.innerWalls`: `true` = full height interior walls (the default), `false` = low walls.
- `summary.weather` also carries `label` (the scene's sky name, translated, for example "Clear"). `summary.openings.total` counts doors and windows that have a sensor.
- `favorites` are item ids: the Dashboard's favorite entities, each mapped to the first item bound to it.
- `people` is only filled when the plan maps people to room sensors; `home` is true when the sensor names a room, `roomId` is set when that room is on the active level.

```
connection: { status: "demo" | "connecting" | "live" | "offline" | "error", message?: string }
theme:      { mode: "auto" | "day" | "night", night: boolean }
prefs:      { labels, people, backdrop, innerWalls: boolean, viewMode: "view" | "walk" | "edit" }
homes:      [{ id, name }]
activeHome: string
levels:     [{ id, name }]            // floors of the active home, bottom first
activeLevel:string | null             // null = every floor
focus:      { roomId: string | null } // camera focus, null = whole home
rooms:      [{ id, name, levelId, temp?, humidity?, lightsOn, lightsTotal }]
summary:    { lightsOn, lightsTotal, avgTemp?, tempUnit?, weather?: { state, temp?, unit? },
              openings: { open, total }, running, security?: { state, label? } }
items:      Item[]
favorites:  string[]                  // item ids
people:     [{ id, name, roomId?, confidence?, home: boolean }]   // only when presence is mapped
```

### Item

```
id, roomId, name, kind (icon key), domain, entityId,
state (raw HA state string), on (bool, "main entity is on / open / unlocked / not off or standby"; a paused player is `on`),
unavailable (bool, also true for state `unknown`),
attrs: {
  brightness?   0..100,
  colorTemp?    kelvin,  minColorTemp?, maxColorTemp?,
  hvacMode?, hvacModes?: string[], temp? (current), setpoint?, minTemp?, maxTemp?, step?, tempUnit? (only when HA sends one),
  mediaState?, mediaTitle?, mediaArtist?, volume? 0..1,
  position?     0..100 (cover),
  speed?        0..100 (fan), speedStep?,
  locked?, running? (activity rule is currently true),
  value?, unit?, deviceClass?   // read-only sensors
}
```

## Native to web

`window.homescapeNative` exists once `ready` was posted. Everything goes through one
function, so a shell can call it with a single `evaluateJavaScript`:

```js
window.homescapeNative.dispatch({ type, ...args })
```

| type | args | effect |
|---|---|---|
| `requestState` | | posts a full `state` |
| `focus` | `roomId` or `null` | camera to a room (switches to its floor first, and marks the room selected in 3D), or the whole home |
| `setLevel` | `levelId` | active floor (`null` is ignored) |
| `setHome` | `homeId` | switch home |
| `setViewMode` | `mode`: `view` or `walk` | edit stays web only |
| `callService` | `domain`, `service`, `data`, `cid?` | HA service through the page's existing connection (demo mode simulates). `result` is `ok: false` when the command failed (a `notice` with the reason follows) |
| `toggle` | `itemId`, `cid?` | same as the web quick pill: toggles the item's main entity, or the first extra entity that can be toggled; `ok: false` with an error for an unknown or untoggleable item |
| `setTheme` | `mode`: `auto`, `day`, `night` | |
| `setPref` | `key`: `labels`, `people`, `backdrop`, `innerWalls`; `value` bool | |
| `search` | `query`, `cid` | answers with `searchResults` |
| `highlight` | `itemId` or `null` | marks an item with the 3D selection outline for about 2.5 s (switches to its floor); `null` clears it |
| `setInsets` | `top`, `bottom`, `left`, `right` (CSS px) | camera framing offsets for areas the shell covers; the home is framed and centred in the free area (ignored while `editInWeb` is on) |
| `editInWeb` | `on` bool | `true` turns app mode off so the full web UI shows; `false` turns it back on |

Unknown types are ignored and produce a `notice` with level `error`.

## Taps in 3D

In app mode a tap on an item, room floor or person does not toggle or open any web card. The page posts `select` (`kind`, `id`; a person's `id` is the same key as in `people`), and the item or room is outlined in 3D. A tap on an item in first-person walk mode still toggles it (the walk has its own crosshair controls); its details key posts `select`.
