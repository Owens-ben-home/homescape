# Presence: named people and pets from room sensors

Homescape can draw the people and pets of a home where a room sensor says they are, instead of simulating an anonymous
household. The contract is generic: any Home Assistant sensor that follows it works (the Roomer integration is one).

## The sensor

One sensor per person or pet, named like `sensor.<name>_room`.

| Part | Meaning |
| --- | --- |
| state | A room value such as `office`, `living_room`, `bedroom`, `kitchen`, `bathroom` or `entry`. `away`, `unknown` and `unavailable` mean nobody is in the home. |
| `confidence` | Number from 0 to 1. Below 0.5 the avatar is drawn faded. Missing counts as sure. |
| `indicators` | List of short, human readable reasons, shown in the hover card. |
| `source` | `sensor`, `sticky`, `prior` or `manual_correction`. A `prior` (guess) or `sticky` (held value) is drawn fainter. |
| `room_area_id` | Optional. The Home Assistant area of that room; used to find the plan room when the value is not mapped. |

Homescape reads the attributes defensively: odd or missing values never throw.

## The correction service

Dragging an avatar to another room in the scene calls the optional service `roomer.correct_room` with:

| Field | Meaning |
| --- | --- |
| `entity_id` | The room sensor to correct. |
| `room` | The room value the avatar was dropped on. |
| `confidence` | Optional, 0 to 1. |

The avatar stays at the drop point until the sensor confirms (about 8 seconds), then goes back to where the sensor says. If
the service does not exist, nothing is sent and the avatar returns.

## The plan data: `Layout.presence`

```json
{
  "presence": {
    "people": {
      "a": { "name": "Alex", "roomEntity": "sensor.alex_room", "look": 0 }
    },
    "roomMap": {
      "office": { "room": "Study" },
      "living_room": { "room": "Open room", "area": { "x": 0, "z": 0, "w": 4, "d": 5 } }
    }
  }
}
```

- `people`: at most 4, keyed by a stable id the plan author chooses. `name` is shown in the hover card, `roomEntity` is the
  sensor, `look` (0 to 3) picks the outfit; each person gets a different one. When the plan has named people, the anonymous
  simulation is replaced.
- `roomMap`: where each room value sits in the plan. `room` is a plan room (id, name or slugified name). `area` (plan
  metres) narrows the value to a zone, so one open room can hold several values such as living room and kitchen.
- Without a `roomMap` entry a value resolves to a room whose `areaId` equals the sensor's `room_area_id` or the value, then
  to a room whose name slugifies to the value.
- Pets use no field here: bind the room sensor to the pet item itself (`Item.entityId`).

Edit it in Edit mode, in the presence editor of the plan card (`ui/PresenceEditor.tsx`, shown in Edit mode), or in the plan JSON.
The logic is in `src/model/presence.ts`; `npm run check:presence` tests it.
