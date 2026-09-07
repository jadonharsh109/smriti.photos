/** A small friend that lives in the window.
 *
 *  Picked in Appearance. It wanders, follows the cursor a little when the
 *  cursor comes near, sits down, and nods off when nobody has moved the mouse
 *  for a while. Click it and it does a trick — a jump with a burst of the
 *  things it likes — and says something. It hides while the viewer or a sheet
 *  is open, and stays put for anyone who has asked their system for less
 *  motion. Purely decorative: it never blocks a click on anything under it
 *  for long, because it is small and keeps moving. */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ui, type CompanionKind } from "./store";

interface Spec {
  speed: number;        // px per second
  flies: boolean;       // no legs, floats
  sayings: string[];
  bits: string[];       // what bursts out on a click
}
const SPECS: Record<Exclude<CompanionKind, "none">, Spec> = {
  cat: { speed: 95, flies: false, sayings: ["meow", "mrrp?", "purr~", "…", "mew!"], bits: ["🐟", "♥", "✦", "🧶"] },
  dog: { speed: 120, flies: false, sayings: ["woof!", "arf", "hehe", "🦴?", "wag wag"], bits: ["🦴", "♥", "✦", "🎾"] },
  duck: { speed: 60, flies: false, sayings: ["quack", "QUACK", "…quack?", "hm."], bits: ["🫧", "✦", "🍞", "♥"] },
  ghost: { speed: 50, flies: true, sayings: ["boo", "ooOOoo", "…", "hi."], bits: ["✦", "✧", "☾", "★"] },
  bee: { speed: 150, flies: true, sayings: ["bzz", "bzzz!", "hm hm hm", "♪"], bits: ["✦", "🌼", "🍯", "♥"] },
};

type Mode = "sit" | "walk" | "sleep" | "trick";

interface Body {
  x: number;
  y: number;
  tx: number;
  ty: number;
  facing: 1 | -1;
  mode: Mode;
  until: number;
  mouse: { x: number; y: number; t: number };
  clicks: number;
  lastCheck: number;
  hidden: boolean;
}

const W = 56; // sprite box
const H = 44;

export default function Companion() {
  const kind = ui.use((s) => s.companion);
  if (kind === "none") return null;
  return <Critter kind={kind} key={kind} />;
}

function Critter({ kind }: { kind: Exclude<CompanionKind, "none"> }) {
  const spec = SPECS[kind];
  const el = useRef<HTMLDivElement>(null);
  const body = useRef<Body>({
    x: Math.max(240, window.innerWidth - 160),
    y: Math.max(80, window.innerHeight - 120),
    tx: 0,
    ty: 0,
    facing: -1,
    mode: "sit",
    until: performance.now() + 1500,
    mouse: { x: -1e4, y: -1e4, t: 0 },
    clicks: 0,
    lastCheck: 0,
    hidden: false,
  });
  const [mode, setMode] = useState<Mode>("sit");
  const [facing, setFacing] = useState<1 | -1>(-1);
  const [hidden, setHidden] = useState(false);
  const [say, setSay] = useState<{ id: number; text: string } | null>(null);
  const [burst, setBurst] = useState<{ id: number; bits: { text: string; dx: number; dy: number; rot: number }[] } | null>(null);
  const still = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    const b = body.current;
    const pickTarget = () => {
      const pad = 24;
      const top = 60;
      b.tx = pad + Math.random() * Math.max(40, window.innerWidth - W - pad * 2);
      b.ty = top + Math.random() * Math.max(40, window.innerHeight - H - top - 40);
    };
    const enter = (m: Mode, ms: number) => {
      b.mode = m;
      b.until = performance.now() + ms;
      setMode(m);
    };
    const onMove = (e: MouseEvent) => {
      b.mouse = { x: e.clientX, y: e.clientY, t: performance.now() };
      if (b.mode === "sleep") enter("sit", 800);
    };
    window.addEventListener("mousemove", onMove);
    const onResize = () => {
      b.x = Math.min(b.x, window.innerWidth - W);
      b.y = Math.min(b.y, window.innerHeight - H);
    };
    window.addEventListener("resize", onResize);

    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      // out of the way while someone is looking at one photo or answering a sheet
      if (now - b.lastCheck > 250) {
        b.lastCheck = now;
        const hide = !!document.querySelector(".viewer, .scrim");
        if (hide !== b.hidden) {
          b.hidden = hide;
          setHidden(hide);
        }
      }
      if (b.hidden || still) return;

      if (b.mode === "trick") {
        if (now > b.until) enter("sit", 1200);
        return;
      }
      const cx = b.x + W / 2;
      const cy = b.y + H / 2;
      const mdx = b.mouse.x - cx;
      const mdy = b.mouse.y - cy;
      const mdist = Math.hypot(mdx, mdy);
      const mouseFresh = now - b.mouse.t < 1500;

      if (b.mode === "sleep") return;

      // a cursor moving nearby is worth following — to a polite distance
      if (mouseFresh && mdist < 260 && mdist > 64 && b.mode !== "walk") {
        b.tx = b.mouse.x - W / 2 - Math.sign(mdx) * 48;
        b.ty = b.mouse.y - H / 2 + 8;
        enter("walk", 4000);
      }

      if (b.mode === "sit") {
        if (now > b.until) {
          if (now - b.mouse.t > 40_000) enter("sleep", 1e9);
          else {
            pickTarget();
            enter("walk", 8000);
          }
        }
        return;
      }

      // walk
      const dx = b.tx - b.x;
      const dy = b.ty - b.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 3 || now > b.until) {
        enter("sit", 1500 + Math.random() * 4500);
        return;
      }
      const speed = spec.speed * (mouseFresh && mdist < 260 ? 1.4 : 1);
      const step = Math.min(dist, speed * dt);
      b.x += (dx / dist) * step;
      b.y += (dy / dist) * step + (spec.flies ? Math.sin(now / 180) * 0.6 : 0);
      const f: 1 | -1 = dx < -0.5 ? -1 : dx > 0.5 ? 1 : b.facing;
      if (f !== b.facing) {
        b.facing = f;
        setFacing(f);
      }
      if (el.current) el.current.style.transform = `translate(${b.x}px, ${b.y}px)`;
    };
    if (el.current) el.current.style.transform = `translate(${b.x}px, ${b.y}px)`;
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("resize", onResize);
    };
  }, [spec, still]);

  const trick = () => {
    const b = body.current;
    if (b.mode === "trick") return;
    b.clicks += 1;
    b.mode = "trick";
    b.until = performance.now() + 900;
    setMode("trick");
    const id = Date.now();
    const n = 10 + Math.floor(Math.random() * 5);
    setBurst({
      id,
      bits: Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
        const r = 46 + Math.random() * 40;
        return { text: spec.bits[Math.floor(Math.random() * spec.bits.length)], dx: Math.cos(a) * r, dy: Math.sin(a) * r - 30, rot: (Math.random() - 0.5) * 240 };
      }),
    });
    setSay({ id, text: spec.sayings[Math.floor(Math.random() * spec.sayings.length)] });
    window.setTimeout(() => setBurst((cur) => (cur?.id === id ? null : cur)), 1000);
    window.setTimeout(() => setSay((cur) => (cur?.id === id ? null : cur)), 1600);
    // every so often it takes off across the whole window
    if (b.clicks % 4 === 0) {
      window.setTimeout(() => {
        b.tx = Math.random() < 0.5 ? 24 : window.innerWidth - W - 24;
        b.ty = 80 + Math.random() * Math.max(40, window.innerHeight - 200);
        b.mode = "walk";
        b.until = performance.now() + 6000;
        setMode("walk");
      }, 950);
    }
  };

  return createPortal(
    <div ref={el} className={`cmp ${kind} ${mode}${spec.flies ? " flies" : ""}${hidden ? " hidden" : ""}`} aria-hidden="true">
      {say && <div className="cmp-say" key={say.id}>{say.text}</div>}
      {mode === "sleep" && <div className="cmp-zz">z<span>z</span><span>z</span></div>}
      <button className="cmp-hit" title="Click me" onClick={trick} onDoubleClick={(e) => e.preventDefault()} style={{ transform: `scaleX(${facing})` }}>
        <Figure kind={kind} />
      </button>
      {burst && (
        <div className="cmp-burst" key={burst.id}>
          {burst.bits.map((p, i) => (
            <span key={i} style={{ "--dx": `${p.dx}px`, "--dy": `${p.dy}px`, "--rot": `${p.rot}deg` } as React.CSSProperties}>{p.text}</span>
          ))}
        </div>
      )}
    </div>,
    document.body
  );
}

/** The drawings — flat shapes, a few classes the stylesheet animates. Facing
 *  right in the source; the walker flips them. Also used, still, as the
 *  preview in Appearance. */
export function Figure({ kind }: { kind: Exclude<CompanionKind, "none"> }) {
  switch (kind) {
    case "cat":
      return (
        <svg viewBox="0 0 56 44" width={W} height={H} className="fig">
          <path className="tail" d="M12 30 C 4 30, 2 22, 8 18" fill="none" stroke="#e08a3c" strokeWidth="4.5" strokeLinecap="round" />
          <rect className="leg l1" x="18" y="30" width="5" height="9" rx="2" fill="#e08a3c" />
          <rect className="leg l2" x="25" y="30" width="5" height="9" rx="2" fill="#d67d2f" />
          <rect className="leg l3" x="34" y="30" width="5" height="9" rx="2" fill="#e08a3c" />
          <rect className="leg l4" x="41" y="30" width="5" height="9" rx="2" fill="#d67d2f" />
          <ellipse className="torso" cx="31" cy="27" rx="16" ry="9.5" fill="#f0a35a" />
          <path d="M27 20 q3 5 0 10 M33 19 q3 6 0 12" stroke="#d67d2f" strokeWidth="2" fill="none" strokeLinecap="round" />
          <g className="head">
            <polygon points="34,14 37,3 42,13" fill="#f0a35a" />
            <polygon points="46,13 52,4 53,15" fill="#f0a35a" />
            <polygon points="36,13 38,7 41,13" fill="#f7c9a3" />
            <polygon points="47,13 50,8 52,14" fill="#f7c9a3" />
            <circle cx="44" cy="18" r="10" fill="#f0a35a" />
            <ellipse className="eye" cx="40.5" cy="17" rx="1.7" ry="2.4" fill="#2b2320" />
            <ellipse className="eye" cx="48" cy="17" rx="1.7" ry="2.4" fill="#2b2320" />
            <path d="M43 22 l1.5 1.5 l1.5 -1.5" stroke="#2b2320" strokeWidth="1.2" fill="none" />
            <circle cx="44.5" cy="21.2" r="1.1" fill="#d96a7a" />
            <path d="M31 21 l6 1 M31 24 l6 -0.5 M57 21 l-6 1 M57 24 l-6 -0.5" stroke="#5a4a40" strokeWidth="0.8" opacity="0.7" />
          </g>
        </svg>
      );
    case "dog":
      return (
        <svg viewBox="0 0 56 44" width={W} height={H} className="fig">
          <path className="tail" d="M12 26 C 6 24, 4 16, 9 13" fill="none" stroke="#b8894f" strokeWidth="4.5" strokeLinecap="round" />
          <rect className="leg l1" x="17" y="30" width="5.5" height="10" rx="2" fill="#b8894f" />
          <rect className="leg l2" x="24" y="30" width="5.5" height="10" rx="2" fill="#a67b45" />
          <rect className="leg l3" x="33" y="30" width="5.5" height="10" rx="2" fill="#b8894f" />
          <rect className="leg l4" x="40" y="30" width="5.5" height="10" rx="2" fill="#a67b45" />
          <ellipse className="torso" cx="30" cy="27" rx="16" ry="9.5" fill="#c9a26b" />
          <ellipse cx="28" cy="31" rx="9" ry="4" fill="#e6d2ad" />
          <g className="head">
            <circle cx="43" cy="17" r="10" fill="#c9a26b" />
            <ellipse className="ear" cx="35" cy="17" rx="3.5" ry="8" fill="#8f6a3c" />
            <ellipse cx="46" cy="21" rx="5" ry="3.8" fill="#e6d2ad" />
            <ellipse className="eye" cx="41" cy="14.5" rx="1.7" ry="2.2" fill="#2b2320" />
            <ellipse className="eye" cx="48" cy="14.5" rx="1.7" ry="2.2" fill="#2b2320" />
            <ellipse cx="49" cy="20" rx="2.2" ry="1.6" fill="#2b2320" />
            <path className="tongue" d="M45 24 q1.5 3 3 0" stroke="#e57a8a" strokeWidth="2.2" strokeLinecap="round" fill="none" />
          </g>
        </svg>
      );
    case "duck":
      return (
        <svg viewBox="0 0 56 44" width={W} height={H} className="fig">
          <path className="leg l1" d="M27 36 v5 M24 41 h6" stroke="#f28c28" strokeWidth="2.2" strokeLinecap="round" fill="none" />
          <path className="leg l3" d="M35 36 v5 M32 41 h6" stroke="#f28c28" strokeWidth="2.2" strokeLinecap="round" fill="none" />
          <g className="torso">
            <ellipse cx="30" cy="29" rx="15" ry="9" fill="#f7d94c" />
            <path d="M18 27 q-6 -2 -8 -8 q6 2 10 6z" fill="#f7d94c" />
            <path className="wing" d="M24 27 q8 -6 14 2 q-8 4 -14 -2z" fill="#e6c437" />
            <circle cx="42" cy="16" r="8.5" fill="#f7d94c" />
            <polygon points="49,15 58,17 49,20" fill="#f28c28" />
            <ellipse className="eye" cx="44" cy="14" rx="1.6" ry="2" fill="#2b2320" />
          </g>
        </svg>
      );
    case "ghost":
      return (
        <svg viewBox="0 0 56 44" width={W} height={H} className="fig">
          <g className="torso">
            <path d="M14 40 v-20 a14 14 0 0 1 28 0 v20 l-4.5 -4 l-4.5 4 l-4.5 -4 l-4.5 4 l-4.5 -4 l-4.5 4z" fill="#eef0fb" opacity="0.95" />
            <path d="M18 38 v-18 a10 10 0 0 1 20 0 v18" fill="none" stroke="#c9cdf0" strokeWidth="1" opacity="0.7" />
            <ellipse className="eye" cx="24" cy="18" rx="2.2" ry="3.2" fill="#3a3550" />
            <ellipse className="eye" cx="33" cy="18" rx="2.2" ry="3.2" fill="#3a3550" />
            <ellipse cx="28.5" cy="26" rx="2.2" ry="1.4" fill="#3a3550" opacity="0.8" />
            <ellipse cx="20" cy="24" rx="2.5" ry="1.4" fill="#f7b8c4" opacity="0.7" />
            <ellipse cx="37" cy="24" rx="2.5" ry="1.4" fill="#f7b8c4" opacity="0.7" />
          </g>
        </svg>
      );
    case "bee":
      return (
        <svg viewBox="0 0 56 44" width={W} height={H} className="fig">
          <g className="torso">
            <ellipse className="wing w1" cx="26" cy="14" rx="9" ry="5" fill="#dfeefe" opacity="0.85" />
            <ellipse className="wing w2" cx="34" cy="13" rx="8" ry="4.5" fill="#dfeefe" opacity="0.7" />
            <path d="M14 26 l-6 1" stroke="#2b2320" strokeWidth="2" strokeLinecap="round" />
            <ellipse cx="29" cy="26" rx="14" ry="9" fill="#f6c343" />
            <path d="M22 18.5 v15 M29 17 v18 M36 18.5 v15" stroke="#2b2320" strokeWidth="4" strokeLinecap="round" />
            <circle cx="43" cy="24" r="6.5" fill="#2b2320" />
            <circle cx="45" cy="22.5" r="1.4" fill="#fff" />
            <path d="M44 18 q2 -4 5 -5 M46 19 q3 -3 6 -2" stroke="#2b2320" strokeWidth="1.3" fill="none" strokeLinecap="round" />
          </g>
        </svg>
      );
  }
}
