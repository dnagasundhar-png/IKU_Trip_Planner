"""Video import: link parsing, job flow, caching, geocoding.

Gemini and Nominatim are stubbed out, so no API key or network is needed. Tests that send a
tripId need the database (the demo trip from seed_demo.py) and are skipped without it.
"""
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.db import check_db
from app.errors import ApiError
from app.main import app
from app.mocks import DEMO_TRIP_ID
from app.routers import imports
from app.schemas import ImportJob, PlaceIn
from app.services import geo, import_cache, video_import
from app.services.video_import import detect_platform, geocode_places, youtube_video_id

client = TestClient(app)

_url = get_settings().database_url
needs_db = pytest.mark.skipif(not (_url and "<password>" not in _url and check_db() == "ok"),
                              reason="DATABASE_URL not set or unreachable")

VID = "dQw4w9WgXcQ"


@pytest.fixture(autouse=True)
def _no_db_cache(monkeypatch):
    """Keep fake test places out of the real import_cache table (see test_cache_survives_restart)."""
    monkeypatch.setattr(import_cache, "_db_enabled", lambda: False)
    import_cache.clear_memory()

TOKYO = {"lat": 35.68, "lng": 139.76, "country_code": "JP"}
SENSOJI = {"lat": 35.7148, "lng": 139.7967, "country_code": "JP"}


@pytest.mark.parametrize("link", [
    f"https://www.youtube.com/watch?v={VID}",
    f"https://youtube.com/watch?v={VID}&t=42s",
    f"https://m.youtube.com/watch?v={VID}",
    f"https://youtu.be/{VID}?si=abc",
    f"https://www.youtube.com/shorts/{VID}",
    f"https://www.youtube.com/embed/{VID}",
    f"  https://www.youtube.com/live/{VID}  ",
])
def test_youtube_links(link):
    assert detect_platform(link) == "youtube"
    assert youtube_video_id(link) == VID


@pytest.mark.parametrize("link,platform", [
    ("https://www.tiktok.com/@someone/video/7300000000000000000", "tiktok"),
    ("https://vm.tiktok.com/ZMabc123/", "tiktok"),
    ("https://example.com/watch?v=" + VID, "unknown"),
    ("not a link", "unknown"),
])
def test_other_platforms(link, platform):
    assert detect_platform(link) == platform


def test_bad_youtube_ids():
    assert youtube_video_id("https://www.youtube.com/watch?v=short") is None
    assert youtube_video_id("https://www.youtube.com/@channel") is None


@pytest.fixture
def fake_geocoder(monkeypatch):
    """Knows Tokyo and Senso-ji; everything else is 'not found'."""
    queries = []

    def fake(query, country_code=None):
        queries.append((query, country_code))
        q = query.lower()
        if q.startswith("senso-ji"):
            return SENSOJI
        if q == "tokyo":
            return TOKYO
        if q.startswith("far away"):
            return {"lat": 34.69, "lng": 135.50, "country_code": "JP"}  # Osaka, ~400 km
        return None

    monkeypatch.setattr(geo, "geocode", fake)
    return queries


@pytest.fixture
def fake_gemini(monkeypatch, fake_geocoder):
    imports.JOBS.clear()
    import_cache.clear_memory()
    calls = []

    def fake(link, destination=None):
        calls.append((link, destination))
        return [PlaceIn(name="浅草寺", name_english="Senso-ji", category="temple", confidence=0.9,
                        source_url=link, timestamp="02:14", tip="Go early")]

    monkeypatch.setattr(video_import, "extract_places_from_youtube", fake)
    return calls


def _import(body):
    r = client.post("/imports/text" if "text" in body else "/imports", json=body)
    assert r.status_code == 202
    job = r.json()
    return job, client.get(f"/imports/{job['jobId']}").json()  # TestClient runs background tasks first


def test_youtube_import_runs_job_and_caches(fake_gemini):
    job, done = _import({"link": f"https://youtu.be/{VID}"})
    assert job["status"] == "pending"
    assert job["platform"] == "youtube"
    assert fake_gemini == [(f"https://youtu.be/{VID}", None)]

    done = ImportJob.model_validate(done)
    assert done.status == "done"
    assert done.places[0].name_english == "Senso-ji"
    assert done.places[0].id.startswith("p_")

    # Same video again (different link form): Gemini isn't called a second time.
    _, again = _import({"link": f"https://www.youtube.com/watch?v={VID}"})
    assert again["status"] == "done"
    assert again["places"][0]["name"] == "浅草寺"
    assert "nameEnglish" in again["places"][0]  # camelCase on the wire
    assert len(fake_gemini) == 1


@needs_db
def test_import_with_trip_uses_destination_and_geocodes(fake_gemini, fake_geocoder):
    _, done = _import({"link": f"https://youtu.be/{VID}", "tripId": DEMO_TRIP_ID})
    assert fake_gemini == [(f"https://youtu.be/{VID}", "Tokyo")]
    place = done["places"][0]
    assert (place["lat"], place["lng"]) == (SENSOJI["lat"], SENSOJI["lng"])
    assert place["confidence"] == 0.9
    assert ("Senso-ji, Tokyo", "JP") in fake_geocoder  # destination as context, country from the trip


@needs_db
def test_unknown_trip_404(fake_gemini):
    r = client.post("/imports", json={"link": f"https://youtu.be/{VID}", "tripId": "t_nope"})
    assert r.status_code == 404
    assert r.json()["error"] == "not_found"


def test_geocode_places(fake_geocoder):
    places = [
        PlaceIn(name="浅草寺", name_english="Senso-ji", confidence=0.9),
        PlaceIn(name="Nowhere Cafe", confidence=0.8),
        PlaceIn(name="Far Away Castle", confidence=1.0),
    ]
    found, missing, far = geocode_places(places, "Tokyo")
    assert (found.lat, found.lng, found.confidence) == (35.7148, 139.7967, 0.9)
    assert (missing.lat, missing.lng, missing.confidence) == (None, None, 0.4)  # not found: halved
    assert far.lat == 34.69 and far.confidence == 0.5  # > 150 km from Tokyo: halved
    assert ("Tokyo", None) in fake_geocoder
    assert ("Senso-ji, Tokyo", "JP") in fake_geocoder  # country taken from the destination


def test_geocode_tries_area_first_and_area_is_never_serialised(fake_geocoder):
    [p] = geocode_places([PlaceIn(name="仲見世", name_english="Nakamise", area="Asakusa", confidence=0.9)], "Tokyo")
    queries = [q for q, _ in fake_geocoder if q != "Tokyo"]
    assert queries[:2] == ["Nakamise, Asakusa, Tokyo", "仲見世, Asakusa, Tokyo"]
    assert not {"area", "city"} & set(p.model_dump(by_alias=True))


def test_geocode_uses_the_places_own_city(fake_geocoder):
    geocode_places([PlaceIn(name="道頓堀", name_english="Dotonbori", area="Namba", city="Osaka")], "Tokyo")
    queries = [q for q, _ in fake_geocoder if q != "Tokyo"]
    assert queries[0] == "Dotonbori, Namba, Osaka"
    assert not any(q.endswith(", Tokyo") for q in queries)  # never "Dotonbori, Tokyo"


def test_gemini_failure_marks_job_failed(monkeypatch, fake_geocoder):
    import_cache.clear_memory()

    def boom(link, destination=None):
        raise ApiError(502, "gemini_failed", "We couldn't read that video.")

    monkeypatch.setattr(video_import, "extract_places_from_youtube", boom)
    _, job = _import({"link": f"https://youtu.be/{VID}"})
    assert job["status"] == "failed"
    assert job["error"] == "gemini_failed"
    assert job["places"] == []


@pytest.fixture
def fake_tiktok(monkeypatch, fake_geocoder):
    imports.JOBS.clear()
    import_cache.clear_memory()
    calls = []

    def fake_resolve(link):
        is_photo = "/photo/" in link or "vm.tiktok" in link
        return "https://www.tiktok.com/@a/video/123", "123", is_photo

    def fake_extract(url, destination=None):
        calls.append((url, destination))
        return [PlaceIn(name="Senso-ji", confidence=0.9, source_url=url)]

    monkeypatch.setattr(video_import, "resolve_tiktok", fake_resolve)
    monkeypatch.setattr(video_import, "extract_places_from_tiktok", fake_extract)
    return calls


def test_tiktok_video_import(fake_tiktok):
    job, done = _import({"link": "https://www.tiktok.com/@a/video/123"})
    assert job["platform"] == "tiktok"
    assert done["status"] == "done"
    assert done["message"] is None
    assert done["places"][0]["lat"] == SENSOJI["lat"]
    assert fake_tiktok == [("https://www.tiktok.com/@a/video/123", None)]


def test_tiktok_slideshow_says_upload_screenshots(fake_tiktok):
    _, done = _import({"link": "https://vm.tiktok.com/ZN8Sp2yEk/"})
    assert done["status"] == "done"
    assert "screenshots" in done["message"]
    _import({"link": "https://www.tiktok.com/@a/photo/123"})
    assert len(fake_tiktok) == 1  # same post id -> cached


def test_resolve_tiktok_rewrites_photo_and_follows_short_links(monkeypatch):
    class R:
        is_redirect = True
        headers = {"location": "https://www.tiktok.com/@chasing.charl/photo/7630841035454827798?_r=1"}

    seen = []
    monkeypatch.setattr(video_import.httpx, "get", lambda url, **kw: seen.append(url) or R())
    url, post_id, is_slideshow = video_import.resolve_tiktok("https://vm.tiktok.com/ZN8Sp2yEk/")
    assert url == "https://www.tiktok.com/@chasing.charl/video/7630841035454827798"
    assert (post_id, is_slideshow) == ("7630841035454827798", True)
    assert seen == ["https://vm.tiktok.com/ZN8Sp2yEk/"]

    # Direct links need no network; redirects to non-TikTok hosts are refused.
    assert video_import.resolve_tiktok("https://www.tiktok.com/@a/video/42?x=1") == \
        ("https://www.tiktok.com/@a/video/42", "42", False)
    R.headers = {"location": "https://evil.example/@a/video/1"}
    with pytest.raises(ApiError) as exc:
        video_import.resolve_tiktok("https://vm.tiktok.com/abc/")
    assert exc.value.code == "bad_link"


@pytest.fixture
def fake_text_and_images(monkeypatch, fake_geocoder):
    imports.JOBS.clear()
    import_cache.clear_memory()
    calls = {"text": [], "images": []}

    def fake_text(text, destination=None, source_url=None, images=()):
        calls["text"].append((text, destination, source_url))
        return [PlaceIn(name="Senso-ji", confidence=0.9, source_url=source_url)] if "senso" in text.lower() else []

    def fake_images(images, destination=None):
        calls["images"].append(([m for _, m in images], destination))
        return [PlaceIn(name="Senso-ji", confidence=0.95)]

    monkeypatch.setattr(video_import, "extract_places_from_text", fake_text)
    monkeypatch.setattr(video_import, "extract_places_from_images", fake_images)
    return calls


def test_paste_caption(fake_text_and_images):
    job, done = _import({"text": "Day 1: Senso-ji at sunrise", "sourceUrl": "https://www.tiktok.com/@a/video/1"})
    assert job["platform"] == "text"
    assert done["status"] == "done"
    assert done["places"][0]["sourceUrl"] == "https://www.tiktok.com/@a/video/1"
    _import({"text": "Day 1: Senso-ji at sunrise"})
    assert len(fake_text_and_images["text"]) == 1  # same text -> cached


def test_paste_caption_with_no_places_fails_helpfully(fake_text_and_images):
    _, done = _import({"text": "follow for more!! #travel"})
    assert done["status"] == "failed"
    assert done["error"] == "no_places"


def test_paste_caption_validation(fake_text_and_images):
    for body in ({"text": ""}, {"text": "   "}, {"text": "x" * 10_001}):
        r = client.post("/imports/text", json=body)
        assert r.status_code in (400, 422), body
        assert "error" in r.json()


def _upload(files, **form):
    return client.post("/imports/images", files=[("files", f) for f in files], data=form)


def test_screenshot_upload(fake_text_and_images):
    r = _upload([("1.jpg", b"\xff\xd8jpeg", "image/jpeg"), ("2.png", b"\x89PNGpng", "image/png")])
    assert r.status_code == 202
    job = r.json()
    assert job["platform"] == "screenshot"
    done = client.get(f"/imports/{job['jobId']}").json()
    assert done["status"] == "done"
    assert done["places"][0]["lat"] == SENSOJI["lat"]
    assert fake_text_and_images["images"] == [(["image/jpeg", "image/png"], None)]


def test_screenshot_upload_validation(fake_text_and_images):
    r = _upload([("a.pdf", b"%PDF", "application/pdf")])
    assert r.status_code == 400 and r.json()["error"] == "bad_images"
    r = _upload([(f"{i}.jpg", b"x", "image/jpeg") for i in range(11)])
    assert r.status_code == 400 and r.json()["error"] == "bad_images"
    r = _upload([("big.jpg", b"x" * (10 * 1024 * 1024 + 1), "image/jpeg")])
    assert r.status_code == 400 and "over 10 MB" in r.json()["message"]
    r = _upload([("empty.jpg", b"", "image/jpeg")])
    assert r.status_code == 400
    r = client.post("/imports/images", data={"tripId": "x"})
    assert r.status_code == 422  # no files at all
    assert fake_text_and_images["images"] == []


@needs_db
def test_screenshot_upload_with_trip(fake_text_and_images):
    r = _upload([("1.jpg", b"\xff\xd8jpeg", "image/jpeg")], tripId=DEMO_TRIP_ID)
    assert r.status_code == 202
    assert fake_text_and_images["images"] == [(["image/jpeg"], "Tokyo")]
    assert _upload([("1.jpg", b"x", "image/jpeg")], tripId="t_nope").status_code == 404


def test_rejects_unknown_platform(fake_gemini):
    r = client.post("/imports", json={"link": "https://example.com/video"})
    assert r.status_code == 400
    assert r.json()["error"] == "unsupported_platform"


def test_unknown_job_404():
    r = client.get("/imports/j_nope")
    assert r.status_code == 404
    assert r.json()["error"] == "not_found"


def test_missing_api_key_is_a_clear_error(monkeypatch):
    monkeypatch.setattr(video_import, "get_settings", lambda: type("S", (), {"gemini_api_key": ""})())
    with pytest.raises(ApiError) as exc:
        video_import.extract_places_from_youtube(f"https://youtu.be/{VID}")
    assert exc.value.code == "gemini_not_configured"


@needs_db
def test_cache_survives_restart(monkeypatch):
    """Places and geocodes written to Tiger Data come back after the memory cache is wiped."""
    from sqlalchemy import delete

    from app.db import _session_factory
    from app.models import GeocodeCacheRow, ImportCacheRow

    monkeypatch.setattr(import_cache, "_db_enabled", lambda: True)
    key, query = "pytest:cache-test", "pytest nowhere street"
    try:
        import_cache.put_places(key, [PlaceIn(name="仲見世", name_english="Nakamise", area="Asakusa", city="Tokyo",
                                              confidence=0.9)])
        import_cache.put_geocode(query, "JP", {"lat": 1.0, "lng": 2.0, "country_code": "JP"})
        import_cache.put_geocode(query, None, None)  # "not found" is cached too
        import_cache.clear_memory()  # = server restart

        [p] = import_cache.get_places(key)
        assert (p.name, p.name_english, p.area, p.city, p.confidence) == ("仲見世", "Nakamise", "Asakusa", "Tokyo", 0.9)
        assert import_cache.get_geocode(query.upper(), "JP") == {"lat": 1.0, "lng": 2.0, "country_code": "JP"}
        assert import_cache.get_geocode(query, None) is None
        assert import_cache.get_geocode("pytest never stored", None) is import_cache.MISS
        assert import_cache.get_places("pytest:never-stored") is None
    finally:
        with _session_factory()() as db:
            db.execute(delete(ImportCacheRow).where(ImportCacheRow.cache_key.like("pytest:%")))
            db.execute(delete(GeocodeCacheRow).where(GeocodeCacheRow.query.like("pytest %")))
            db.commit()


def test_cache_db_errors_are_cache_misses(monkeypatch):
    monkeypatch.setattr(import_cache, "_db_enabled", lambda: True)

    def broken():
        raise RuntimeError("database down")

    monkeypatch.setattr(import_cache, "_session_factory", lambda: broken)
    assert import_cache.get_places("youtube:x") is None
    assert import_cache.get_geocode("anything", None) is import_cache.MISS
    import_cache.put_places("youtube:x", [PlaceIn(name="a")])  # logged, not raised
    assert import_cache.get_places("youtube:x")[0].name == "a"  # still cached in memory


class _QuotaError(Exception):
    code = 429


def _fake_genai(monkeypatch, outcomes):
    """Stub google.genai.Client: outcomes maps model -> exception to raise, or places to return."""
    import google.genai

    from app.config import Settings
    from app.services.video_import import _Extraction, _ExtractedPlace

    tried = []

    class Models:
        def generate_content(self, model, contents, config):
            tried.append(model)
            out = outcomes[model]
            if isinstance(out, Exception):
                raise out
            return type("R", (), {"parsed": _Extraction(places=[_ExtractedPlace(
                name=n, name_english=n, category="temple", confidence=0.9) for n in out]), "text": ""})()

    monkeypatch.setattr(google.genai, "Client", lambda **kw: type("C", (), {"models": Models()})())
    monkeypatch.setattr(video_import, "get_settings", lambda: Settings(
        gemini_api_key="test", gemini_model="m1", gemini_fallback_models="m2,m3"))
    return tried


def test_gemini_falls_back_to_next_model_on_quota(monkeypatch):
    tried = _fake_genai(monkeypatch, {"m1": _QuotaError("429"), "m2": ["Senso-ji"], "m3": ["never"]})
    places = video_import.extract_places_from_text("Senso-ji at sunrise")
    assert [p.name for p in places] == ["Senso-ji"]
    assert tried == ["m1", "m2"]


def test_gemini_all_models_out_of_quota(monkeypatch):
    tried = _fake_genai(monkeypatch, {m: _QuotaError("429") for m in ("m1", "m2", "m3")})
    with pytest.raises(ApiError) as exc:
        video_import.extract_places_from_text("Senso-ji")
    assert exc.value.code == "gemini_quota"
    assert tried == ["m1", "m2", "m3"]


def test_gemini_other_errors_do_not_fall_back(monkeypatch):
    tried = _fake_genai(monkeypatch, {"m1": RuntimeError("video is private"), "m2": ["x"], "m3": ["x"]})
    with pytest.raises(ApiError) as exc:
        video_import.extract_places_from_youtube(f"https://youtu.be/{VID}")
    assert exc.value.code == "gemini_failed"
    assert tried == ["m1"]


def test_blank_fallback_setting_uses_default():
    from app.config import Settings
    s = Settings(gemini_model="", gemini_fallback_models=" ")
    assert s.gemini_models == ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash"]


@needs_db
def test_saving_places_drops_the_old_itinerary_and_protects_the_demo(monkeypatch):
    """Places imported after an itinerary exists must be planned in, so saving them clears the old plan."""
    from sqlalchemy import delete, select

    from app.db import _session_factory
    from app.models import ItineraryRow, PlaceRow, TripRow
    from app.routers import trips as trips_router

    monkeypatch.setattr(trips_router, "resolve_destination", lambda d: ("JP", "JPY"))
    trip_id = client.post("/trips", json={
        "destination": "pytest-Tokyo", "startDate": "2026-12-01", "endDate": "2026-12-02",
        "dayStart": "09:00", "dayEnd": "21:00", "travellers": 1, "interests": [], "homeCurrency": "GBP",
    }).json()["id"]
    try:
        with _session_factory()() as db:
            db.add(ItineraryRow(trip_id=trip_id, data={"days": []}))
            db.add(PlaceRow(id=f"p_ai{trip_id[-6:]}", trip_id=trip_id, name="AI stop", origin="ai"))
            db.commit()

        r = client.post(f"/trips/{trip_id}/places", json={"places": [{"name": "Senso-ji", "lat": 35.71, "lng": 139.8}]})
        assert r.status_code == 200
        assert client.get(f"/trips/{trip_id}/itinerary").json()["error"] == "no_itinerary"
        with _session_factory()() as db:
            origins = list(db.scalars(select(PlaceRow.origin).where(PlaceRow.trip_id == trip_id)))
        assert origins == ["import"]  # the AI stop for the old plan is gone, the imported place stays

        r = client.post(f"/trips/{DEMO_TRIP_ID}/places", json={"places": [{"name": "x"}]})
        assert (r.status_code, r.json()["error"]) == (403, "read_only")
    finally:
        with _session_factory()() as db:
            db.execute(delete(TripRow).where(TripRow.id == trip_id))
            db.commit()
