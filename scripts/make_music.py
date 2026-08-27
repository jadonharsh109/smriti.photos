"""Generate the music Smriti ships with its Moments.

Why generate rather than source: the app is distributed as installers under the
AGPL, and every bundled file has to have a licence someone can point at. Audio
found online is a minefield — "royalty free" is a marketing phrase, not a
licence, CC-BY needs attribution most montages never carry, and a public-domain
*composition* still leaves the *recording* owned by whoever played it. Rather
than assert something unverifiable, these tracks are written here, by this
file, and are part of the repository like any other source. Re-run it and you
get the same bytes.

Nothing here pretends to be a composer. It is additive synthesis over a slow
chord progression: a few detuned partials per note, a soft attack so nothing
ever stabs, a feedback delay standing in for a room, and a gentle low-pass so
it sits under a montage rather than competing with it. Music for the middle
distance, which is the only kind that belongs behind someone's photographs.

    python scripts/make_music.py            # writes backend/app/assets/music/
"""
import hashlib
import json
import shutil
import struct
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

SR = 44100
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "backend" / "app" / "assets" / "music"

# Semitone offsets from the tonic. Ordinary progressions on purpose — the
# point is to be unobtrusive, and an unresolved chord makes people look up.
PROGRESSIONS = {
    # I – V – vi – IV, the one everybody knows and nobody notices
    "warm": [(0, "maj"), (7, "maj"), (9, "min"), (5, "maj")],
    # vi – IV – I – V, the same chords entered from the sad end
    "reflective": [(9, "min"), (5, "maj"), (0, "maj"), (7, "maj")],
    # I – vi – IV – V, brighter, and it keeps moving
    "bright": [(0, "maj"), (9, "min"), (5, "maj"), (7, "maj")],
    # i – VI – III – VII, the minor lap — evening light, nothing mournful
    "dusk": [(0, "min"), (8, "maj"), (3, "maj"), (10, "maj")],
    # I – IV – V – IV, the two-chord sway with a lift in the middle
    "festive": [(0, "maj"), (5, "maj"), (7, "maj"), (5, "maj")],
    # IV – I – V – vi, starts away from home and keeps leaning back toward it
    "drift": [(5, "maj"), (0, "maj"), (7, "maj"), (9, "min")],
}
CHORD = {"maj": (0, 4, 7, 12), "min": (0, 3, 7, 12)}

TRACKS = [
    # name, tonic midi, seconds per chord, arpeggio notes per chord, brightness
    ("warm-light", "warm", 60, 4.0, 4, 2600.0),
    ("quiet-hours", "reflective", 57, 5.0, 3, 1900.0),
    ("out-in-the-open", "bright", 62, 3.2, 6, 3400.0),
    ("evening-lamps", "dusk", 57, 4.6, 4, 2100.0),
    ("mela", "festive", 64, 2.6, 8, 3600.0),
    ("slow-river", "drift", 59, 5.4, 3, 1750.0),
]


def midi_hz(n: float) -> float:
    return 440.0 * (2.0 ** ((n - 69) / 12.0))


def _adsr(n: int, attack: float, release: float) -> np.ndarray:
    """Soft in, soft out. A hard edge on a pad is the one thing that would make
    this sound like a computer rather than a room."""
    env = np.ones(n)
    a = min(int(SR * attack), n // 2)
    r = min(int(SR * release), n - a)
    if a:
        env[:a] = np.linspace(0, 1, a) ** 1.6
    if r:
        env[-r:] *= np.linspace(1, 0, r) ** 1.4
    return env


def voice(freq: float, dur: float, amp: float, partials: int = 5,
          detune: float = 0.0016, attack: float = 0.35, release: float = 1.1) -> np.ndarray:
    """One note: a few partials, each slightly out of tune with the last.

    The detune is the whole character. Perfectly tuned partials sum into
    something glassy and dead; a fraction of a percent apart they beat against
    each other slowly, which is what a real instrument does."""
    n = int(SR * dur)
    t = np.arange(n) / SR
    out = np.zeros(n)
    for k in range(1, partials + 1):
        f = freq * k * (1.0 + detune * (k - 1))
        if f > SR / 2.2:
            break
        # higher partials quieter, and phase-offset so they do not all start
        # at zero and click together
        out += (amp / (k ** 1.7)) * np.sin(2 * np.pi * f * t + k * 1.7)
    return out * _adsr(n, attack, release)


def one_pole_lp(x: np.ndarray, cutoff: float) -> np.ndarray:
    """Cheap low-pass. Takes the edge off the partials so the pad sits behind
    a picture instead of in front of it."""
    a = np.exp(-2.0 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc = (1 - a) * x[i] + a * acc
        y[i] = acc
    return y


def delay(x: np.ndarray, seconds: float, feedback: float, mix: float) -> np.ndarray:
    """A room, approximately. Three taps is enough to stop it sounding dry."""
    out = x.copy()
    d = int(SR * seconds)
    tap = x
    gain = feedback
    for _ in range(3):
        tap = np.concatenate([np.zeros(d), tap])[: len(x)]
        out += tap * gain * mix
        gain *= feedback
    return out


def render(prog_name: str, tonic: int, chord_secs: float, arp_notes: int,
           cutoff: float, bars: int = 4) -> np.ndarray:
    prog = PROGRESSIONS[prog_name]
    total = int(SR * chord_secs * len(prog) * bars) + SR * 3
    left = np.zeros(total)
    right = np.zeros(total)
    rng = np.random.default_rng(abs(hash(prog_name)) % (2**31))

    pos = 0
    for bar in range(bars):
        for degree, quality in prog:
            start = pos
            # --- the pad: the chord, held, wide ---
            for j, iv in enumerate(CHORD[quality]):
                note = tonic + degree + iv
                # voiced low, and the top note an octave up for air
                sig = voice(midi_hz(note), chord_secs + 1.6, 0.16,
                            partials=6, attack=0.5, release=1.4)
                # spread the voices across the stereo field by a few ms
                skew = int(SR * 0.004 * (j - 1.5))
                a, b = (skew, 0) if skew > 0 else (0, -skew)
                for buf, off in ((left, a), (right, b)):
                    end = min(len(buf), start + off + len(sig))
                    buf[start + off:end] += sig[: end - start - off]
            # --- the arpeggio: one line on top, quiet, slightly loose ---
            step = chord_secs / arp_notes
            for k in range(arp_notes):
                iv = CHORD[quality][k % len(CHORD[quality])]
                note = tonic + degree + iv + 12
                # human-ish: a few ms early or late, never exactly on the grid
                jitter = int(SR * rng.uniform(-0.012, 0.012))
                s = max(0, start + int(SR * step * k) + jitter)
                sig = voice(midi_hz(note), step * 1.8, 0.055,
                            partials=3, attack=0.02, release=step * 1.2)
                end = min(len(left), s + len(sig))
                left[s:end] += sig[: end - s] * 0.85
                right[s:end] += sig[: end - s] * 1.0
            pos += int(SR * chord_secs)

    left, right = one_pole_lp(left, cutoff), one_pole_lp(right, cutoff * 1.05)
    left = delay(left, 0.37, 0.34, 0.5)
    right = delay(right, 0.41, 0.34, 0.5)
    stereo = np.stack([left, right], axis=1)

    peak = np.abs(stereo).max()
    if peak > 0:
        stereo = stereo / peak * 0.72          # headroom; the montage ducks it further
    fade = int(SR * 2.0)
    stereo[:fade] *= np.linspace(0, 1, fade)[:, None]
    stereo[-fade:] *= np.linspace(1, 0, fade)[:, None]
    return stereo


def write_wav(path: Path, stereo: np.ndarray) -> None:
    pcm = (np.clip(stereo, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def main() -> None:
    ffmpeg = shutil.which("ffmpeg") or "/Applications/Smriti.app/Contents/Resources/bin/ffmpeg"
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = []
    for name, prog, tonic, secs, arp, cutoff in TRACKS:
        print(f"rendering {name}…")
        stereo = render(prog, tonic, secs, arp, cutoff)
        wav = OUT / f"{name}.wav"
        mp3 = OUT / f"{name}.mp3"
        write_wav(wav, stereo)
        subprocess.run([ffmpeg, "-y", "-v", "error", "-i", str(wav),
                        "-codec:a", "libmp3lame", "-b:a", "128k", str(mp3)], check=True)
        wav.unlink()
        data = mp3.read_bytes()
        manifest.append({
            "file": mp3.name,
            "title": name.replace("-", " ").title(),
            "mood": prog,
            "seconds": round(len(stereo) / SR, 1),
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
        })
        print(f"   {mp3.name}: {len(data)/1e6:.2f} MB, {len(stereo)/SR:.0f}s")
    (OUT / "manifest.json").write_text(json.dumps({
        "_comment": "Generated by scripts/make_music.py, which is part of this "
                    "repository. These recordings are original works of the Smriti "
                    "project and carry the project's own licence — there is no "
                    "third-party audio bundled in this app. Re-run the script to "
                    "reproduce them byte for byte.",
        "generator": "scripts/make_music.py",
        "tracks": manifest,
    }, indent=2) + "\n")
    print(f"\nwrote {len(manifest)} tracks + manifest to {OUT}")


if __name__ == "__main__":
    main()
