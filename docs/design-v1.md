# v1 layout implementation

The accepted compact image concept is implemented as a light macOS workspace. The editor remains the dominant central surface, with centered file tabs above it and two independent bottom windows. Fine borders, 8px gutters, subtle shadows and a teal accent connect the panels without removing their separation.

The left dock is a narrow, vertically centered floating rectangle. Its icons are 18px with hover/focus labels. Settings can hide or restore tools; its height fits the visible controls. More Tools and Settings stay available so hidden tools can always be reached again.

Auxiliary views float over the editor rather than permanently shifting the workspace. Home and recent projects, Files, Outline, GitHub, Libraries, Boards, basic OpenOCD controls and Settings share the same visual language. The command palette, file finder and project search use the same light overlay styling.

File operations are in the native macOS menu bar, alongside Edit, View, Build, Tools and Window. The application title bar has the project, repository branch, file finder and command controls. The editor toolbar retains environment/port selection, refresh, identify, verify, upload and task cancellation.

The left bottom window is a real PTY shell. The right window has Serial Output, Build Output and Problems tabs; changing those tabs does not replace or restart the shell. The serial pane retains start/stop, baud, clear, send and line-ending controls. Build progress and chip details appear only when needed.

The screenshot in `images/workspace-v1.jpg` is the running native app, not generated artwork. Device and serial states reflect actual runtime state; no connected board or successful upload is fabricated for the screenshot.

## Version history

- `88d589d`: pre-redesign checkpoint, including native File menu integration and the previously unpushed project work.
- `v1.0.0`: complete layout implementation and application version 1.0.0.

Validation is limited to the frontend/native builds and focused visual inspection. No exhaustive regression suite or hardware flashing was performed for this design pass.
