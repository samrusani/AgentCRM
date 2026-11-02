import type { SVGProps } from 'react';

const PATHS = {
  today: 'M2.5 3.5h11v10h-11zM2.5 6.5h11M5.5 2v3M10.5 2v3M5.5 9.5l1.7 1.7 3.3-3.4',
  people: 'M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM1.5 13.5c0-2.2 2-3.5 4.5-3.5s4.5 1.3 4.5 3.5M11 3a2.2 2.2 0 0 1 0 4.4M12 10.2c1.5.4 2.5 1.5 2.5 3.3',
  pipeline: 'M2 2.5h3.2v11H2zM6.4 2.5h3.2v7H6.4zM10.8 2.5H14v9h-3.2z',
  research: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.6 10.6 14 14M7 5v4M5 7h4',
  settings:
    'M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4zM8 1.5v1.7M8 12.8v1.7M1.5 8h1.7M12.8 8h1.7M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2',
  search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM10.6 10.6 14 14',
  panel: 'M2.5 3h11v10h-11zM10 3v10',
  chevronLeft: 'M10 3.5 5.5 8l4.5 4.5',
  chevronRight: 'M6 3.5 10.5 8 6 12.5',
  chevronDown: 'M3.5 6 8 10.5 12.5 6',
  close: 'M3.5 3.5l9 9M12.5 3.5l-9 9',
  check: 'M3 8.5l3.2 3.2L13 4.8',
  more: 'M3.5 8h.01M8 8h.01M12.5 8h.01',
  pencil: 'M10.5 2.5l3 3L5.5 13.5l-3.5.5.5-3.5z',
  pause: 'M5.5 3v10M10.5 3v10',
  play: 'M5 3l8 5-8 5z',
  stop: 'M4 4h8v8H4z',
  send: 'M2 8 14 2.5 10 13.5 7.5 9z',
  sun: 'M8 10.8a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6zM8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1',
  external: 'M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4',
  building: 'M3 14V2.5h7V14M10 6.5h3V14M5.5 5h2M5.5 7.5h2M5.5 10h2M1.5 14h13',
  deal: 'M2 5.5h12v8H2zM5.5 5.5V3.5h5v2M2 9h12',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, ...rest }: { name: IconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
