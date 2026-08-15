/** Smriti (स्मृति) brand mark — a white lotus on a saffron→rose→violet
 * glass squircle. The lotus holds memory; the palette is a Jaipur dusk. */
export default function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="sm-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#FFB25E" />
          <stop offset="0.5" stopColor="#FF7B9C" />
          <stop offset="1" stopColor="#B96BFF" />
        </linearGradient>
        <linearGradient id="sm-shine" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(255,255,255,0.5)" />
          <stop offset="0.6" stopColor="rgba(255,255,255,0)" />
        </linearGradient>
      </defs>
      <rect x="1.5" y="1.5" width="29" height="29" rx="9.5" fill="url(#sm-mark)" />
      <rect x="1.5" y="1.5" width="29" height="29" rx="9.5" fill="url(#sm-shine)" opacity="0.55" />
      <rect x="1.5" y="1.5" width="29" height="29" rx="9.5" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="0.8" />
      {/* lotus: center petal, two side petals, cradle leaf */}
      <path d="M16 6.6c2.6 3.3 2.6 7.4 0 10.2-2.6-2.8-2.6-6.9 0-10.2z" fill="#fff" opacity="0.97" />
      <path d="M9.2 10.6c3.5 0.5 6.1 2.9 6.7 6.3-3.5-0.3-6.2-2.8-6.7-6.3z" fill="#fff" opacity="0.82" />
      <path d="M22.8 10.6c-3.5 0.5-6.1 2.9-6.7 6.3 3.5-0.3 6.2-2.8 6.7-6.3z" fill="#fff" opacity="0.82" />
      <path d="M9 19.2c2 2 4.4 3 7 3s5-1 7-3" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" opacity="0.95" />
      <circle cx="16" cy="24.9" r="1.15" fill="#fff" opacity="0.9" />
    </svg>
  );
}
