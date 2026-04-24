import type { LovelaceCardConfig, HomeAssistant } from "custom-card-helpers";

export interface YarboColors {
  trail_completed?: string;
  trail_transit?: string;
  trail_planned?: string;
  obstacle?: string;
  robot?: string;
  zone_work?: string;
  zone_nogo?: string;
  zone_novision?: string;
  zone_geofence?: string;
  zone_pathway?: string;
  map_background?: string;
}

export interface YarboCardConfig extends LovelaceCardConfig {
  type: string;
  prefix?: string;
  device_id?: string;
  name?: string;
  show_map?: boolean;
  map_height?: number;
  show_advanced?: boolean;
  compact?: boolean;
  colors?: YarboColors;
  /** Rain-sensor threshold above which the card surfaces a rain alert.
   * The Yarbo phone app uses 500 by default. */
  rain_threshold?: number;
}

export const DEFAULT_COLORS: Required<YarboColors> = {
  trail_completed: "#3D348B",
  trail_transit: "#7678ED",
  trail_planned: "#9ca3af",
  obstacle: "#D55E00",
  robot: "#03a9f4",
  zone_work: "#009E73",
  zone_nogo: "#D55E00",
  zone_novision: "#CC79A7",
  zone_geofence: "#F0E442",
  zone_pathway: "#0072B2",
  // Not actually used as a fill; a falsy override means "fall back to
  // HA theme vars" (see _renderMapBackground). The value here is just a
  // reasonable swatch for the editor's color picker.
  map_background: "#f5f5f5",
};

export const COLOR_THEMES: Record<string, Required<YarboColors>> = {
  // Okabe-Ito — the de facto colorblind-safe palette. Current default.
  "okabe-ito": {
    trail_completed: "#3D348B",
    trail_transit: "#7678ED",
    trail_planned: "#9ca3af",
    obstacle: "#D55E00",
    robot: "#03a9f4",
    zone_work: "#009E73",
    zone_nogo: "#D55E00",
    zone_novision: "#CC79A7",
    zone_geofence: "#F0E442",
    zone_pathway: "#0072B2",
    map_background: "#f5f5f5",
  },
  // Saturated, lively. Great on light themes; not CVD-safe.
  vibrant: {
    trail_completed: "#6200EA",
    trail_transit: "#7C4DFF",
    trail_planned: "#90A4AE",
    obstacle: "#FF1744",
    robot: "#00E5FF",
    zone_work: "#00C853",
    zone_nogo: "#FF1744",
    zone_novision: "#FF6D00",
    zone_geofence: "#FFD600",
    zone_pathway: "#2962FF",
    map_background: "#FAFAFA",
  },
  // Bright neon palette tuned for dark HA themes.
  "dark-neon": {
    trail_completed: "#BB86FC",
    trail_transit: "#CF9FFF",
    trail_planned: "#5C6370",
    obstacle: "#FF6E40",
    robot: "#4FC3F7",
    zone_work: "#00E676",
    zone_nogo: "#FF5252",
    zone_novision: "#FF80AB",
    zone_geofence: "#FFEA00",
    zone_pathway: "#40C4FF",
    map_background: "#1E293B",
  },
  // High-contrast, dark-on-light. Useful for visual accessibility.
  "high-contrast": {
    trail_completed: "#000000",
    trail_transit: "#444444",
    trail_planned: "#888888",
    obstacle: "#B00020",
    robot: "#0033CC",
    zone_work: "#1B5E20",
    zone_nogo: "#B00020",
    zone_novision: "#4A148C",
    zone_geofence: "#F57F17",
    zone_pathway: "#0D47A1",
    map_background: "#FFFFFF",
  },
  // Soft pastel palette — calm, minimal, daylight-friendly.
  pastel: {
    trail_completed: "#6B5B95",
    trail_transit: "#A89CC9",
    trail_planned: "#C5C8D6",
    obstacle: "#E08283",
    robot: "#82B5C7",
    zone_work: "#B5EAD7",
    zone_nogo: "#FFB7B2",
    zone_novision: "#FFDAC1",
    zone_geofence: "#FFE9A8",
    zone_pathway: "#C7CEEA",
    map_background: "#FFFEF7",
  },
  // 80s CRT terminal — green phosphor on black, with amber/red
  // warning accents for no-go and obstacles (matches classic terminal
  // alert conventions).
  "terminal-80s": {
    trail_completed: "#39FF14",
    trail_transit: "#00E63D",
    trail_planned: "#228B22",
    obstacle: "#FF4500",
    robot: "#00FF41",
    zone_work: "#008F11",
    zone_nogo: "#FF0000",
    zone_novision: "#FFB000",
    zone_geofence: "#FFFF00",
    zone_pathway: "#00B030",
    map_background: "#000000",
  },
  // Grayscale + single warning accent. Editorial / print look.
  monochrome: {
    trail_completed: "#212121",
    trail_transit: "#616161",
    trail_planned: "#BDBDBD",
    obstacle: "#D32F2F",
    robot: "#424242",
    zone_work: "#757575",
    zone_nogo: "#D32F2F",
    zone_novision: "#9E9E9E",
    zone_geofence: "#FBC02D",
    zone_pathway: "#424242",
    map_background: "#FAFAFA",
  },
};

export const THEME_LABELS: Record<string, string> = {
  "okabe-ito": "Okabe-Ito (CVD-safe, default)",
  vibrant: "Vibrant",
  "dark-neon": "Dark / Neon",
  "high-contrast": "High Contrast",
  pastel: "Pastel",
  "terminal-80s": "80s Terminal (green/black)",
  monochrome: "Monochrome",
};

export const COLOR_LABELS: Record<keyof YarboColors, string> = {
  trail_completed: "Completed trail",
  trail_transit: "Transit trail",
  trail_planned: "Planned path",
  obstacle: "Obstacle marker",
  robot: "Robot body",
  zone_work: "Work zone",
  zone_nogo: "No-go zone",
  zone_novision: "No-vision zone",
  zone_geofence: "Geofence",
  zone_pathway: "Pathway",
  map_background: "Map background",
};

export interface YarboEntities {
  online?: string;
  charging?: string;
  battery?: string;
  errorCode?: string;
  workingState?: string;
  autoPlanStatus?: string;
  autoPlanPause?: string;
  rechargingStatus?: string;
  rtkSignal?: string;
  network?: string;
  headType?: string;
  planSelect?: string;
  workingStateSelect?: string;
  planStartPercent?: string;
  volume?: string;
  soundSwitch?: string;
  headlightSwitch?: string;
  startPlan?: string;
  pausePlan?: string;
  resumePlan?: string;
  stopPlan?: string;
  recharge?: string;
  refreshPlans?: string;
  refreshMap?: string;
  refreshDevice?: string;
  refreshGps?: string;
  mapZones?: string;
  deviceTracker?: string;
}

export type { HomeAssistant };
