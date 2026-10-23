/* 图标库 —— 与已确认原型的 SVG path 逐值一致（lucide 风格 24px 线性图标） */

export const ICON_PATHS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  package:
    '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="M3 8v9l9 5 9-5V8M12 13v9"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h8"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5"/><path d="M4 16v4h16v-4"/>',
  cloud:
    '<path d="M20 16.6A5 5 0 0 0 18 7h-1.3A7 7 0 1 0 5 18h3"/><path d="m12 21 0-9m-4 4 4-4 4 4"/>',
  search: '<circle cx="10.7" cy="10.7" r="6.7"/><path d="m16 16 5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  left: '<path d="m15 18-6-6 6-6"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  checkcircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  alert:
    '<path d="M10.3 3.9a2 2 0 0 1 3.4 0l8 13.7a2 2 0 0 1-1.7 3H4a2 2 0 0 1-1.7-3Z"/><path d="M12 9v4m0 4h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.2h.01"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-12h-7z"/>',
  brain:
    '<path d="M12 18V5a3 3 0 0 0-6 0 4 4 0 0 0-3 6 4 4 0 0 0 1 7 4 4 0 0 0 8 0Zm0 0V5a3 3 0 0 1 6 0 4 4 0 0 1 3 6 4 4 0 0 1-1 7 4 4 0 0 1-8 0Z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.5 2.6-1.8-.7a8 8 0 0 1-1.6 1l-.3 1.9h-3l-.3-1.9a8 8 0 0 1-1.7-1l-1.8.7-1.5-2.6L8.6 15a9 9 0 0 1 0-2l-1.5-1.2L8.6 9l1.8.7a8 8 0 0 1 1.7-1l.3-1.9h3l.3 1.9a8 8 0 0 1 1.6 1l1.8-.7 1.5 2.6-1.4 1.2a9 9 0 0 1 .1 2.2Z" transform="translate(-2 -2)"/>',
  logout: '<path d="M10 17l5-5-5-5M15 12H3"/><path d="M12 3h6a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3h-6"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  refresh:
    '<path d="M3 11a9 9 0 0 1 15-6l3 3M21 3v5h-5M21 13a9 9 0 0 1-15 6l-3-3M3 21v-5h5"/>',
  edit: '<path d="M12 20h9M4 20l4.5-1 11-11a2.1 2.1 0 0 0-3-3l-11 11L4 20Z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  filecheck:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6Z"/><path d="M14 2v6h6m-12 9 2 2 5-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8m0-5v5h5"/><path d="M12 7v5l4 2"/>',
  link: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 1 0-7-7l-2 2"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2"/>',
  lock: '<rect x="4" y="10" width="16" height="12" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  clipboard:
    '<rect x="5" y="4" width="14" height="18" rx="2"/><rect x="9" y="2" width="6" height="4" rx="1"/><path d="M9 12h6m-6 4h6"/>',
  filter: '<path d="M4 7h16M7 12h10m-7 5h4"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
  external: '<path d="M14 4h6v6m0-6-9 9"/><path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5"/>',
  paperclip: '<path d="m9 16 6-6a3 3 0 1 0-4-4l-7 7a5 5 0 0 0 7 7l8-8"/>',
  activity: '<path d="M3 12h5l3-7 4 14 3-7h3"/>',
  arrow: '<path d="M4 12h16m-7-7 7 7-7 7"/>',
  sparkle: '<path d="m12 2 2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2Z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2.2-2.5 4m0 3h.01"/>',
  retry: '<path d="M3 11a9 9 0 1 1 2 6M3 5v6h6"/>',
  arrowup: '<path d="M7 17 17 7M8 7h9v9"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>',
} as const

export type IconName = keyof typeof ICON_PATHS

interface IconProps {
  name: IconName
  size?: 'sm' | 'md' | 'lg' | 'xl'
  className?: string
}

export function Icon({ name, size = 'md', className = '' }: IconProps) {
  const sizeClass = size === 'md' ? '' : size
  return (
    <svg
      className={`icon ${sizeClass} ${className}`.trim()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] ?? ICON_PATHS.info }}
    />
  )
}
