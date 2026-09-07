interface IconProps {
  size?: number;
  className?: string;
}

function Svg({ size = 20, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const IconPhotos = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="7.5" height="7.5" rx="2" />
    <rect x="13.5" y="3" width="7.5" height="7.5" rx="2" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="2" />
    <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" />
  </Svg>
);

export const IconPeople = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8.2" r="3.4" />
    <path d="M3.2 19.5c.9-3.2 3.1-4.8 5.8-4.8s4.9 1.6 5.8 4.8" />
    <circle cx="17" cy="9.5" r="2.6" />
    <path d="M16.2 14.8c2.4.2 4 1.6 4.7 4.2" />
  </Svg>
);

export const IconPin = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 21.5S5.5 16 5.5 11a6.5 6.5 0 1 1 13 0c0 5-6.5 10.5-6.5 10.5z" />
    <circle cx="12" cy="10.8" r="2.4" />
  </Svg>
);

export const IconGlobe = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c3.2 3.6 3.2 14.4 0 18M12 3c-3.2 3.6-3.2 14.4 0 18" />
  </Svg>
);

export const IconSparkle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11 4l1.7 4.6L17.3 10l-4.6 1.7L11 16.3l-1.7-4.6L4.7 10l4.6-1.7z" />
    <path d="M18.5 15l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z" />
  </Svg>
);

export const IconAlbum = (p: IconProps) => (
  <Svg {...p}>
    <rect x="7" y="7" width="13.5" height="13.5" rx="2.5" />
    <path d="M3.5 16.5v-10a3 3 0 0 1 3-3h10" />
  </Svg>
);

export const IconCopy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" />
    <path d="M15.5 4.5h-9a2 2 0 0 0-2 2v9" />
  </Svg>
);

export const IconSliders = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 7h9M18.5 7h2M3.5 17h4M13 17h7.5" />
    <circle cx="15.5" cy="7" r="2.4" />
    <circle cx="9.5" cy="17" r="2.4" />
  </Svg>
);

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
);

export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.2M12 7.6h.01" />
  </Svg>
);

export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4v10.5m0 0l-4.2-4.2m4.2 4.2l4.2-4.2M4.5 19.5h15" />
  </Svg>
);

export const IconChevronL = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.5 5.5L8 12l6.5 6.5" />
  </Svg>
);

export const IconChevronR = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.5 5.5L16 12l-6.5 6.5" />
  </Svg>
);

export const IconLock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    <path d="M12 14.5v2" />
  </Svg>
);

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 6.5h15M9.5 6V4.8a1.8 1.8 0 0 1 1.8-1.8h1.4a1.8 1.8 0 0 1 1.8 1.8V6M6.5 6.5l.8 12.2a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8l.8-12.2M10 10.5v6M14 10.5v6" />
  </Svg>
);

export const IconPlay = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none" />
  </Svg>
);

/** "Show in Finder / File Explorer" — a folder standing open, with the arrow
 *  that every OS uses for *go to where this lives*. */
export const IconFolderOpen = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 18.5V6a1.8 1.8 0 0 1 1.8-1.8h3.6l2 2.4h5.8A1.8 1.8 0 0 1 18.5 8.4v1.6" />
    <path d="M3.5 18.5l2.4-6.2a1.6 1.6 0 0 1 1.5-1h13a1 1 0 0 1 .95 1.35l-1.9 5a1.6 1.6 0 0 1-1.5 1.05H3.5z" />
  </Svg>
);

/** Preview — the corners a viewfinder draws, meaning "look at this larger". */
export const IconExpand = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 4.5H5.6a1.1 1.1 0 0 0-1.1 1.1V9M15 4.5h3.4a1.1 1.1 0 0 1 1.1 1.1V9M9 19.5H5.6a1.1 1.1 0 0 1-1.1-1.1V15M15 19.5h3.4a1.1 1.1 0 0 0 1.1-1.1V15" />
  </Svg>
);

export const IconPencil = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20h4l10.5-10.5a2.83 2.83 0 1 0-4-4L4 16v4z" />
    <path d="M13.5 6.5l4 4" />
  </Svg>
);

export const IconCamera = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 8.5h2.7l1.3-2h7l1.3 2h2.7a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5V10a1.5 1.5 0 0 1 1.5-1.5z" />
    <circle cx="12" cy="13.5" r="3.2" />
  </Svg>
);

export const IconFilm = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <path d="M7.5 4.5v15M16.5 4.5v15M3 12h18M3 8.25h4.5M3 15.75h4.5M16.5 8.25H21M16.5 15.75H21" />
  </Svg>
);

export const IconDoc = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z" />
    <path d="M14 3.5V8h4.5M9 13h6M9 16.5h4" />
  </Svg>
);

/** Outline until it is filled — the whole point of the control is the moment
 *  it changes state, so the shape stays put and only the fill moves. */
export const IconHeart = ({ filled, ...p }: IconProps & { filled?: boolean }) => (
  <Svg {...p}>
    <path
      d="M12 20.3 4.6 12.9a4.6 4.6 0 0 1 0-6.5 4.6 4.6 0 0 1 6.5 0l.9.9.9-.9a4.6 4.6 0 0 1 6.5 0 4.6 4.6 0 0 1 0 6.5z"
      fill={filled ? "currentColor" : "none"}
    />
  </Svg>
);

/* ---- added with the desktop shell ---- */

export const IconVideo = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M3 9h18M3 15h18M7.5 5v14M16.5 5v14" />
  </Svg>
);

export const IconLive = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <circle cx="12" cy="12" r="8" strokeDasharray="3 3" />
  </Svg>
);

export const IconGear = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Svg>
);

export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
);

export const IconDrive = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="6" width="18" height="12" rx="2" />
    <circle cx="17" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <path d="M6.5 12h6" />
  </Svg>
);

export const IconMore = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);

export const IconGridSmall = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="4" height="4" fill="currentColor" stroke="none" />
    <rect x="10" y="3" width="4" height="4" fill="currentColor" stroke="none" />
    <rect x="17" y="3" width="4" height="4" fill="currentColor" stroke="none" />
    <rect x="3" y="10" width="4" height="4" fill="currentColor" stroke="none" />
    <rect x="10" y="10" width="4" height="4" fill="currentColor" stroke="none" />
    <rect x="17" y="10" width="4" height="4" fill="currentColor" stroke="none" />
    <rect x="3" y="17" width="4" height="4" fill="currentColor" stroke="none" />
    <rect x="10" y="17" width="4" height="4" fill="currentColor" stroke="none" />
    <rect x="17" y="17" width="4" height="4" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconGridLarge = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="18" rx="1" fill="currentColor" stroke="none" />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 7.5V12l3.5 2" />
  </Svg>
);

export const IconContrast = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" opacity="0.45" />
  </Svg>
);

export const IconMerge = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 4v5a5 5 0 0 0 5 5h2M18 4v5a5 5 0 0 1-5 5M12 14v6" />
    <path d="m9 17 3 3 3-3" />
  </Svg>
);

export const IconEyeOff = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 3l18 18M10.6 6.3A9.7 9.7 0 0 1 12 6c5 0 8.5 4 9.5 6-.4.8-1.2 2-2.4 3.1M6.6 6.7C4.4 8.1 3 10.2 2.5 12c1 2 4.5 6 9.5 6 1.6 0 3-.4 4.3-1" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </Svg>
);
