import { LitElement, html, css, svg, nothing, type TemplateResult, type SVGTemplateResult, type PropertyValues } from "lit";
import { property, state, query } from "lit/decorators.js";
import { DEFAULT_COLORS, type YarboColors } from "./types";

export interface GeoJsonFeature {
  type: "Feature";
  geometry: {
    type: "Polygon" | "LineString" | "Point" | "MultiPoint";
    coordinates: number[] | number[][] | number[][][];
  };
  properties: {
    id?: string | number;
    name?: string;
    zone_type?: string;
    [k: string]: unknown;
  };
}

export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
}

export type TrailPhase = "heading" | "cleaning";

export interface TrailPoint {
  lon: number;
  lat: number;
  phase: TrailPhase;
}

interface Style {
  fill?: string;
  fillOpacity?: number;
  stroke?: string;
  strokeWidth?: number;
  strokeDasharray?: string;
  order: number; // lower = drawn first (behind)
  label: string;
}

// Color-blind-friendly palette based on Okabe-Ito (2008), which is the
// de facto standard for accessible data viz. The zones deliberately
// avoid red/green pairings (the most common CVD axis). Redundant
// pattern cues (dashes on geofence, dashes on deadends, dashed transit
// trail) give additional non-chromatic differentiation.
const ZONE_STYLES: Record<string, Style> = {
  areas: {
    fill: "#009E73", // Okabe-Ito bluish green
    fillOpacity: 0.22,
    stroke: "#00664d",
    strokeWidth: 1.5,
    order: 1,
    label: "Work zone",
  },
  nogozones: {
    fill: "#D55E00", // Okabe-Ito vermillion
    fillOpacity: 0.32,
    stroke: "#8f3d00",
    strokeWidth: 2,
    order: 4,
    label: "No-go",
  },
  novisionzones: {
    fill: "#CC79A7", // Okabe-Ito reddish purple
    fillOpacity: 0.24,
    stroke: "#7b4571",
    strokeWidth: 1.5,
    order: 3,
    label: "No-vision",
  },
  elec_fence: {
    fill: "none",
    stroke: "#F0E442", // Okabe-Ito yellow
    strokeWidth: 3,
    strokeDasharray: "6 4",
    order: 5,
    label: "Geofence",
  },
  pathways: {
    fill: "none",
    stroke: "#0072B2", // Okabe-Ito blue
    strokeWidth: 18,
    order: 2,
    label: "Pathway",
  },
  sidewalks: {
    fill: "none",
    stroke: "#7a7f85",
    strokeWidth: 4,
    order: 2,
    label: "Sidewalk",
  },
  deadends: {
    fill: "none",
    stroke: "#7a7f85",
    strokeWidth: 2,
    strokeDasharray: "3 3",
    order: 2,
    label: "Dead end",
  },
};

const DEFAULT_STYLE: Style = {
  fill: "#9e9e9e",
  fillOpacity: 0.2,
  stroke: "#616161",
  strokeWidth: 1,
  order: 0,
  label: "Zone",
};

// Charging point color (Okabe-Ito sky blue) — not user-overridable yet.
const CHARGING_COLOR = "#56B4E9";

function styleFor(zoneType: string | undefined): Style {
  if (zoneType && zoneType in ZONE_STYLES) return ZONE_STYLES[zoneType];
  return DEFAULT_STYLE;
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 20;
const ZOOM_STEP = 1.35;
const FOLLOW_ZOOM = 20; // full zoom

class YarboMap extends LitElement {
  @property({ attribute: false }) public geojson?: GeoJsonFeatureCollection;
  @property({ attribute: false }) public robot?: {
    latitude: number;
    longitude: number;
    heading?: number; // radians
  };
  @property({ type: Number }) public height = 240;
  /**
   * When set, polygon features whose `properties.id` is in this set are
   * drawn with emphasis; non-matching `areas` polygons are dimmed. Other
   * zone types (nogo, paths, etc.) are left alone. Pass `undefined` to
   * disable plan highlighting.
   */
  @property({ attribute: false }) public planAreaIds?: Set<string>;
  /** Ordered list of trail points for the current plan run. Each point
   * carries the plan phase that was active when it was recorded, so we
   * can draw the transit ("heading") portion differently from the
   * working ("cleaning") portion. */
  @property({ attribute: false }) public trail?: Array<TrailPoint>;
  /** GeoJSON FeatureCollection of LineString features — the projected
   * path the robot plans to drive for the current running plan. Rendered
   * beneath the trail so the completed portion visually "covers" it. */
  @property({ attribute: false }) public plannedPath?: GeoJsonFeatureCollection;
  /** Area IDs belonging to the currently running plan (not just the
   * selected one). Used to highlight zones during execution. */
  @property({ attribute: false }) public runningAreaIds?: Set<string>;
  /** Dynamic obstacles detected during the current run, as a GeoJSON
   * FeatureCollection of Point/MultiPoint features. Rendered on top of
   * zones but beneath the robot glyph. */
  @property({ attribute: false }) public obstacles?: GeoJsonFeatureCollection;
  /** Optional per-element color overrides. */
  @property({ attribute: false }) public colors?: YarboColors;
  /** Set of no-go zone IDs (as strings) that are currently disabled.
   * Disabled zones render dimmed + dashed instead of as a hard no-go. */
  @property({ attribute: false }) public disabledNogoIds?: Set<string>;

  // Pan/zoom state. cx/cy are viewBox center in "base" viewport units
  // (pre-zoom). zoom=1 shows the fitted bbox; >1 zooms in.
  @state() private _zoom = 1;
  @state() private _cx = 0;
  @state() private _cy = 0;
  @state() private _dragging = false;
  @state() private _followRobot = false;
  @state() private _fullscreen = false;
  @state() private _legendOpen = false;
  @state() private _menuOpen = false;

  // Cached base viewport dims (set in render)
  private _baseW = 1000;
  private _baseH = 400;
  private _initializedCenter = false;
  // Last effective (robot-centered) viewport coords — captured each
  // render while follow-mode is on. Used to keep the frame in place
  // when the user toggles follow off.
  private _lastFollowCx: number | null = null;
  private _lastFollowCy: number | null = null;

  // Pointer-drag tracking (single finger / mouse)
  private _dragStartX = 0;
  private _dragStartY = 0;
  private _dragStartCx = 0;
  private _dragStartCy = 0;
  private _activePointer: number | null = null;

  // Multi-touch pinch tracking. Holds every currently-down pointer so we
  // can compute a distance between two fingers.
  private _pointers: Map<number, { x: number; y: number }> = new Map();
  private _pinchStartDist = 0;
  private _pinchStartZoom = 1;
  private _pinchStartCx = 0;
  private _pinchStartCy = 0;
  private _pinchStartMidX = 0; // midpoint in client-px at pinch start
  private _pinchStartMidY = 0;
  private _isPinching = false;

  @query("svg") private _svg?: SVGSVGElement;

  private _resizeObserver?: ResizeObserver;
  private _observedSvg?: SVGSVGElement;

  public connectedCallback(): void {
    super.connectedCallback();
    if ("ResizeObserver" in window) {
      this._resizeObserver = new ResizeObserver(() => {
        // Kick a re-render so the robot-scale recomputes with new dims.
        this.requestUpdate();
      });
    }
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    this._resizeObserver?.disconnect();
    this._resizeObserver = undefined;
    this._observedSvg = undefined;
  }

  protected updated(changed: PropertyValues): void {
    super.updated(changed);
    if (this._svg && this._svg !== this._observedSvg) {
      this._resizeObserver?.disconnect();
      this._resizeObserver?.observe(this._svg);
      this._observedSvg = this._svg;
      // First observation fires synchronously with current size; that's
      // enough to let the next render compute robot scale correctly.
    }
  }

  private _colors(): Required<YarboColors> {
    return { ...DEFAULT_COLORS, ...(this.colors ?? {}) };
  }

  protected render(): TemplateResult | typeof nothing {
    const feats = this.geojson?.features ?? [];
    if (feats.length === 0 && !this.robot) {
      return html`<div class="empty">No map data yet</div>`;
    }

    // Collect every coordinate into lon/lat pairs for bbox
    const lonLats: Array<[number, number]> = [];
    for (const f of feats) collectCoords(f, lonLats);
    if (this.robot) {
      lonLats.push([this.robot.longitude, this.robot.latitude]);
    }
    if (this.trail && this.trail.length) {
      for (const p of this.trail) lonLats.push([p.lon, p.lat]);
    }
    if (this.plannedPath && this.plannedPath.features) {
      for (const f of this.plannedPath.features) collectCoords(f, lonLats);
    }
    if (this.obstacles && this.obstacles.features) {
      for (const f of this.obstacles.features) collectCoords(f, lonLats);
    }

    if (lonLats.length === 0) {
      return html`<div class="empty">Map has no georeferenced features</div>`;
    }

    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (const [lon, lat] of lonLats) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    const cLat = (minLat + maxLat) / 2;
    const lonScale = Math.cos((cLat * Math.PI) / 180);

    // Pad bbox by 8% (min 5 metres of equivalent lat degrees)
    const padLat = Math.max((maxLat - minLat) * 0.08, 5e-5);
    const padLon = Math.max((maxLon - minLon) * 0.08, 5e-5);
    minLat -= padLat; maxLat += padLat;
    minLon -= padLon; maxLon += padLon;

    // Viewbox: 1 unit = 1 pixel at equator-equivalent
    const w = 1000;
    const spanLon = (maxLon - minLon) * lonScale;
    const spanLat = maxLat - minLat;
    const aspect = spanLat / spanLon || 1;
    const h = Math.max(120, Math.min(600, Math.round(w * aspect)));
    this._baseW = w;
    this._baseH = h;
    if (!this._initializedCenter) {
      this._cx = w / 2;
      this._cy = h / 2;
      this._initializedCenter = true;
    }

    const project = (lon: number, lat: number): [number, number] => {
      const x = ((lon - minLon) * lonScale / spanLon) * w;
      // y is flipped (screen down = south)
      const y = h - ((lat - minLat) / spanLat) * h;
      return [x, y];
    };

    // Dynamic viewBox for pan/zoom. When follow-robot is on, the center
    // tracks the robot; zoom is whatever the user has set. When follow is
    // off, we use the stored pan/zoom state.
    let effCx = this._cx;
    let effCy = this._cy;
    if (this._followRobot && this.robot) {
      const [rx, ry] = project(this.robot.longitude, this.robot.latitude);
      effCx = rx;
      effCy = ry;
      this._lastFollowCx = rx;
      this._lastFollowCy = ry;
    }
    const effZoom = this._zoom;
    const vbW = w / effZoom;
    const vbH = h / effZoom;
    const vbX = effCx - vbW / 2;
    const vbY = effCy - vbH / 2;
    // Stroke/point sizes scale inversely with zoom so they don't balloon
    const strokeScale = 1 / effZoom;
    // For the robot glyph specifically: we want a constant on-screen
    // size regardless of zoom OR the SVG element's physical dimensions
    // (which change between inline-card / fullscreen). Compute using
    // the actual SVG bounding rect when available.
    let robotScale = strokeScale;
    let obstacleScale = strokeScale;
    const rect = this._svg?.getBoundingClientRect();
    if (rect && rect.width > 0 && rect.height > 0) {
      // preserveAspectRatio="meet" uses the smaller ratio.
      const pxPerUnit = Math.min(rect.width / vbW, rect.height / vbH);
      if (pxPerUnit > 0) {
        // Robot: outer halo r=36 units → target ~32 screen px.
        robotScale = 32 / (36 * pxPerUnit);
        // Obstacle: outer halo r=6 units → target ~12 screen px.
        obstacleScale = 12 / (6 * pxPerUnit);
      }
    }

    // Collect render items per zone type so we can z-order
    const polygons: SVGTemplateResult[] = [];
    const lines: SVGTemplateResult[] = [];
    const points: SVGTemplateResult[] = [];
    const hasPlanFilter =
      this.planAreaIds instanceof Set && this.planAreaIds.size > 0;
    const c = this._colors();
    // Map zone_type → user-overridable color (undefined means use default).
    const zoneOverride: Record<string, string | undefined> = {
      areas: c.zone_work,
      nogozones: c.zone_nogo,
      novisionzones: c.zone_novision,
      elec_fence: c.zone_geofence,
      pathways: c.zone_pathway,
    };
    for (const f of feats) {
      const baseStyle = styleFor(f.properties?.zone_type);
      const overrideColor = zoneOverride[f.properties?.zone_type ?? ""];
      const s: Style = overrideColor
        ? {
            ...baseStyle,
            // For polygon zones override fill; for line-only zones
            // (pathways, elec_fence) override stroke.
            fill: baseStyle.fill !== "none" ? overrideColor : baseStyle.fill,
            stroke:
              baseStyle.fill === "none"
                ? overrideColor
                : baseStyle.stroke,
          }
        : baseStyle;
      const g = f.geometry;
      const isArea = f.properties?.zone_type === "areas";
      const isNogo = f.properties?.zone_type === "nogozones";
      const nogoDisabled =
        isNogo &&
        f.properties?.id != null &&
        this.disabledNogoIds instanceof Set &&
        this.disabledNogoIds.has(String(f.properties.id));
      const inPlan =
        hasPlanFilter &&
        isArea &&
        f.properties?.id != null &&
        this.planAreaIds!.has(String(f.properties.id));
      // Selected plan areas: darker/denser fill, slightly heavier stroke.
      // Disabled no-go zones: dimmed fill + thicker dashed border so the
      // zone is still readable as "no-go shape" but clearly inactive.
      const fillOp =
        (s.fillOpacity ?? 1) *
        (nogoDisabled ? 0.5 : inPlan ? 2.6 : 1);
      const stroke = s.stroke ?? "none";
      const strokeW =
        (s.strokeWidth ?? 1) * (inPlan ? 1.8 : nogoDisabled ? 1.4 : 1);
      const strokeDash = nogoDisabled
        ? "5 4"
        : s.strokeDasharray ?? "";
      if (g.type === "Polygon") {
        const rings = g.coordinates as number[][][];
        if (!rings.length) continue;
        const d = rings
          .map(
            (ring) =>
              "M " +
              ring
                .map(([lon, lat]) => {
                  const [x, y] = project(lon, lat);
                  return `${x.toFixed(2)},${y.toFixed(2)}`;
                })
                .join(" L ") +
              " Z",
          )
          .join(" ");
        polygons.push(svg`
          <path
            d=${d}
            fill=${s.fill ?? "none"}
            fill-opacity=${fillOp}
            stroke=${stroke}
            stroke-width=${strokeW}
            stroke-dasharray=${strokeDash}
            stroke-opacity=${nogoDisabled ? 0.85 : 1}
            vector-effect="non-scaling-stroke"
            data-order=${s.order}
          >
            <title>${f.properties?.name || s.label}${inPlan ? " (in selected plan)" : ""}${nogoDisabled ? " (disabled)" : ""}</title>
          </path>
        `);
      } else if (g.type === "LineString") {
        const pts = g.coordinates as number[][];
        if (pts.length < 2) continue;
        const d = "M " + pts
          .map(([lon, lat]) => {
            const [x, y] = project(lon, lat);
            return `${x.toFixed(2)},${y.toFixed(2)}`;
          })
          .join(" L ");
        lines.push(svg`
          <path
            d=${d}
            fill="none"
            stroke=${s.stroke ?? "#888"}
            stroke-width=${s.strokeWidth ?? 1.5}
            stroke-dasharray=${s.strokeDasharray ?? ""}
            stroke-linecap="round"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
            data-order=${s.order}
          >
            <title>${f.properties?.name || s.label}</title>
          </path>
        `);
        if (f.properties?.zone_type === "pathways") {
          // Road-marking style: thin dashed stripe down the middle.
          lines.push(svg`
            <path
              d=${d}
              fill="none"
              stroke="#ffffff"
              stroke-width="3"
              stroke-dasharray="10 8"
              stroke-linecap="butt"
              stroke-linejoin="round"
              stroke-opacity="0.9"
              vector-effect="non-scaling-stroke"
            />
          `);
        }
      } else if (g.type === "Point") {
        const [lon, lat] = g.coordinates as number[];
        const [x, y] = project(lon, lat);
        points.push(svg`
          <g class="charging" transform="translate(${x},${y}) scale(${strokeScale})">
            <circle r="8" fill=${CHARGING_COLOR} stroke="#fff" stroke-width="1.5" />
            <path
              d="M -1.5 -4 L 2 -0.5 L 0 -0.5 L 1.5 4 L -2 0.5 L 0 0.5 Z"
              fill="#fff"
            />
            <title>${f.properties?.name || "Charging station"}</title>
          </g>
        `);
      }
    }

    // Polygons render in FeatureCollection order (areas → nogozones →
    // novisionzones → elec_fence), which naturally layers restricted zones
    // on top of work areas.

    const planned = this._renderPlannedPath(project, c);
    const trail = this._renderTrail(project, strokeScale, c);
    const obstacles = this._renderObstacles(project, obstacleScale, c);
    const robot = this.robot
      ? this._renderRobot(this.robot, project, robotScale, c)
      : null;
    const legend = this._renderLegend(feats, c);

    const wrapStyle = (() => {
      const parts: string[] = [];
      if (!this._fullscreen) parts.push(`height:${this.height}px`);
      if (this.colors?.map_background) {
        parts.push(`background:${this.colors.map_background}`);
      }
      return parts.join(";");
    })();
    return html`
      <div
        class="map-wrap ${this._dragging ? "dragging" : ""} ${this._fullscreen ? "fullscreen" : ""}"
        style=${wrapStyle}
      >
        <svg
          viewBox="${vbX} ${vbY} ${vbW} ${vbH}"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          style=${this.colors?.map_background
            ? `background:${this.colors.map_background}`
            : ""}
          @wheel=${this._onWheel}
          @pointerdown=${this._onPointerDown}
          @pointermove=${this._onPointerMove}
          @pointerup=${this._onPointerUp}
          @pointercancel=${this._onPointerUp}
          @dblclick=${this._onDoubleClick}
        >
          <!-- Over-sized background: SVG doesn't clip outside the viewBox,
               so an extra-large rect reliably paints the letterbox bands
               regardless of container aspect. -->
          <rect
            x="-100000" y="-100000" width="200000" height="200000"
            fill=${this.colors?.map_background ?? "var(--yc-map-bg, var(--primary-background-color))"}
          />
          ${polygons}
          ${lines}
          ${points}
          ${planned}
          ${trail}
          ${obstacles}
          ${robot}
        </svg>
        ${legend}
        ${this._renderZoomControls()}
      </div>
    `;
  }

  private _renderZoomControls(): TemplateResult {
    const resetDisabled =
      this._zoom === 1 &&
      this._cx === this._baseW / 2 &&
      this._cy === this._baseH / 2;
    return html`
      <div class="zoom-controls">
        <div class="zoom-pill">
          <button
            class="zoom-btn"
            @click=${() => this._zoomBy(ZOOM_STEP)}
            ?disabled=${this._zoom >= MAX_ZOOM}
            title="Zoom in"
            aria-label="Zoom in"
          >
            <ha-icon icon="mdi:plus"></ha-icon>
          </button>
          <button
            class="zoom-btn"
            @click=${() => this._zoomBy(1 / ZOOM_STEP)}
            ?disabled=${this._zoom <= MIN_ZOOM}
            title="Zoom out"
            aria-label="Zoom out"
          >
            <ha-icon icon="mdi:minus"></ha-icon>
          </button>
        </div>
        <div class="zoom-more">
          <button
            class="zoom-btn ${this._menuOpen ? "active" : ""}"
            @click=${() => (this._menuOpen = !this._menuOpen)}
            title="More"
            aria-label="More view options"
            aria-haspopup="true"
            aria-expanded=${this._menuOpen}
          >
            <ha-icon icon="mdi:dots-vertical"></ha-icon>
          </button>
          ${this._menuOpen
            ? html`
                <div class="zoom-menu" role="menu">
                  <button
                    class="zoom-menu-item ${this._followRobot ? "active" : ""}"
                    @click=${() => {
                      this._toggleFollowRobot();
                      this._menuOpen = false;
                    }}
                    ?disabled=${!this.robot}
                    role="menuitem"
                  >
                    <ha-icon icon="mdi:crosshairs-gps"></ha-icon>
                    <span>${this._followRobot ? "Stop following" : "Follow robot"}</span>
                  </button>
                  <button
                    class="zoom-menu-item"
                    @click=${() => {
                      this._resetView();
                      this._menuOpen = false;
                    }}
                    ?disabled=${resetDisabled}
                    role="menuitem"
                  >
                    <ha-icon icon="mdi:image-filter-center-focus"></ha-icon>
                    <span>Reset view</span>
                  </button>
                  <button
                    class="zoom-menu-item ${this._fullscreen ? "active" : ""}"
                    @click=${() => {
                      this._toggleFullscreen();
                      this._menuOpen = false;
                    }}
                    role="menuitem"
                  >
                    <ha-icon
                      icon=${this._fullscreen
                        ? "mdi:fullscreen-exit"
                        : "mdi:fullscreen"}
                    ></ha-icon>
                    <span>${this._fullscreen ? "Exit fullscreen" : "Fullscreen"}</span>
                  </button>
                </div>
              `
            : nothing}
        </div>
      </div>
    `;
  }

  private _renderObstacles(
    project: (lon: number, lat: number) => [number, number],
    scale: number,
    c: Required<YarboColors>,
  ): SVGTemplateResult | null {
    const feats = this.obstacles?.features;
    if (!feats || feats.length === 0) return null;
    const color = c.obstacle;
    const marks: SVGTemplateResult[] = [];
    for (const f of feats) {
      const g = f.geometry;
      if (!g) continue;
      const pts: number[][] = [];
      if (g.type === "Point") pts.push(g.coordinates as number[]);
      else if (g.type === "MultiPoint") pts.push(...(g.coordinates as number[][]));
      else continue;
      if (pts.length === 0) continue;
      let sx = 0, sy = 0;
      for (const [lon, lat] of pts) {
        const [x, y] = project(lon, lat);
        sx += x;
        sy += y;
      }
      const cx = sx / pts.length;
      const cy = sy / pts.length;
      marks.push(svg`
        <g
          class="obstacle"
          transform="translate(${cx.toFixed(2)},${cy.toFixed(2)}) scale(${scale})"
        >
          <circle r="6" fill=${color} fill-opacity="0.25"
            vector-effect="non-scaling-stroke" />
          <circle r="3" fill=${color} stroke="#ffffff"
            stroke-width="0.6" vector-effect="non-scaling-stroke" />
          <title>Obstacle</title>
        </g>
      `);
    }
    if (marks.length === 0) return null;
    return svg`<g class="obstacles">${marks}</g>`;
  }

  private _renderPlannedPath(
    project: (lon: number, lat: number) => [number, number],
    c: Required<YarboColors>,
  ): SVGTemplateResult | null {
    const feats = this.plannedPath?.features;
    if (!feats || feats.length === 0) return null;
    // Always render the entire planned path as a faint always-visible
    // guide. "Completed" is shown by the GPS trail drawn on top.
    const paths: SVGTemplateResult[] = [];
    for (const f of feats) {
      if (f.geometry?.type !== "LineString") continue;
      const pts = f.geometry.coordinates as number[][];
      if (!pts || pts.length < 2) continue;
      const d = "M " + pts
        .map(([lon, lat]) => {
          const [x, y] = project(lon, lat);
          return `${x.toFixed(2)},${y.toFixed(2)}`;
        })
        .join(" L ");
      paths.push(svg`
        <path
          d=${d}
          fill="none"
          stroke=${c.trail_planned}
          stroke-width="2"
          stroke-dasharray="5 5"
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-opacity="0.65"
          vector-effect="non-scaling-stroke"
        />
      `);
    }
    if (paths.length === 0) return null;
    return svg`<g class="planned-path">${paths}</g>`;
  }

  private _renderTrail(
    project: (lon: number, lat: number) => [number, number],
    strokeScale: number,
    c: Required<YarboColors>,
  ): SVGTemplateResult | null {
    const trail = this.trail;
    if (!trail || trail.length < 2) return null;

    // Split the trail into contiguous same-phase segments, so each phase
    // draws as its own polyline. Adjacent phases share an overlap point
    // so there's no visual gap at the transition.
    const segments: Array<{ phase: TrailPhase; d: string }> = [];
    let segPhase: TrailPhase | null = null;
    let segParts: string[] = [];
    const flush = () => {
      if (segPhase && segParts.length > 1) {
        segments.push({ phase: segPhase, d: "M " + segParts.join(" L ") });
      }
    };
    for (let i = 0; i < trail.length; i++) {
      const p = trail[i];
      const [x, y] = project(p.lon, p.lat);
      const coord = `${x.toFixed(2)},${y.toFixed(2)}`;
      if (p.phase !== segPhase) {
        if (segPhase && segParts.length > 0) {
          // Include this point as the last point of the previous phase
          // so the line meets without a visible gap.
          segParts.push(coord);
          flush();
        }
        segPhase = p.phase;
        segParts = [coord];
      } else {
        segParts.push(coord);
      }
    }
    flush();

    // Trail strokes render in fixed screen pixels (non-scaling-stroke),
    // so widths are constant across zoom levels.
    return svg`
      <g class="trail">
        ${segments.map((seg) => {
          if (seg.phase === "heading") {
            return svg`
              <path
                d=${seg.d}
                fill="none"
                stroke=${c.trail_transit}
                stroke-width="5"
                stroke-dasharray="8 5"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-opacity="0.95"
                vector-effect="non-scaling-stroke"
              ><title>Transit path (moving to area)</title></path>
            `;
          }
          return svg`
            <path
              d=${seg.d}
              fill="none"
              stroke=${c.trail_completed}
              stroke-width="5"
              stroke-linecap="round"
              stroke-linejoin="round"
              vector-effect="non-scaling-stroke"
            ><title>Completed path</title></path>
          `;
        })}
      </g>
    `;
  }

  private _renderRobot(
    robot: NonNullable<YarboMap["robot"]>,
    project: (lon: number, lat: number) => [number, number],
    scale: number,
    c: Required<YarboColors>,
  ): SVGTemplateResult {
    const [x, y] = project(robot.longitude, robot.latitude);
    // Yarbo's local frame (per SDK docs) is +X=west, +Y=north, phi in
    // radians CCW from +X. Screen is east-right, north-up. The frame is
    // mirrored across X, so CCW in robot frame becomes CW in screen frame.
    // Screen rotation (CW, degrees) = phi*180/π + 180.
    let deg = 0;
    if (typeof robot.heading === "number" && Number.isFinite(robot.heading)) {
      deg = (robot.heading * 180) / Math.PI + 180;
      deg = ((deg % 360) + 360) % 360;
    }
    const body = c.robot;
    return svg`
      <g class="robot" transform="translate(${x.toFixed(2)},${y.toFixed(2)}) scale(${scale})">
        <circle r="36" fill=${body} fill-opacity="0.08" />
        <circle r="24" fill=${body} fill-opacity="0.22" />
        <ellipse cx="0" cy="5" rx="16" ry="5" fill="#000000" fill-opacity="0.35" />
        <g transform="rotate(${deg.toFixed(1)})">
          <path
            d="M -13 -11 Q -17 0 -13 11 L 10 11 Q 16 6 21 0 Q 16 -6 10 -11 Z"
            fill=${body}
            stroke="#ffffff"
            stroke-width="2.2"
          />
          <path
            d="M 21 0 L 10 -8 L 10 8 Z"
            fill="#ffeb3b"
            stroke="#ffffff"
            stroke-width="1.1"
          />
          <circle cx="-2" cy="0" r="3.6" fill="#01579b" stroke="#ffffff" stroke-width="1.4" />
          <circle cx="-10" cy="-7" r="1.5" fill="#ffffff" />
          <circle cx="-10" cy="7" r="1.5" fill="#ffffff" />
        </g>
        <title>Robot position</title>
      </g>
    `;
  }

  // ----- interaction -----

  private _clampCenter(): void {
    // Keep the viewport center within the base canvas so you can't pan
    // infinitely into empty space.
    const vbW = this._baseW / this._zoom;
    const vbH = this._baseH / this._zoom;
    const minX = vbW / 2;
    const maxX = this._baseW - vbW / 2;
    const minY = vbH / 2;
    const maxY = this._baseH - vbH / 2;
    this._cx = Math.max(minX, Math.min(maxX, this._cx));
    this._cy = Math.max(minY, Math.min(maxY, this._cy));
  }

  private _screenToWorld(ev: { clientX: number; clientY: number }): { x: number; y: number } | null {
    if (!this._svg) return null;
    const rect = this._svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const fx = (ev.clientX - rect.left) / rect.width; // 0..1
    const fy = (ev.clientY - rect.top) / rect.height;
    const vbW = this._baseW / this._zoom;
    const vbH = this._baseH / this._zoom;
    return {
      x: this._cx - vbW / 2 + fx * vbW,
      y: this._cy - vbH / 2 + fy * vbH,
    };
  }

  private _zoomBy(factor: number): void {
    this._applyZoom(this._zoom * factor);
  }

  private _applyZoom(newZoom: number, pivot?: { x: number; y: number }): void {
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
    if (z === this._zoom) return;
    if (pivot) {
      // Keep the pivot point anchored to the same world coordinate.
      const k = 1 - this._zoom / z;
      this._cx += (pivot.x - this._cx) * k;
      this._cy += (pivot.y - this._cy) * k;
    }
    this._zoom = z;
    this._clampCenter();
  }

  private _resetView = (): void => {
    this._zoom = 1;
    this._cx = this._baseW / 2;
    this._cy = this._baseH / 2;
    this._followRobot = false;
  };

  private _toggleFollowRobot(): void {
    if (this._followRobot) {
      // Exiting follow: freeze the frame where the robot currently is.
      if (this._lastFollowCx !== null && this._lastFollowCy !== null) {
        this._cx = this._lastFollowCx;
        this._cy = this._lastFollowCy;
        this._clampCenter();
      }
      this._followRobot = false;
    } else {
      // Entering follow: snap to full zoom centered on the robot.
      this._zoom = FOLLOW_ZOOM;
      this._followRobot = true;
    }
  }

  private _onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    if (this._followRobot) {
      // In follow mode, wheel just adjusts zoom. Center stays on robot.
      this._applyZoom(this._zoom * factor);
      return;
    }
    const pivot = this._screenToWorld(ev) ?? undefined;
    this._applyZoom(this._zoom * factor, pivot);
  };

  private _onPointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0 && ev.pointerType === "mouse") return;
    const target = ev.target as Element;
    if (target && target.closest(".zoom-controls, .legend")) return;
    ev.preventDefault();
    (ev.currentTarget as Element).setPointerCapture?.(ev.pointerId);
    this._pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

    if (this._pointers.size === 1) {
      // Pan drag start — exit follow but freeze frame where robot is.
      if (this._followRobot) {
        if (this._lastFollowCx !== null && this._lastFollowCy !== null) {
          this._cx = this._lastFollowCx;
          this._cy = this._lastFollowCy;
        }
        this._followRobot = false;
      }
      this._activePointer = ev.pointerId;
      this._dragStartX = ev.clientX;
      this._dragStartY = ev.clientY;
      this._dragStartCx = this._cx;
      this._dragStartCy = this._cy;
      this._dragging = true;
    } else if (this._pointers.size === 2) {
      // Second finger down → start pinch. Cancel the single-pointer pan.
      this._dragging = false;
      this._activePointer = null;
      this._beginPinch();
    }
  };

  private _onPointerMove = (ev: PointerEvent): void => {
    if (!this._svg) return;
    if (!this._pointers.has(ev.pointerId)) return;
    this._pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

    if (this._isPinching && this._pointers.size >= 2) {
      this._applyPinch();
      return;
    }
    if (this._activePointer !== ev.pointerId) return;
    const rect = this._svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const dx = ev.clientX - this._dragStartX;
    const dy = ev.clientY - this._dragStartY;
    const vbW = this._baseW / this._zoom;
    const vbH = this._baseH / this._zoom;
    this._cx = this._dragStartCx - (dx / rect.width) * vbW;
    this._cy = this._dragStartCy - (dy / rect.height) * vbH;
    this._clampCenter();
  };

  private _onPointerUp = (ev: PointerEvent): void => {
    this._pointers.delete(ev.pointerId);
    (ev.currentTarget as Element).releasePointerCapture?.(ev.pointerId);
    if (this._isPinching && this._pointers.size < 2) {
      // Drop out of pinch. If one finger remains, use it to continue
      // a pan from the current center — avoids a jump.
      this._isPinching = false;
      const remaining = Array.from(this._pointers.entries())[0];
      if (remaining) {
        const [id, { x, y }] = remaining;
        this._activePointer = id;
        this._dragStartX = x;
        this._dragStartY = y;
        this._dragStartCx = this._cx;
        this._dragStartCy = this._cy;
        this._dragging = true;
      }
      return;
    }
    if (this._activePointer === ev.pointerId) {
      this._activePointer = null;
      this._dragging = false;
    }
  };

  // ----- pinch helpers -----

  private _beginPinch(): void {
    const pts = Array.from(this._pointers.values());
    if (pts.length < 2) return;
    const [p1, p2] = pts;
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (dist < 1) return;
    this._pinchStartDist = dist;
    this._pinchStartZoom = this._zoom;
    this._pinchStartCx = this._cx;
    this._pinchStartCy = this._cy;
    this._pinchStartMidX = (p1.x + p2.x) / 2;
    this._pinchStartMidY = (p1.y + p2.y) / 2;
    this._isPinching = true;
  }

  private _applyPinch(): void {
    if (!this._svg) return;
    const pts = Array.from(this._pointers.values());
    if (pts.length < 2) return;
    const [p1, p2] = pts;
    const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (dist < 1) return;
    const rect = this._svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const scale = dist / this._pinchStartDist;
    const newZoom = Math.max(
      MIN_ZOOM,
      Math.min(MAX_ZOOM, this._pinchStartZoom * scale),
    );

    // World coordinate of the pinch midpoint at pinch start — stays anchored
    // as the user zooms/pans.
    const fx0 = (this._pinchStartMidX - rect.left) / rect.width - 0.5;
    const fy0 = (this._pinchStartMidY - rect.top) / rect.height - 0.5;
    const worldAnchorX =
      this._pinchStartCx + fx0 * (this._baseW / this._pinchStartZoom);
    const worldAnchorY =
      this._pinchStartCy + fy0 * (this._baseH / this._pinchStartZoom);

    // Current midpoint screen position (moves with the user's fingers).
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    const fx = (midX - rect.left) / rect.width - 0.5;
    const fy = (midY - rect.top) / rect.height - 0.5;

    // Solve: newCx + fx * baseW/newZoom == worldAnchorX
    this._cx = worldAnchorX - fx * (this._baseW / newZoom);
    this._cy = worldAnchorY - fy * (this._baseH / newZoom);
    this._zoom = newZoom;
    this._clampCenter();
  }

  private _toggleFullscreen(): void {
    this._fullscreen = !this._fullscreen;
  }

  private _onDoubleClick = (ev: MouseEvent): void => {
    ev.preventDefault();
    const pivot = this._screenToWorld(ev) ?? undefined;
    this._applyZoom(this._zoom * ZOOM_STEP * ZOOM_STEP, pivot);
  };

  protected willUpdate(changed: PropertyValues): void {
    // If the geojson/robot reference changes enough to rebuild the bbox,
    // the next render will reset _baseW/_baseH. We intentionally keep
    // _cx/_cy/_zoom so the user's view is preserved across live updates.
    super.willUpdate(changed);
  }

  private _renderLegend(
    feats: GeoJsonFeature[],
    c: Required<YarboColors>,
  ): TemplateResult | typeof nothing {
    const types = new Set<string>();
    for (const f of feats) {
      const t = f.properties?.zone_type;
      if (t) types.add(t);
    }
    const hasTrail = this.trail && this.trail.length > 1;
    const hasPlanned = !!(
      this.plannedPath?.features?.some(
        (f) =>
          f.geometry?.type === "LineString" &&
          Array.isArray(f.geometry.coordinates) &&
          f.geometry.coordinates.length >= 2,
      )
    );
    const hasCleaningTrail = !!this.trail?.some((p) => p.phase === "cleaning");
    if (
      types.size === 0 &&
      !hasTrail &&
      !hasPlanned &&
      !this.obstacles?.features?.length
    ) {
      return nothing;
    }
    const zoneOverride: Record<string, string | undefined> = {
      areas: c.zone_work,
      nogozones: c.zone_nogo,
      novisionzones: c.zone_novision,
      elec_fence: c.zone_geofence,
      pathways: c.zone_pathway,
    };
    const items: TemplateResult[] = [];
    for (const t of types) {
      const base = styleFor(t);
      const ov = zoneOverride[t];
      const fill = ov && base.fill !== "none" ? ov : base.fill;
      const stroke = ov && base.fill === "none" ? ov : base.stroke;
      items.push(html`
        <span class="legend-item" title=${t}>
          <span
            class="swatch"
            style=${`background:${fill && fill !== "none" ? fill : stroke ?? "#888"}; border-color:${stroke ?? "#888"}; opacity:${base.fillOpacity ?? 1};`}
          ></span>
          ${base.label}
        </span>
      `);
    }
    if (hasPlanned) {
      items.push(html`
        <span class="legend-item" title="projected plan path">
          <span
            class="swatch"
            style="background:#9ca3af; border-color:#6b7280;"
          ></span>
          Planned
        </span>
      `);
    }
    if (hasTrail) {
      const hasHeading = this.trail!.some((p) => p.phase === "heading");
      if (hasHeading) {
        items.push(html`
          <span class="legend-item" title="transit to area">
            <span
              class="swatch"
              style=${`background:${c.trail_transit}; border-color:${c.trail_completed};`}
            ></span>
            Transit
          </span>
        `);
      }
    }
    if (hasCleaningTrail) {
      items.push(html`
        <span class="legend-item" title="completed work">
          <span
            class="swatch"
            style=${`background:${c.trail_completed}; border-color:${c.trail_completed};`}
          ></span>
          Completed
        </span>
      `);
    }
    const hasObstacles = !!(
      this.obstacles && this.obstacles.features && this.obstacles.features.length > 0
    );
    if (hasObstacles) {
      items.push(html`
        <span class="legend-item" title="detected obstacle">
          <span
            class="swatch"
            style=${`background:${c.obstacle}; border-color:${c.obstacle};`}
          ></span>
          Obstacle
        </span>
      `);
    }
    return html`
      <div class="legend ${this._legendOpen ? "open" : "closed"}">
        <button
          class="legend-toggle"
          @click=${() => (this._legendOpen = !this._legendOpen)}
          aria-label=${this._legendOpen ? "Hide legend" : "Show legend"}
          aria-expanded=${this._legendOpen}
          title=${this._legendOpen ? "Hide legend" : "Show legend"}
        >
          <ha-icon
            icon=${this._legendOpen
              ? "mdi:chevron-down"
              : "mdi:information-outline"}
          ></ha-icon>
          <span class="legend-toggle-label">Legend</span>
        </button>
        ${this._legendOpen
          ? html`<div class="legend-items">${items}</div>`
          : nothing}
      </div>
    `;
  }

  static styles = css`
    :host {
      display: block;
    }
    .map-wrap {
      position: relative;
      border-radius: 12px;
      overflow: hidden;
      background: var(--secondary-background-color);
      border: 1px solid var(--divider-color);
    }
    .map-wrap.fullscreen {
      position: fixed;
      inset: 0;
      height: 100vh !important;
      width: 100vw;
      z-index: 9999;
      border-radius: 0;
      border: none;
    }
    .map-wrap.fullscreen svg {
      /* Ensure the SVG element itself is the same size as the wrap so
         letterbox bands outside the viewBox content are painted by the
         map-background color instead of the theme grey. */
      width: 100%;
      height: 100%;
    }
    svg {
      width: 100%;
      height: 100%;
      display: block;
      cursor: grab;
      touch-action: none;
      user-select: none;
    }
    .map-wrap.dragging svg {
      cursor: grabbing;
    }
    .zoom-controls {
      position: absolute;
      right: 8px;
      top: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      z-index: 1;
    }
    .zoom-pill {
      display: flex;
      flex-direction: column;
      background: color-mix(
        in srgb,
        var(--card-background-color, var(--primary-background-color)) 85%,
        transparent
      );
      backdrop-filter: blur(4px);
      border: 1px solid var(--divider-color);
      border-radius: 999px;
      overflow: hidden;
    }
    .zoom-more {
      display: flex;
      flex-direction: column;
      background: color-mix(
        in srgb,
        var(--card-background-color, var(--primary-background-color)) 85%,
        transparent
      );
      backdrop-filter: blur(4px);
      border: 1px solid var(--divider-color);
      border-radius: 999px;
      position: relative;
    }
    .zoom-pill .zoom-btn + .zoom-btn {
      border-top: 1px solid var(--divider-color);
    }
    .zoom-btn {
      width: 30px;
      height: 30px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: none;
      border-radius: 0;
      background: transparent;
      color: var(--primary-text-color);
      cursor: pointer;
      padding: 0;
    }
    .zoom-btn:hover:not([disabled]) {
      background: var(--secondary-background-color);
    }
    .zoom-btn[disabled] {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .zoom-btn.active {
      background: #03a9f4;
      color: #ffffff;
    }
    .zoom-btn.active:hover:not([disabled]) {
      background: #0288d1;
    }
    .zoom-btn:focus-visible {
      outline: 2px solid var(--yc-accent, #03a9f4);
      outline-offset: -2px;
    }
    .zoom-menu {
      position: absolute;
      top: 0;
      right: calc(100% + 6px);
      display: flex;
      flex-direction: column;
      min-width: 160px;
      background: var(--card-background-color, var(--primary-background-color));
      border: 1px solid var(--divider-color);
      border-radius: 8px;
      padding: 4px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      z-index: 2;
    }
    .zoom-menu-item {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      font: inherit;
      font-size: 0.85rem;
      color: var(--primary-text-color);
      background: transparent;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      text-align: left;
      white-space: nowrap;
    }
    .zoom-menu-item:hover:not([disabled]) {
      background: var(--secondary-background-color);
    }
    .zoom-menu-item[disabled] {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .zoom-menu-item.active {
      color: #03a9f4;
    }
    .zoom-menu-item ha-icon {
      --mdc-icon-size: 16px;
    }
    .zoom-btn ha-icon {
      --mdc-icon-size: 18px;
    }
    .empty {
      padding: 24px;
      text-align: center;
      color: var(--secondary-text-color);
      font-size: 0.9rem;
      border: 1px dashed var(--divider-color);
      border-radius: 12px;
    }
    .legend {
      position: absolute;
      left: 8px;
      bottom: 8px;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 6px;
      max-width: calc(100% - 16px);
    }
    .legend-toggle {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 10px;
      font-size: 0.72rem;
      color: var(--primary-text-color);
      background: color-mix(
        in srgb,
        var(--card-background-color, var(--primary-background-color)) 85%,
        transparent
      );
      backdrop-filter: blur(4px);
      border: 1px solid var(--divider-color);
      border-radius: 999px;
      cursor: pointer;
      font-family: inherit;
    }
    .legend-toggle ha-icon {
      --mdc-icon-size: 14px;
    }
    .legend-toggle:hover {
      background: var(--secondary-background-color);
    }
    .legend-items {
      background: color-mix(
        in srgb,
        var(--card-background-color, var(--primary-background-color)) 85%,
        transparent
      );
      backdrop-filter: blur(4px);
      padding: 6px 10px;
      border-radius: 8px;
      display: flex;
      flex-wrap: wrap;
      gap: 4px 12px;
      font-size: 0.72rem;
      color: var(--primary-text-color);
      border: 1px solid var(--divider-color);
    }
    .legend-item {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .swatch {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 2px;
      border: 1px solid transparent;
    }
  `;
}

function collectCoords(f: GeoJsonFeature, out: Array<[number, number]>): void {
  const g = f.geometry;
  if (!g) return;
  if (g.type === "Point") {
    const [lon, lat] = g.coordinates as number[];
    if (Number.isFinite(lon) && Number.isFinite(lat)) out.push([lon, lat]);
  } else if (g.type === "MultiPoint") {
    for (const [lon, lat] of g.coordinates as number[][]) {
      if (Number.isFinite(lon) && Number.isFinite(lat)) out.push([lon, lat]);
    }
  } else if (g.type === "LineString") {
    for (const [lon, lat] of g.coordinates as number[][]) {
      if (Number.isFinite(lon) && Number.isFinite(lat)) out.push([lon, lat]);
    }
  } else if (g.type === "Polygon") {
    for (const ring of g.coordinates as number[][][]) {
      for (const [lon, lat] of ring) {
        if (Number.isFinite(lon) && Number.isFinite(lat)) out.push([lon, lat]);
      }
    }
  }
}

if (!customElements.get("yarbo-map")) {
  customElements.define("yarbo-map", YarboMap);
}

declare global {
  interface HTMLElementTagNameMap {
    "yarbo-map": YarboMap;
  }
}
