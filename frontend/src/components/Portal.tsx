import { createPortal } from "react-dom";

/** Renders overlay UI (lightbox, modals, selection bar) at document.body so
 * no ancestor transform/filter/animation can ever hijack their fixed
 * positioning or clip them. */
export default function Portal({ children }: { children: React.ReactNode }) {
  return createPortal(children, document.body);
}
