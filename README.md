# Yarbo Card

A Lovelace custom card for the [YarboHA](https://github.com/YarboInc/YarboHA)
Home Assistant integration. One compact card with status, a live SVG map
(zones, planned path, obstacles, robot position), and in-situ controls.

## Features

### Header + status
- Device name, online badge, battery with charging-aware icon
- **Activity hero** — current state (Mowing, Snowblowing, Patrolling…),
  head-type-aware verb when `auto_plan_status == "Cleaning"`
- **Progress ring** during active runs (coverage % of planned path)
- **Elapsed timer** anchored to the first `Cleaning` transition, with
  idle-debounce so brief glitches don't reset it
- **Pill strip** with head type, speed, fix quality, RTK signal,
  network, rain-sensor reading

### Map (pure SVG, no tiles)
- Work zones, no-go zones (with per-zone disabled visual treatment),
  no-vision zones, geofences, pathways, sidewalks, charging stations —
  all Okabe-Ito color-blind-safe palette
- **Planned path** from undocumented `plan_feedback` topic (discovered
  via capture); rendered as faint gray dashed guide
- **Completed trail** — robot's actual GPS track, solid indigo
- **Transit trail** — dashed amber for Calculating/Heading phases
- **Obstacles** from `cloud_points_feedback` — red dots with halo
- **Robot glyph** with pulsing halo, drop shadow, and heading wedge
- Pinch-zoom, drag-pan, wheel-zoom, follow-robot mode, CSS fullscreen
- Collapsible legend, overflow menu for secondary controls

### Controls
- Context-aware primary button: **Start Plan** / **Pause** / **Resume**,
  sized proportionally to importance
- Secondary icon row: Stop (when running/paused) + Dock
- Plan dropdown + Start-% slider visible only in idle state
- Running/Paused status strip replaces dropdown when plan is active

### No-go zones
- Per-zone toggle (`<ha-switch>`) in a collapsible section
- Disabled zones render dim + dashed on the map
- Toggling routes through the discovered `save_nogozone` MQTT command
- Matches Yarbo app behavior: **blocked while a plan is running**

### Service (for automations)

```yaml
service: yarbo.set_nogozone_enabled
data:
  device_id: <ha_device_id>
  zone_id: 1408
  enabled: false
```

### Intelligent error surfacing
- **Hard errors** (red): offline, `error_code != 0` — keyboard-actionable
- **Soft alerts** (amber): filtered `abnormal_msg` fields that match
  `/error|alert|fault|fail|abnormal/i` AND have non-benign values
- **Impact detection**, **rain threshold** (configurable, app default 500),
  and **camera fault** banners

### Configurable

Visual editor exposes:
- Entity prefix + display name
- Layout toggles (map, advanced, compact)
- Map height, rain threshold
- 11 color overrides (trails, zones, robot, obstacle, background) —
  Okabe-Ito defaults, user can customize

## Installation

### Via HACS (recommended)

(if/when submitted as a custom repository)

### Manual

```bash
npm install
npm run build
# copy dist/yarbo-card.js to /config/www/yarbo-card.js
```

Then in Home Assistant: **Settings → Dashboards → Resources → Add
Resource**:
- URL: `/local/yarbo-card.js`
- Type: JavaScript Module

## Usage

Minimum config:

```yaml
type: custom:yarbo-card
prefix: senor_choppy   # the slug of your device's entities
```

Full config reference:

| Key | Type | Default | Description |
|---|---|---|---|
| `prefix` | string | *inferred* | Entity prefix (e.g. `senor_choppy`) |
| `name` | string | *inferred* | Display name override |
| `show_map` | bool | `true` | Render the SVG map |
| `map_height` | number | `240` | Map height in pixels |
| `show_advanced` | bool | `true` | Show the collapsible advanced section |
| `compact` | bool | `false` | Tighter paddings and gaps |
| `rain_threshold` | number | `500` | Rain-sensor value at/above which to show alert |
| `colors` | object | *(Okabe-Ito)* | Per-element color overrides — see editor |

## Integration patches required

Several features in this card depend on integration-side patches that
are NOT yet upstreamed to [YarboHA](https://github.com/YarboInc/YarboHA).
Captured as PR candidates:

1. **Map data zlib fallback** — the `get_map` response can arrive with
   `data` as a zlib-compressed bytes-as-string. Current integration
   treats it as dict and silently fails. Fix: try zlib-decode before
   raw JSON parse.
2. **Plan-feedback subscription** — the undocumented `plan_feedback`
   topic carries projected path + m² cleaned. Needs a subscriber +
   property exposure.
3. **Cloud-points subscription** — `cloud_points_feedback` carries
   dynamic obstacles (`tmp_barrier_points`). Same pattern.
4. **No-go toggle** — `save_nogozone` MQTT command to flip the `enable`
   bit on a zone. Requires a direct publish (bypassing the SDK's
   control-topics allow-list) because the command isn't listed in the
   device JSON.
5. **Charging precondition relaxation** — `Cannot start plan: device is
   charging` blocks legitimate dock-leave. Robot firmware handles
   undock automatically when a plan is started.
6. **Running-plan attributes on `plan_select`** — `area_ids`,
   `running_area_id`, `actual_clean_area`, `plan_path_geojson`.
7. **Online-sensor extras** — wheel speed, odom confidence, ultrasonic,
   impact, rain, abnormal_msg as entity attributes.
8. **Startup plan_feedback refresh** — ask the robot for current plan
   state on setup so interrupted plans survive HA restart.

## Development

```bash
npm install
npm run watch   # rebuild on file changes
# copy dist/yarbo-card.js to /config/www/ and hard-reload
```

Stack: TypeScript · Lit · Rollup · no runtime deps beyond Lit.

## License

MIT
