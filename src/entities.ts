import type { HomeAssistant, YarboEntities } from "./types";

const SUFFIX_MAP: { key: keyof YarboEntities; domain: string; suffix: string }[] = [
  { key: "online", domain: "binary_sensor", suffix: "online" },
  { key: "charging", domain: "binary_sensor", suffix: "charging" },
  { key: "soundSwitch", domain: "switch", suffix: "sound_switch" },
  { key: "headlightSwitch", domain: "switch", suffix: "headlight" },
  { key: "battery", domain: "sensor", suffix: "battery" },
  { key: "errorCode", domain: "sensor", suffix: "error_code" },
  { key: "workingState", domain: "sensor", suffix: "heart_beat_state" },
  { key: "autoPlanStatus", domain: "sensor", suffix: "auto_plan_status" },
  { key: "autoPlanPause", domain: "sensor", suffix: "auto_plan_pause_status" },
  { key: "rechargingStatus", domain: "sensor", suffix: "recharging_status" },
  { key: "rtkSignal", domain: "sensor", suffix: "rtk_signal" },
  { key: "network", domain: "sensor", suffix: "network" },
  { key: "headType", domain: "sensor", suffix: "head_type" },
  { key: "mapZones", domain: "sensor", suffix: "map_zones" },
  { key: "planSelect", domain: "select", suffix: "plan_select" },
  { key: "workingStateSelect", domain: "select", suffix: "working_state" },
  { key: "planStartPercent", domain: "number", suffix: "plan_start_percent" },
  { key: "volume", domain: "number", suffix: "volume" },
  { key: "startPlan", domain: "button", suffix: "start_plan" },
  { key: "pausePlan", domain: "button", suffix: "pause_plan" },
  { key: "resumePlan", domain: "button", suffix: "resume_plan" },
  { key: "stopPlan", domain: "button", suffix: "stop_plan" },
  { key: "recharge", domain: "button", suffix: "return_to_charge" },
  { key: "refreshPlans", domain: "button", suffix: "refresh_plans" },
  { key: "refreshMap", domain: "button", suffix: "refresh_map_data" },
  { key: "refreshDevice", domain: "button", suffix: "refresh_device_data" },
  { key: "refreshGps", domain: "button", suffix: "refresh_gps_reference" },
  { key: "deviceTracker", domain: "device_tracker", suffix: "location" },
];

export function resolveEntities(
  hass: HomeAssistant,
  prefix: string,
): YarboEntities {
  const out: YarboEntities = {};
  for (const { key, domain, suffix } of SUFFIX_MAP) {
    const id = `${domain}.${prefix}_${suffix}`;
    if (hass.states[id]) {
      (out as Record<string, string>)[key] = id;
    }
  }
  return out;
}

export function inferPrefix(hass: HomeAssistant): string | undefined {
  const state = Object.keys(hass.states).find((id) =>
    id.startsWith("binary_sensor.") && id.endsWith("_online") &&
    hass.states[id].attributes?.device_class === "connectivity" &&
    // Best-effort: look for a matching battery sensor with same prefix
    hass.states[`sensor.${id.slice("binary_sensor.".length, -"_online".length)}_battery`] !== undefined &&
    hass.states[`button.${id.slice("binary_sensor.".length, -"_online".length)}_start_plan`] !== undefined,
  );
  if (!state) return undefined;
  return state.slice("binary_sensor.".length, -"_online".length);
}

export function deviceName(hass: HomeAssistant, ents: YarboEntities, fallback: string): string {
  const anchor =
    ents.online || ents.battery || ents.workingState || ents.deviceTracker;
  if (anchor && hass.states[anchor]) {
    const friendly = hass.states[anchor].attributes?.friendly_name;
    if (typeof friendly === "string") {
      // Friendly names look like "Senor Choppy Online" — strip the trailing label
      const parts = friendly.split(" ");
      if (parts.length > 1) return parts.slice(0, -1).join(" ");
      return friendly;
    }
  }
  return fallback;
}
