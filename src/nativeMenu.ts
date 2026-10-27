import { Menu, type MenuItemOptions } from "@tauri-apps/api/menu";

/** File actions live in the system menu bar, never in the workspace chrome. */
export async function installNativeMenu(
  recents: string[],
  run: (action: string) => void,
  cancelled: () => boolean,
) {
  const item = (
    text: string,
    action: string,
    accelerator?: string,
  ): MenuItemOptions => ({
    text,
    action: () => run(action),
    ...(accelerator ? { accelerator } : {}),
  });
  const menu = await Menu.new({
    items: [
      {
        text: "OpenPlatform",
        items: [
          { item: { About: { name: "OpenPlatform", version: "1.0.0" } } },
          { item: "Separator" },
          item("Settings…", "Workspace: Settings", "CmdOrCtrl+Comma"),
          { item: "Services" },
          { item: "Separator" },
          { item: "Hide" },
          { item: "HideOthers" },
          { item: "ShowAll" },
          { item: "Separator" },
          { item: "Quit" },
        ],
      },
      {
        text: "File",
        items: [
          item("New Project…", "File: New Project", "CmdOrCtrl+Shift+N"),
          item("Open Project…", "File: Open Project", "CmdOrCtrl+O"),
          {
            text: "Open Recent",
            items: recents.length
              ? recents.map((path) => item(path, `recent:${path}`))
              : [{ text: "No recent projects", enabled: false }],
          },
          {
            text: "New from Template",
            items: [
              item("ESP32", "File: New Project"),
              item("Arduino Uno", "File: New Arduino Uno Project"),
              item("Arduino Nano", "File: New Arduino Nano Project"),
            ],
          },
          { item: "Separator" },
          item("New File…", "File: New File", "CmdOrCtrl+N"),
          item("Save", "File: Save", "CmdOrCtrl+S"),
          item("Save All", "File: Save All", "CmdOrCtrl+Alt+S"),
          item("Save As…", "File: Save As", "CmdOrCtrl+Shift+S"),
          { item: "Separator" },
          item("Close Tab", "Close Tab", "CmdOrCtrl+W"),
        ],
      },
      {
        text: "Edit",
        items: [
          { item: "Undo" },
          { item: "Redo" },
          { item: "Separator" },
          { item: "Cut" },
          { item: "Copy" },
          { item: "Paste" },
          { item: "SelectAll" },
          { item: "Separator" },
          item("Format Document", "Editor: Format Document"),
          item("Reload File from Disk", "Editor: Reload File from Disk"),
        ],
      },
      {
        text: "View",
        items: [
          item("Command Palette…", "Command Palette", "CmdOrCtrl+Shift+P"),
          item("Go to File…", "Go to File", "CmdOrCtrl+P"),
          item("Find in Project…", "Find in Project", "CmdOrCtrl+Shift+F"),
          { item: "Separator" },
          item("Project Files", "Panel: Show Files"),
          item("Outline", "Panel: Show Outline"),
          item("Toggle Sidebar", "Panel: Toggle Sidebar", "CmdOrCtrl+B"),
          item("Terminal", "Terminal: Toggle"),
          item("Build Output", "Output: Toggle"),
          item("Serial Monitor", "Panel: Show Serial Monitor"),
          item("Problems", "Panel: Show Problems"),
          { item: "Separator" },
          { item: "Fullscreen" },
        ],
      },
      {
        text: "Build",
        items: [
          item("Verify", "Build: Verify"),
          item("Upload", "Build: Upload"),
          item("Stop", "Build: Cancel"),
          { item: "Separator" },
          item("Clean", "Build: Clean"),
          item("Run Tests", "Build: Run Tests"),
          item("Static Analysis", "Build: Static Analysis"),
          item(
            "Generate Compilation Database",
            "Build: Generate Compilation Database",
          ),
        ],
      },
      {
        text: "Tools",
        items: [
          item("Refresh Ports", "Device: Refresh Ports"),
          item("Identify Chip", "Device: Identify Chip"),
          item("Start / Stop Serial Monitor", "Serial: Toggle Monitor"),
          { item: "Separator" },
          item("Install Dependencies", "Project: Install Dependencies"),
          item("Check Toolchain", "Tools: Check Toolchain"),
          item("Restart C++ Language Server", "C++: Restart Language Server"),
          item("Open in VS Code", "Workspace: Open in VS Code"),
        ],
      },
      {
        text: "Window",
        items: [
          { item: "Minimize" },
          { item: "Maximize" },
          { item: "BringAllToFront" },
        ],
      },
    ],
  });
  if (!cancelled()) await menu.setAsAppMenu();
  return () => menu.close();
}
