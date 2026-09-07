import { IconAlbum, IconHeart, IconLock, IconTrash } from "../components/Icons";
import { actions } from "./actions";
import { selection } from "./store";
import { InfoToggle, SelectToggle, SelectionActions, TbButton, ZoomSlider } from "./Toolbar";

/** The three controls every grid page has at the right of its toolbar. */
export function GridControls() {
  return (
    <>
      <ZoomSlider />
      <SelectToggle />
      <InfoToggle />
    </>
  );
}

/** What the toolbar offers while something is selected: the standard verbs,
 *  with room for a page's own before them. */
export function StandardSelection({ children, fav = true, lock = true, trash = true }: { children?: React.ReactNode; fav?: boolean; lock?: boolean; trash?: boolean }) {
  const ids = () => [...selection.get().ids];
  return (
    <SelectionActions>
      {children}
      <TbButton icon={<IconAlbum size={14} />} title="Add to Album…" onClick={() => actions.addToAlbum(ids())} />
      {fav && <TbButton icon={<IconHeart size={14} />} title="Favourite" onClick={() => actions.favourite(ids(), true)} />}
      {lock && <TbButton icon={<IconLock size={14} />} title="Hide in Locked" onClick={() => actions.hideInLocked(ids())} />}
      {trash && <TbButton icon={<IconTrash size={14} />} title="Move to Trash" danger onClick={() => actions.trash(ids())} />}
    </SelectionActions>
  );
}
