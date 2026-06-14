import { LitElement, html, css, unsafeCSS, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import type { YarboCardConfig, HomeAssistant, YarboEntities } from "./types";
import { resolveEntities, inferPrefix, deviceName } from "./entities";
import { renderSchedulerSection, SCHEDULER_CSS } from "./scheduler-section";
import "./map-view";
import type { GeoJsonFeatureCollection, TrailPhase, TrailPoint } from "./map-view";
import "./mesh-view";
import type { MeshData, MeshMode, MeshStyle } from "./mesh-view";

const CARD_VERSION = "0.1.0";

// Head type → verb shown while auto_plan_status is "Cleaning".
// Keys match the `HeadMsg.head_type` value_map strings from the Yarbo SDK
// (see yarbo_robot_sdk/devices/yarbo_Y.json). Keys normalized lower-case.
const HEAD_CLEANING_VERB: Record<string, string> = {
  "mower": "Mowing",
  "mower pro": "Mowing",
  "snow blower": "Snowblowing",
  "snowblower": "Snowblowing",
  "blower": "Blowing",
  "smart cover": "Patrolling", // SAM module
  "sam": "Patrolling",
  "plow": "Plowing",
};

function cleaningVerbFor(headType: string | undefined): string {
  if (!headType) return "Cleaning";
  return HEAD_CLEANING_VERB[headType.toLowerCase()] ?? "Cleaning";
}

// Register card in the Lovelace custom card catalog
// so it shows up in the card picker.
const w = window as unknown as {
  customCards?: Array<{ type: string; name: string; description: string; preview?: boolean }>;
};
w.customCards = w.customCards || [];
if (!w.customCards.some((c) => c.type === "yarbo-card")) {
  w.customCards.push({
    type: "yarbo-card",
    name: "Yarbo Card",
    description: "Status and controls for a Yarbo robot",
    preview: true,
  });
}

// eslint-disable-next-line no-console
console.info(
  `%c YARBO-CARD %c v${CARD_VERSION} `,
  "color:white;background:#2a7;font-weight:700;padding:2px 4px;border-radius:3px 0 0 3px",
  "background:#444;color:white;padding:2px 4px;border-radius:0 3px 3px 0",
);

class YarboCard extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @state() private _config?: YarboCardConfig;
  @state() private _prefix?: string;
  private _didInitialRefresh = false;

  // Live-run tracking — the timer anchors on auto_plan_status="Cleaning"
  // (i.e. actively working). Phases like "Calculating Route" or
  // "Heading to Area" don't count toward "Running for ...".
  @state() private _trail: TrailPoint[] = [];
  // Base work-zone map (GeoJSON). Fetched on demand via the yarbo/map_zones
  // WebSocket command rather than read from the map_zones sensor attribute:
  // the integration no longer exposes the full GeoJSON as an attribute (a
  // complex map exceeds HA's 16 KB attribute limit). Refetched whenever the
  // sensor signals the map changed.
  @state() private _mapGeojson?: GeoJsonFeatureCollection;
  private _mapZonesSig?: string;
  private _mapFetchInFlight = false;
  // Live display value for sliders while dragging (entity state only
  // updates when the drag ends). Keyed by entity_id.
  @state() private _liveSlider: Record<string, number> = {};
  @state() private _cleaningStartedAt: number | null = null;
  @state() private _now = Date.now();
  // Timestamp of the most recent idle→(Calculating Route|Heading to Area)
  // transition — where the trail begins. null when no plan is active.
  private _planStartedAt: number | null = null;
  private _lastTrailPoint?: [number, number];
  private _backfillRequested = false;
  // Timestamp (ms) when we first observed auto_plan_status = idle this
  // dip. null when the plan is active. Idle is only committed after
  // IDLE_DEBOUNCE_MS — shorter dips are ignored to preserve the trail
  // through firmware glitches and transient status blips.
  private _idleSince: number | null = null;
  private static readonly IDLE_DEBOUNCE_MS = 30_000;
  private _tickHandle: ReturnType<typeof setInterval> | null = null;

  // Minimum distance between trail points in degrees (≈0.55m at lat 45°).
  // Prevents the trail from ballooning with GPS jitter at standstill.
  private static readonly TRAIL_MIN_STEP = 5e-6;
  // Cap is well above a typical whole-plan point count so the trail
  // effectively covers the entire run. Only long idle-drift or jitter
  // scenarios would ever trim; a 10k-point array is ~400 KB.
  private static readonly TRAIL_MAX_POINTS = 10000;
  // Distance threshold for "covered" — planned point is within this
  // many degrees of lat/lon of any cleaning-phase trail point. 4.5e-6 deg
  // ≈ 0.5 m at any reasonable latitude.
  private static readonly COVERAGE_THRESHOLD_DEG = 4.5e-6;

  // Coverage memo keyed by reference equality of trail + plannedPath.
  private _coverageCache?: {
    trail: TrailPoint[];
    planned: GeoJsonFeatureCollection;
    annotated: GeoJsonFeatureCollection;
    pct: number;
  };

  // Per-device terrain mesh state. _meshData is null until first fetch,
  // {} when fetched but empty for this device.
  @state() private _meshData: MeshData | null = null;
  @state() private _meshMode: MeshMode = "3d";
  @state() private _meshStyle: MeshStyle = "fill";
  @state() private _meshLoading = false;
  @state() private _meshError: string | null = null;
  @state() private _meshExpanded = false;
  // null = show all areas; otherwise the subset to render.
  @state() private _meshAreas: Set<string> | null = null;

  // Waypoint composer state. Each waypoint stored as {lat, lon} so the
  // map renders it without lossy round-trips through CombinedOdom xy;
  // we convert to local meters only when dispatching the service.
  @state() private _waypointMode = false;
  @state() private _waypoints: Array<{lat: number; lon: number}> = [];
  @state() private _waypointType = 0;
  @state() private _waypointBusy = false;
  @state() private _waypointError: string | null = null;

  public connectedCallback(): void {
    super.connectedCallback();
    this._tickHandle = setInterval(() => {
      if (this._cleaningStartedAt !== null) this._now = Date.now();
    }, 1000);
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._tickHandle !== null) {
      clearInterval(this._tickHandle);
      this._tickHandle = null;
    }
  }

  public static getStubConfig(hass: HomeAssistant): YarboCardConfig {
    const prefix = inferPrefix(hass) ?? "my_robot";
    return { type: "custom:yarbo-card", prefix };
  }

  public static async getConfigElement(): Promise<HTMLElement> {
    await import("./yarbo-card-editor");
    return document.createElement("yarbo-card-editor");
  }

  public setConfig(config: YarboCardConfig): void {
    if (!config) throw new Error("Invalid configuration");
    this._config = config;
    this._prefix = config.prefix;
  }

  public getCardSize(): number {
    return this._config?.compact ? 3 : 6;
  }

  protected willUpdate(changed: PropertyValues): void {
    if (!this._prefix && this.hass) {
      this._prefix = inferPrefix(this.hass);
    }
    if (this.hass && this._prefix) {
      this._syncPlanRun();
      this._maybeFetchMapZones();
    }
    super.willUpdate(changed);
  }

  private _syncPlanRun(): void {
    const ents = resolveEntities(this.hass!, this._prefix!);
    const autoStatus = ents.autoPlanStatus
      ? this.hass!.states[ents.autoPlanStatus]?.state
      : undefined;
    let phase = this._phaseFor(autoStatus);
    const isCleaning = autoStatus === "Cleaning";
    // "Recharging" is only meaningful mid-plan. If we're not currently
    // tracking a run, treat it as idle (don't anchor a new "plan" off
    // a docked-charging state). Once a plan is in flight, recharging
    // keeps the trail alive across the auto-recharge cycle.
    if (phase === "recharging" && this._planStartedAt === null) {
      phase = null;
    }
    const isIdle = phase === null;

    if (isIdle) {
      // Debounce idle transitions: only commit the run-end after the
      // status has been idle for IDLE_DEBOUNCE_MS. This keeps the trail
      // and timer alive through brief glitches.
      const now = Date.now();
      if (this._idleSince === null) {
        this._idleSince = now;
        return;
      }
      if (now - this._idleSince < YarboCard.IDLE_DEBOUNCE_MS) {
        return;
      }
      // Idle has been sustained — actually end the run.
      if (this._cleaningStartedAt !== null) this._cleaningStartedAt = null;
      if (this._planStartedAt !== null) {
        this._planStartedAt = null;
        this._backfillRequested = false;
      }
      return;
    }
    // Non-idle observed — cancel any pending idle debounce.
    this._idleSince = null;

    // Non-idle: plan is active in some phase.
    if (this._planStartedAt === null) {
      // First time we've seen this run. Anchor trail at "now" and
      // kick off a backfill to recover any points we missed before
      // the card mounted.
      this._planStartedAt = Date.now();
      this._trail = [];
      this._lastTrailPoint = undefined;
      this._backfillRequested = false;
      void this._backfillTrail(ents);
    }
    if (isCleaning && this._cleaningStartedAt === null) {
      this._cleaningStartedAt = Date.now();
      this._now = this._cleaningStartedAt;
    }

    const pos = this._extractRobotPosition(ents);
    if (pos && phase !== null) {
      this._appendTrailPoint(pos.longitude, pos.latitude, phase);
    }
  }

  private _phaseFor(autoStatus: string | undefined): TrailPhase | null {
    if (!autoStatus) return null;
    if (autoStatus === "Cleaning") return "cleaning";
    if (autoStatus === "Waypoint Navigation") return "cleaning";
    if (autoStatus === "Waypoint Complete") return "cleaning";
    if (autoStatus === "Calculating Route") return "heading";
    if (autoStatus === "Heading to Area") return "heading";
    // Mid-plan recharge cycles: keep the run/trail alive instead of
    // letting the idle debounce reset everything. Caller gates this on
    // an already-active plan (a docked mower at rest also reports
    // these states without a real plan context).
    if (autoStatus === "Charging") return "recharging";
    if (autoStatus === "Returning on Path") return "recharging";
    if (autoStatus === "Returning in Area") return "recharging";
    if (autoStatus === "Repositioning") return "recharging";
    if (autoStatus === "Verifying") return "recharging";
    return null; // Not Started / Completed / Error / Standby / unknown
  }

  private _appendTrailPoint(
    lon: number,
    lat: number,
    phase: TrailPhase,
  ): void {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    const last = this._lastTrailPoint;
    const lastPhase = this._trail.length
      ? this._trail[this._trail.length - 1].phase
      : null;
    if (last && lastPhase === phase) {
      const dx = Math.abs(lon - last[0]);
      const dy = Math.abs(lat - last[1]);
      if (dx < YarboCard.TRAIL_MIN_STEP && dy < YarboCard.TRAIL_MIN_STEP) {
        return;
      }
    }
    this._lastTrailPoint = [lon, lat];
    const trail = this._trail.concat([{ lon, lat, phase }]);
    if (trail.length > YarboCard.TRAIL_MAX_POINTS) {
      trail.splice(0, trail.length - YarboCard.TRAIL_MAX_POINTS);
    }
    this._trail = trail;
  }

  protected render(): TemplateResult | typeof nothing {
    if (!this.hass || !this._config) return nothing;
    const prefix = this._prefix;
    if (!prefix) {
      return this._renderWarning(
        "No prefix configured and no Yarbo device found. Set `prefix:` in the card configuration.",
      );
    }
    const ents = resolveEntities(this.hass, prefix);
    if (!ents.battery && !ents.online && !ents.workingState) {
      return this._renderWarning(
        `No Yarbo entities found for prefix "${prefix}". Check the card configuration.`,
      );
    }
    if (!this._didInitialRefresh) {
      this._didInitialRefresh = true;
      this._initialRefresh(ents);
    }
    const name = this._config.name ?? deviceName(this.hass, ents, "Yarbo");

    const running = this._cleaningStartedAt !== null;
    return html`
      <ha-card class=${running ? "running" : ""}>
        <div class="root ${this._config.compact ? "compact" : ""}">
          ${this._renderHeader(name, ents, running)}
          ${this._renderError(ents)}
          ${this._config.show_map ?? true ? this._renderMap(ents) : nothing}
          ${this._renderPlan(ents)}
          ${this._renderControls(ents)}
          ${this._renderStatus(ents)}
          ${this._renderNogoZones(ents)}
          ${this._renderScheduler(ents, prefix)}
          ${this._renderMeshSection()}
          ${this._config.show_advanced ?? true ? this._renderAdvanced(ents) : nothing}
        </div>
      </ha-card>
    `;
  }

  private _renderMap(ents: YarboEntities): TemplateResult | typeof nothing {
    const geojson = this._mapGeojson;
    const robot = this._extractRobotPosition(ents);
    const planAreaIds = this._extractPlanAreaIds(ents);
    const plannedPath = this._extractPlannedPath(ents);
    const runningAreaIds = this._extractRunningAreaIds(ents);
    const runningAreaId = this._extractRunningAreaId(ents);
    const finishedAreaIds = this._extractFinishedAreaIds(ents);
    if (!geojson && !robot) return nothing;
    // While a plan is running, highlight the running areas instead of
    // whatever's selected in the dropdown (they may differ).
    const highlight = runningAreaIds ?? planAreaIds;
    const obstacles = this._extractObstacles(ents);
    const disabledNogoIds = this._extractDisabledNogoIds(ents);
    return html`
      <yarbo-map
        .geojson=${geojson}
        .robot=${robot}
        .planAreaIds=${highlight}
        .plannedPath=${plannedPath}
        .runningAreaId=${runningAreaId}
        .finishedAreaIds=${finishedAreaIds}
        .trail=${this._trail.length > 1 ? this._trail : undefined}
        .obstacles=${obstacles}
        .disabledNogoIds=${disabledNogoIds}
        .colors=${this._config?.colors}
        .height=${this._config?.map_height ?? 240}
        .waypointMode=${this._waypointMode}
        .waypoints=${this._waypoints}
        .idle=${!this._isMowerBusy(ents)}
        @map-click=${this._onMapClick}
        @waypoint-click=${this._onWaypointMarkerClick}
        @request-waypoint-mode=${this._onWaypointModeRequest}
      ></yarbo-map>
    `;
  }

  private _extractDisabledNogoIds(ents: YarboEntities): Set<string> | undefined {
    if (!ents.mapZones) return undefined;
    const s = this.hass!.states[ents.mapZones];
    const list = s?.attributes?.nogo_zones as
      | Array<{ id: string | number; enable: boolean }>
      | undefined;
    if (!Array.isArray(list)) return undefined;
    const ids = list
      .filter((z) => z && z.enable === false)
      .map((z) => String(z.id));
    return ids.length ? new Set(ids) : undefined;
  }

  private _computeCoverage(planned: GeoJsonFeatureCollection): {
    annotated: GeoJsonFeatureCollection;
    pct: number;
  } {
    const trail = this._trail;
    if (
      this._coverageCache &&
      this._coverageCache.trail === trail &&
      this._coverageCache.planned === planned
    ) {
      return this._coverageCache;
    }

    const threshold = YarboCard.COVERAGE_THRESHOLD_DEG;
    const threshold2 = threshold * threshold;
    const cellSize = threshold * 2;
    // Grid-index cleaning-phase trail points for fast proximity lookup.
    const grid = new Map<string, Array<[number, number]>>();
    for (const p of trail) {
      if (p.phase !== "cleaning") continue;
      const cx = Math.floor(p.lon / cellSize);
      const cy = Math.floor(p.lat / cellSize);
      const key = `${cx},${cy}`;
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
      }
      bucket.push([p.lon, p.lat]);
    }

    let total = 0;
    let covered = 0;
    const annotatedFeatures: typeof planned.features = [];

    for (const f of planned.features) {
      if (f.geometry?.type !== "LineString") {
        annotatedFeatures.push(f);
        continue;
      }
      const coords = f.geometry.coordinates as number[][];
      const coveredFlags: boolean[] = new Array(coords.length);
      for (let i = 0; i < coords.length; i++) {
        total++;
        const [lon, lat] = coords[i];
        const cx = Math.floor(lon / cellSize);
        const cy = Math.floor(lat / cellSize);
        let hit = false;
        outer: for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const bucket = grid.get(`${cx + dx},${cy + dy}`);
            if (!bucket) continue;
            for (let j = 0; j < bucket.length; j++) {
              const dlon = bucket[j][0] - lon;
              const dlat = bucket[j][1] - lat;
              if (dlon * dlon + dlat * dlat < threshold2) {
                hit = true;
                break outer;
              }
            }
          }
        }
        coveredFlags[i] = hit;
        if (hit) covered++;
      }
      annotatedFeatures.push({
        ...f,
        properties: { ...(f.properties ?? {}), _covered: coveredFlags },
      });
    }

    const result = {
      trail,
      planned,
      annotated: {
        type: "FeatureCollection" as const,
        features: annotatedFeatures,
      },
      pct: total > 0 ? (covered / total) * 100 : 0,
    };
    this._coverageCache = result;
    return result;
  }

  private _extractCoveragePct(ents: YarboEntities): number | null {
    // Prefer the firmware-reported cumulative progress (preserved
    // across mid-plan auto-recharges, matches the Yarbo app). Fall
    // back to the local trail-vs-planned-path estimate when the
    // sensor is missing or unavailable.
    if (ents.planProgress) {
      const s = this.hass!.states[ents.planProgress];
      if (s && s.state !== "unknown" && s.state !== "unavailable") {
        const v = Number.parseFloat(s.state);
        if (Number.isFinite(v)) return v;
      }
    }
    const planned = this._extractPlannedPath(ents);
    if (!planned) return null;
    return this._computeCoverage(planned).pct;
  }

  private _extractObstacles(
    ents: YarboEntities,
  ): GeoJsonFeatureCollection | undefined {
    if (!ents.mapZones) return undefined;
    const s = this.hass!.states[ents.mapZones];
    const gj = s?.attributes?.obstacles_geojson as
      | GeoJsonFeatureCollection
      | null
      | undefined;
    if (!gj || !Array.isArray(gj.features) || gj.features.length === 0) {
      return undefined;
    }
    return gj;
  }

  private _extractLiveMetrics(ents: YarboEntities): {
    speedMps: number | null;
    confidence: number | null;
    abnormal: string | null;
    impact: number | null;
    rain: number | null;
    rainTriggered: boolean;
    cameraFault: string | null;
  } {
    const out = {
      speedMps: null as number | null,
      confidence: null as number | null,
      abnormal: null as string | null,
      impact: null as number | null,
      rain: null as number | null,
      rainTriggered: false,
      cameraFault: null as string | null,
    };
    if (!ents.online) return out;
    const s = this.hass!.states[ents.online];
    const a = s?.attributes as Record<string, unknown> | undefined;
    if (!a) return out;
    if (typeof a.speed_mps === "number") out.speedMps = a.speed_mps;
    if (typeof a.odom_confidence === "number") out.confidence = a.odom_confidence;
    if (typeof a.impact_sensor === "number") out.impact = a.impact_sensor;
    if (typeof a.rain_sensor_data === "number") out.rain = a.rain_sensor_data;
    const threshold = this._config?.rain_threshold ?? 500;
    if (out.rain != null && out.rain >= threshold) out.rainTriggered = true;
    out.abnormal = this._extractAbnormalAlerts(a.abnormal_msg);
    // Camera-only flag: scan abnormal_msg dict for *_camera fields with
    // non-zero values (firmware uses 2 = fault by observation).
    const am = a.abnormal_msg;
    if (am && typeof am === "object" && !Array.isArray(am)) {
      const faults: string[] = [];
      for (const [k, v] of Object.entries(am as Record<string, unknown>)) {
        if (!/_camera$/i.test(k)) continue;
        if (v === 0 || v == null) continue;
        faults.push(`${k.replace(/_camera$/i, "")}=${v}`);
      }
      if (faults.length) out.cameraFault = faults.join(", ");
    }
    return out;
  }

  // Only surface genuine alerts. The firmware's `abnormal_msg` is
  // actually a status block — most fields are always-present state codes
  // (battery_community_state, *_status, *_state) where 0/1 is normal.
  // We only flag fields whose name hints at an error AND whose value is
  // a non-zero/non-falsy signal.
  private static readonly _ALERT_NAME_RE =
    /(error|alert|fault|fail|abnormal)/i;
  private _extractAbnormalAlerts(raw: unknown): string | null {
    if (raw == null) return null;
    if (typeof raw === "string") {
      return raw.trim() === "" ? null : raw;
    }
    if (typeof raw !== "object" || Array.isArray(raw)) return null;
    const alerts: string[] = [];
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (
        v === 0 ||
        v === "0" ||
        v === -1 ||
        v === "-1" ||
        v === null ||
        v === false ||
        v === "" ||
        v === "OK" ||
        v === "ok" ||
        v === "normal"
      ) {
        // 0 = no error, -1 = sentinel ("not applicable / uninitialized")
        continue;
      }
      if (!YarboCard._ALERT_NAME_RE.test(k)) continue;
      alerts.push(`${k}=${typeof v === "object" ? JSON.stringify(v) : v}`);
    }
    return alerts.length ? alerts.join(", ") : null;
  }

  private _extractPlannedPath(
    ents: YarboEntities,
  ): GeoJsonFeatureCollection | undefined {
    if (!ents.planSelect) return undefined;
    const s = this.hass!.states[ents.planSelect];
    const gj = s?.attributes?.plan_path_geojson as
      | GeoJsonFeatureCollection
      | null
      | undefined;
    if (!gj || !Array.isArray(gj.features) || gj.features.length === 0) {
      return undefined;
    }
    return gj;
  }

  private _extractRunningAreaIds(ents: YarboEntities): Set<string> | undefined {
    if (!ents.planSelect) return undefined;
    const s = this.hass!.states[ents.planSelect];
    const raw = s?.attributes?.running_area_ids;
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    return new Set(raw.map((v) => String(v)));
  }

  private _extractRunningAreaId(ents: YarboEntities): string | undefined {
    if (!ents.planSelect) return undefined;
    const s = this.hass!.states[ents.planSelect];
    const v = s?.attributes?.running_area_id;
    if (v === undefined || v === null || v === "") return undefined;
    return String(v);
  }

  private _extractFinishedAreaIds(ents: YarboEntities): Set<string> | undefined {
    if (!ents.planSelect) return undefined;
    const s = this.hass!.states[ents.planSelect];
    const raw = s?.attributes?.finished_area_ids;
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    return new Set(raw.map((v) => String(v)));
  }

  private _extractCleanedArea(ents: YarboEntities): number | null {
    if (!ents.planSelect) return null;
    const s = this.hass!.states[ents.planSelect];
    const v = s?.attributes?.actual_clean_area;
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    return v;
  }

  /** Firmware-reported plan progress 0-100, or null if unavailable.
   * When ≥ COMPLETE_PROGRESS_PCT we treat the run as completed
   * regardless of any lingering actualCleanArea > 0 in plan_feedback
   * (which the firmware doesn't reset on completion). */
  private _extractPlanProgressPct(ents: YarboEntities): number | null {
    if (!ents.planProgress) return null;
    const s = this.hass!.states[ents.planProgress];
    if (!s || s.state === "unknown" || s.state === "unavailable") return null;
    const v = Number.parseFloat(s.state);
    return Number.isFinite(v) ? v : null;
  }
  private static readonly COMPLETE_PROGRESS_PCT = 99;

  private _extractPlanAreaIds(ents: YarboEntities): Set<string> | undefined {
    if (!ents.planSelect) return undefined;
    const s = this.hass!.states[ents.planSelect];
    const raw = s?.attributes?.area_ids;
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    return new Set(raw.map((v) => String(v)));
  }

  /** Resolve the device serial (sn) via the entity → device registry. */
  private _resolveSn(ents: YarboEntities): string | undefined {
    const deviceId = this._extractDeviceId(ents);
    if (!deviceId || !this.hass) return undefined;
    const devices = (this.hass as unknown as {
      devices?: Record<string, { identifiers?: Array<[string, string]> }>;
    }).devices;
    const id = devices?.[deviceId]?.identifiers?.find((i) => i[0] === "yarbo");
    return id?.[1];
  }

  /**
   * Refetch the base map over WebSocket when the map_zones sensor signals a
   * change (or on first load). Cheap no-op when nothing changed.
   */
  private _maybeFetchMapZones(): void {
    const ents = resolveEntities(this.hass!, this._prefix!);
    if (!ents.mapZones) return;
    const s = this.hass!.states[ents.mapZones];
    if (!s) return;
    // map_zones writes state only when its summary changes, so last_updated is
    // a reliable "map changed" signal; fall back to feature_count.
    const sig = String(s.last_updated ?? s.attributes?.feature_count ?? "");
    if (sig === this._mapZonesSig) return;
    const sn = this._resolveSn(ents);
    if (!sn) return;
    this._mapZonesSig = sig;
    void this._fetchMapZones(sn);
  }

  private async _fetchMapZones(sn: string): Promise<void> {
    if (!this.hass || this._mapFetchInFlight) return;
    this._mapFetchInFlight = true;
    try {
      const result = await (this.hass as unknown as {
        callWS: (msg: Record<string, unknown>) => Promise<unknown>;
      }).callWS({ type: "yarbo/map_zones", sn });
      const gj = (result as { geojson?: GeoJsonFeatureCollection })?.geojson;
      this._mapGeojson = gj && Array.isArray(gj.features) ? gj : undefined;
    } catch (e) {
      // ERR_NOT_FOUND until the first map refresh; harmless — retried when the
      // sensor's signature next changes (i.e. when map data arrives).
      console.warn("yarbo-card: yarbo/map_zones failed", e);
    } finally {
      this._mapFetchInFlight = false;
    }
  }

  private _extractRobotPosition(
    ents: YarboEntities,
  ): { latitude: number; longitude: number; heading?: number } | undefined {
    if (!ents.deviceTracker) return undefined;
    const s = this.hass!.states[ents.deviceTracker];
    if (!s || s.state === "unavailable") return undefined;
    const attrs = s.attributes ?? {};
    const lat = Number(attrs.latitude);
    const lon = Number(attrs.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
    const heading =
      typeof attrs.heading === "number" ? attrs.heading : undefined;
    return { latitude: lat, longitude: lon, heading };
  }

  private _renderWarning(message: string): TemplateResult {
    return html`<ha-card><div class="warning">${message}</div></ha-card>`;
  }

  private _renderHeader(
    name: string,
    ents: YarboEntities,
    running: boolean,
  ): TemplateResult {
    const online = ents.online && this.hass!.states[ents.online]?.state === "on";
    const battery = ents.battery ? this.hass!.states[ents.battery] : undefined;
    const charging =
      ents.charging && this.hass!.states[ents.charging]?.state === "on";
    const batteryPct = battery ? Number(battery.state) : undefined;
    const batteryIcon = this._batteryIcon(batteryPct, !!charging);

    return html`
      <div class="header">
        <div class="title">
          <ha-icon
            class="robot-icon ${running ? "pulse" : ""}"
            icon="mdi:robot-mower"
          ></ha-icon>
          <div class="name" title=${name}>${name}</div>
        </div>
        <div class="badges">
          <div
            class="badge ${online ? "on" : "off"}"
            title=${online ? "Online" : "Offline"}
          >
            <ha-icon icon=${online ? "mdi:wifi" : "mdi:wifi-off"}></ha-icon>
            <span>${online ? "Online" : "Offline"}</span>
          </div>
          ${batteryPct != null
            ? html`
                <div
                  class="badge battery ${charging ? "charging" : ""}"
                  title=${charging ? "Charging" : "Battery"}
                  @click=${() => ents.battery && this._more(ents.battery)}
                >
                  <ha-icon icon=${batteryIcon}></ha-icon>
                  <span>${Math.round(batteryPct)}%</span>
                </div>
              `
            : nothing}
        </div>
      </div>
    `;
  }

  private _renderStatus(ents: YarboEntities): TemplateResult {
    const activity = this._activityText(ents);
    const recharging =
      ents.rechargingStatus &&
      this.hass!.states[ents.rechargingStatus]?.state &&
      this.hass!.states[ents.rechargingStatus].state !== "Not Started"
        ? this.hass!.states[ents.rechargingStatus].state
        : null;
    const rtk = ents.rtkSignal ? this.hass!.states[ents.rtkSignal]?.state : null;
    const network = ents.network ? this.hass!.states[ents.network]?.state : null;
    const headType = ents.headType
      ? this.hass!.states[ents.headType]?.state
      : null;
    const { speedMps, confidence, rain, rainTriggered } =
      this._extractLiveMetrics(ents);
    const running = this._cleaningStartedAt !== null;
    const elapsed = running
      ? this._formatElapsed(this._now - this._cleaningStartedAt!)
      : null;
    const cleanedArea = this._extractCleanedArea(ents);
    const coveragePct = this._extractCoveragePct(ents);

    return html`
      <div class="status">
        <div class="hero">
          <div class="hero-main">
            <div class="hero-label">Status</div>
            <div class="hero-value">${activity}</div>
            ${elapsed
              ? html`<div class="hero-sub running">
                  <ha-icon icon="mdi:timer-play-outline"></ha-icon>
                  ${elapsed}${cleanedArea != null
                    ? html` · ${cleanedArea.toFixed(1)} m²`
                    : nothing}
                </div>`
              : recharging
                ? html`<div class="hero-sub">${recharging}</div>`
                : nothing}
          </div>
          ${running && coveragePct != null
            ? this._renderProgressRing(coveragePct)
            : nothing}
        </div>
        <div class="pills">
          ${headType
            ? html`<span class="pill" title="Head type">
                <ha-icon icon="mdi:tools"></ha-icon>${headType}
              </span>`
            : nothing}
          ${speedMps != null
            ? html`<span class="pill pill-fixed" title="Wheel speed">
                <ha-icon icon="mdi:speedometer"></ha-icon>${this._formatSpeed(speedMps)}
              </span>`
            : nothing}
          ${confidence != null
            ? html`<span
                class="pill pill-fixed ${confidence < 0.5 ? "pill-warn" : ""}"
                title="Fused odometry confidence"
              >
                <ha-icon
                  icon=${confidence >= 0.8
                    ? "mdi:crosshairs-gps"
                    : confidence >= 0.5
                      ? "mdi:crosshairs"
                      : "mdi:crosshairs-question"}
                ></ha-icon>${Math.round(confidence * 100)}% fix
              </span>`
            : nothing}
          ${rtk
            ? html`<span class="pill" title="RTK signal">
                <ha-icon icon=${this._rtkIcon(rtk)}></ha-icon>RTK ${rtk}
              </span>`
            : nothing}
          ${network
            ? html`<span class="pill" title="Network">
                <ha-icon icon="mdi:access-point-network"></ha-icon>${network}
              </span>`
            : nothing}
          ${rain != null
            ? html`<span
                class="pill ${rainTriggered ? "pill-warn" : ""}"
                title="Rain sensor (threshold ${this._config?.rain_threshold ?? 500})"
              >
                <ha-icon icon=${rainTriggered ? "mdi:weather-pouring" : "mdi:water-percent"}></ha-icon>${rain}
              </span>`
            : nothing}
        </div>
      </div>
    `;
  }

  private _renderProgressRing(pct: number): TemplateResult {
    const clamped = Math.max(0, Math.min(100, pct));
    const radius = 22;
    const c = 2 * Math.PI * radius;
    const offset = c * (1 - clamped / 100);
    return html`
      <div class="progress-ring" title="Plan coverage">
        <svg viewBox="0 0 56 56" aria-hidden="true">
          <circle
            cx="28" cy="28" r=${radius}
            fill="none" stroke="var(--divider-color)" stroke-width="5"
          />
          <circle
            cx="28" cy="28" r=${radius}
            fill="none" stroke="var(--yc-ok)" stroke-width="5"
            stroke-linecap="round"
            stroke-dasharray=${c.toFixed(2)}
            stroke-dashoffset=${offset.toFixed(2)}
            transform="rotate(-90 28 28)"
            style="transition: stroke-dashoffset 0.6s ease;"
          />
        </svg>
        <div class="progress-text">
          <span class="progress-pct">${Math.round(clamped)}%</span>
        </div>
      </div>
    `;
  }

  private _formatSpeed(speedMps: number): string {
    const kmh = speedMps * 3.6;
    return kmh >= 1 ? `${Math.round(kmh)} km/h` : `${kmh.toFixed(1)} km/h`;
  }

  private _renderError(ents: YarboEntities): TemplateResult | typeof nothing {
    const parts: TemplateResult[] = [];
    // Offline is the hardest failure mode — nothing else matters.
    const offline =
      ents.online && this.hass!.states[ents.online]?.state === "off";
    if (offline) {
      parts.push(html`
        <div class="banner banner-error">
          <ha-icon icon="mdi:wifi-off"></ha-icon>
          <span>Device offline</span>
        </div>
      `);
    }
    if (ents.errorCode) {
      const s = this.hass!.states[ents.errorCode]?.state;
      if (s && s !== "0" && s !== "unknown" && s !== "unavailable") {
        parts.push(html`
          <div
            class="banner banner-error"
            role="button"
            tabindex="0"
            @click=${() => this._more(ents.errorCode!)}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                this._more(ents.errorCode!);
              }
            }}
          >
            <ha-icon icon="mdi:alert"></ha-icon>
            <span>Error code: ${s}</span>
          </div>
        `);
      }
    }
    const { abnormal, impact, rainTriggered, rain, cameraFault } =
      this._extractLiveMetrics(ents);
    if (impact != null && impact > 0) {
      parts.push(html`
        <div class="banner banner-warn">
          <ha-icon icon="mdi:car-brake-alert"></ha-icon>
          <span>Impact detected (sensor=${impact})</span>
        </div>
      `);
    }
    if (rainTriggered && rain != null) {
      parts.push(html`
        <div class="banner banner-warn">
          <ha-icon icon="mdi:weather-pouring"></ha-icon>
          <span>Rain detected (${rain})</span>
        </div>
      `);
    }
    if (cameraFault) {
      parts.push(html`
        <div class="banner banner-warn">
          <ha-icon icon="mdi:camera-off-outline"></ha-icon>
          <span>Camera fault: ${cameraFault}</span>
        </div>
      `);
    }
    if (abnormal) {
      parts.push(html`
        <div class="banner banner-warn">
          <ha-icon icon="mdi:alert-circle-outline"></ha-icon>
          <span>${abnormal}</span>
        </div>
      `);
    }
    return parts.length ? html`${parts}` : nothing;
  }

  private _renderPlan(ents: YarboEntities): TemplateResult | typeof nothing {
    if (!ents.planSelect && !ents.planStartPercent) return nothing;
    const plan = ents.planSelect ? this.hass!.states[ents.planSelect] : undefined;
    const pct = ents.planStartPercent
      ? this.hass!.states[ents.planStartPercent]
      : undefined;

    // Only show the plan dropdown + start-% slider when the Start
    // button is the primary action (i.e. truly idle). When running,
    // explicitly paused, or mid-plan interrupted (resumable), replace
    // with a compact status label — start-% is irrelevant in those
    // states since the robot is resuming, not launching fresh.
    const running =
      this._cleaningStartedAt !== null || this._isAnyPhaseActive(ents);
    const pauseStatus = ents.autoPlanPause
      ? this.hass!.states[ents.autoPlanPause]?.state
      : undefined;
    const explicitlyPaused =
      !!pauseStatus &&
      pauseStatus !== "Not Paused" &&
      pauseStatus !== "unknown" &&
      pauseStatus !== "unavailable";
    const cleanedArea = this._extractCleanedArea(ents);
    const progressPct = this._extractPlanProgressPct(ents);
    // A "resumable" plan needs cleanedArea > 0 AND progress < the
    // completion threshold. After a real completion the firmware
    // leaves actualCleanArea > 0 indefinitely; without the progress
    // gate we'd misread that as "interrupted, can resume".
    const interruptedPlan =
      !running &&
      cleanedArea != null && cleanedArea > 0 &&
      (progressPct == null || progressPct < YarboCard.COMPLETE_PROGRESS_PCT);
    const activeOrResumable = running || explicitlyPaused || interruptedPlan;
    if (activeOrResumable) {
      const planName = plan?.state;
      const showName =
        planName &&
        planName !== "unknown" &&
        planName !== "unavailable" &&
        planName !== "";
      const label = running ? "Running" : "Paused";
      return html`
        <div class="plan-running ${running ? "" : "paused"}">
          <ha-icon
            icon=${running
              ? "mdi:clipboard-check-outline"
              : "mdi:clipboard-alert-outline"}
          ></ha-icon>
          <span class="plan-running-label">${label}</span>
          ${showName
            ? html`<span class="plan-running-name">${planName}</span>`
            : nothing}
        </div>
      `;
    }

    return html`
      <div class="plan">
        ${plan
          ? html`
              <label>
                <span>Plan</span>
                <select
                  @change=${(e: Event) => this._selectPlan(ents.planSelect!, e)}
                  .value=${plan.state}
                >
                  ${(plan.attributes?.options as string[] | undefined)?.map(
                    (o) =>
                      html`<option
                        ?selected=${o === plan.state}
                        value=${o}
                      >
                        ${o}
                      </option>`,
                  )}
                </select>
              </label>
            `
          : nothing}
        ${pct
          ? (() => {
              const entityId = ents.planStartPercent!;
              const live = this._liveSlider[entityId];
              const display = Math.round(
                live !== undefined ? live : Number(pct.state),
              );
              return html`
                <label>
                  <span>Start %</span>
                  <div class="slider-row">
                    <input
                      type="range"
                      min=${pct.attributes?.min ?? 0}
                      max=${pct.attributes?.max ?? 99}
                      step="1"
                      .value=${String(display)}
                      @input=${(e: Event) =>
                        this._onSliderInput(entityId, e)}
                      @change=${(e: Event) =>
                        this._onSliderCommit(entityId, e)}
                    />
                    <span class="pct">${display}%</span>
                  </div>
                </label>
              `;
            })()
          : nothing}
      </div>
    `;
  }

  private _renderControls(ents: YarboEntities): TemplateResult {
    // Waypoint composer takes over the control row while active: the
    // pause/resume/dock buttons make no sense before a path is sent, and
    // the user needs a way to commit / wipe / abort placement.
    if (this._waypointMode) return this._renderWaypointControls(ents);

    // Determine the primary action for the current state. Only one
    // action is ever the "right" thing to press at a time — promote it
    // to full width; demote the rest to a compact icon row.
    const running = this._cleaningStartedAt !== null || this._isAnyPhaseActive(ents);
    // Paused-or-resumable signals:
    //  - auto_plan_pause_status non-idle = firmware explicitly reports
    //    a paused run ("Manual Pause", "Low Battery Recharging", "Bumper",
    //    "Stuck", "Error", etc.)
    //  - plan_feedback carried non-zero actualCleanArea AND a phase is
    //    not currently active = a plan was interrupted mid-run (e.g. rain,
    //    robot returned to charge); the app shows Resume for this case too.
    const pauseStatus = ents.autoPlanPause
      ? this.hass!.states[ents.autoPlanPause]?.state
      : undefined;
    const explicitlyPaused =
      !!pauseStatus &&
      pauseStatus !== "Not Paused" &&
      pauseStatus !== "unknown" &&
      pauseStatus !== "unavailable";
    const cleanedArea = this._extractCleanedArea(ents);
    const progressPct = this._extractPlanProgressPct(ents);
    const interruptedPlan =
      !running &&
      cleanedArea != null && cleanedArea > 0 &&
      (progressPct == null || progressPct < YarboCard.COMPLETE_PROGRESS_PCT);
    const canResume = explicitlyPaused || interruptedPlan;

    let primary: {
      icon: string;
      label: string;
      entity?: string;
    };
    if (canResume) {
      primary = {
        icon: "mdi:play-circle",
        label: "Resume",
        entity: ents.resumePlan,
      };
    } else if (running) {
      primary = { icon: "mdi:pause", label: "Pause", entity: ents.pausePlan };
    } else {
      primary = { icon: "mdi:play", label: "Start Plan", entity: ents.startPlan };
    }

    // Secondary actions depend on state too — no point showing Start
    // when running, or Pause/Resume when idle.
    const secondary: Array<{
      icon: string;
      label: string;
      entity?: string;
    }> = [];
    if (running || canResume) {
      secondary.push({ icon: "mdi:stop", label: "Stop", entity: ents.stopPlan });
    }
    secondary.push({
      icon: "mdi:home-lightning-bolt",
      label: "Dock",
      entity: ents.recharge,
    });

    return html`
      <div class="controls">
        <button
          class="primary-ctrl"
          ?disabled=${!primary.entity}
          @click=${() => primary.entity && this._press(primary.entity)}
          aria-label=${primary.label}
        >
          <ha-icon icon=${primary.icon}></ha-icon>
          <span>${primary.label}</span>
        </button>
        <div class="secondary-ctrls">
          ${secondary.map(
            (b) => html`
              <button
                class="icon-ctrl"
                ?disabled=${!b.entity}
                @click=${() => b.entity && this._press(b.entity!)}
                title=${b.label}
                aria-label=${b.label}
              >
                <ha-icon icon=${b.icon}></ha-icon>
                <span class="icon-ctrl-label">${b.label}</span>
              </button>
            `,
          )}
        </div>
      </div>
    `;
  }

  private _renderWaypointControls(ents: YarboEntities): TemplateResult {
    const ref = this._extractGpsRef(ents);
    const count = this._waypoints.length;
    const canStart = !!ref && count > 0 && !this._waypointBusy;
    return html`
      <div class="controls">
        <button
          class="primary-ctrl"
          ?disabled=${!canStart}
          @click=${() => ref && void this._sendWaypoints(ref)}
          aria-label="Start"
        >
          <ha-icon icon="mdi:play"></ha-icon>
          <span>${this._waypointBusy ? "Sending…" : `Start (${count})`}</span>
        </button>
        <div class="secondary-ctrls">
          <button
            class="icon-ctrl"
            ?disabled=${count === 0 || this._waypointBusy}
            @click=${() => { this._waypoints = []; this._waypointError = null; }}
            title="Clear waypoints"
            aria-label="Clear"
          >
            <ha-icon icon="mdi:close-circle-outline"></ha-icon>
            <span class="icon-ctrl-label">Clear</span>
          </button>
          <button
            class="icon-ctrl"
            ?disabled=${this._waypointBusy}
            @click=${() => {
              this._waypointMode = false;
              this._waypoints = [];
              this._waypointError = null;
            }}
            title="Cancel waypoint mode"
            aria-label="Cancel"
          >
            <ha-icon icon="mdi:cancel"></ha-icon>
            <span class="icon-ctrl-label">Cancel</span>
          </button>
        </div>
        ${this._waypointError
          ? html`<div class="wp-error">${this._waypointError}</div>`
          : nothing}
      </div>
    `;
  }

  private _isAnyPhaseActive(ents: YarboEntities): boolean {
    if (!ents.autoPlanStatus) return false;
    const s = this.hass!.states[ents.autoPlanStatus]?.state;
    return (
      !!s &&
      s !== "Not Started" &&
      s !== "Completed" &&
      !s.startsWith("Error") &&
      s !== "unknown"
    );
  }

  private _renderNogoZones(ents: YarboEntities): TemplateResult | typeof nothing {
    if (!ents.mapZones) return nothing;
    const s = this.hass!.states[ents.mapZones];
    const zones = s?.attributes?.nogo_zones as
      | Array<{ id: string | number; name: string; enable: boolean }>
      | undefined;
    if (!zones || zones.length === 0) return nothing;
    const running = this._cleaningStartedAt !== null;
    const deviceId = this._extractDeviceId(ents);
    return html`
      <details class="nogo">
        <summary>
          <span>No-go zones</span>
          <span class="nogo-count">${zones.filter((z) => z.enable).length} / ${zones.length} active</span>
        </summary>
        ${running
          ? html`<div class="nogo-locked">
              <ha-icon icon="mdi:lock"></ha-icon>
              Map changes are blocked while a plan is running.
            </div>`
          : nothing}
        <div class="nogo-list">
          ${zones.map(
            (z) => html`
              <div class="nogo-row">
                <span class="nogo-name">${z.name || `Zone ${z.id}`}</span>
                <ha-switch
                  .checked=${z.enable}
                  ?disabled=${running || !deviceId}
                  @change=${(e: Event) =>
                    this._toggleNogoZone(
                      deviceId,
                      z.id,
                      (e.target as HTMLInputElement).checked,
                    )}
                ></ha-switch>
              </div>
            `,
          )}
        </div>
      </details>
    `;
  }

  private _renderScheduler(
    _ents: YarboEntities,
    prefix: string,
  ): TemplateResult | typeof nothing {
    const sched = this._config?.scheduler;
    if (!sched || !sched.enabled || !this.hass) return nothing;
    // Schedule entities are integration-provided and discovered by
    // entity-id pattern (sensor.<prefix>_schedule_*); the section
    // dispatches button.press / switch.toggle directly. The card
    // doesn't need to inject service-call handlers.
    return renderSchedulerSection({
      hass: this.hass,
      prefix,
      config: sched,
    });
  }

  private _extractDeviceId(ents: YarboEntities): string | undefined {
    // We need the HA device_id (registry uuid) for the service call.
    // Look it up via any of our known entities → entity registry → device_id.
    if (!this.hass) return undefined;
    const anchor = ents.online ?? ents.battery ?? ents.mapZones;
    if (!anchor) return undefined;
    const entries = (this.hass as unknown as {
      entities?: Record<string, { device_id?: string }>;
    }).entities;
    return entries?.[anchor]?.device_id;
  }

  private _renderMeshSection(): TemplateResult | typeof nothing {
    if (!this.hass) return nothing;
    const scoped = this._areaScopedData();
    const areaIds = scoped ? Object.keys(scoped.areas) : [];
    const allSelected =
      this._meshAreas === null || this._meshAreas.size === areaIds.length;
    return html`
      <details
        class="mesh"
        ?open=${this._meshExpanded}
        @toggle=${(e: Event) => {
          this._meshExpanded = (e.target as HTMLDetailsElement).open;
          if (this._meshExpanded && this._meshData === null && !this._meshLoading) {
            void this._fetchMesh();
          }
        }}
      >
        <summary>
          <span>Terrain mesh</span>
          <span class="mesh-meta">
            ${this._meshLoading
              ? "loading…"
              : scoped
                ? `${areaIds.length} area(s)`
                : "tap to load"}
          </span>
        </summary>
        <div class="mesh-controls">
          <button
            class=${this._meshMode === "2d" ? "active" : ""}
            @click=${() => (this._meshMode = "2d")}
          >2D</button>
          <button
            class=${this._meshMode === "3d" ? "active" : ""}
            @click=${() => (this._meshMode = "3d")}
          >3D</button>
          <span class="mesh-sep"></span>
          <button
            class=${this._meshStyle === "fill" ? "active" : ""}
            @click=${() => (this._meshStyle = "fill")}
            title="Solid (hypsometric tint)"
          >Fill</button>
          <button
            class=${this._meshStyle === "wire" ? "active" : ""}
            @click=${() => (this._meshStyle = "wire")}
            title="Wireframe (triangle edges only)"
          >Wire</button>
          <button @click=${() => void this._fetchMesh()} title="Refresh from integration">
            ↻
          </button>
        </div>
        ${areaIds.length > 1
          ? html`
              <div class="mesh-areas">
                <span class="mesh-areas-label">Areas:</span>
                <label class="mesh-area-pill">
                  <input
                    type="checkbox"
                    .checked=${allSelected}
                    @change=${(e: Event) => this._toggleAllAreas(
                      (e.target as HTMLInputElement).checked, areaIds,
                    )}
                  />
                  <span>All</span>
                </label>
                ${areaIds.map((id) => {
                  const on = this._meshAreas === null || this._meshAreas.has(id);
                  return html`
                    <label class="mesh-area-pill ${on ? "on" : ""}">
                      <input
                        type="checkbox"
                        .checked=${on}
                        @change=${(e: Event) => this._toggleArea(
                          id, (e.target as HTMLInputElement).checked, areaIds,
                        )}
                      />
                      <span>${id}</span>
                    </label>
                  `;
                })}
              </div>
            `
          : nothing}
        ${this._meshError
          ? html`<div class="mesh-error">${this._meshError}</div>`
          : nothing}
        ${scoped
          ? html`<yarbo-mesh-view
              .data=${scoped}
              .mode=${this._meshMode}
              .renderStyle=${this._meshStyle}
              .selectedAreas=${this._meshAreas}
            ></yarbo-mesh-view>`
          : html`<div class="mesh-empty">
              ${this._meshLoading ? "Loading mesh…" : "Tap refresh to load."}
            </div>`}
      </details>
    `;
  }

  // ---- Waypoint composer ----

  /** True when the mower is actively running a plan (or has one paused),
   * which gates entry into waypoint mode. */
  private _isMowerBusy(ents: YarboEntities): boolean {
    if (this._cleaningStartedAt !== null) return true;
    if (this._isAnyPhaseActive(ents)) return true;
    const pauseStatus = ents.autoPlanPause
      ? this.hass?.states[ents.autoPlanPause]?.state
      : undefined;
    if (pauseStatus &&
        pauseStatus !== "Not Paused" &&
        pauseStatus !== "unknown" &&
        pauseStatus !== "unavailable") return true;
    return false;
  }

  private _onMapClick = (e: CustomEvent): void => {
    if (!this._waypointMode) return;
    const { lat, lon, inArea, inNogo } = e.detail as {
      lat: number; lon: number; inArea?: boolean; inNogo?: boolean;
    };
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (inNogo === true) {
      this._waypointError = "Can't drop a waypoint inside a no-go zone.";
      return;
    }
    if (inArea === false) {
      this._waypointError = "Tap inside a mowable area.";
      return;
    }
    this._waypoints = [...this._waypoints, { lat, lon }];
    this._waypointError = null;
  };

  private _onWaypointMarkerClick = (e: CustomEvent): void => {
    const { index } = e.detail as { index: number };
    if (!Number.isInteger(index) || index < 0) return;
    this._waypoints = this._waypoints.filter((_, j) => j !== index);
    this._waypointError = null;
  };

  private _onWaypointModeRequest = (e: CustomEvent): void => {
    const { active } = e.detail as { active: boolean };
    this._waypointMode = !!active;
    if (!active) {
      this._waypoints = [];
      this._waypointError = null;
    }
  };

  /** Pull GPS reference lat/lon from the device_tracker's attributes. */
  private _extractGpsRef(ents: YarboEntities): { lat: number; lon: number } | null {
    if (!ents.deviceTracker || !this.hass) return null;
    const s = this.hass.states[ents.deviceTracker];
    const a = s?.attributes as Record<string, unknown> | undefined;
    if (!a) return null;
    const lat = a.gps_ref_latitude;
    const lon = a.gps_ref_longitude;
    if (typeof lat !== "number" || typeof lon !== "number") return null;
    return { lat, lon };
  }

  /** lat/lon → CombinedOdom local meters (origin = gps_ref).
   *
   * Yarbo's local frame is +X = WEST, +Y = NORTH (per SDK
   * convert_local_to_gps). Lon decreases as we go west, so the x sign
   * is inverted relative to a naïve (lon - ref) projection. The SDK
   * forward function is `lon = ref_lon - x / m_per_deg_lon`; this is
   * the inverse.
   */
  private _latLonToLocal(
    lat: number, lon: number, ref: { lat: number; lon: number },
  ): { x: number; y: number } {
    const M_PER_DEG_LAT = 111_320;
    const x = (ref.lon - lon) * M_PER_DEG_LAT * Math.cos((ref.lat * Math.PI) / 180);
    const y = (lat - ref.lat) * M_PER_DEG_LAT;
    return { x, y };
  }

  private async _sendWaypoints(ref: { lat: number; lon: number }): Promise<void> {
    if (!this.hass || this._waypoints.length === 0) return;
    const ents = resolveEntities(this.hass, this._prefix!);
    const deviceId = this._extractDeviceId(ents);
    if (!deviceId) {
      this._waypointError = "Could not resolve device_id";
      return;
    }
    const points = this._waypoints.map((w) => {
      const { x, y } = this._latLonToLocal(w.lat, w.lon, ref);
      return { x: Number(x.toFixed(3)), y: Number(y.toFixed(3)), phi: 0 };
    });
    this._waypointBusy = true;
    this._waypointError = null;
    try {
      await this.hass.callService("yarbo", "goto_waypoints", {
        device_id: deviceId,
        points,
        type: this._waypointType,
      });
      // Success — drop out of waypoint mode so the normal pause/dock
      // controls return for the in-progress run.
      this._waypoints = [];
      this._waypointMode = false;
    } catch (err) {
      console.warn("yarbo-card: goto_waypoints failed", err);
      this._waypointError = (err as Error)?.message ?? "goto_waypoints failed";
    } finally {
      this._waypointBusy = false;
    }
  }

  private _toggleAllAreas(on: boolean, ids: string[]): void {
    this._meshAreas = on ? null : new Set();
  }

  private _toggleArea(id: string, on: boolean, all: string[]): void {
    const cur = this._meshAreas
      ? new Set(this._meshAreas)
      : new Set(all);
    if (on) cur.add(id); else cur.delete(id);
    // Collapse to null if everything is checked again.
    this._meshAreas = cur.size === all.length ? null : cur;
  }

  /** Return MeshData scoped to the device this card is showing. */
  private _areaScopedData(): MeshData | undefined {
    if (!this._meshData || !this._prefix) return undefined;
    // Service returns {devices: {sn: {gps_ref, areas}}} — pick our SN.
    // _prefix is the slugified device name, sn is the serial. Look it
    // up via the online sensor's device entry.
    const ents = resolveEntities(this.hass!, this._prefix);
    const anchor = ents.online ?? ents.battery;
    if (!anchor || !this.hass) return undefined;
    const entityEntry = (this.hass as unknown as {
      entities?: Record<string, { device_id?: string }>;
    }).entities?.[anchor];
    const devices = (this.hass as unknown as {
      devices?: Record<string, { identifiers?: Array<[string, string]> }>;
    }).devices;
    if (!entityEntry?.device_id || !devices) return undefined;
    const dev = devices[entityEntry.device_id];
    const id = dev?.identifiers?.find((i) => i[0] === "yarbo");
    const sn = id?.[1];
    if (!sn) return undefined;
    const root = this._meshData as unknown as {
      devices: Record<string, MeshData>;
    };
    return root.devices?.[sn];
  }

  private async _fetchMesh(): Promise<void> {
    if (!this.hass) return;
    this._meshLoading = true;
    this._meshError = null;
    try {
      const result = await (this.hass as unknown as {
        callWS: (msg: Record<string, unknown>) => Promise<unknown>;
      }).callWS({
        type: "call_service",
        domain: "yarbo",
        service: "get_altitude_mesh",
        return_response: true,
      });
      const response = (result as { response?: unknown })?.response;
      // The shape is {devices: {sn: {gps_ref, areas}}}; cache as-is.
      this._meshData = (response as MeshData) ?? null;
    } catch (e) {
      console.warn("yarbo-card: get_altitude_mesh failed", e);
      this._meshError = "Failed to load mesh.";
    } finally {
      this._meshLoading = false;
    }
  }

  private async _toggleNogoZone(
    deviceId: string | undefined,
    zoneId: string | number,
    enabled: boolean,
  ): Promise<void> {
    if (!deviceId || !this.hass) return;
    try {
      await this.hass.callService("yarbo", "set_nogozone_enabled", {
        device_id: deviceId,
        zone_id: zoneId,
        enabled,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("yarbo-card: nogozone toggle failed", e);
    }
  }

  private _renderAdvanced(ents: YarboEntities): TemplateResult {
    const vol = ents.volume ? this.hass!.states[ents.volume] : undefined;
    const sound = ents.soundSwitch
      ? this.hass!.states[ents.soundSwitch]
      : undefined;
    const headlight = ents.headlightSwitch
      ? this.hass!.states[ents.headlightSwitch]
      : undefined;

    return html`
      <details class="advanced">
        <summary>Advanced</summary>
        <div class="adv-grid">
          ${sound
            ? html`
                <div class="adv-row">
                  <span>Sound</span>
                  <ha-switch
                    .checked=${sound.state === "on"}
                    @change=${(e: Event) =>
                      this._toggleSwitch(
                        ents.soundSwitch!,
                        (e.target as HTMLInputElement).checked,
                      )}
                  ></ha-switch>
                </div>
              `
            : nothing}
          ${headlight
            ? html`
                <div class="adv-row">
                  <span>Headlight</span>
                  <ha-switch
                    .checked=${headlight.state === "on"}
                    @change=${(e: Event) =>
                      this._toggleSwitch(
                        ents.headlightSwitch!,
                        (e.target as HTMLInputElement).checked,
                      )}
                  ></ha-switch>
                </div>
              `
            : nothing}
          ${vol
            ? (() => {
                const entityId = ents.volume!;
                const live = this._liveSlider[entityId];
                const display = Math.round(
                  live !== undefined ? live : Number(vol.state),
                );
                return html`
                  <div class="adv-row">
                    <span>Volume</span>
                    <div class="slider-row">
                      <input
                        type="range"
                        min=${vol.attributes?.min ?? 0}
                        max=${vol.attributes?.max ?? 100}
                        step="1"
                        .value=${String(display)}
                        @input=${(e: Event) =>
                          this._onSliderInput(entityId, e)}
                        @change=${(e: Event) =>
                          this._onSliderCommit(entityId, e)}
                      />
                      <span class="pct">${display}%</span>
                    </div>
                  </div>
                `;
              })()
            : nothing}
        </div>
        <div class="refresh-row">
          ${this._miniBtn("mdi:refresh", "Device", ents.refreshDevice)}
          ${this._miniBtn("mdi:map-marker-radius", "Map", ents.refreshMap)}
          ${this._miniBtn("mdi:crosshairs-gps", "GPS", ents.refreshGps)}
          ${this._miniBtn("mdi:playlist-check", "Plans", ents.refreshPlans)}
        </div>
      </details>
    `;
  }

  // ----- helpers -----

  private _btn(o: {
    icon: string;
    label: string;
    entity?: string;
    accent?: boolean;
  }): TemplateResult {
    const disabled = !o.entity;
    return html`
      <button
        class="ctrl ${o.accent ? "accent" : ""}"
        ?disabled=${disabled}
        @click=${() => o.entity && this._press(o.entity)}
        title=${o.label}
      >
        <ha-icon icon=${o.icon}></ha-icon>
        <span>${o.label}</span>
      </button>
    `;
  }

  private _miniBtn(
    icon: string,
    label: string,
    entity?: string,
  ): TemplateResult | typeof nothing {
    if (!entity) return nothing;
    return html`
      <button
        class="mini"
        @click=${() => this._press(entity)}
        title=${`Refresh ${label}`}
      >
        <ha-icon icon=${icon}></ha-icon>
        <span>${label}</span>
      </button>
    `;
  }

  private _activityText(ents: YarboEntities): string {
    // Prefer richer statuses first
    const planning = ents.autoPlanStatus
      ? this.hass!.states[ents.autoPlanStatus]?.state
      : undefined;
    if (planning && planning !== "Not Started" && planning !== "unknown") {
      if (planning === "Cleaning") {
        const headType = ents.headType
          ? this.hass!.states[ents.headType]?.state
          : undefined;
        return cleaningVerbFor(headType);
      }
      return planning;
    }
    const recharging = ents.rechargingStatus
      ? this.hass!.states[ents.rechargingStatus]?.state
      : undefined;
    if (
      recharging &&
      recharging !== "Not Started" &&
      recharging !== "unknown"
    ) {
      return recharging;
    }
    // Sitting on the dock: rechargingStatus reflects the dock-approach
    // state machine ("Returning on Path" → "Charging" → "Not Started"
    // once settled), so once docked it returns to Not Started even
    // though contactor power is still flowing. Fall back to the
    // persistent charging binary sensor for the steady-state case.
    if (
      ents.charging &&
      this.hass!.states[ents.charging]?.state === "on"
    ) {
      return "Charging";
    }
    const working = ents.workingState
      ? this.hass!.states[ents.workingState]?.state
      : undefined;
    if (working && working !== "unknown") return working;
    return "Idle";
  }

  private async _backfillTrail(ents: YarboEntities): Promise<void> {
    if (this._backfillRequested) return;
    if (!this.hass || !ents.autoPlanStatus || !ents.deviceTracker) return;
    // Look back up to 6 hours for a plan's entry transition.
    const end = new Date();
    const start = new Date(end.getTime() - 6 * 3600 * 1000);
    type HistRow = { s: string; lu: number; a?: Record<string, unknown> };
    type HistResp = Record<string, HistRow[]>;
    let history: HistResp;
    try {
      history = await this.hass.callWS<HistResp>({
        type: "history/history_during_period",
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        entity_ids: [ents.autoPlanStatus, ents.deviceTracker],
        minimal_response: false,
        no_attributes: false,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("yarbo-card: trail backfill history query failed", e);
      return;
    }
    const statusRows = history[ents.autoPlanStatus] ?? [];
    const trackerRows = history[ents.deviceTracker] ?? [];
    if (statusRows.length === 0) return;

    // Guard against the recorder race: if the latest recorded status is
    // idle but the live state is non-idle, the recorder hasn't flushed
    // the current plan's transition yet. Using history here would
    // latch onto a PREVIOUS plan's run. Bail and retry on the next
    // hass update until history catches up.
    const lastRow = statusRows[statusRows.length - 1];
    const lastRowPhase = this._phaseFor(lastRow.s);
    if (lastRowPhase === null) {
      // _backfillRequested stays false; next willUpdate will retry.
      return;
    }
    // Now we trust history. Mark as in-flight so we don't re-query.
    this._backfillRequested = true;

    // Walk BACKWARD from the latest row to find the boundary of the
    // current continuous non-idle run: the most recent idle-or-gap that
    // ends just before a non-idle row.
    let planStartTs: number | null = null;
    for (let i = statusRows.length - 1; i >= 0; i--) {
      const curPhase = this._phaseFor(statusRows[i].s);
      if (curPhase === null) {
        // Boundary found. The NEXT row (i+1) is the first non-idle of
        // the current run.
        if (i + 1 < statusRows.length) {
          planStartTs = statusRows[i + 1].lu * 1000;
        }
        break;
      }
    }
    // If every row in the window is non-idle, the run started before
    // the query window. Anchor at the oldest row we have.
    if (planStartTs === null) {
      planStartTs = statusRows[0].lu * 1000;
    }

    // Build the phase timeline over [planStartTs, now]. Every status
    // row in this span should be non-idle because we identified a
    // continuous run. If any idle slips in, we bail on the timeline
    // early to avoid tagging subsequent points with a stale phase.
    const phaseTimeline: Array<{ ts: number; phase: TrailPhase }> = [];
    for (const r of statusRows) {
      const ts = r.lu * 1000;
      if (ts < planStartTs) continue;
      const ph = this._phaseFor(r.s);
      if (ph === null) break;
      const prev = phaseTimeline[phaseTimeline.length - 1];
      if (!prev || prev.phase !== ph) phaseTimeline.push({ ts, phase: ph });
    }
    if (phaseTimeline.length === 0) return;

    // Walk tracker history from planStartTs forward and tag each point.
    const resolvePhase = (ts: number): TrailPhase => {
      // Linear scan is fine — at most ~dozens of entries.
      let ph: TrailPhase = phaseTimeline[0].phase;
      for (const e of phaseTimeline) {
        if (ts >= e.ts) ph = e.phase;
        else break;
      }
      return ph;
    };

    const rebuilt: TrailPoint[] = [];
    let lastLon: number | null = null;
    let lastLat: number | null = null;
    let lastPhase: TrailPhase | null = null;
    for (const r of trackerRows) {
      const ts = r.lu * 1000;
      if (ts < planStartTs) continue;
      const a = r.a ?? {};
      const lon = Number((a as { longitude?: unknown }).longitude);
      const lat = Number((a as { latitude?: unknown }).latitude);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const ph = resolvePhase(ts);
      if (
        lastLon !== null &&
        lastLat !== null &&
        lastPhase === ph &&
        Math.abs(lon - lastLon) < YarboCard.TRAIL_MIN_STEP &&
        Math.abs(lat - lastLat) < YarboCard.TRAIL_MIN_STEP
      ) {
        continue;
      }
      rebuilt.push({ lon, lat, phase: ph });
      lastLon = lon;
      lastLat = lat;
      lastPhase = ph;
    }

    if (rebuilt.length === 0) return;

    // If the live-tracked trail already has points appended since mount,
    // splice the backfill in front of them (de-duping at the seam).
    const seamLast = rebuilt[rebuilt.length - 1];
    const existing = this._trail.filter(
      (p) =>
        !(
          Math.abs(p.lon - seamLast.lon) < YarboCard.TRAIL_MIN_STEP &&
          Math.abs(p.lat - seamLast.lat) < YarboCard.TRAIL_MIN_STEP
        ),
    );
    const combined = rebuilt.concat(existing);
    if (combined.length > YarboCard.TRAIL_MAX_POINTS) {
      combined.splice(0, combined.length - YarboCard.TRAIL_MAX_POINTS);
    }
    this._trail = combined;
    this._planStartedAt = planStartTs;
    this._lastTrailPoint = [seamLast.lon, seamLast.lat];

    // If Cleaning started before the card mounted, recover that anchor.
    // Prefer the historical timestamp over the live "Date.now()" estimate
    // set by _syncPlanRun — history is the ground truth.
    const cleaningEntry = phaseTimeline.find((e) => e.phase === "cleaning");
    if (cleaningEntry) {
      if (
        this._cleaningStartedAt === null ||
        cleaningEntry.ts < this._cleaningStartedAt
      ) {
        this._cleaningStartedAt = cleaningEntry.ts;
        this._now = Date.now();
      }
    }
  }

  private _formatElapsed(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return "0s";
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  private _batteryIcon(pct: number | undefined, charging: boolean): string {
    if (pct == null || Number.isNaN(pct)) return "mdi:battery-unknown";
    const bucket = Math.min(10, Math.max(0, Math.floor(pct / 10))) * 10;
    if (charging) {
      if (bucket === 0) return "mdi:battery-charging-outline";
      if (bucket === 100) return "mdi:battery-charging";
      return `mdi:battery-charging-${bucket}`;
    }
    if (bucket === 100) return "mdi:battery";
    if (bucket === 0) return "mdi:battery-outline";
    return `mdi:battery-${bucket}`;
  }

  private _rtkIcon(state: string): string {
    switch (state) {
      case "Strong":
        return "mdi:signal-cellular-3";
      case "Medium":
        return "mdi:signal-cellular-2";
      default:
        return "mdi:signal-cellular-1";
    }
  }

  private async _press(entityId: string): Promise<void> {
    await this.hass!.callService("button", "press", { entity_id: entityId });
  }

  private async _initialRefresh(ents: YarboEntities): Promise<void> {
    // Fire the four refresh buttons staggered so we don't hammer the
    // coordinator all at once. Swallow errors — if a button is missing
    // or the device is offline, the user will see stale data rather
    // than a broken card.
    const targets = [
      ents.refreshDevice,
      ents.refreshMap,
      ents.refreshGps,
      ents.refreshPlans,
    ].filter((id): id is string => !!id);
    for (let i = 0; i < targets.length; i++) {
      const id = targets[i];
      try {
        await this._press(id);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`yarbo-card: refresh ${id} failed`, e);
      }
      if (i < targets.length - 1) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }

  private async _selectPlan(entityId: string, e: Event): Promise<void> {
    const target = e.target as HTMLSelectElement;
    await this.hass!.callService("select", "select_option", {
      entity_id: entityId,
      option: target.value,
    });
  }

  private _onSliderInput(entityId: string, e: Event): void {
    const target = e.target as HTMLInputElement;
    const n = Math.round(Number(target.value));
    if (!Number.isFinite(n)) return;
    this._liveSlider = { ...this._liveSlider, [entityId]: n };
  }

  private async _onSliderCommit(entityId: string, e: Event): Promise<void> {
    const target = e.target as HTMLInputElement;
    const n = Math.round(Number(target.value));
    if (!Number.isFinite(n)) return;
    // Clear the local override — the entity state will catch up.
    const next = { ...this._liveSlider };
    delete next[entityId];
    this._liveSlider = next;
    await this.hass!.callService("number", "set_value", {
      entity_id: entityId,
      value: n,
    });
  }

  private async _toggleSwitch(
    entityId: string,
    on: boolean,
  ): Promise<void> {
    await this.hass!.callService("switch", on ? "turn_on" : "turn_off", {
      entity_id: entityId,
    });
  }

  private _more(entityId: string): void {
    const event = new Event("hass-more-info", { bubbles: true, composed: true });
    (event as unknown as { detail: unknown }).detail = { entityId };
    this.dispatchEvent(event);
  }

  static styles = css`
    :host {
      --yc-accent: var(--primary-color, #03a9f4);
      --yc-ok: var(--success-color, #43a047);
      --yc-warn: var(--warning-color, #ff9800);
      --yc-err: var(--error-color, #e53935);
      --yc-muted: var(--secondary-text-color, #8a8a8a);
    }
    ha-card {
      overflow: hidden;
      transition: border-color 0.3s ease, box-shadow 0.3s ease;
    }
    ha-card.running {
      border: 2px solid var(--yc-ok);
      box-shadow: 0 0 0 1px color-mix(in srgb, var(--yc-ok) 30%, transparent);
    }
    .robot-icon.pulse {
      animation: yc-card-pulse 2.2s ease-in-out infinite;
    }
    @keyframes yc-card-pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.08); opacity: 0.75; }
    }
    .plan-running {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: color-mix(in srgb, var(--yc-ok) 10%, var(--secondary-background-color));
      border-left: 3px solid var(--yc-ok);
      border-radius: 8px;
      font-size: 0.9rem;
    }
    .plan-running.paused {
      background: color-mix(in srgb, var(--yc-warn) 10%, var(--secondary-background-color));
      border-left-color: var(--yc-warn);
    }
    .plan-running ha-icon {
      --mdc-icon-size: 18px;
      color: var(--yc-ok);
    }
    .plan-running.paused ha-icon {
      color: var(--yc-warn);
    }
    .plan-running-label {
      text-transform: uppercase;
      letter-spacing: 0.05em;
      font-size: 0.72rem;
      color: var(--yc-muted);
    }
    .plan-running-name {
      font-weight: 600;
      color: var(--primary-text-color);
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .root {
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .root.compact {
      padding: 10px;
      gap: 8px;
    }
    .warning {
      padding: 16px;
      color: var(--yc-warn);
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .title {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .robot-icon {
      --mdc-icon-size: 28px;
      color: var(--yc-accent);
    }
    .name {
      font-size: 1.2rem;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .badges {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 999px;
      font-size: 0.8rem;
      background: var(--secondary-background-color);
      color: var(--yc-muted);
      cursor: default;
    }
    .badge.battery {
      cursor: pointer;
      background: color-mix(in srgb, var(--yc-accent) 18%, transparent);
      color: var(--primary-text-color);
    }
    .badge.battery.charging {
      background: color-mix(in srgb, var(--yc-ok) 22%, transparent);
    }
    .badge.on {
      color: var(--yc-ok);
    }
    .badge.off {
      color: var(--yc-muted);
    }
    .status {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px 14px;
      background: var(--secondary-background-color);
      border-radius: 12px;
    }
    .hero {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .hero-main {
      flex: 1;
      min-width: 0;
    }
    .hero-label {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--yc-muted);
    }
    .hero-value {
      font-size: 1.4rem;
      font-weight: 700;
      line-height: 1.2;
      margin-top: 2px;
      color: var(--primary-text-color);
    }
    .hero-sub {
      font-size: 0.85rem;
      color: var(--yc-muted);
      margin-top: 4px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-variant-numeric: tabular-nums;
    }
    .hero-sub.running {
      color: var(--yc-ok);
    }
    .hero-sub ha-icon {
      --mdc-icon-size: 16px;
    }
    .progress-ring {
      position: relative;
      width: 56px;
      height: 56px;
      flex: 0 0 56px;
    }
    .progress-ring svg {
      width: 100%;
      height: 100%;
    }
    .progress-text {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .progress-pct {
      font-size: 0.85rem;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      color: var(--primary-text-color);
    }
    .pills {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 8px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--primary-text-color) 8%, transparent);
      color: var(--yc-muted);
      font-size: 0.78rem;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .pill ha-icon {
      --mdc-icon-size: 14px;
      flex-shrink: 0;
    }
    .pill.pill-warn {
      color: var(--yc-warn);
      background: color-mix(in srgb, var(--yc-warn) 15%, transparent);
    }
    /* Fixed-width numeric pills so they don't reflow as values change. */
    .pill.pill-fixed {
      min-width: 84px;
      justify-content: flex-start;
    }
    .banner {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 10px;
      font-size: 0.9rem;
      border-left: 4px solid currentColor;
    }
    .banner-error {
      background: color-mix(in srgb, var(--yc-err) 18%, transparent);
      color: var(--yc-err);
      font-weight: 600;
      cursor: pointer;
    }
    .banner-error:hover {
      background: color-mix(in srgb, var(--yc-err) 25%, transparent);
    }
    .banner-warn {
      background: color-mix(in srgb, var(--yc-warn) 15%, transparent);
      color: var(--yc-warn);
      font-weight: 500;
    }
    .plan {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .plan label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex: 1 1 180px;
      min-width: 160px;
    }
    .plan span {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--yc-muted);
    }
    .plan select {
      padding: 6px 8px;
      background: var(--secondary-background-color);
      color: var(--primary-text-color);
      border: 1px solid var(--divider-color);
      border-radius: 8px;
      font: inherit;
    }
    .slider-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .slider-row input[type="range"] {
      flex: 1;
      accent-color: var(--yc-accent);
    }
    .slider-row .pct {
      min-width: 40px;
      text-align: right;
      font-variant-numeric: tabular-nums;
      color: var(--primary-text-color);
    }
    .controls {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .primary-ctrl {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 14px 16px;
      border-radius: 12px;
      border: none;
      background: var(--yc-accent);
      color: var(--text-primary-color, #fff);
      cursor: pointer;
      font: inherit;
      font-size: 1rem;
      font-weight: 600;
      transition: transform 0.06s ease, background 0.2s ease;
    }
    .primary-ctrl:hover:not([disabled]) {
      background: color-mix(in srgb, var(--yc-accent) 85%, #000);
    }
    .primary-ctrl:active:not([disabled]) {
      transform: scale(0.98);
    }
    .primary-ctrl[disabled] {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .primary-ctrl ha-icon {
      --mdc-icon-size: 22px;
    }
    .primary-ctrl:focus-visible,
    .icon-ctrl:focus-visible,
    .mini:focus-visible {
      outline: 2px solid var(--yc-accent);
      outline-offset: 2px;
    }
    .secondary-ctrls {
      display: flex;
      gap: 8px;
    }
    .icon-ctrl {
      flex: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px;
      border-radius: 10px;
      border: 1px solid var(--divider-color);
      background: transparent;
      color: var(--primary-text-color);
      cursor: pointer;
      font: inherit;
      font-size: 0.85rem;
      transition: background 0.2s ease;
    }
    .icon-ctrl:hover:not([disabled]) {
      background: var(--secondary-background-color);
    }
    .icon-ctrl[disabled] {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .icon-ctrl ha-icon {
      --mdc-icon-size: 18px;
    }
    .icon-ctrl-label {
      font-size: 0.85rem;
    }
    @media (max-width: 380px) {
      .icon-ctrl-label { display: none; }
      .primary-ctrl { padding: 12px 14px; font-size: 0.95rem; }
    }
    .nogo {
      border-top: 1px solid var(--divider-color);
      padding-top: 8px;
    }
    .mesh {
      border-top: 1px solid var(--divider-color);
      padding-top: 8px;
    }
    .wp-error {
      flex-basis: 100%;
      padding: 6px 4px 0;
      color: var(--error-color, #c33);
      font-size: 0.82rem;
    }
    .mesh summary {
      cursor: pointer;
      color: var(--primary-text-color);
      font-size: 0.9rem;
      font-weight: 500;
      list-style: none;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .mesh summary::-webkit-details-marker { display: none; }
    .mesh-meta {
      color: var(--secondary-text-color);
      font-size: 0.8rem;
      margin-left: auto;
    }
    .mesh-controls {
      display: flex;
      gap: 6px;
      margin: 8px 0;
    }
    .mesh-controls button {
      background: var(--card-background-color);
      color: var(--primary-text-color);
      border: 1px solid var(--divider-color);
      border-radius: 4px;
      padding: 4px 10px;
      cursor: pointer;
      font-size: 0.8rem;
    }
    .mesh-controls button.active {
      background: var(--primary-color);
      color: var(--text-primary-color, #fff);
      border-color: var(--primary-color);
    }
    .mesh-sep {
      width: 1px;
      height: 18px;
      background: var(--divider-color);
      margin: 0 4px;
    }
    .mesh-empty, .mesh-error {
      padding: 12px;
      color: var(--secondary-text-color);
      font-size: 0.85rem;
    }
    .mesh-error { color: var(--error-color, #c33); }
    yarbo-mesh-view {
      width: 100%;
      height: 360px;
      display: block;
    }
    .mesh-areas {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      margin-bottom: 8px;
    }
    .mesh-areas-label {
      color: var(--secondary-text-color);
      font-size: 0.8rem;
      margin-right: 4px;
    }
    .mesh-area-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border: 1px solid var(--divider-color);
      border-radius: 12px;
      font-size: 0.78rem;
      cursor: pointer;
      user-select: none;
      background: var(--card-background-color);
      color: var(--secondary-text-color);
    }
    .mesh-area-pill input {
      margin: 0;
      cursor: pointer;
    }
    .mesh-area-pill.on {
      background: var(--primary-color);
      color: var(--text-primary-color, #fff);
      border-color: var(--primary-color);
    }
    .nogo summary {
      cursor: pointer;
      color: var(--primary-text-color);
      font-size: 0.9rem;
      font-weight: 500;
      list-style: none;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .nogo summary::-webkit-details-marker {
      display: none;
    }
    .nogo summary::before {
      content: "▸ ";
      color: var(--yc-muted);
      transition: transform 0.15s ease;
      display: inline-block;
    }
    .nogo[open] summary::before {
      transform: rotate(90deg);
    }
    .nogo-count {
      margin-left: auto;
      font-size: 0.78rem;
      color: var(--yc-muted);
      font-variant-numeric: tabular-nums;
    }
    .nogo-locked {
      margin-top: 8px;
      padding: 6px 10px;
      font-size: 0.8rem;
      color: var(--yc-muted);
      background: var(--secondary-background-color);
      border-left: 3px solid var(--yc-warn);
      border-radius: 6px;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .nogo-locked ha-icon {
      --mdc-icon-size: 14px;
    }
    .nogo-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 8px;
    }
    .nogo-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 4px 6px;
    }
    .nogo-name {
      flex: 1;
      font-size: 0.9rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .advanced {
      border-top: 1px solid var(--divider-color);
      padding-top: 8px;
    }
    .advanced summary {
      cursor: pointer;
      color: var(--yc-muted);
      font-size: 0.85rem;
      list-style: none;
      user-select: none;
    }
    .advanced summary::-webkit-details-marker {
      display: none;
    }
    .advanced summary::before {
      content: "▸ ";
      display: inline-block;
      transition: transform 0.15s ease;
    }
    .advanced[open] summary::before {
      transform: rotate(90deg);
    }
    .adv-grid {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-top: 10px;
    }
    .adv-row {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .adv-row > span:first-child {
      flex: 0 0 80px;
      color: var(--yc-muted);
      font-size: 0.85rem;
    }
    .adv-row .slider-row {
      flex: 1;
    }
    .refresh-row {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 12px;
    }
    .mini {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 5px 10px;
      font-size: 0.8rem;
      border: 1px solid var(--divider-color);
      border-radius: 999px;
      background: transparent;
      color: var(--yc-muted);
      cursor: pointer;
      font-family: inherit;
    }
    .mini ha-icon {
      --mdc-icon-size: 16px;
    }
    .mini:hover {
      color: var(--primary-text-color);
      background: var(--secondary-background-color);
    }
    ${unsafeCSS(SCHEDULER_CSS)}
  `;
}

if (!customElements.get("yarbo-card")) {
  customElements.define("yarbo-card", YarboCard);
}
