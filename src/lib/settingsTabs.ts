// Settings categories — shared so the shell Sidebar can render the sub-nav in the same
// sidebar card the other sections use, while Settings.tsx renders the matching pane.
import { film, globe, hardDrive, info, server, triangleAlert } from "./icons";

export const SETTINGS_TABS = [
  { id: "general", label: "General", icon: info },
  { id: "storage", label: "Storage", icon: hardDrive },
  { id: "media", label: "Media", icon: film },
  { id: "artwork", label: "Artwork", icon: globe },
  { id: "network", label: "Network", icon: server },
  { id: "advanced", label: "Advanced", icon: triangleAlert },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];
