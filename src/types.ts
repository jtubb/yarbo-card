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
