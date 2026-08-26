import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { personFaces, setPersonCover, type Person } from "../api/client";
import { IconClose } from "./Icons";
import Portal from "./Portal";

interface Props {
  person: Person;
  onClose: () => void;
}

/** Choosing the face that stands for someone.
 *
 *  Smriti picks a cover on its own — the biggest, most confident face it can
 *  see, preferring one where the person is alone. It is a decent guess and
 *  sometimes a poor one: the photo it lands on can be a squint, a half-turn, or
 *  simply not how someone would like to be shown. This is the override.
 *
 *  Faces, not photos. A cover is drawn as a round crop everywhere it appears,
 *  so the crop is the thing being chosen — and a group shot holds several, one
 *  per person in it. Offering the photo would put Smriti back to guessing which
 *  face in it was meant, which is the guess this exists to settle. */
export default function CoverPicker({ person, onClose }: Props) {
  const qc = useQueryClient();
  const { data: faces, isLoading } = useQuery({
    queryKey: ["person-faces", person.id],
    queryFn: () => personFaces(person.id),
  });

  const choose = useMutation({
    mutationFn: (faceId: number | null) => setPersonCover(person.id, faceId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["person", person.id] });
      qc.invalidateQueries({ queryKey: ["people"] });
      onClose();
    },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !choose.isPending) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, choose.isPending]);

  const who = person.name ?? "this person";
  const count = faces?.length ?? 0;
  return (
    <Portal>
      <div className="modal-back" onClick={() => !choose.isPending && onClose()}>
        <div className="modal" style={{ width: 620 }} onClick={(e) => e.stopPropagation()}>
          <header>
            Choose a photo for {who}
            <span className="spacer" />
            <button
              className="icon-btn"
              style={{ width: 30, height: 30 }}
              disabled={choose.isPending}
              onClick={onClose}
            >
              <IconClose size={15} />
            </button>
          </header>

          <div className="modal-body">
            {choose.error && (
              <p className="sub" style={{ color: "var(--danger)" }}>
                {String((choose.error as Error).message)}
              </p>
            )}
            {isLoading ? (
              <div className="face-pick-grid">
                {/* the grid it is about to become, so nothing jumps */}
                {Array.from({ length: 12 }, (_, i) => (
                  <div key={i} className="face-pick">
                    <div className="skeleton" style={{ width: "100%", aspectRatio: 1, borderRadius: "50%" }} />
                  </div>
                ))}
              </div>
            ) : count === 0 ? (
              <p className="muted small" style={{ padding: "10px 0" }}>
                Nothing to choose from — every photo of {who} is either on a drive that isn’t
                connected or in the Locked section.
              </p>
            ) : (
              <>
                <p className="muted small" style={{ margin: "0 0 12px" }}>
                  {count === 1
                    ? "The one face Smriti has of them."
                    : `Pick any of the ${count} faces Smriti has of them.`}
                </p>
                <div className="face-pick-grid">
                  {faces!.map((f) => (
                    <button
                      key={f.id}
                      className={`face-pick${f.id === person.cover_face_id ? " on" : ""}`}
                      disabled={choose.isPending}
                      title={f.id === person.cover_face_id ? "This is the current photo" : "Use this photo"}
                      onClick={() => choose.mutate(f.id)}
                    >
                      <img src={`/api/faces/${f.id}/thumb`} loading="lazy" decoding="async" alt="" />
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Only worth offering once a choice has actually been made — before
              that, "let Smriti choose" is what is already happening. */}
          <footer>
            {person.cover_src === "manual" && (
              <button
                className="ghost"
                style={{ marginRight: "auto" }}
                disabled={choose.isPending}
                title="Go back to the face Smriti would pick on its own"
                onClick={() => choose.mutate(null)}
              >
                Let Smriti choose
              </button>
            )}
            <button disabled={choose.isPending} onClick={onClose}>
              Done
            </button>
          </footer>
        </div>
      </div>
    </Portal>
  );
}
