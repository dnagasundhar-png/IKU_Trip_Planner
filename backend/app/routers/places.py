from fastapi import APIRouter, Depends
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from ..db import get_db
from ..errors import ApiError
from ..ids import new_id
from ..models import ItineraryRow, PlaceRow
from ..ratelimit import write_limit
from ..schemas import Place, PlacesIn, PlacesOut
from .trips import READ_ONLY_TRIPS, get_trip_or_404

router = APIRouter(prefix="/trips/{trip_id}/places", tags=["places"])

_UPDATABLE = ["name", "name_english", "category", "lat", "lng", "confidence", "source_url", "ts", "tip", "origin"]


def place_out(row) -> Place:
    return Place(
        id=row.id, name=row.name, name_english=row.name_english, category=row.category,
        lat=row.lat, lng=row.lng, confidence=row.confidence, source_url=row.source_url,
        timestamp=row.ts, tip=row.tip,
    )


@router.get("", response_model=PlacesOut)
def list_places(trip_id: str, db: Session = Depends(get_db)) -> PlacesOut:
    """All places for the trip: the user's imported ones first, then the stops Gemini added.

    The front end uses this to resolve itinerary `placeId`s into names and map pins.
    """
    get_trip_or_404(db, trip_id)
    rows = db.scalars(
        select(PlaceRow).where(PlaceRow.trip_id == trip_id)
        .order_by((PlaceRow.origin != "import"), PlaceRow.name)
    )
    return PlacesOut(places=[place_out(r) for r in rows])


@router.post("", response_model=PlacesOut, dependencies=[Depends(write_limit)])
def save_places(trip_id: str, body: PlacesIn, db: Session = Depends(get_db)) -> PlacesOut:
    """Upsert the places the user confirmed after import (origin='import').

    New places change what the itinerary should contain, so a stored itinerary (and the stops Gemini
    added for it) is dropped, as PATCH /trips does; the itinerary page then regenerates."""
    get_trip_or_404(db, trip_id)
    if trip_id in READ_ONLY_TRIPS:
        raise ApiError(403, "read_only", "The demo trip can't be changed. Create your own trip to add places.")

    # Place IDs are global. If an incoming ID already belongs to another trip
    # (e.g. the importer reused "p1"), or repeats within this request, give it a fresh one.
    incoming = [p.id for p in body.places if p.id]
    taken = set(db.scalars(
        select(PlaceRow.id).where(PlaceRow.id.in_(incoming), PlaceRow.trip_id != trip_id)
    )) if incoming else set()

    rows, seen = [], set()
    for p in body.places:
        pid = p.id if p.id and p.id not in taken and p.id not in seen else new_id("p")
        seen.add(pid)
        rows.append(dict(
            id=pid, trip_id=trip_id, name=p.name, name_english=p.name_english, category=p.category,
            lat=p.lat, lng=p.lng, confidence=p.confidence, source_url=p.source_url,
            ts=p.timestamp, tip=p.tip, origin="import",
        ))

    if rows:
        stmt = pg_insert(PlaceRow).values(rows)
        stmt = stmt.on_conflict_do_update(
            index_elements=[PlaceRow.id],
            set_={c: stmt.excluded[c] for c in _UPDATABLE},
        )
        db.execute(stmt)
        db.execute(delete(ItineraryRow).where(ItineraryRow.trip_id == trip_id))
        db.execute(delete(PlaceRow).where(PlaceRow.trip_id == trip_id, PlaceRow.origin == "ai"))
        db.commit()

    return PlacesOut(places=[place_out(PlaceRow(**r)) for r in rows])
