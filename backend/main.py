import os
import asyncio
from datetime import date, time, timedelta, datetime
from typing import List, Optional
import psycopg2
from psycopg2.extras import RealDictCursor
import psycopg2.pool
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import threading

# ─── DB setup ────────────────────────────────────────────────────────────────

DB_CONFIG = {
    "host": os.getenv("DB_HOST", "localhost"),
    "port": int(os.getenv("DB_PORT", "5432")),
    "user": os.getenv("DB_USER", "postgres"),
    "password": os.getenv("DB_PASSWORD", ""),
    "database": os.getenv("DB_NAME", "postgres"),
}

pool = psycopg2.pool.ThreadedConnectionPool(1, 20, **DB_CONFIG)


def get_conn():
    return pool.getconn()


def release_conn(conn):
    pool.putconn(conn)


def init_db():
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("CREATE SCHEMA IF NOT EXISTS appointments;")
            cur.execute("""
                CREATE TABLE IF NOT EXISTS appointments.providers (
                    id SERIAL PRIMARY KEY,
                    name TEXT NOT NULL,
                    service TEXT NOT NULL,
                    duration_minutes INTEGER NOT NULL DEFAULT 30,
                    buffer_minutes INTEGER NOT NULL DEFAULT 0,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                );
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS appointments.availability_blocks (
                    id SERIAL PRIMARY KEY,
                    provider_id INTEGER NOT NULL REFERENCES appointments.providers(id) ON DELETE CASCADE,
                    day_of_week TEXT NOT NULL,
                    start_time TIME NOT NULL,
                    end_time TIME NOT NULL
                );
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS appointments.bookings (
                    id SERIAL PRIMARY KEY,
                    provider_id INTEGER NOT NULL REFERENCES appointments.providers(id) ON DELETE CASCADE,
                    client_name TEXT NOT NULL,
                    booking_date DATE NOT NULL,
                    start_time TIME NOT NULL,
                    status TEXT NOT NULL DEFAULT 'confirmed',
                    created_at TIMESTAMPTZ DEFAULT NOW()
                );
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS appointments.waitlist (
                    id SERIAL PRIMARY KEY,
                    provider_id INTEGER NOT NULL REFERENCES appointments.providers(id) ON DELETE CASCADE,
                    client_name TEXT NOT NULL,
                    booking_date DATE NOT NULL,
                    position INTEGER NOT NULL,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                );
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS appointments.holds (
                    id SERIAL PRIMARY KEY,
                    provider_id INTEGER NOT NULL REFERENCES appointments.providers(id) ON DELETE CASCADE,
                    waitlist_id INTEGER REFERENCES appointments.waitlist(id) ON DELETE CASCADE,
                    booking_date DATE NOT NULL,
                    start_time TIME NOT NULL,
                    client_name TEXT NOT NULL,
                    expires_at TIMESTAMPTZ NOT NULL,
                    confirmed BOOLEAN NOT NULL DEFAULT FALSE
                );
            """)
        conn.commit()
    finally:
        release_conn(conn)


# ─── App ─────────────────────────────────────────────────────────────────────

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    init_db()
    asyncio.create_task(hold_expiry_loop())


# ─── Models ──────────────────────────────────────────────────────────────────

class ProviderCreate(BaseModel):
    name: str
    service: str


class ProviderConfig(BaseModel):
    duration_minutes: int
    buffer_minutes: int


class TimeBlockIn(BaseModel):
    start_time: str
    end_time: str


class DayAvailability(BaseModel):
    day_of_week: str
    blocks: List[TimeBlockIn]


class AvailabilitySave(BaseModel):
    days: List[DayAvailability]


class BookingCreate(BaseModel):
    provider_id: int
    client_name: str
    booking_date: str
    start_time: str


class WaitlistJoin(BaseModel):
    provider_id: int
    client_name: str
    booking_date: str


class HoldConfirm(BaseModel):
    hold_id: int


# ─── Helpers ─────────────────────────────────────────────────────────────────

DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"]


def next_5_weekdays():
    """Return next 5 weekdays starting from tomorrow."""
    result = []
    d = date.today() + timedelta(days=1)
    while len(result) < 5:
        if d.weekday() < 5:  # Mon=0, Fri=4
            result.append(d)
        d += timedelta(days=1)
    return result


def day_name(d: date) -> str:
    return DAYS[d.weekday()]


def time_to_minutes(t: time) -> int:
    return t.hour * 60 + t.minute


def minutes_to_time(m: int) -> time:
    return time(m // 60, m % 60)


def generate_slots_for_block(block_start: time, block_end: time, duration: int) -> List[time]:
    """Generate slot start times within a block (no buffer logic here)."""
    slots = []
    cur = time_to_minutes(block_start)
    end = time_to_minutes(block_end)
    while cur + duration <= end:
        slots.append(minutes_to_time(cur))
        cur += duration
    return slots


def compute_available_slots(provider_id: int, booking_date: date, conn) -> List[time]:
    """Compute available slots for a provider on a given date."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            "SELECT duration_minutes, buffer_minutes FROM appointments.providers WHERE id = %s",
            (provider_id,)
        )
        provider = cur.fetchone()
        if not provider:
            return []
        duration = provider["duration_minutes"]
        buffer = provider["buffer_minutes"]
        day = day_name(booking_date)

        cur.execute(
            "SELECT start_time, end_time FROM appointments.availability_blocks "
            "WHERE provider_id = %s AND day_of_week = %s ORDER BY start_time",
            (provider_id, day)
        )
        blocks = cur.fetchall()
        if not blocks:
            return []

        # Get existing confirmed bookings for that day
        cur.execute(
            "SELECT start_time FROM appointments.bookings "
            "WHERE provider_id = %s AND booking_date = %s AND status = 'confirmed'",
            (provider_id, booking_date)
        )
        booked_times = {row["start_time"] for row in cur.fetchall()}

        # Get active holds for that day
        cur.execute(
            "SELECT start_time FROM appointments.holds "
            "WHERE provider_id = %s AND booking_date = %s AND confirmed = FALSE "
            "AND expires_at > NOW()",
            (provider_id, booking_date)
        )
        held_times = {row["start_time"] for row in cur.fetchall()}

    # Compute occupied intervals: (start_min, end_min+buffer) for each booking/hold
    occupied = []
    for bt in booked_times | held_times:
        s = time_to_minutes(bt)
        occupied.append((s, s + duration + buffer))

    available = []
    for block in blocks:
        bs = time_to_minutes(block["start_time"])
        be = time_to_minutes(block["end_time"])
        cur_time = bs
        while cur_time + duration <= be:
            slot_end = cur_time + duration
            # Check if this slot conflicts with any occupied interval
            conflict = False
            for (occ_start, occ_end) in occupied:
                # conflict if slot overlaps [occ_start, occ_end)
                if cur_time < occ_end and slot_end > occ_start:
                    conflict = True
                    break
            if not conflict:
                available.append(minutes_to_time(cur_time))
            cur_time += duration + buffer

    return sorted(set(available))


# ─── Hold expiry background task ─────────────────────────────────────────────

async def hold_expiry_loop():
    while True:
        await asyncio.sleep(5)
        try:
            conn = get_conn()
            try:
                with conn.cursor(cursor_factory=RealDictCursor) as cur:
                    # Get expired unconfirmed holds
                    cur.execute("""
                        SELECT id, provider_id, booking_date, start_time
                        FROM appointments.holds
                        WHERE confirmed = FALSE AND expires_at <= NOW()
                    """)
                    expired = cur.fetchall()
                    for hold in expired:
                        # Delete the expired hold
                        cur.execute("DELETE FROM appointments.holds WHERE id = %s", (hold["id"],))
                        # Check if there's a next person on waitlist
                        cur.execute("""
                            SELECT id, client_name FROM appointments.waitlist
                            WHERE provider_id = %s AND booking_date = %s
                            ORDER BY position ASC LIMIT 1
                        """, (hold["provider_id"], hold["booking_date"]))
                        next_waiter = cur.fetchone()
                        if next_waiter:
                            # Remove from waitlist
                            cur.execute("DELETE FROM appointments.waitlist WHERE id = %s", (next_waiter["id"],))
                            # Reorder positions
                            cur.execute("""
                                UPDATE appointments.waitlist
                                SET position = position - 1
                                WHERE provider_id = %s AND booking_date = %s
                            """, (hold["provider_id"], hold["booking_date"]))
                            # Create new hold
                            expires_at = datetime.utcnow() + timedelta(seconds=60)
                            cur.execute("""
                                INSERT INTO appointments.holds
                                (provider_id, waitlist_id, booking_date, start_time, client_name, expires_at)
                                VALUES (%s, %s, %s, %s, %s, %s AT TIME ZONE 'UTC')
                            """, (hold["provider_id"], next_waiter["id"], hold["booking_date"],
                                  hold["start_time"], next_waiter["client_name"], expires_at))
                conn.commit()
            finally:
                release_conn(conn)
        except Exception as e:
            print(f"Hold expiry error: {e}")


# ─── Routes ──────────────────────────────────────────────────────────────────

@app.get("/providers")
def list_providers():
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT id, name, service, duration_minutes, buffer_minutes FROM appointments.providers ORDER BY id")
            providers = cur.fetchall()
            result = []
            for p in providers:
                cur.execute(
                    "SELECT day_of_week, start_time, end_time FROM appointments.availability_blocks "
                    "WHERE provider_id = %s ORDER BY day_of_week, start_time",
                    (p["id"],)
                )
                blocks = cur.fetchall()
                availability = {}
                for b in blocks:
                    d = b["day_of_week"]
                    if d not in availability:
                        availability[d] = []
                    availability[d].append({
                        "start_time": b["start_time"].strftime("%H:%M"),
                        "end_time": b["end_time"].strftime("%H:%M"),
                    })
                result.append({
                    "id": p["id"],
                    "name": p["name"],
                    "service": p["service"],
                    "duration_minutes": p["duration_minutes"],
                    "buffer_minutes": p["buffer_minutes"],
                    "availability": availability,
                })
        return result
    finally:
        release_conn(conn)


@app.post("/providers")
def create_provider(data: ProviderCreate):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "INSERT INTO appointments.providers (name, service) VALUES (%s, %s) RETURNING id, name, service, duration_minutes, buffer_minutes",
                (data.name, data.service)
            )
            provider = cur.fetchone()
        conn.commit()
        return {"id": provider["id"], "name": provider["name"], "service": provider["service"],
                "duration_minutes": provider["duration_minutes"], "buffer_minutes": provider["buffer_minutes"],
                "availability": {}}
    finally:
        release_conn(conn)


@app.put("/providers/{provider_id}/config")
def update_config(provider_id: int, data: ProviderConfig):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE appointments.providers SET duration_minutes = %s, buffer_minutes = %s WHERE id = %s",
                (data.duration_minutes, data.buffer_minutes, provider_id)
            )
            if cur.rowcount == 0:
                raise HTTPException(status_code=404, detail="Provider not found")
        conn.commit()
        return {"ok": True}
    finally:
        release_conn(conn)


@app.put("/providers/{provider_id}/availability")
def save_availability(provider_id: int, data: AvailabilitySave):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM appointments.availability_blocks WHERE provider_id = %s", (provider_id,))
            for day_avail in data.days:
                for block in day_avail.blocks:
                    cur.execute(
                        "INSERT INTO appointments.availability_blocks (provider_id, day_of_week, start_time, end_time) VALUES (%s, %s, %s, %s)",
                        (provider_id, day_avail.day_of_week, block.start_time, block.end_time)
                    )
        conn.commit()
        return {"ok": True}
    finally:
        release_conn(conn)


@app.get("/providers/{provider_id}/bookings")
def list_bookings(provider_id: int):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT id, client_name, booking_date, start_time FROM appointments.bookings "
                "WHERE provider_id = %s AND status = 'confirmed' AND booking_date >= CURRENT_DATE "
                "ORDER BY booking_date, start_time",
                (provider_id,)
            )
            bookings = cur.fetchall()
            return [
                {
                    "id": b["id"],
                    "client_name": b["client_name"],
                    "booking_date": b["booking_date"].isoformat(),
                    "start_time": b["start_time"].strftime("%H:%M"),
                }
                for b in bookings
            ]
    finally:
        release_conn(conn)


@app.get("/providers/{provider_id}/slots")
def get_slots(provider_id: int):
    conn = get_conn()
    try:
        days = next_5_weekdays()
        result = {}
        for d in days:
            slots = compute_available_slots(provider_id, d, conn)
            day_key = day_name(d)
            if day_key not in result:
                result[day_key] = []
            result[day_key].extend([s.strftime("%H:%M") for s in slots])
        return result
    finally:
        release_conn(conn)


@app.post("/bookings")
def create_booking(data: BookingCreate):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Use advisory lock to prevent double booking
            cur.execute("SELECT pg_advisory_xact_lock(%s)", (data.provider_id,))

            booking_date = date.fromisoformat(data.booking_date)
            start_time = time.fromisoformat(data.start_time)

            # Check if slot is already booked
            cur.execute(
                "SELECT id FROM appointments.bookings WHERE provider_id = %s AND booking_date = %s AND start_time = %s AND status = 'confirmed'",
                (data.provider_id, booking_date, start_time)
            )
            if cur.fetchone():
                raise HTTPException(status_code=409, detail="Slot already booked")

            # Check if slot is under a hold
            cur.execute(
                "SELECT id FROM appointments.holds WHERE provider_id = %s AND booking_date = %s AND start_time = %s AND confirmed = FALSE AND expires_at > NOW()",
                (data.provider_id, booking_date, start_time)
            )
            if cur.fetchone():
                raise HTTPException(status_code=409, detail="Slot is currently on hold")

            cur.execute(
                "INSERT INTO appointments.bookings (provider_id, client_name, booking_date, start_time) VALUES (%s, %s, %s, %s) RETURNING id",
                (data.provider_id, data.client_name, booking_date, start_time)
            )
            booking = cur.fetchone()
        conn.commit()
        return {"id": booking["id"], "client_name": data.client_name,
                "booking_date": data.booking_date, "start_time": data.start_time}
    finally:
        release_conn(conn)


@app.delete("/bookings/{booking_id}")
def cancel_booking(booking_id: int):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT provider_id, booking_date, start_time FROM appointments.bookings WHERE id = %s AND status = 'confirmed'",
                (booking_id,)
            )
            booking = cur.fetchone()
            if not booking:
                raise HTTPException(status_code=404, detail="Booking not found")

            cur.execute("UPDATE appointments.bookings SET status = 'cancelled' WHERE id = %s", (booking_id,))

            provider_id = booking["provider_id"]
            booking_date = booking["booking_date"]
            start_time = booking["start_time"]

            # Check for waitlist
            cur.execute(
                "SELECT id, client_name FROM appointments.waitlist "
                "WHERE provider_id = %s AND booking_date = %s ORDER BY position ASC LIMIT 1",
                (provider_id, booking_date)
            )
            next_waiter = cur.fetchone()
            if next_waiter:
                cur.execute("DELETE FROM appointments.waitlist WHERE id = %s", (next_waiter["id"],))
                cur.execute("""
                    UPDATE appointments.waitlist SET position = position - 1
                    WHERE provider_id = %s AND booking_date = %s
                """, (provider_id, booking_date))
                expires_at = datetime.utcnow() + timedelta(seconds=60)
                cur.execute("""
                    INSERT INTO appointments.holds
                    (provider_id, waitlist_id, booking_date, start_time, client_name, expires_at)
                    VALUES (%s, %s, %s, %s, %s, %s AT TIME ZONE 'UTC')
                """, (provider_id, next_waiter["id"], booking_date, start_time,
                      next_waiter["client_name"], expires_at))
        conn.commit()
        return {"ok": True}
    finally:
        release_conn(conn)


@app.post("/waitlist")
def join_waitlist(data: WaitlistJoin):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            booking_date = date.fromisoformat(data.booking_date)
            cur.execute(
                "SELECT COALESCE(MAX(position), 0) + 1 AS next_pos FROM appointments.waitlist "
                "WHERE provider_id = %s AND booking_date = %s",
                (data.provider_id, booking_date)
            )
            pos = cur.fetchone()["next_pos"]
            cur.execute(
                "INSERT INTO appointments.waitlist (provider_id, client_name, booking_date, position) VALUES (%s, %s, %s, %s) RETURNING id",
                (data.provider_id, data.client_name, booking_date, pos)
            )
            entry = cur.fetchone()
        conn.commit()
        return {"id": entry["id"], "position": pos}
    finally:
        release_conn(conn)


@app.get("/holds")
def get_holds(client_name: str, provider_id: int):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT id, provider_id, booking_date, start_time, client_name, expires_at
                FROM appointments.holds
                WHERE client_name = %s AND provider_id = %s AND confirmed = FALSE AND expires_at > NOW()
            """, (client_name, provider_id))
            holds = cur.fetchall()
            return [
                {
                    "id": h["id"],
                    "provider_id": h["provider_id"],
                    "booking_date": h["booking_date"].isoformat(),
                    "start_time": h["start_time"].strftime("%H:%M"),
                    "client_name": h["client_name"],
                    "expires_at": h["expires_at"].isoformat(),
                }
                for h in holds
            ]
    finally:
        release_conn(conn)


@app.post("/holds/{hold_id}/confirm")
def confirm_hold(hold_id: int):
    conn = get_conn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT id, provider_id, booking_date, start_time, client_name FROM appointments.holds "
                "WHERE id = %s AND confirmed = FALSE AND expires_at > NOW()",
                (hold_id,)
            )
            hold = cur.fetchone()
            if not hold:
                raise HTTPException(status_code=404, detail="Hold not found or expired")

            cur.execute("UPDATE appointments.holds SET confirmed = TRUE WHERE id = %s", (hold_id,))
            cur.execute(
                "INSERT INTO appointments.bookings (provider_id, client_name, booking_date, start_time) VALUES (%s, %s, %s, %s) RETURNING id",
                (hold["provider_id"], hold["client_name"], hold["booking_date"], hold["start_time"])
            )
            booking = cur.fetchone()
        conn.commit()
        return {"id": booking["id"]}
    finally:
        release_conn(conn)


@app.delete("/data")
def delete_all():
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM appointments.holds")
            cur.execute("DELETE FROM appointments.waitlist")
            cur.execute("DELETE FROM appointments.bookings")
            cur.execute("DELETE FROM appointments.availability_blocks")
            cur.execute("DELETE FROM appointments.providers")
        conn.commit()
        return {"ok": True}
    finally:
        release_conn(conn)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=3001)
