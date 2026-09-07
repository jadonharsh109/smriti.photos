/** The toolbar is the page's heading. Each page renders one `<Toolbar>`, which
 *  portals its title, count and controls into the strip the shell owns — so
 *  the strip's height and position never depend on what the page is doing. */
import { createContext, useContext, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { IconChevronL, IconClose, IconGridLarge, IconGridSmall, IconInfo, IconSearch } from "../components/Icons";
import { TILE_MAX, TILE_MIN, inspector, selection, selectionActions, setInspectorOpen, setSelecting, setTileHeight, view } from "./store";

export const ShellContext = createContext<{ toolbarEl: HTMLElement | null; contentEl: HTMLElement | null }>({
  toolbarEl: null,
  contentEl: null,
});
export const useShell = () => useContext(ShellContext);

export function Toolbar({
  title,
  count,
  back,
  children,
}: {
  title?: React.ReactNode;
  count?: string | null;
  /** Where the back chevron goes; detail views set it. */
  back?: string;
  children?: React.ReactNode;
}) {
  const { toolbarEl } = useShell();
  const nav = useNavigate();
  if (!toolbarEl) return null;
  return createPortal(
    <>
      {back && (
        <button className="back" title="Back" onClick={() => nav(back)}>
          <IconChevronL size={15} />
        </button>
      )}
      {title != null && <span className="title">{title}</span>}
      {count != null && <span className="count num">{count}</span>}
      <span className="grow" />
      {children}
    </>,
    toolbarEl
  );
}

export function TbButton({
  on,
  icon,
  title,
  primary,
  danger,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  on?: boolean;
  icon?: React.ReactNode;
  primary?: boolean;
  danger?: boolean;
}) {
  const cls = ["tb", on ? "on" : "", icon && !children ? "icon" : "", primary ? "primary" : "", danger ? "danger" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={cls} title={title} aria-label={typeof title === "string" && !children ? title : undefined} {...rest}>
      {icon}
      {children}
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: React.ReactNode }[];
  onChange: (v: T) => void;
}) {
  return (
    <span className="tseg" role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={o.value === value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </span>
  );
}

export function ZoomSlider() {
  const h = view.use((s) => s.tileHeight);
  return (
    <span className="zoom" title="Thumbnail size (⌘+ / ⌘−)">
      <IconGridSmall size={12} />
      <input type="range" min={TILE_MIN} max={TILE_MAX} step={2} value={h} aria-label="Thumbnail size" onChange={(e) => setTileHeight(Number(e.target.value))} />
      <IconGridLarge size={12} />
    </span>
  );
}

export function ToolbarSearch({
  value,
  onChange,
  placeholder,
  hits,
  autoFocus,
  onSubmit,
  inputRef,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  hits?: string;
  autoFocus?: boolean;
  onSubmit?: () => void;
  inputRef?: React.RefObject<HTMLInputElement>;
}) {
  const local = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? local;
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus, ref]);
  return (
    <label className="tsearch">
      <IconSearch size={13} />
      <input
        ref={ref}
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        data-toolbar-search
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.stopPropagation();
            onChange("");
          }
          if (e.key === "Enter") onSubmit?.();
        }}
      />
      {value && hits && <span className="hits num">{hits}</span>}
      {value && (
        <button className="clear" title="Clear" onClick={() => onChange("")}>
          <IconClose size={12} />
        </button>
      )}
    </label>
  );
}

export function InfoToggle() {
  const open = inspector.use((s) => s.open);
  return <TbButton on={open} icon={<IconInfo size={14} />} title="Info (⌘I)" onClick={() => setInspectorOpen(!open)} />;
}

export function SelectToggle() {
  const selecting = view.use((s) => s.selecting);
  return (
    <TbButton
      on={selecting}
      onClick={() => {
        if (selecting) selectionActions.clear();
        setSelecting(!selecting);
      }}
    >
      {selecting ? "Done" : "Select"}
    </TbButton>
  );
}

/** "N selected" plus the actions that apply to a selection, shown in place of
 *  the page's usual controls while something is selected. */
export function SelectionActions({ children }: { children?: React.ReactNode }) {
  const n = selection.use((s) => s.ids.size);
  if (n === 0) return null;
  return (
    <span className="tsel">
      <span className="n num">{n.toLocaleString()} selected</span>
      {children}
      <TbButton onClick={() => selectionActions.clear()}>Clear</TbButton>
    </span>
  );
}
