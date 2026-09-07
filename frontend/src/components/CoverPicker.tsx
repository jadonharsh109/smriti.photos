import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { personFaces, setPersonCover, type Person } from "../api/client";
import { faceUrl } from "../lib/images";
import Portal from "./Portal";

interface Props {
  person: Person;
  onClose: () => void;
}

/** Choosing the face that stands for someone. Faces, not photos: a cover is
 *  drawn as a round crop everywhere, and a group shot holds several. */
export default function CoverPicker({ person, onClose }: Props) {
  const qc = useQueryClient();
  const { data: faces, isLoading } = useQuery({ queryKey: ["person-faces", person.id], queryFn: () => personFaces(person.id) });
  const choose = useMutation({
    mutationFn: (faceId: number | null) => setPersonCover(person.id, faceId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["person", person.id] });
      qc.invalidateQueries({ queryKey: ["people"] });
      onClose();
    },
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !choose.isPending && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, choose.isPending]);

  const who = person.name ?? "this person";
  const count = faces?.length ?? 0;
  return (
    <Portal>
      <div className="scrim" onClick={() => !choose.isPending && onClose()}>
        <div className="sheet wide" role="dialog" onClick={(e) => e.stopPropagation()}>
          <header>Choose a photo for {who}</header>
          <div className="sbody">
            {choose.error ? <p className="note bad">{String((choose.error as Error).message)}</p> : null}
            {isLoading ? (
              <div className="face-pick-grid">
                {Array.from({ length: 12 }, (_, i) => <div key={i} className="face-pick skel" />)}
              </div>
            ) : count === 0 ? (
              <p>Nothing to choose from — every photo of {who} is either on a drive that isn’t connected or in the Locked section.</p>
            ) : (
              <>
                <p>{count === 1 ? "The one face Smriti has of them." : `Any of the ${count} faces Smriti has of them.`}</p>
                <div className="face-pick-grid">
                  {faces!.map((f) => (
                    <button key={f.id} className={`face-pick${f.id === person.cover_face_id ? " on" : ""}`} disabled={choose.isPending} title={f.id === person.cover_face_id ? "The current photo" : "Use this photo"} onClick={() => choose.mutate(f.id)}>
                      <img src={faceUrl(f.id)} loading="lazy" decoding="async" alt="" />
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="sfoot">
            {person.cover_src === "manual" && (
              <button className="btn left" disabled={choose.isPending} title="Go back to the face Smriti would pick on its own" onClick={() => choose.mutate(null)}>Let Smriti Choose</button>
            )}
            <button className="btn" disabled={choose.isPending} onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
