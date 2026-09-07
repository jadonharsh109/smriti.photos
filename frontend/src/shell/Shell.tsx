import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { UpdateSheet } from "../components/UpdateNotice";
import { ActionsHost } from "./actions";
import { ContextMenuHost } from "./ContextMenu";
import Inspector from "./Inspector";
import Preferences from "./Preferences";
import Sidebar from "./Sidebar";
import StatusBar from "./StatusBar";
import { ShellContext } from "./Toolbar";
import {
  inspector,
  openPrefs,
  prefs,
  selection,
  selectionActions,
  setInspectorOpen,
  setInspectorSubject,
  setSelecting,
  setTileHeight,
  startJobStream,
  view,
} from "./store";

/** The window: sidebar · toolbar and content · inspector, status bar below.
 *  Pages render into the content column and put their controls into the
 *  toolbar through `Toolbar`; everything else here is shared. */
export default function Shell() {
  const qc = useQueryClient();
  const location = useLocation();
  const nav = useNavigate();
  const [toolbarEl, setToolbarEl] = useState<HTMLElement | null>(null);
  const [contentEl, setContentEl] = useState<HTMLElement | null>(null);
  const infoOpen = inspector.use((s) => s.open);
  const prefsOpen = prefs.use((s) => s.open);

  // one event stream for the window; anything a finished job or a drive
  // change touched is refetched
  useEffect(() => {
    startJobStream(
      () => setTimeout(() => qc.invalidateQueries(), 400),
      () => {
        for (const key of ["volumes", "roots", "stats", "file"]) qc.invalidateQueries({ queryKey: [key] });
      }
    );
  }, [qc]);

  // a new view starts with nothing selected and nothing being inspected
  useEffect(() => {
    selectionActions.clear();
    setSelecting(false);
    setInspectorSubject(null);
    if (location.pathname === "/settings") {
      openPrefs();
      nav("/", { replace: true });
    }
  }, [location.pathname, nav]);

  // the window's own shortcuts; pages handle their own on top of these
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const t = e.target as HTMLElement | null;
      const typing = !!t?.closest("input, textarea, [contenteditable]");
      const k = e.key.toLowerCase();
      if (mod && k === "i") {
        e.preventDefault();
        setInspectorOpen(!inspector.get().open);
      } else if (mod && e.key === ",") {
        e.preventDefault();
        openPrefs();
      } else if (mod && k === "f") {
        const el = document.querySelector<HTMLInputElement>("[data-toolbar-search]");
        e.preventDefault();
        if (el) {
          el.focus();
          el.select();
        } else nav("/search");
      } else if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        setTileHeight(view.get().tileHeight + 20);
      } else if (mod && e.key === "-") {
        e.preventDefault();
        setTileHeight(view.get().tileHeight - 20);
      } else if (mod && k === "a" && !typing) {
        const order = selection.get().order;
        if (order.length) {
          e.preventDefault();
          selectionActions.replace(order);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav]);

  return (
    <ShellContext.Provider value={{ toolbarEl, contentEl }}>
      <div className={`app${infoOpen ? "" : " no-info"}`}>
        <div className="body">
          <Sidebar />
          <section className="content" ref={setContentEl}>
            <header className="toolbar" ref={setToolbarEl} data-tauri-drag-region />
            <div className="stage" id="main-scroll">
              <Outlet />
            </div>
          </section>
          <Inspector />
        </div>
        <StatusBar />
      </div>
      {prefsOpen && <Preferences />}
      <ActionsHost />
      <UpdateSheet />
      <ContextMenuHost />
    </ShellContext.Provider>
  );
}
