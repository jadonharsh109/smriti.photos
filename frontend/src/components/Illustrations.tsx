/** Liquid-glass illustration set: translucent layered shapes with specular
 * edges, drawn to read on the dark aurora wallpaper. Pure inline SVG. */

interface ArtProps {
  className?: string;
  style?: React.CSSProperties;
}

function Defs({ id }: { id: string }) {
  return (
    <defs>
      <linearGradient id={`${id}-acc`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#7CC4FF" />
        <stop offset="0.55" stopColor="#6E7BFF" />
        <stop offset="1" stopColor="#B96BFF" />
      </linearGradient>
      <linearGradient id={`${id}-glass`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="rgba(255,255,255,0.16)" />
        <stop offset="1" stopColor="rgba(255,255,255,0.05)" />
      </linearGradient>
      <linearGradient id={`${id}-shine`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="rgba(255,255,255,0.55)" />
        <stop offset="0.5" stopColor="rgba(255,255,255,0)" />
      </linearGradient>
      <radialGradient id={`${id}-glow`} cx="50%" cy="42%" r="60%">
        <stop offset="0" stopColor="rgba(110,123,255,0.5)" />
        <stop offset="1" stopColor="rgba(110,123,255,0)" />
      </radialGradient>
    </defs>
  );
}

const glassFill = "rgba(22,26,44,0.55)";
const stroke = "rgba(255,255,255,0.22)";

/** Stack of tilted glass photo cards with a sun/mountain scene. */
export function ArtPhotos({ className, style }: ArtProps) {
  const id = "il-ph";
  return (
    <svg viewBox="0 0 200 160" className={className} style={style} aria-hidden="true">
      <Defs id={id} />
      <ellipse cx="100" cy="86" rx="86" ry="60" fill={`url(#${id}-glow)`} />
      {/* back cards */}
      <g transform="rotate(-9 100 84)">
        <rect x="38" y="34" width="104" height="84" rx="14" fill={glassFill} stroke={stroke} />
      </g>
      <g transform="rotate(7 104 86)">
        <rect x="52" y="38" width="104" height="84" rx="14" fill={glassFill} stroke={stroke} />
      </g>
      {/* front card with a scene */}
      <g transform="rotate(-2 100 88)">
        <rect x="44" y="46" width="112" height="90" rx="16" fill={`url(#${id}-glass)`} stroke="rgba(255,255,255,0.32)" />
        <rect x="52" y="54" width="96" height="60" rx="10" fill="rgba(10,14,28,0.6)" />
        <circle cx="76" cy="72" r="9" fill="#FFB27D" opacity="0.95" />
        <path d="M52 108 l26 -24 18 16 16 -13 36 27 v0 a10 10 0 0 1 -10 10 h-76 a10 10 0 0 1 -10 -10z" fill={`url(#${id}-acc)`} opacity="0.8" />
        <rect x="52" y="54" width="96" height="22" rx="10" fill={`url(#${id}-shine)`} opacity="0.35" />
        <circle cx="140" cy="124" r="4" fill="#7CC4FF" />
        <rect x="56" y="120" width="44" height="7" rx="3.5" fill="rgba(255,255,255,0.25)" />
      </g>
    </svg>
  );
}

/** Two overlapping face medallions in glass rings. */
export function ArtPeople({ className, style }: ArtProps) {
  const id = "il-pe";
  return (
    <svg viewBox="0 0 200 160" className={className} style={style} aria-hidden="true">
      <Defs id={id} />
      <ellipse cx="100" cy="84" rx="84" ry="58" fill={`url(#${id}-glow)`} />
      {/* back face */}
      <g>
        <circle cx="128" cy="72" r="34" fill={glassFill} stroke={stroke} />
        <circle cx="128" cy="64" r="11" fill="rgba(255,255,255,0.3)" />
        <path d="M108 92 a20 14 0 0 1 40 0" fill="rgba(255,255,255,0.3)" />
      </g>
      {/* front face with gradient ring */}
      <g>
        <circle cx="80" cy="90" r="40" fill="rgba(16,20,36,0.72)" stroke={`url(#${id}-acc)`} strokeWidth="3" />
        <circle cx="80" cy="80" r="13.5" fill={`url(#${id}-acc)`} opacity="0.9" />
        <path d="M55 116 a25 17 0 0 1 50 0" fill={`url(#${id}-acc)`} opacity="0.85" />
        <path d="M48 68 a40 40 0 0 1 64 -9" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
      </g>
      {/* sparkle */}
      <path d="M158 108 l3.2 8 8 3.2 -8 3.2 -3.2 8 -3.2 -8 -8 -3.2 8 -3.2z" fill="#4FE0C6" opacity="0.9" />
    </svg>
  );
}

/** Glass globe with a gradient location pin. */
export function ArtPlaces({ className, style }: ArtProps) {
  const id = "il-pl";
  return (
    <svg viewBox="0 0 200 160" className={className} style={style} aria-hidden="true">
      <Defs id={id} />
      <ellipse cx="100" cy="88" rx="84" ry="58" fill={`url(#${id}-glow)`} />
      <circle cx="100" cy="92" r="50" fill={glassFill} stroke={stroke} />
      <path d="M50 92 h100 M100 42 c22 24 22 76 0 100 M100 42 c-22 24 -22 76 0 100" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="1.6" />
      <ellipse cx="100" cy="92" rx="50" ry="18" fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="1.4" />
      <path d="M62 66 a50 50 0 0 1 52 -21" fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth="2.4" strokeLinecap="round" opacity="0.7" />
      {/* pin */}
      <path d="M100 30 c-15 0 -26 11 -26 25 0 18 26 43 26 43 s26 -25 26 -43 c0 -14 -11 -25 -26 -25z" fill={`url(#${id}-acc)`} stroke="rgba(255,255,255,0.45)" strokeWidth="1.6" />
      <circle cx="100" cy="55" r="9.5" fill="#0b0f1e" opacity="0.55" />
      <circle cx="100" cy="55" r="4.5" fill="#fff" />
      <ellipse cx="100" cy="120" rx="16" ry="4" fill="rgba(0,0,0,0.4)" />
    </svg>
  );
}

/** Sparkling event timeline with photo moments. */
export function ArtEvents({ className, style }: ArtProps) {
  const id = "il-ev";
  return (
    <svg viewBox="0 0 200 160" className={className} style={style} aria-hidden="true">
      <Defs id={id} />
      <ellipse cx="100" cy="84" rx="84" ry="56" fill={`url(#${id}-glow)`} />
      <path d="M30 110 C 70 66, 130 122, 172 62" fill="none" stroke={`url(#${id}-acc)`} strokeWidth="3" strokeLinecap="round" strokeDasharray="1 10" opacity="0.9" />
      <g transform="rotate(-8 62 74)">
        <rect x="38" y="52" width="48" height="42" rx="10" fill={glassFill} stroke={stroke} />
        <circle cx="52" cy="66" r="5" fill="#FFB27D" />
        <path d="M42 88 l12 -11 8 7 8 -6 12 10 a6 6 0 0 1 -6 6 h-28 a6 6 0 0 1 -6 -6z" fill={`url(#${id}-acc)`} opacity="0.75" />
      </g>
      <g transform="rotate(6 138 96)">
        <rect x="112" y="74" width="52" height="44" rx="10" fill={`url(#${id}-glass)`} stroke="rgba(255,255,255,0.3)" />
        <circle cx="128" cy="90" r="5.5" fill="#4FE0C6" />
        <path d="M116 112 l13 -12 9 8 8 -6 14 10 a6 6 0 0 1 -6 6 h-32 a6 6 0 0 1 -6 -6z" fill={`url(#${id}-acc)`} opacity="0.75" />
      </g>
      <path d="M158 34 l4 10 10 4 -10 4 -4 10 -4 -10 -10 -4 10 -4z" fill="#FFD08A" />
      <path d="M40 26 l2.6 6.6 6.6 2.6 -6.6 2.6 -2.6 6.6 -2.6 -6.6 -6.6 -2.6 6.6 -2.6z" fill="#7CC4FF" opacity="0.9" />
    </svg>
  );
}

/** Album book with photos slipping out. */
export function ArtAlbums({ className, style }: ArtProps) {
  const id = "il-al";
  return (
    <svg viewBox="0 0 200 160" className={className} style={style} aria-hidden="true">
      <Defs id={id} />
      <ellipse cx="100" cy="88" rx="84" ry="56" fill={`url(#${id}-glow)`} />
      {/* slipping photos */}
      <g transform="rotate(-14 120 60)">
        <rect x="92" y="30" width="58" height="44" rx="8" fill={glassFill} stroke={stroke} />
        <circle cx="108" cy="46" r="5" fill="#FFB27D" />
        <path d="M96 68 l14 -13 10 9 9 -7 15 11 a6 6 0 0 1 -6 6 h-36 a6 6 0 0 1 -6 -6z" fill={`url(#${id}-acc)`} opacity="0.7" />
      </g>
      {/* album cover */}
      <g>
        <rect x="42" y="52" width="102" height="78" rx="16" fill={`url(#${id}-glass)`} stroke="rgba(255,255,255,0.32)" />
        <rect x="42" y="52" width="102" height="30" rx="16" fill={`url(#${id}-shine)`} opacity="0.3" />
        <rect x="42" y="52" width="16" height="78" rx="8" fill={`url(#${id}-acc)`} opacity="0.85" />
        <rect x="70" y="70" width="56" height="8" rx="4" fill="rgba(255,255,255,0.3)" />
        <rect x="70" y="86" width="38" height="7" rx="3.5" fill="rgba(255,255,255,0.16)" />
        <circle cx="126" cy="112" r="9" fill={`url(#${id}-acc)`} opacity="0.9" />
        <path d="M122.5 112 l2.6 2.6 5 -5.4" stroke="#fff" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

/** Two near-identical frames with a difference highlight. */
export function ArtDupes({ className, style }: ArtProps) {
  const id = "il-du";
  return (
    <svg viewBox="0 0 200 160" className={className} style={style} aria-hidden="true">
      <Defs id={id} />
      <ellipse cx="100" cy="84" rx="84" ry="56" fill={`url(#${id}-glow)`} />
      <g transform="rotate(-6 78 82)">
        <rect x="34" y="44" width="82" height="66" rx="12" fill={glassFill} stroke={stroke} />
        <circle cx="56" cy="64" r="6" fill="#FFB27D" opacity="0.85" />
        <path d="M40 100 l20 -18 13 11 12 -9 21 16 a8 8 0 0 1 -8 8 h-50 a8 8 0 0 1 -8 -8z" fill="rgba(255,255,255,0.22)" />
      </g>
      <g transform="rotate(5 126 86)">
        <rect x="86" y="52" width="82" height="66" rx="12" fill={`url(#${id}-glass)`} stroke="rgba(255,255,255,0.32)" />
        <circle cx="108" cy="72" r="6" fill="#FFB27D" />
        <path d="M92 108 l20 -18 13 11 12 -9 21 16 a8 8 0 0 1 -8 8 h-50 a8 8 0 0 1 -8 -8z" fill={`url(#${id}-acc)`} opacity="0.8" />
        <circle cx="156" cy="64" r="12" fill="rgba(111,227,165,0.16)" stroke="#6FE3A5" strokeWidth="2" />
        <path d="M151.5 64 l3 3 6 -6.5" stroke="#6FE3A5" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  );
}

/** Shield of glass over a photo — privacy. */
export function ArtShield({ className, style }: ArtProps) {
  const id = "il-sh";
  return (
    <svg viewBox="0 0 200 160" className={className} style={style} aria-hidden="true">
      <Defs id={id} />
      <ellipse cx="100" cy="84" rx="84" ry="58" fill={`url(#${id}-glow)`} />
      {/* photo behind */}
      <g transform="rotate(-7 70 80)">
        <rect x="34" y="46" width="72" height="58" rx="11" fill={glassFill} stroke={stroke} />
        <circle cx="54" cy="64" r="5.5" fill="#FFB27D" opacity="0.9" />
        <path d="M38 94 l18 -16 11 10 10 -8 19 14 a7 7 0 0 1 -7 7 h-44 a7 7 0 0 1 -7 -7z" fill="rgba(255,255,255,0.2)" />
      </g>
      {/* shield */}
      <g>
        <path d="M124 34 l40 14 v28 c0 26 -17 42 -40 52 -23 -10 -40 -26 -40 -52 v-28z" fill={`url(#${id}-glass)`} stroke="rgba(255,255,255,0.36)" strokeWidth="1.6" />
        <path d="M124 34 l40 14 v14 h-80 v-14z" fill={`url(#${id}-shine)`} opacity="0.25" />
        <path d="M124 44 l30 10.5 v20.5 c0 19.5 -12.7 31.7 -30 39.7 -17.3 -8 -30 -20.2 -30 -39.7 v-20.5z" fill="rgba(14,18,34,0.5)" />
        <rect x="112" y="74" width="24" height="20" rx="6" fill={`url(#${id}-acc)`} />
        <path d="M117 74 v-6 a7 7 0 0 1 14 0 v6" fill="none" stroke={`url(#${id}-acc)`} strokeWidth="4" strokeLinecap="round" />
        <circle cx="124" cy="83" r="3" fill="#fff" />
      </g>
    </svg>
  );
}

/** Folder catching falling photos — add your library. */
export function ArtFolder({ className, style }: ArtProps) {
  const id = "il-fo";
  return (
    <svg viewBox="0 0 200 160" className={className} style={style} aria-hidden="true">
      <Defs id={id} />
      <ellipse cx="100" cy="92" rx="84" ry="54" fill={`url(#${id}-glow)`} />
      {/* falling photos */}
      <g transform="rotate(-16 78 44)">
        <rect x="58" y="24" width="40" height="32" rx="7" fill={glassFill} stroke={stroke} />
        <path d="M61 50 l10 -9 7 6 6 -5 11 8 a5 5 0 0 1 -5 5 h-24 a5 5 0 0 1 -5 -5z" fill={`url(#${id}-acc)`} opacity="0.7" />
      </g>
      <g transform="rotate(12 126 40)">
        <rect x="104" y="22" width="40" height="32" rx="7" fill={`url(#${id}-glass)`} stroke="rgba(255,255,255,0.3)" />
        <circle cx="116" cy="34" r="4" fill="#FFB27D" />
      </g>
      {/* folder */}
      <path d="M40 74 a10 10 0 0 1 10 -10 h28 l10 12 h62 a10 10 0 0 1 10 10 v38 a12 12 0 0 1 -12 12 h-96 a12 12 0 0 1 -12 -12z" fill={glassFill} stroke={stroke} />
      <path d="M36 86 a10 10 0 0 1 10 -10 h108 a10 10 0 0 1 10 10 l-6 40 a12 12 0 0 1 -12 10 h-92 a12 12 0 0 1 -12 -10z" fill={`url(#${id}-glass)`} stroke="rgba(255,255,255,0.34)" />
      <rect x="36" y="76" width="128" height="22" rx="10" fill={`url(#${id}-shine)`} opacity="0.22" />
      <circle cx="100" cy="112" r="13" fill={`url(#${id}-acc)`} opacity="0.95" />
      <path d="M100 106 v12 M94 112 h12" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}
