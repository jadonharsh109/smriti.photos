import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type Filters } from "../api/client";
import { ArtFolder } from "../components/Illustrations";
import TimelineGrid from "../components/TimelineGrid";

interface Stats {
  photos: number;
  videos: number;
  persons: number;
  live: number;
}

type MediaTab = "all" | "photo" | "video" | "live";

export default function TimelinePage() {
  const [tab, setTab] = useState<MediaTab>("all");
  const { data: stats } = useQuery({
    queryKey: ["stats"],
    queryFn: () => api.get<Stats>("/api/stats"),
  });
  const empty = stats && stats.photos + stats.videos === 0;
  const filters: Filters =
    tab === "live" ? { live: true } : { media_type: tab === "all" ? undefined : tab };
  return (
    <div className="page">
      {empty ? (
        <div className="empty">
          <ArtFolder className="art" />
          <p>Your library is empty — point Smriti at the folders that hold your photos and it will do the rest.</p>
          <div className="cta row" style={{ justifyContent: "center" }}>
            <Link to="/settings">
              <button className="primary">Choose a photos folder</button>
            </Link>
            <Link to="/welcome">
              <button className="ghost">What is Smriti?</button>
            </Link>
          </div>
        </div>
      ) : (
        <>
          <header className="page-head">
            <div>
              <h1>Photos</h1>
              <p className="sub">Your whole library, newest first.</p>
            </div>
            <div className="actions">
              <div className="seg">
                <button className={tab === "all" ? "on" : ""} onClick={() => setTab("all")}>
                  All
                </button>
                <button className={tab === "photo" ? "on" : ""} onClick={() => setTab("photo")}>
                  Photos{stats ? ` · ${stats.photos.toLocaleString()}` : ""}
                </button>
                <button className={tab === "video" ? "on" : ""} onClick={() => setTab("video")}>
                  Videos{stats ? ` · ${stats.videos.toLocaleString()}` : ""}
                </button>
                {/* Only offered when there are any: a tab that is always empty
                    is a question the library cannot answer. */}
                {(stats?.live ?? 0) > 0 && (
                  <button className={tab === "live" ? "on" : ""} onClick={() => setTab("live")}>
                    Live · {stats!.live.toLocaleString()}
                  </button>
                )}
              </div>
            </div>
          </header>
          <TimelineGrid
            filters={filters}
            emptyText={
              tab === "video"
                ? "No videos in your library yet"
                : tab === "live"
                ? "No Live Photos found yet"
                : "Nothing here yet"
            }
          />
        </>
      )}
    </div>
  );
}
