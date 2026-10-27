import type { SVGProps } from "react";

const paths = {
  home: "m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z",
  folder: "M3 5h6l2 2h10v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
  file: "M14 2H5v20h14V7Zm0 0v5h5",
  github:
    "M9 19c-4 1-4-2-6-2m12 5v-4a3.5 3.5 0 0 0-1-2.5c3.5-.4 7-1.7 7-6A4.7 4.7 0 0 0 19.7 6 4.3 4.3 0 0 0 19.6 2S18.3 1.6 15 3.5a13.4 13.4 0 0 0-6 0C5.7 1.6 4.4 2 4.4 2A4.3 4.3 0 0 0 4.3 6 4.7 4.7 0 0 0 3 9.5c0 4.3 3.5 5.6 7 6A3.5 3.5 0 0 0 9 18v4",
  library: "M3 3h4v18H3Zm7 0h4v18h-4Zm7 1 4-1 4 17-4 1Z",
  chip: "M6 6h12v12H6ZM9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4M18 9h4m-4 6h4",
  terminal: "m5 6 6 6-6 6m9 0h5",
  serial: "M2 12h4l3-8 6 16 3-8h4",
  bug: "M8 8h8v8a4 4 0 0 1-8 0ZM9 8V6a3 3 0 0 1 6 0v2M5 6l3 3m8 0 3-3M3 13h5m8 0h5M5 21l3-3m8 0 3 3m-4-8v7",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  settings:
    "m9 3 1-1h4l1 3 3 1 3-1 2 4-2 2v3l2 2-2 4-3-1-3 1-1 3h-4l-1-3-3-1-3 1-2-4 2-2v-3L1 9l2-4 3 1 3-1Zm3 5a4 4 0 1 0 0 8 4 4 0 0 0 0-8",
  search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14m5 12 6 6",
  command:
    "M8 8H5a3 3 0 1 1 3-3v14a3 3 0 1 1-3-3h14a3 3 0 1 1-3 3V5a3 3 0 1 1 3 3H8",
  branch:
    "M6 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4m0 16a2 2 0 1 0 0-4 2 2 0 0 0 0 4m12-12a2 2 0 1 0 0-4 2 2 0 0 0 0 4M6 6v12m12-8a8 8 0 0 1-8 8H6",
  check: "m5 12 4 4L20 5",
  upload: "M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6",
  refresh: "M20 7a9 9 0 1 0 1 8M20 2v5h-5",
  save: "M3 3h15l3 3v15H3Zm4 0v7h10V3M7 21v-7h10v7",
  close: "m6 6 12 12M6 18 18 6",
  plus: "M12 5v14M5 12h14",
  chevron: "m8 10 4 4 4-4",
  outline: "M9 5h12M9 12h12M9 19h12M3 5h.01M3 12h.01M3 19h.01",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
  stop: "M6 6h12v12H6Z",
  play: "m7 3 14 9-14 9Z",
  send: "m3 3 19 9-19 9 4-9Zm4 9h15",
  warning: "m12 3 10 18H2Zm0 6v5m0 3h.01",
  expand: "M14 3h7v7m0-7-7 7M10 21H3v-7m0 7 7-7",
  panel: "M3 3h18v18H3Zm6 0v18",
  output: "M4 3h16v18H4Zm4 5h8m-8 4h8m-8 4h5",
} as const;
export type IconName = keyof typeof paths;
export function Icon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & { name: IconName }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "more" ? 3.5 : 1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  );
}
