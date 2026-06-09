/**
 * Per-area triangulated terrain mesh view.
 *
 * - 2D mode: SVG triangulated overhead with hypsometric tint.
 * - 3D mode: WebGL canvas with orbit (drag) + zoom (wheel) controls.
 *
 * Self-contained: no Three.js or any 3D framework. Just raw WebGL +
 * inline 4x4 matrix helpers + Delaunator (~5 KB) for triangulation.
 */

import { LitElement, html, css, svg, nothing, type TemplateResult } from "lit";
import { property, state, query } from "lit/decorators.js";
import Delaunator from "delaunator";

const M_PER_DEG_LAT = 111_320;

export type AltitudeSample = [number, number, number, number];

export interface MeshData {
  gps_ref: { latitude: number | null; longitude: number | null };
  areas: Record<string, AltitudeSample[]>;
}

export type MeshMode = "2d" | "3d";
export type MeshStyle = "fill" | "wire";

interface Triangle {
  p0: [number, number, number];
  p1: [number, number, number];
  p2: [number, number, number];
  zAvg: number;
}

class YarboMeshView extends LitElement {
  @property({ attribute: false }) public data?: MeshData;
  @property() public mode: MeshMode = "3d";
  @property({ attribute: "render-style" }) public renderStyle: MeshStyle = "fill";
  /** Vertical exaggeration applied in 3D. 1 = true scale. */
  @property({ type: Number, attribute: "z-exaggeration" })
    public zExaggeration = 4;
  /** Optional set of area_ids to render. null/undefined = all areas. */
  @property({ attribute: false })
    public selectedAreas: Set<string> | null = null;
  /** Max triangle edge length in meters. Triangles with a longer edge
   * are dropped — Delaunay's convex hull would otherwise bridge
   * disjoint clusters (different yard zones tagged under one
   * cleanAreaId) with long thin "blob" triangles.
   */
  @property({ type: Number, attribute: "max-edge-m" })
    public maxEdgeM = 3;

  @query("canvas") private _canvas?: HTMLCanvasElement;

  // Orbit camera state (3D).
  @state() private _yaw = Math.PI / 4;
  @state() private _pitch = Math.PI / 5;
  @state() private _distance = 1;  // set on first frame from bounds
  // Pan offset in world XY meters. Applied to the model before
  // rotation, so dragging shifts the apparent view in screen space.
  @state() private _panX = 0;
  @state() private _panY = 0;
  private _autoFit = true;         // recompute distance until user wheels
  @state() private _isFullscreen = false;

  // Mesh memo so we don't retriangulate every frame.
  private _meshKey = "";
  private _triangles: Triangle[] = [];
  private _zMin = 0;
  private _zMax = 0;
  private _bounds = {
    cx: 0, cy: 0, cz: 0, dx: 1, dy: 1, dz: 1,
  };

  // WebGL plumbing.
  private _gl: WebGLRenderingContext | null = null;
  private _program: WebGLProgram | null = null;
  private _aPos = -1;
  private _aColor = -1;
  private _uMvp: WebGLUniformLocation | null = null;
  private _vbuf: WebGLBuffer | null = null;
  private _cbuf: WebGLBuffer | null = null;
  private _vertexCount = 0;
  // Parallel buffers for the wireframe draw path.
  private _ebuf: WebGLBuffer | null = null;
  private _ecbuf: WebGLBuffer | null = null;
  private _edgeVertexCount = 0;
  private _meshBufferKey = "";

  // Pointer handling.
  private _dragMode: "none" | "rotate" | "pan" = "none";
  private _lastX = 0;
  private _lastY = 0;
  // For two-finger touch (pinch zoom + drag pan).
  private _pointers = new Map<number, { x: number; y: number }>();
  private _pinchDist = 0;
  private _pinchMidX = 0;
  private _pinchMidY = 0;
  private _ro: ResizeObserver | null = null;

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      position: relative;
      background: var(--card-background-color, #111);
      border-radius: 8px;
      overflow: hidden;
    }
    :host(:fullscreen) {
      border-radius: 0;
    }
    svg, canvas {
      width: 100%;
      height: 100%;
      display: block;
    }
    canvas {
      touch-action: none;
      cursor: grab;
    }
    canvas.rotating { cursor: grabbing; }
    canvas.panning { cursor: move; }
    .legend {
      position: absolute;
      bottom: 8px;
      right: 12px;
      background: rgba(0, 0, 0, 0.55);
      color: #fff;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-family: monospace;
      pointer-events: none;
    }
    .overlay-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      background: rgba(0, 0, 0, 0.55);
      color: #fff;
      border: none;
      border-radius: 4px;
      width: 32px;
      height: 32px;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .overlay-btn:hover {
      background: rgba(0, 0, 0, 0.75);
    }
    .empty {
      padding: 24px;
      text-align: center;
      color: var(--secondary-text-color);
    }
    .hint {
      position: absolute;
      bottom: 8px;
      left: 12px;
      color: rgba(255, 255, 255, 0.6);
      font-size: 10px;
      font-family: monospace;
      pointer-events: none;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
    this._ro = new ResizeObserver(() => this._renderGl());
    this._ro.observe(this);
    document.addEventListener("fullscreenchange", this._onFullscreenChange);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this._ro?.disconnect();
    this._ro = null;
    document.removeEventListener("fullscreenchange", this._onFullscreenChange);
  }

  private _onFullscreenChange = (): void => {
    this._isFullscreen = document.fullscreenElement === this;
  };

  private _toggleFullscreen = async (): Promise<void> => {
    if (document.fullscreenElement === this) {
      await document.exitFullscreen();
    } else {
      try {
        await this.requestFullscreen();
      } catch (e) {
        console.warn("yarbo-mesh: fullscreen denied", e);
      }
    }
  };

  protected updated(): void {
    this._ensureMesh();
    if (this.mode === "3d") {
      this._renderGl();
    }
  }

  protected render(): TemplateResult | typeof nothing {
    if (!this.data) {
      return html`<div class="empty">No mesh data loaded.</div>`;
    }
    const refLat = this.data.gps_ref?.latitude;
    const refLon = this.data.gps_ref?.longitude;
    if (refLat == null || refLon == null) {
      return html`<div class="empty">GPS reference missing — can't project.</div>`;
    }
    this._ensureMesh();
    if (this._triangles.length === 0) {
      return html`<div class="empty">
        Not enough samples to triangulate (need ≥ 3 per selected area).
        Run a plan to collect terrain data.
      </div>`;
    }

    if (this.mode === "3d") {
      const cls =
        this._dragMode === "rotate" ? "rotating"
        : this._dragMode === "pan" ? "panning"
        : "";
      return html`
        <canvas
          class=${cls}
          @pointerdown=${this._onPointerDown}
          @pointermove=${this._onPointerMove}
          @pointerup=${this._onPointerUp}
          @pointercancel=${this._onPointerUp}
          @wheel=${this._onWheel}
          @contextmenu=${(e: Event) => e.preventDefault()}
        ></canvas>
        ${this._renderFullscreenBtn()}
        ${this._renderLegend()}
        <div class="hint">drag • shift+drag/right-drag pan • wheel zoom</div>
      `;
    }
    return html`${this._render2d()}${this._renderFullscreenBtn()}${this._renderLegend()}`;
  }

  private _renderFullscreenBtn(): TemplateResult {
    return html`
      <button
        class="overlay-btn"
        title=${this._isFullscreen ? "Exit fullscreen" : "Fullscreen"}
        @click=${this._toggleFullscreen}
      >${this._isFullscreen ? "⤓" : "⛶"}</button>
    `;
  }

  private _renderLegend(): TemplateResult {
    return html`<div class="legend">
      ${this.mode.toUpperCase()}
      · ${this._zMin.toFixed(2)}–${this._zMax.toFixed(2)} m
      · ${this._triangles.length} tri
    </div>`;
  }

  // ---- Mesh build (shared between 2D and 3D) ----

  private _meshSignature(): string {
    if (!this.data) return "";
    const sel = this.selectedAreas
      ? [...this.selectedAreas].sort().join("|")
      : "*";
    const counts = Object.entries(this.data.areas)
      .map(([a, pts]) => `${a}:${pts.length}`)
      .join(",");
    return `${this.data.gps_ref.latitude},${this.data.gps_ref.longitude}|${sel}|${counts}|e=${this.maxEdgeM}`;
  }

  private _ensureMesh(): void {
    const sig = this._meshSignature();
    if (sig === this._meshKey) return;
    this._meshKey = sig;
    this._triangles = [];
    this._zMin = Infinity;
    this._zMax = -Infinity;
    if (!this.data) return;
    const refLat = this.data.gps_ref.latitude;
    const refLon = this.data.gps_ref.longitude;
    if (refLat == null || refLon == null) return;
    const cosLat = Math.cos((refLat * Math.PI) / 180);
    let xMin = Infinity, xMax = -Infinity;
    let yMin = Infinity, yMax = -Infinity;
    for (const [areaId, samples] of Object.entries(this.data.areas)) {
      if (this.selectedAreas && !this.selectedAreas.has(areaId)) continue;
      if (samples.length < 3) continue;
      const projected: Array<[number, number, number]> = samples.map((s) => {
        const x = (s[1] - refLon) * M_PER_DEG_LAT * cosLat;
        const y = (s[0] - refLat) * M_PER_DEG_LAT;
        return [x, y, s[2]];
      });
      const flat = new Float64Array(projected.length * 2);
      for (let i = 0; i < projected.length; i++) {
        flat[i * 2] = projected[i][0];
        flat[i * 2 + 1] = projected[i][1];
      }
      const d = new Delaunator(flat);
      const tris = d.triangles;
      const maxEdgeSq = this.maxEdgeM > 0
        ? this.maxEdgeM * this.maxEdgeM
        : Infinity;
      for (let i = 0; i < tris.length; i += 3) {
        const p0 = projected[tris[i]];
        const p1 = projected[tris[i + 1]];
        const p2 = projected[tris[i + 2]];
        // Drop triangles bridging disjoint clusters: any single edge
        // longer than maxEdgeM. Uses planar distance — the gaps we're
        // filtering are horizontal, so z-component bias would just
        // make this less effective on sloped terrain.
        const e01 = (p0[0] - p1[0]) ** 2 + (p0[1] - p1[1]) ** 2;
        const e12 = (p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2;
        const e20 = (p2[0] - p0[0]) ** 2 + (p2[1] - p0[1]) ** 2;
        if (e01 > maxEdgeSq || e12 > maxEdgeSq || e20 > maxEdgeSq) {
          continue;
        }
        const zAvg = (p0[2] + p1[2] + p2[2]) / 3;
        if (zAvg < this._zMin) this._zMin = zAvg;
        if (zAvg > this._zMax) this._zMax = zAvg;
        for (const [x, y] of [p0, p1, p2]) {
          if (x < xMin) xMin = x;
          if (x > xMax) xMax = x;
          if (y < yMin) yMin = y;
          if (y > yMax) yMax = y;
        }
        this._triangles.push({ p0, p1, p2, zAvg });
      }
    }
    if (this._triangles.length === 0) return;
    this._bounds = {
      cx: (xMin + xMax) / 2,
      cy: (yMin + yMax) / 2,
      cz: (this._zMin + this._zMax) / 2,
      dx: xMax - xMin,
      dy: yMax - yMin,
      dz: this._zMax - this._zMin,
    };
    if (this._autoFit) {
      const diag = Math.sqrt(
        this._bounds.dx ** 2 + this._bounds.dy ** 2,
      );
      this._distance = Math.max(2, diag * 1.4);
    }
  }

  // ---- 2D (SVG) ----

  private _render2d(): TemplateResult {
    const w = this.clientWidth || 600;
    const h = this.clientHeight || 360;
    const b = this._bounds;
    const pad = 12;
    const sx = (w - 2 * pad) / Math.max(1e-6, b.dx);
    const sy = (h - 2 * pad) / Math.max(1e-6, b.dy);
    const s = Math.min(sx, sy);
    const xMin = b.cx - b.dx / 2;
    const yMin = b.cy - b.dy / 2;
    const fit = (x: number, y: number): [number, number] => [
      pad + (x - xMin) * s,
      h - pad - (y - yMin) * s,
    ];
    const wire = this.renderStyle === "wire";
    const polys = this._triangles.map((t) => {
      const a = fit(t.p0[0], t.p0[1]);
      const b1 = fit(t.p1[0], t.p1[1]);
      const c = fit(t.p2[0], t.p2[1]);
      const color = elevationColor(t.zAvg, this._zMin, this._zMax);
      const d = `${a[0]},${a[1]} ${b1[0]},${b1[1]} ${c[0]},${c[1]}`;
      return svg`<polygon
        points=${d}
        fill=${wire ? "none" : color}
        stroke=${color}
        stroke-width=${wire ? 1 : 0.5}
      />`;
    });
    return html`
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
        ${polys}
      </svg>
    `;
  }

  // ---- 3D (WebGL) ----

  private _initGl(): boolean {
    if (this._gl && this._program) return true;
    const canvas = this._canvas;
    if (!canvas) return false;
    const gl = canvas.getContext("webgl", { antialias: true, alpha: true });
    if (!gl) return false;
    this._gl = gl;
    const vs = compileShader(gl, gl.VERTEX_SHADER, `
      attribute vec3 a_pos;
      attribute vec3 a_color;
      uniform mat4 u_mvp;
      varying vec3 v_color;
      void main() {
        gl_Position = u_mvp * vec4(a_pos, 1.0);
        v_color = a_color;
      }
    `);
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, `
      precision mediump float;
      varying vec3 v_color;
      void main() { gl_FragColor = vec4(v_color, 1.0); }
    `);
    if (!vs || !fs) return false;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn("yarbo-mesh: link failed", gl.getProgramInfoLog(prog));
      return false;
    }
    this._program = prog;
    this._aPos = gl.getAttribLocation(prog, "a_pos");
    this._aColor = gl.getAttribLocation(prog, "a_color");
    this._uMvp = gl.getUniformLocation(prog, "u_mvp");
    this._vbuf = gl.createBuffer();
    this._cbuf = gl.createBuffer();
    this._ebuf = gl.createBuffer();
    this._ecbuf = gl.createBuffer();
    gl.enable(gl.DEPTH_TEST);
    return true;
  }

  private _uploadBuffers(): void {
    const gl = this._gl;
    if (!gl || !this._vbuf || !this._cbuf || !this._ebuf || !this._ecbuf) {
      return;
    }
    // Rebuild buffers when the mesh changes.
    if (this._meshBufferKey === this._meshKey) return;
    this._meshBufferKey = this._meshKey;
    const n = this._triangles.length * 9;  // 3 verts * 3 coords
    const positions = new Float32Array(n);
    const colors = new Float32Array(n);
    const cx = this._bounds.cx;
    const cy = this._bounds.cy;
    const cz = this._bounds.cz;
    let pi = 0;
    let ci = 0;
    // Edge dedup: keep one line per unique vertex pair. Hash by the
    // ordered pair of vertex coords. Storing string keys is fine —
    // small dataset, simpler than building shared-index tables.
    const edgeSet = new Set<string>();
    const edgePos: number[] = [];
    const edgeCol: number[] = [];
    const pushEdge = (
      a: [number, number, number], b: [number, number, number],
    ): void => {
      const k = ax2k(a, b);
      if (edgeSet.has(k)) return;
      edgeSet.add(k);
      const rgbA = elevationColorRgb(a[2], this._zMin, this._zMax);
      const rgbB = elevationColorRgb(b[2], this._zMin, this._zMax);
      edgePos.push(
        a[0] - cx, a[1] - cy, (a[2] - cz) * this.zExaggeration,
        b[0] - cx, b[1] - cy, (b[2] - cz) * this.zExaggeration,
      );
      edgeCol.push(...rgbA, ...rgbB);
    };
    for (const t of this._triangles) {
      for (const p of [t.p0, t.p1, t.p2]) {
        positions[pi++] = p[0] - cx;
        positions[pi++] = p[1] - cy;
        positions[pi++] = (p[2] - cz) * this.zExaggeration;
        const rgb = elevationColorRgb(p[2], this._zMin, this._zMax);
        colors[ci++] = rgb[0];
        colors[ci++] = rgb[1];
        colors[ci++] = rgb[2];
      }
      pushEdge(t.p0, t.p1);
      pushEdge(t.p1, t.p2);
      pushEdge(t.p2, t.p0);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this._vbuf);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._cbuf);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.STATIC_DRAW);
    this._vertexCount = this._triangles.length * 3;
    gl.bindBuffer(gl.ARRAY_BUFFER, this._ebuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(edgePos), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this._ecbuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(edgeCol), gl.STATIC_DRAW);
    this._edgeVertexCount = edgePos.length / 3;
  }

  private _renderGl(): void {
    if (this.mode !== "3d") return;
    if (!this._initGl()) return;
    const canvas = this._canvas!;
    const gl = this._gl!;
    // Match drawing buffer to the on-screen size (DPR-aware).
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.07, 0.07, 0.09, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this._uploadBuffers();
    if (this._vertexCount === 0) return;

    gl.useProgram(this._program);
    const wire = this.renderStyle === "wire";
    const posBuf = wire ? this._ebuf : this._vbuf;
    const colBuf = wire ? this._ecbuf : this._cbuf;
    const count = wire ? this._edgeVertexCount : this._vertexCount;
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.enableVertexAttribArray(this._aPos);
    gl.vertexAttribPointer(this._aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
    gl.enableVertexAttribArray(this._aColor);
    gl.vertexAttribPointer(this._aColor, 3, gl.FLOAT, false, 0, 0);

    const aspect = w / h;
    const fov = Math.PI / 4;
    const proj = mat4Perspective(fov, aspect, 0.1, 10000);
    // Orbit camera: yaw around Z, pitch around X. Z-up world.
    // Order (applied right-to-left to model points):
    //   1. T(-pan)    : shift model so the pan target is at origin
    //   2. RZ(yaw)    : rotate world about Z
    //   3. RX(-pitch) : tilt camera
    //   4. T(0,0,-d)  : back camera away
    const view = mat4Identity();
    mat4TranslateInPlace(view, 0, 0, -this._distance);
    mat4MulInPlace(view, mat4RotateX(-this._pitch));
    mat4MulInPlace(view, mat4RotateZ(this._yaw));
    mat4TranslateInPlace(view, -this._panX, -this._panY, 0);
    const mvp = mat4Multiply(proj, view);
    gl.uniformMatrix4fv(this._uMvp, false, mvp);

    gl.drawArrays(wire ? gl.LINES : gl.TRIANGLES, 0, count);
  }

  // ---- Pointer / wheel handlers --------------------------------------

  private _onPointerDown = (e: PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Two-finger touch initialises pinch (zoom + pan together).
    if (this._pointers.size === 2) {
      this._dragMode = "pan";  // displayed cursor hint
      const [p1, p2] = [...this._pointers.values()];
      this._pinchDist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      this._pinchMidX = (p1.x + p2.x) / 2;
      this._pinchMidY = (p1.y + p2.y) / 2;
      this.requestUpdate();
      return;
    }

    // Single-pointer drag: shift / right-button / middle = pan,
    // anything else = rotate. (Touch is always rotate single-finger;
    // touch pan happens via the two-finger path above.)
    const isPan = e.shiftKey || e.button === 1 || e.button === 2;
    this._dragMode = isPan ? "pan" : "rotate";
    this._lastX = e.clientX;
    this._lastY = e.clientY;
    this.requestUpdate();
  };

  private _onPointerMove = (e: PointerEvent) => {
    const tracked = this._pointers.get(e.pointerId);
    if (!tracked) return;
    tracked.x = e.clientX;
    tracked.y = e.clientY;

    // Two-finger pinch: zoom by distance ratio + pan by midpoint shift.
    if (this._pointers.size === 2) {
      const [p1, p2] = [...this._pointers.values()];
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      const mx = (p1.x + p2.x) / 2;
      const my = (p1.y + p2.y) / 2;
      if (this._pinchDist > 0) {
        const scale = this._pinchDist / Math.max(1, dist);
        this._distance = clamp(this._distance * scale, 2, 2000);
        this._autoFit = false;
      }
      this._applyPan(mx - this._pinchMidX, my - this._pinchMidY);
      this._pinchDist = dist;
      this._pinchMidX = mx;
      this._pinchMidY = my;
      this._renderGl();
      return;
    }

    if (this._dragMode === "none") return;
    const dx = e.clientX - this._lastX;
    const dy = e.clientY - this._lastY;
    this._lastX = e.clientX;
    this._lastY = e.clientY;
    if (this._dragMode === "rotate") {
      this._yaw -= dx * 0.008;
      this._pitch -= dy * 0.008;
      const limit = Math.PI / 2 - 0.05;
      if (this._pitch > limit) this._pitch = limit;
      if (this._pitch < -limit) this._pitch = -limit;
    } else {
      this._applyPan(dx, dy);
    }
    this._renderGl();
  };

  private _onPointerUp = (e: PointerEvent) => {
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    this._pointers.delete(e.pointerId);
    if (this._pointers.size === 0) {
      this._dragMode = "none";
      this._pinchDist = 0;
    } else if (this._pointers.size === 1) {
      // Lifted one of two fingers — transition out of pinch but stay
      // engaged on the remaining one as a rotate.
      const remaining = [...this._pointers.values()][0];
      this._lastX = remaining.x;
      this._lastY = remaining.y;
      this._dragMode = "rotate";
      this._pinchDist = 0;
    }
    this.requestUpdate();
  };

  private _onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const scale = Math.exp(e.deltaY * 0.001);
    this._distance = clamp(this._distance * scale, 2, 2000);
    this._autoFit = false;
    this._renderGl();
  };

  /** Translate the target point in screen-aligned XY (world coords).
   * dx, dy are screen-pixel deltas. */
  private _applyPan(dx: number, dy: number): void {
    if (!this._canvas) return;
    const h = this._canvas.clientHeight || 1;
    // World units per screen pixel at the current distance.
    const fov = Math.PI / 4;
    const worldPerPx = (this._distance * Math.tan(fov / 2) * 2) / h;
    // Camera-local right (after yaw) and up (yaw + pitch). Pitch ≠ 0
    // tilts "up" out of the world XY plane; flatten to XY so panning
    // stays on the ground rather than sliding into the sky.
    const cosY = Math.cos(this._yaw);
    const sinY = Math.sin(this._yaw);
    // right = (cos yaw, -sin yaw)
    // up    = (sin yaw,  cos yaw)  (XY-flattened)
    const rx = cosY, ry = -sinY;
    const ux = sinY, uy = cosY;
    this._panX += -dx * worldPerPx * rx + dy * worldPerPx * ux;
    this._panY += -dx * worldPerPx * ry + dy * worldPerPx * uy;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

customElements.define("yarbo-mesh-view", YarboMeshView);

// ---- Edge dedup key ----------------------------------------------------

/** Stable string key for an unordered (a,b) vertex pair. Coords are
 * rounded to mm so floating-point sample equality works. */
function ax2k(
  a: [number, number, number], b: [number, number, number],
): string {
  const k = (p: [number, number, number]) =>
    `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)},${Math.round(p[2] * 1000)}`;
  const ka = k(a);
  const kb = k(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}

// ---- Matrix helpers ----------------------------------------------------

function mat4Identity(): Float32Array {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function mat4Perspective(
  fovy: number, aspect: number, near: number, far: number,
): Float32Array {
  const f = 1.0 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) * nf;
  m[11] = -1;
  m[14] = 2 * far * near * nf;
  return m;
}

function mat4RotateX(a: number): Float32Array {
  const c = Math.cos(a), s = Math.sin(a);
  const m = mat4Identity();
  m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
  return m;
}

function mat4RotateZ(a: number): Float32Array {
  const c = Math.cos(a), s = Math.sin(a);
  const m = mat4Identity();
  m[0] = c; m[1] = s; m[4] = -s; m[5] = c;
  return m;
}

function mat4Multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[k * 4 + j] * b[i * 4 + k];
      }
      out[i * 4 + j] = sum;
    }
  }
  return out;
}

function mat4MulInPlace(a: Float32Array, b: Float32Array): void {
  const result = mat4Multiply(a, b);
  for (let i = 0; i < 16; i++) a[i] = result[i];
}

function mat4TranslateInPlace(
  m: Float32Array, x: number, y: number, z: number,
): void {
  m[12] += m[0] * x + m[4] * y + m[8] * z;
  m[13] += m[1] * x + m[5] * y + m[9] * z;
  m[14] += m[2] * x + m[6] * y + m[10] * z;
  m[15] += m[3] * x + m[7] * y + m[11] * z;
}

// ---- Shader helpers ----------------------------------------------------

function compileShader(
  gl: WebGLRenderingContext, type: number, src: string,
): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.warn("yarbo-mesh: shader compile failed", gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

// ---- Colors -----------------------------------------------------------

function elevationColor(z: number, zMin: number, zMax: number): string {
  const [r, g, b] = elevationColorRgb(z, zMin, zMax);
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}

function elevationColorRgb(
  z: number, zMin: number, zMax: number,
): [number, number, number] {
  const t = (z - zMin) / Math.max(0.001, zMax - zMin);
  if (t < 0.5) {
    const k = t * 2;
    return [(60 + 200 * k) / 255, 180 / 255, (70 + 20 * (1 - k)) / 255];
  }
  const k = (t - 0.5) * 2;
  return [250 / 255, (180 - 110 * k) / 255, (70 - 20 * k) / 255];
}
