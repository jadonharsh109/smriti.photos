import { useQuery } from "@tanstack/react-query";
import { Suspense, lazy, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import {
  ArtAlbums,
  ArtDupes,
  ArtEvents,
  ArtPeople,
  ArtPhotos,
  ArtPlaces,
  ArtShield,
} from "../components/Illustrations";
import Logo from "../components/Logo";

// three.js lives in its own chunk — the app itself never pays for it
const Hero3D = lazy(() => import("../components/Hero3D"));

interface Stats {
  photos: number;
  videos: number;
  persons: number;
  people_visible: number;
  faces: number;
  geocoded: number;
}

/** Adds .in when the element scrolls into view (drives the reveal transition). */
function Reveal({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          el.classList.add("in");
          io.disconnect();
        }
      },
      { threshold: 0.15 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={`reveal ${className}`}>
      {children}
    </div>
  );
}

const fmt = (n: number | undefined) => (n == null ? "—" : n.toLocaleString());

export default function LandingPage() {
  const { data: stats } = useQuery({
    queryKey: ["stats"],
    queryFn: () => api.get<Stats>("/api/stats"),
  });
  const hasLibrary = (stats?.photos ?? 0) + (stats?.videos ?? 0) > 0;

  return (
    <>
      <div className="aurora">
        <i /><i /><i /><i />
      </div>
      <div className="grain" />

      <div className="lp">
        <nav className="lp-nav" data-tauri-drag-region>
          <div className="lp-nav-inner">
            <span className="brand">
              <Logo size={27} />
              <span>
                smriti<span className="faint">.photos</span>
              </span>
            </span>
            <div className="links">
              <a href="#features">Features</a>
              <a href="#how">How it works</a>
              <a href="#privacy">Privacy</a>
            </div>
            <span className="spacer" />
            <Link to="/">
              <button className="primary">Open library</button>
            </Link>
          </div>
        </nav>

        {/* ---- hero ---- */}
        <header className="lp-hero">
          <Suspense fallback={null}>
            <Hero3D />
          </Suspense>
          <div className="lp-hero-copy lp-inner">
            <div className="lp-eyebrow">
              <span className="dot" />
              <span className="dev">स्मृति</span>&nbsp;· smṛti — Sanskrit for “that which is remembered”
            </div>
            <h1 className="lp-title dev warm">
              हर याद,
              <br />
              संजोई हुई।
            </h1>
            <p className="lp-sub">
              <em>Every memory, lovingly kept.</em> Smriti turns the photo folders
              on your drives into a living library — <span className="dev">यादें</span>, <span className="dev">लोग</span>,{" "}
              <span className="dev">जगहें</span> — all of it computed on your machine,
              none of it leaving it. No cloud, no accounts.
            </p>
            <div className="lp-cta">
              <Link to="/">
                <button className="primary big">{hasLibrary ? "Open your library" : "Start organizing"}</button>
              </Link>
              <a href="#features">
                <button className="big">See what's inside</button>
              </a>
            </div>
            <div className="lp-stats">
              <span className="chip"><span className="dot" /><strong>{fmt(stats?.photos)}</strong>&nbsp;photos indexed</span>
              <span className="chip"><strong>{fmt(stats?.videos)}</strong>&nbsp;videos</span>
              <span className="chip"><strong>{fmt(stats?.people_visible)}</strong>&nbsp;people recognized</span>
              <span className="chip"><strong>{fmt(stats?.geocoded)}</strong>&nbsp;photos placed on the map</span>
            </div>
          </div>
        </header>

        <div className="lp-motif" />

        {/* ---- features ---- */}
        <section className="lp-section lp-inner" id="features">
          <Reveal className="lp-sec-head">
            <div className="k"><span className="dev">यादें</span> · The library</div>
            <h2>Six ways through your photos</h2>
            <p>One index on disk — explored from every angle.</p>
          </Reveal>
          <div className="lp-bento">
            <Reveal className="lp-feature wide">
              <span className="glow" style={{ background: "#ff9a5e" }} />
              <ArtPhotos className="art" />
              <div className="hin dev">यादें</div>
              <h3>A timeline that flies</h3>
              <p>
                Justified, edge-to-edge photo rows grouped by day, virtualized to
                glide through a hundred thousand shots. Scrub years with a flick.
              </p>
            </Reveal>
            <Reveal className="lp-feature wide d1">
              <span className="glow" style={{ background: "#ff7b9c" }} />
              <ArtPeople className="art" />
              <div className="hin dev">अपने लोग</div>
              <h3>People, found on-device</h3>
              <p>
                Faces are detected and grouped by a neural engine running locally.
                Name someone once and every photo of them lines up.
              </p>
            </Reveal>
            <Reveal className="lp-feature">
              <span className="glow" style={{ background: "#7cc4ff" }} />
              <ArtPlaces className="art" />
              <div className="hin dev">जगहें</div>
              <h3>Places &amp; a globe</h3>
              <p>GPS becomes cities and countries — resolved offline — on a spinning 3D globe.</p>
            </Reveal>
            <Reveal className="lp-feature d1">
              <span className="glow" style={{ background: "#ffb25e" }} />
              <ArtEvents className="art" />
              <div className="hin dev">सफ़र</div>
              <h3>Events, auto-split</h3>
              <p>Trips and moments detected from the gaps in your timeline, ready to rename.</p>
            </Reveal>
            <Reveal className="lp-feature d2">
              <span className="glow" style={{ background: "#4fe0c6" }} />
              <ArtDupes className="art" />
              <div className="hin dev">सफ़ाई</div>
              <h3>Duplicate hunter</h3>
              <p>Exact and near-duplicates surfaced with a suggested keeper — cleanup goes to the recoverable Trash.</p>
            </Reveal>
            <Reveal className="lp-feature wide d1">
              <span className="glow" style={{ background: "#b96bff" }} />
              <ArtAlbums className="art" />
              <div className="hin dev">एल्बम</div>
              <h3>Albums without moving a file</h3>
              <p>
                Albums are virtual collections over your existing folder structure.
                Curate freely — your carefully arranged directories stay exactly as
                they are.
              </p>
            </Reveal>
          </div>
        </section>

        <div className="lp-motif" />

        {/* ---- how it works ---- */}
        <section className="lp-section lp-inner" id="how">
          <Reveal className="lp-sec-head">
            <div className="k"><span className="dev">शुरुआत</span> · Setup</div>
            <h2>Three steps, one evening</h2>
            <p>Point it at a folder and let the background jobs do the rest.</p>
          </Reveal>
          <div className="lp-steps">
            <Reveal className="lp-step">
              <span className="num">1</span>
              <h3>Add your folders</h3>
              <p>
                Pick the photo folders on your Mac or external SSD. Drives are
                tracked by identity — unplug and replug freely.
              </p>
            </Reveal>
            <Reveal className="lp-step d1">
              <span className="num">2</span>
              <h3>Let it index</h3>
              <p>
                Thumbnails, EXIF, locations, faces and duplicates are computed in
                the background. Watch the progress live in the sidebar.
              </p>
            </Reveal>
            <Reveal className="lp-step d2">
              <span className="num">3</span>
              <h3>Explore</h3>
              <p>
                Fly through the timeline, name your people, spin the globe, and
                reclaim gigabytes from duplicates.
              </p>
            </Reveal>
          </div>
        </section>

        <div className="lp-motif" />

        {/* ---- privacy ---- */}
        <section className="lp-section lp-inner" id="privacy">
          <Reveal>
            <div className="lp-privacy">
              <ArtShield className="art" />
              <div>
                <div className="k" style={{ marginBottom: 8 }}><span className="dev">निजता</span> · Privacy</div>
                <h2>
                  <span className="dev">आपकी यादें, सिर्फ़ आपके पास।</span>
                </h2>
                <p>
                  Your memories stay with you alone. Smriti is a local app in the
                  truest sense: the server runs on your machine, the database lives
                  in a folder you can see, and the machine-learning models are
                  files on your disk.
                </p>
                <ul>
                  <li><span className="tick">✓</span> Face recognition runs on your CPU — photos never leave the machine</li>
                  <li><span className="tick">✓</span> Reverse geocoding from a bundled offline dataset</li>
                  <li><span className="tick">✓</span> Originals stay untouched — deleting is always a recoverable move to the system Trash</li>
                  <li><span className="tick">✓</span> Works with the network cable unplugged</li>
                </ul>
              </div>
            </div>
          </Reveal>
        </section>

        {/* ---- final CTA ---- */}
        <section className="lp-final lp-inner">
          <Reveal>
            <h2 className="lp-title dev warm" style={{ fontSize: "clamp(34px,5vw,54px)" }}>
              आपकी यादें यहीं हैं।
            </h2>
            <p className="lp-sub">Your photos are already here — open the library and see them the way they deserve to be seen.</p>
            <div className="lp-cta">
              <Link to="/">
                <button className="primary big">Open Smriti</button>
              </Link>
            </div>
          </Reveal>
          <footer className="lp-footer">
            <span className="row" style={{ gap: 8 }}>
              <Logo size={18} /> smriti.photos · <span className="dev">स्मृति</span> — a local photo library
            </span>
            <span>Made with ♥ in India · runs entirely on this machine</span>
          </footer>
        </section>
      </div>
    </>
  );
}
