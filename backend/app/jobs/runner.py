"""In-process job manager: jobs table + live SSE fan-out + cancellation."""
import asyncio
import time

from .. import db
from ..services import aggregates


class JobManager:
    def __init__(self) -> None:
        self.subscribers: set[asyncio.Queue] = set()
        self.cancel_requested: set[int] = set()
        self.tasks: dict = {}
        self.loop: asyncio.AbstractEventLoop | None = None

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        # jobs left 'running' by a previous process are dead
        db.execute("UPDATE jobs SET status='interrupted', message='server restarted' WHERE status='running'")

    # -- lifecycle -----------------------------------------------------------
    def create(self, kind: str, root_id: int | None = None, message: str = "") -> int:
        cur = db.execute(
            "INSERT INTO jobs (kind, root_id, status, message, started_at) VALUES (?,?,?,?,?)",
            (kind, root_id, "running", message, int(time.time())),
        )
        job_id = cur.lastrowid
        self._publish(job_id)
        return job_id

    def start(self, job_id: int, coro) -> None:
        # Called from threadpool endpoints — schedule onto the main loop safely.
        fut = asyncio.run_coroutine_threadsafe(self._guard(job_id, coro), self.loop)
        self.tasks[job_id] = fut

    async def _guard(self, job_id: int, coro) -> None:
        try:
            await coro
        except asyncio.CancelledError:
            self.finish(job_id, "cancelled")
        except Exception as e:
            self.finish(job_id, "failed", message=f"{type(e).__name__}: {e}")
        finally:
            self.tasks.pop(job_id, None)
            self.cancel_requested.discard(job_id)
            await self._settle(job_id)

    async def _settle(self, job_id: int) -> None:
        """Bring the maintained aggregates (services/aggregates.py) up to date
        with whatever the job did, off the event loop, then publish the job a
        second time. The UI refetches when it sees a job stop; the first
        publish came from `finish` before the numbers were current, and this
        one lands after they are — so a page that refetched early refetches
        once more and shows the truth. A cancelled or failed job settles too:
        a face scan stopped halfway still stored faces."""
        row = db.query_one("SELECT kind FROM jobs WHERE id=?", (job_id,))
        if not row:
            return
        try:
            await asyncio.to_thread(aggregates.after_job, row["kind"])
        except Exception as e:  # noqa: BLE001 - never fail a finished job over this
            print(f"aggregates after {row['kind']}: {type(e).__name__}: {e}")
        self._publish(job_id)

    def update(self, job_id: int, *, total=None, done=None, errors=None, message=None) -> None:
        sets, params = [], []
        for col, val in (("total", total), ("done", done), ("errors", errors), ("message", message)):
            if val is not None:
                sets.append(f"{col}=?")
                params.append(val)
        if sets:
            db.execute(f"UPDATE jobs SET {', '.join(sets)} WHERE id=?", (*params, job_id))
        self._publish(job_id)

    def finish(self, job_id: int, status: str, message: str | None = None) -> None:
        db.execute(
            "UPDATE jobs SET status=?, message=COALESCE(?, message), finished_at=? WHERE id=?",
            (status, message, int(time.time()), job_id),
        )
        self._publish(job_id)

    # -- cancellation --------------------------------------------------------
    def request_cancel(self, job_id: int) -> None:
        self.cancel_requested.add(job_id)

    def is_cancelled(self, job_id: int) -> bool:
        return job_id in self.cancel_requested

    def any_running(self, kind: str | None = None) -> bool:
        if kind:
            return db.query_one("SELECT id FROM jobs WHERE status='running' AND kind=?", (kind,)) is not None
        return db.query_one("SELECT id FROM jobs WHERE status='running'") is not None

    # -- SSE -----------------------------------------------------------------
    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=500)
        self.subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self.subscribers.discard(q)

    def _publish(self, job_id: int) -> None:
        row = db.query_one("SELECT * FROM jobs WHERE id=?", (job_id,))
        if not row or self.loop is None or self.loop.is_closed():
            return
        self.loop.call_soon_threadsafe(self._fanout, dict(row))

    def publish_event(self, event_type: str, payload: dict) -> None:
        """Push a non-job event (e.g. drive attach/remove) to SSE subscribers."""
        if self.loop is None or self.loop.is_closed():
            return
        self.loop.call_soon_threadsafe(self._fanout, {"__type": event_type, **payload})

    def _fanout(self, event: dict) -> None:
        for q in list(self.subscribers):
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass


manager = JobManager()
