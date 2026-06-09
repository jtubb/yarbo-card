// Lit fragment for the Scheduler section.
//
// Discovery model: the YarboHA integration creates one
// `sensor.<prefix>_schedule_<plan>` per configured schedule, plus
// related buttons (`_run_now`, `_skip_next`) and switches (`_enabled`)
// off the same base entity_id. The card just enumerates those sensors
// and renders rows; all logic — hold reason, last_run, next_eligible —
// comes from the sensor's state and attributes.
//
// This file is intentionally dumb. It does no slugging, no helper-ID
// derivation, no priority evaluation. If you find yourself adding
// scheduling logic here, push it into the integration instead.

import { html, nothing, type TemplateResult } from "lit";
import type { HomeAssistant, YarboSchedulerConfig } from "./types";

export interface SchedulerSectionInput {
  hass: HomeAssistant;
  prefix: string;
  config: YarboSchedulerConfig;
}

interface ScheduleRow {
  /** Status sensor entity_id, e.g. `sensor.my_yarbo_schedule_front_yard`. */
  sensorId: string;
  /** Friendly plan name, from sensor attribute. */
  planName: string;
  /** Hold reason string from sensor state. */
  holdReason: string;
  /** Pre-formatted label from sensor attribute, falls back to reason. */
  holdLabel: string;
  /** Run-Now button entity_id (derived from sensor base). */
  runNowId: string;
  /** Skip-Next button entity_id (derived from sensor base). */
  skipNextId: string;
  /** Per-schedule enable switch entity_id (derived from sensor base). */
  enabledSwitchId: string;
  /** Skip-pending flag from sensor attribute. */
  skipPending: boolean;
  /** Schedule-enabled flag from sensor attribute. */
  scheduleEnabled: boolean;
  /** Optional ISO timestamps for display. */
  lastRunIso: string | null;
  nextEligibleIso: string | null;
  /** Sentinel for missing/unavailable. */
  missing: boolean;
}

export function renderSchedulerSection(
  input: SchedulerSectionInput,
): TemplateResult | typeof nothing {
  const { hass, prefix, config } = input;
  if (!config.enabled) return nothing;

  const globalSwitchId = `switch.${prefix}_scheduler_enabled`;
  const globalSwitchState = hass.states[globalSwitchId];
  const globalEnabled = globalSwitchState?.state === "on";
  const globalMissing = !globalSwitchState;

  const rows = collectRows(hass, prefix);
  const nowMs = Date.now();

  if (rows.length === 0) {
    return html`
      <details class="sched" open>
        <summary>
          <span>Scheduler</span>
          <span class="sched-count">no schedules</span>
        </summary>
        <div class="sched-empty">
          No schedules configured. Open <strong>Settings → Devices &
          Services → Yarbo → Configure → "Add a schedule"</strong> to
          create one.
        </div>
        ${globalMissing
          ? nothing
          : html`<div class="sched-pause-row">
              <span class="sched-pause-label">
                Scheduler ${globalEnabled ? "enabled" : "paused"}
              </span>
              <ha-switch
                .checked=${globalEnabled}
                @change=${() =>
                  toggleSwitch(hass, globalSwitchId, globalEnabled)}
              ></ha-switch>
            </div>`}
      </details>
    `;
  }

  return html`
    <details class="sched" open>
      <summary>
        <span>Scheduler</span>
        <span class="sched-count">
          ${globalEnabled
            ? `${rows.length} ${rows.length === 1 ? "schedule" : "schedules"}`
            : "paused"}
        </span>
      </summary>
      ${globalMissing
        ? nothing
        : html`<div class="sched-pause-row">
            <span class="sched-pause-label">Scheduler enabled</span>
            <ha-switch
              .checked=${globalEnabled}
              @change=${() => toggleSwitch(hass, globalSwitchId, globalEnabled)}
            ></ha-switch>
          </div>`}
      ${renderSummary(rows, nowMs, globalEnabled)}
      <div class="sched-list">
        ${rows.map((r) => renderRow(hass, r, nowMs))}
      </div>
    </details>
  `;
}

/** Top-of-section summary: which schedule fires soonest + when.
 *
 * Mirrors the integration-side ``YarboNextScheduledRunSensor`` logic
 * (soonest non-null next_eligible_at across this device's schedules).
 * Implemented client-side too so the card works even if the user hasn't
 * upgraded the integration yet. Skipped silently when nothing is in
 * cooldown (everything either eligible-now, held by external gate, or
 * no schedules) — under those conditions there's no honest timestamp
 * to display.
 */
function renderSummary(
  rows: ScheduleRow[],
  nowMs: number,
  globalEnabled: boolean,
): TemplateResult | typeof nothing {
  if (!globalEnabled) return nothing;
  const soonest = findSoonest(rows);
  // If nothing has a known timestamp, surface "eligible now" if any
  // row is currently eligible — that's at least informative.
  if (soonest === null) {
    const eligibleNow = rows.find((r) => r.holdReason === "eligible");
    if (eligibleNow) {
      return html`
        <div class="sched-summary">
          <span class="sched-summary-label">Next:</span>
          <strong>${eligibleNow.planName}</strong>
          <span class="sched-summary-time">eligible now</span>
        </div>
      `;
    }
    return nothing;
  }
  return html`
    <div class="sched-summary">
      <span class="sched-summary-label">Next:</span>
      <strong>${soonest.planName}</strong>
      <span class="sched-summary-time">
        in ${formatCountdown(soonest.iso, nowMs)}
      </span>
    </div>
  `;
}

function findSoonest(
  rows: ScheduleRow[],
): { planName: string; iso: string } | null {
  let best: { planName: string; iso: string; ms: number } | null = null;
  for (const r of rows) {
    if (!r.nextEligibleIso) continue;
    const ms = Date.parse(r.nextEligibleIso);
    if (!Number.isFinite(ms)) continue;
    if (best === null || ms < best.ms) {
      best = { planName: r.planName, iso: r.nextEligibleIso, ms };
    }
  }
  return best;
}

function renderRow(
  hass: HomeAssistant,
  r: ScheduleRow,
  nowMs: number,
): TemplateResult {
  const lastLabel =
    r.lastRunIso === null
      ? "never run"
      : `last ${formatRelativeTime(r.lastRunIso, nowMs)}`;
  const nextLabel =
    r.nextEligibleIso !== null
      ? `· next in ${formatCountdown(r.nextEligibleIso, nowMs)}`
      : "";
  return html`
    <div class="sched-row">
      <div class="sched-plan">
        <div class="sched-name">${r.planName || r.sensorId}</div>
        <div class="sched-sub">
          <span
            class="sched-badge sched-badge-${slugReason(r.holdReason)}"
            title=${r.holdReason}
          >${r.holdLabel}</span>
          <span class="sched-time">${lastLabel}</span>
          ${nextLabel ? html`<span class="sched-time">${nextLabel}</span>` : nothing}
          ${!r.scheduleEnabled
            ? html`<span class="sched-warn" title="This schedule is disabled.">disabled</span>`
            : nothing}
        </div>
      </div>
      <button
        class="sched-mini"
        title="Run this plan now"
        @click=${() => pressButton(hass, r.runNowId)}
        ?disabled=${r.missing || !hass.states[r.runNowId]}
      >
        <ha-icon icon="mdi:play"></ha-icon>
      </button>
      <button
        class="sched-mini ${r.skipPending ? "sched-mini-active" : ""}"
        title=${r.skipPending ? "Cancel skip" : "Skip the next scheduled run"}
        @click=${() => pressButton(hass, r.skipNextId)}
        ?disabled=${r.missing || !hass.states[r.skipNextId]}
      >
        <ha-icon icon=${r.skipPending ? "mdi:close" : "mdi:skip-next"}></ha-icon>
      </button>
    </div>
  `;
}

// ---------- Discovery -------------------------------------------------------

function collectRows(hass: HomeAssistant, prefix: string): ScheduleRow[] {
  const sensorPrefix = `sensor.${prefix}_schedule_`;
  const ids = Object.keys(hass.states).filter((id) =>
    id.startsWith(sensorPrefix),
  );
  // Stable ordering by entity_id keeps the visual list deterministic
  // across renders (Object.keys order isn't guaranteed for state diffs).
  ids.sort();
  const rows: ScheduleRow[] = [];
  for (const sensorId of ids) {
    const state = hass.states[sensorId];
    const base = sensorId.slice("sensor.".length); // e.g. my_yarbo_schedule_front_yard
    const runNowId = `button.${base}_run_now`;
    const skipNextId = `button.${base}_skip_next`;
    const enabledSwitchId = `switch.${base}_enabled`;
    const attrs = state?.attributes ?? {};
    rows.push({
      sensorId,
      planName: typeof attrs.plan_name === "string" ? attrs.plan_name : "",
      holdReason: state?.state ?? "unknown",
      holdLabel:
        typeof attrs.hold_label === "string"
          ? attrs.hold_label
          : (state?.state ?? "Unknown"),
      runNowId,
      skipNextId,
      enabledSwitchId,
      skipPending: Boolean(attrs.skip_next),
      scheduleEnabled: attrs.schedule_enabled !== false, // default true if missing
      lastRunIso:
        typeof attrs.last_run === "string" && attrs.last_run.length > 0
          ? attrs.last_run
          : null,
      nextEligibleIso:
        typeof attrs.next_eligible_at === "string" &&
        attrs.next_eligible_at.length > 0
          ? attrs.next_eligible_at
          : null,
      missing: !state || state.state === "unavailable",
    });
  }
  return rows;
}

// ---------- Actions ---------------------------------------------------------

function pressButton(hass: HomeAssistant, entityId: string): void {
  if (!hass.states[entityId]) return;
  hass.callService("button", "press", { entity_id: entityId }).catch((e) => {
    // eslint-disable-next-line no-console
    console.warn("yarbo-card: scheduler press failed", entityId, e);
  });
}

function toggleSwitch(
  hass: HomeAssistant,
  entityId: string,
  currentlyOn: boolean,
): void {
  if (!hass.states[entityId]) return;
  hass.callService("switch", currentlyOn ? "turn_off" : "turn_on", {
    entity_id: entityId,
  }).catch((e) => {
    // eslint-disable-next-line no-console
    console.warn("yarbo-card: scheduler toggle failed", entityId, e);
  });
}

// ---------- Display helpers -------------------------------------------------

/** Compact relative time for PAST timestamps. "5 days ago" / "12 mins ago".
 *
 * Single-unit (largest non-zero) on purpose — for historical events
 * the precise breakdown ("ran 47 days, 3 hours, 14 mins ago") is just
 * noise.
 */
function formatRelativeTime(iso: string, nowMs: number): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "?";
  const diff = nowMs - ms;
  if (diff < 0) {
    // Future timestamp passed to the past-formatter — fall through to
    // the countdown formatter so callers don't have to branch.
    return formatCountdown(iso, nowMs);
  }
  const absSec = Math.floor(diff / 1000);
  if (absSec < 60) return "just now";
  const min = Math.floor(absSec / 60);
  if (min < 60) return `${min} min${min === 1 ? "" : "s"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? "" : "s"} ago`;
}

/** Granular countdown for FUTURE timestamps. "2d 14h 32m".
 *
 * Multi-unit so the user can see at a glance exactly how close — the
 * difference between "in 3 d" and "in 1 d 4 h 12 m" matters when you
 * want to know whether to plan around it. Suppresses leading zeros so
 * short countdowns stay tight ("32m" not "0d 0h 32m").
 *
 * Returns "<1 min" for sub-minute and "now" for past/zero.
 */
function formatCountdown(iso: string, nowMs: number): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "?";
  const diffSec = Math.floor((ms - nowMs) / 1000);
  if (diffSec <= 0) return "now";
  if (diffSec < 60) return "<1 min";
  let rem = diffSec;
  const days = Math.floor(rem / 86400); rem %= 86400;
  const hours = Math.floor(rem / 3600); rem %= 3600;
  const mins = Math.floor(rem / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  // Always show minutes if we have nothing else, OR if we have hours
  // (so "1h 0m" doesn't read as "1h" — the trailing "0m" reassures the
  // user the precision is real). Skip minutes only when the days
  // component is large enough that minutes are noise.
  if (days >= 7) {
    // ≥1 week out — collapse to "Xd Yh", drop minutes for legibility.
  } else {
    parts.push(`${mins}m`);
  }
  return parts.join(" ");
}

/** Map hold reason to a CSS modifier slug (no spaces, lowercase). */
function slugReason(reason: string): string {
  return reason.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** CSS for the scheduler section. */
export const SCHEDULER_CSS = `
.sched {
  border-top: 1px solid var(--divider-color);
  padding-top: 8px;
}
.sched summary {
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
.sched summary::-webkit-details-marker { display: none; }
.sched summary::before {
  content: "▸ ";
  color: var(--yc-muted);
  transition: transform 0.15s ease;
  display: inline-block;
}
.sched[open] summary::before { transform: rotate(90deg); }
.sched-count {
  margin-left: auto;
  font-size: 0.78rem;
  color: var(--yc-muted);
  font-variant-numeric: tabular-nums;
}
.sched-empty {
  margin-top: 8px;
  padding: 6px 10px;
  font-size: 0.8rem;
  color: var(--yc-muted);
  background: var(--secondary-background-color);
  border-radius: 6px;
}
.sched-pause-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px;
  margin-top: 6px;
}
.sched-pause-label {
  flex: 1;
  font-size: 0.85rem;
  color: var(--yc-muted);
}
.sched-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 6px 4px;
  font-size: 0.85rem;
  flex-wrap: wrap;
}
.sched-summary-label {
  color: var(--yc-muted);
}
.sched-summary strong {
  color: var(--primary-text-color);
  font-weight: 600;
}
.sched-summary-time {
  margin-left: auto;
  color: var(--yc-muted);
  font-variant-numeric: tabular-nums;
}
.sched-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 4px;
}
.sched-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px;
}
.sched-plan {
  flex: 1;
  min-width: 0;
}
.sched-name {
  font-size: 0.92rem;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sched-sub {
  font-size: 0.78rem;
  color: var(--yc-muted);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}
.sched-time {
  font-variant-numeric: tabular-nums;
}
.sched-badge {
  display: inline-block;
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 600;
  background: var(--secondary-background-color);
  color: var(--primary-text-color);
}
.sched-badge-eligible {
  background: rgba(0, 158, 115, 0.15);
  color: #009E73;
}
.sched-badge-cooldown,
.sched-badge-sleep,
.sched-badge-weather {
  background: rgba(0, 114, 178, 0.15);
  color: #0072B2;
}
.sched-badge-paused,
.sched-badge-skipped,
.sched-badge-skip-queued {
  background: rgba(240, 228, 66, 0.25);
  color: #B58900;
}
.sched-badge-battery,
.sched-badge-presence {
  background: rgba(204, 121, 167, 0.18);
  color: #813A6B;
}
.sched-badge-robot-offline,
.sched-badge-robot-busy {
  background: rgba(213, 94, 0, 0.15);
  color: #D55E00;
}
.sched-warn {
  color: #D55E00;
  font-weight: 500;
}
.sched-mini {
  background: var(--secondary-background-color);
  border: 1px solid var(--divider-color);
  color: var(--primary-text-color);
  border-radius: 6px;
  padding: 4px 8px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.sched-mini[disabled] {
  opacity: 0.45;
  cursor: not-allowed;
}
.sched-mini-active {
  background: rgba(240, 228, 66, 0.25);
  border-color: rgba(181, 137, 0, 0.5);
  color: #B58900;
}
.sched-mini ha-icon { --mdc-icon-size: 18px; }
`;
