import { LitElement, html, css, type TemplateResult, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import {
  COLOR_LABELS,
  DEFAULT_COLORS,
  type HomeAssistant,
  type YarboCardConfig,
  type YarboColors,
} from "./types";

class YarboCardEditor extends LitElement {
  @property({ attribute: false }) public hass?: HomeAssistant;
  @state() private _config?: YarboCardConfig;

  public setConfig(config: YarboCardConfig): void {
    this._config = config;
  }

  private _fire(newConfig: YarboCardConfig): void {
    this._config = newConfig;
    const ev = new CustomEvent("config-changed", {
      detail: { config: newConfig },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(ev);
  }

  private _updateField<K extends keyof YarboCardConfig>(
    key: K,
    value: YarboCardConfig[K] | undefined,
  ): void {
    if (!this._config) return;
    const next: YarboCardConfig = { ...this._config };
    if (value === undefined || value === "" || value === null) {
      delete (next as Record<string, unknown>)[key as string];
    } else {
      (next as Record<string, unknown>)[key as string] = value;
    }
    this._fire(next);
  }

  private _updateColor(key: keyof YarboColors, value: string): void {
    if (!this._config) return;
    const current = this._config.colors ?? {};
    const nextColors: YarboColors = { ...current };
    const def = DEFAULT_COLORS[key];
    if (!value || value.toLowerCase() === def.toLowerCase()) {
      delete nextColors[key];
    } else {
      nextColors[key] = value;
    }
    const next: YarboCardConfig = { ...this._config };
    if (Object.keys(nextColors).length === 0) {
      delete next.colors;
    } else {
      next.colors = nextColors;
    }
    this._fire(next);
  }

  private _resetColors(): void {
    if (!this._config) return;
    const next = { ...this._config };
    delete next.colors;
    this._fire(next);
  }

  protected render(): TemplateResult | typeof nothing {
    if (!this._config) return nothing;
    const c = this._config;
    const colors = c.colors ?? {};

    const colorRow = (key: keyof YarboColors) => {
      const val = colors[key] ?? DEFAULT_COLORS[key];
      const overridden = colors[key] !== undefined;
      return html`
        <div class="color-row">
          <label>${COLOR_LABELS[key]}</label>
          <input
            type="color"
            .value=${val}
            @change=${(e: Event) =>
              this._updateColor(key, (e.target as HTMLInputElement).value)}
          />
          <code>${val}</code>
          ${overridden
            ? html`<button
                class="reset"
                @click=${() => this._updateColor(key, "")}
                title="Reset to default"
              >
                reset
              </button>`
            : nothing}
        </div>
      `;
    };

    return html`
      <div class="editor">
        <div class="section">
          <h3>Device</h3>
          <div class="text-row">
            <label>Entity prefix</label>
            <input
              type="text"
              .value=${c.prefix ?? ""}
              placeholder="senor_choppy"
              @change=${(e: Event) =>
                this._updateField(
                  "prefix",
                  (e.target as HTMLInputElement).value.trim() || undefined,
                )}
            />
          </div>
          <div class="text-row">
            <label>Display name override</label>
            <input
              type="text"
              .value=${c.name ?? ""}
              placeholder="(inferred)"
              @change=${(e: Event) =>
                this._updateField(
                  "name",
                  (e.target as HTMLInputElement).value.trim() || undefined,
                )}
            />
          </div>
        </div>

        <div class="section">
          <h3>Layout</h3>
          <div class="toggle-row">
            <label>
              <input
                type="checkbox"
                .checked=${c.show_map ?? true}
                @change=${(e: Event) =>
                  this._updateField(
                    "show_map",
                    (e.target as HTMLInputElement).checked,
                  )}
              />
              Show map
            </label>
          </div>
          <div class="toggle-row">
            <label>
              <input
                type="checkbox"
                .checked=${c.show_advanced ?? true}
                @change=${(e: Event) =>
                  this._updateField(
                    "show_advanced",
                    (e.target as HTMLInputElement).checked,
                  )}
              />
              Show advanced section
            </label>
          </div>
          <div class="toggle-row">
            <label>
              <input
                type="checkbox"
                .checked=${c.compact ?? false}
                @change=${(e: Event) =>
                  this._updateField(
                    "compact",
                    (e.target as HTMLInputElement).checked,
                  )}
              />
              Compact
            </label>
          </div>
          <div class="text-row">
            <label>Map height (px)</label>
            <input
              type="number"
              min="120"
              max="800"
              .value=${String(c.map_height ?? 240)}
              @change=${(e: Event) => {
                const n = parseInt((e.target as HTMLInputElement).value, 10);
                this._updateField(
                  "map_height",
                  Number.isFinite(n) && n > 0 ? n : undefined,
                );
              }}
            />
          </div>
          <div class="text-row">
            <label>Rain alert threshold</label>
            <input
              type="number"
              min="0"
              max="1000"
              step="10"
              .value=${String(c.rain_threshold ?? 500)}
              @change=${(e: Event) => {
                const n = parseInt((e.target as HTMLInputElement).value, 10);
                this._updateField(
                  "rain_threshold",
                  Number.isFinite(n) && n >= 0 ? n : undefined,
                );
              }}
            />
          </div>
        </div>

        <div class="section">
          <div class="section-header">
            <h3>Colors</h3>
            ${c.colors
              ? html`<button
                  class="reset"
                  @click=${() => this._resetColors()}
                  title="Reset all colors to defaults"
                >
                  reset all
                </button>`
              : nothing}
          </div>
          <h4>Trails</h4>
          ${colorRow("trail_completed")}
          ${colorRow("trail_transit")}
          ${colorRow("trail_planned")}
          <h4>Markers</h4>
          ${colorRow("robot")}
          ${colorRow("obstacle")}
          <h4>Zones</h4>
          ${colorRow("zone_work")}
          ${colorRow("zone_nogo")}
          ${colorRow("zone_novision")}
          ${colorRow("zone_geofence")}
          ${colorRow("zone_pathway")}
          <h4>Background</h4>
          ${colorRow("map_background")}
        </div>
      </div>
    `;
  }

  static styles = css`
    :host {
      display: block;
      color: var(--primary-text-color);
      font-family: var(--paper-font-body1_-_font-family, inherit);
    }
    .editor {
      display: flex;
      flex-direction: column;
      gap: 20px;
      padding: 8px 0;
    }
    .section {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .section-header {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    h3 {
      margin: 0;
      font-size: 1rem;
      color: var(--primary-text-color);
    }
    h4 {
      margin: 8px 0 2px 0;
      font-size: 0.85rem;
      color: var(--secondary-text-color);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .color-row,
    .text-row,
    .toggle-row {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .color-row label,
    .text-row label {
      flex: 0 0 180px;
      font-size: 0.9rem;
    }
    .color-row input[type="color"] {
      width: 42px;
      height: 30px;
      padding: 0;
      border: 1px solid var(--divider-color);
      border-radius: 6px;
      background: transparent;
      cursor: pointer;
    }
    .color-row code {
      font-family: var(--code-font-family, monospace);
      font-size: 0.8rem;
      color: var(--secondary-text-color);
      min-width: 70px;
    }
    .text-row input[type="text"],
    .text-row input[type="number"] {
      flex: 1;
      padding: 6px 8px;
      background: var(--secondary-background-color);
      color: var(--primary-text-color);
      border: 1px solid var(--divider-color);
      border-radius: 6px;
      font: inherit;
    }
    .toggle-row label {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
    }
    button.reset {
      background: transparent;
      border: 1px solid var(--divider-color);
      border-radius: 4px;
      color: var(--secondary-text-color);
      padding: 2px 8px;
      font-size: 0.75rem;
      cursor: pointer;
    }
    button.reset:hover {
      color: var(--primary-text-color);
      background: var(--secondary-background-color);
    }
  `;
}

if (!customElements.get("yarbo-card-editor")) {
  customElements.define("yarbo-card-editor", YarboCardEditor);
}
