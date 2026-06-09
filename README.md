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
prefix: my_robot   # the slug of your device's entities
```

Full config reference:

| Key | Type | Default | Description |
|---|---|---|---|
| `prefix` | string | *inferred* | Entity prefix (e.g. `my_robot`) |
| `name` | string | *inferred* | Display name override |
| `show_map` | bool | `true` | Render the SVG map |
| `map_height` | number | `240` | Map height in pixels |
| `show_advanced` | bool | `true` | Show the collapsible advanced section |
| `compact` | bool | `false` | Tighter paddings and gaps |
| `rain_threshold` | number | `500` | Rain-sensor value at/above which to show alert |
| `colors` | object | *(Okabe-Ito)* | Per-element color overrides — see editor |
| `scheduler` | object | *(off)* | Enables the Scheduler section — see below |

## Scheduler

The auto-mowing scheduler lives in the YarboHA integration (Python),
not the card. The card just shows status and exposes Run Now / Skip /
Pause buttons; everything else — schedule definitions, persistence,
the per-minute evaluator, plan-start preflight — runs in the
integration so it works whether the dashboard is open or not.

Requires the
[`scheduler` branch of `jtubb/YarboHA`](https://github.com/jtubb/YarboHA/tree/scheduler).
Until that's merged upstream, the easiest path is to point HACS or
your manual install at the fork.

### What it does

- **Per-plan minimum interval** — "front yard every 3 days, back yard
  every 5". Manual runs from any source (card, Yarbo app, voice) also
  update the cooldown clock — the integration listens to plan-start
  events directly.
- **Weather hold** — skip when a configured `weather.*` entity reports
  rainy / pouring / etc.
- **Quiet hours** — no runs inside a time window (cross-midnight
  aware), optionally combined with a sun-elevation gate ("after
  dark").
- **Battery floor** — skip if battery < N %.
- **Presence hold** — skip if any of a list of person/device_tracker/
  zone entities are `home`.
- **Pre-run notification** — push a notification N minutes before
  starting; press *Skip* during the grace window to cancel.
- **Per-schedule pause** + **global per-device pause** — disable
  individual schedules without deleting them, or halt everything with
  one switch.

### Setup

1. Install the YarboHA integration's `scheduler` branch and restart
   Home Assistant.
2. **Settings → Devices & Services → Yarbo → Configure → "Add a
   schedule"**. Pick a plan, set the interval, configure any optional
   gates. Repeat per plan.
3. In your dashboard's Yarbo card config, enable the section:

   ```yaml
   type: custom:yarbo-card
   prefix: my_yarbo
   scheduler:
     enabled: true
   ```

   Or use the visual editor's "Show scheduler section on the card"
   toggle. The card auto-discovers the integration-provided schedule
   entities — no other config needed.

### Entities exposed (per schedule)

| Entity | Purpose |
|---|---|
| `sensor.<prefix>_schedule_<slug>` | State = current hold reason. Attributes: `next_eligible_at`, `last_run`, `interval_days`, `skip_next`, `schedule_enabled`, plus all the gate values. |
| `button.<prefix>_schedule_<slug>_run_now` | Bypass cooldown and start the plan now. Honors all standard preflight (online, RTK, no plan running). |
| `button.<prefix>_schedule_<slug>_skip_next` | Toggle the per-schedule skip flag. Clears automatically after the next eligible window passes. |
| `switch.<prefix>_schedule_<slug>_enabled` | Per-schedule enable/disable (preserves history). |

Plus per device:

| Entity | Purpose |
|---|---|
| `switch.<prefix>_scheduler_enabled` | Master kill-switch for all schedules on this device. |

### Verification

- Open Developer Tools → States and inspect
  `sensor.<prefix>_schedule_<slug>`. The `state` is the hold reason
  (`eligible`, `cooldown`, `weather`, `sleep`, `battery`, `presence`,
  `paused`, `skipped`, `robot-offline`, `robot-busy`).
- For end-to-end testing, edit a schedule to `interval_days: 0.01`
  (~14 minutes), wait, and watch the integration log
  (`[scheduler] firing '<plan>' on <sn>`).

### Optional: rain → no-go zones

`blueprints/automation/yarbo/yarbo_rain_nogo_manager.yaml` is a small
HA blueprint (a hundred lines, no scheduler state) that enables a set
of no-go zones whenever a rain sensor flips active, and releases them
after a configurable grace period. It's a separate concern from the
scheduler — kept as a blueprint because it needs no persistence and
the standard automation editor handles it cleanly.

To use:

1. Copy `yarbo_rain_nogo_manager.yaml` into
   `<config>/blueprints/automation/yarbo/`.
2. **Settings → Automations → Create Automation → Use Blueprint →
   "Yarbo Rain No-Go Manager"**. Configure your rain sensor, the zone
   IDs to enable, and the grace period.

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
