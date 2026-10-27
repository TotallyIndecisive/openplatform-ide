import { useEffect, useState } from "react";

export const dockItems = [
  { id: "home", label: "Home", icon: "home" },
  { id: "files", label: "Project files", icon: "folder" },
  { id: "git", label: "GitHub", icon: "github" },
  { id: "libraries", label: "Libraries", icon: "library" },
  { id: "boards", label: "Boards", icon: "chip" },
  { id: "terminal", label: "Terminal", icon: "terminal" },
  { id: "serial", label: "Serial output", icon: "serial" },
  { id: "debug", label: "Debug", icon: "bug" },
] as const;
export type DockId = (typeof dockItems)[number]["id"];
type Preferences = {
  fontSize: number;
  minimap: boolean;
  wordWrap: boolean;
  dock: DockId[];
};
const defaults: Preferences = {
  fontSize: 14,
  minimap: true,
  wordWrap: true,
  dock: dockItems.map((item) => item.id),
};
export function usePreferences() {
  const [preferences, setPreferences] = useState<Preferences>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("openplatform:appearance") || "null",
      );
      if (!saved) return defaults;
      return {
        fontSize: Math.max(11, Math.min(20, Number(saved.fontSize) || 14)),
        minimap: saved.minimap !== false,
        wordWrap: saved.wordWrap !== false,
        dock: Array.isArray(saved.dock)
          ? defaults.dock.filter((id) => saved.dock.includes(id))
          : defaults.dock,
      };
    } catch {
      return defaults;
    }
  });
  useEffect(() => {
    localStorage.setItem(
      "openplatform:appearance",
      JSON.stringify(preferences),
    );
  }, [preferences]);
  return [preferences, setPreferences] as const;
}
