# TRIPEZIUM

> AI trip planner that turns the places you've saved online into a costed, multi-currency itinerary — and adapts when plans change.

Built at the **IKU Womxn in STEM Hackathon** (KCL · Imperial · UCL), 17–18 October 2026.

---

## The problem

Planning a trip means twenty open tabs, a camera roll full of TikTok screenshots, and no real idea what any of it will cost — especially across currencies. Once you're there, plans break (rain, closures, overspending) and you're stuck re-planning in a language you don't speak.

## The solution

1. **Sign up** and tell us where and when you're going — countries, cities and dates for each stop.
2. **Pick interests** from activities that actually make sense for that destination *and season* (no silly suggestions).
3. **Import inspiration** — paste TikTok links or upload screenshots of places you've seen online. We extract the places automatically.
4. **Get an itinerary** — day-by-day, mapped, and costed in local currency *and* your home currency.
5. **Edit by chatting** — "swap day 2 and 3", "cheaper dinner in Osaka", "add more food spots".
6. **Travel with it** — the app knows where you are in your trip, coaches you on useful phrases, and translates live by voice.

---

## Features

### Core
- **Destination-aware interests** — Gemini generates activity options relevant to the chosen places and season.
- **Link & screenshot import** — TikTok links are resolved via TikTok's oEmbed endpoint (caption + thumbnail); screenshots go to Gemini's multimodal input. Extracted places feed the itinerary.
- **Structured itinerary generation** — Gemini returns itinerary data as JSON against a fixed schema, so every item can be rendered, edited, costed and re-planned.
- **Chat-based editing** — natural-language changes (typed or spoken) applied to the structured itinerary. Every change is re-checked on the server (opening hours, holidays, travel time, prices) and saved to the trip.
- **Travel time between stops** — every stop says how you get there (walk, public transport or train, with minutes and distance), and the plan leaves enough time to do it.
- **Your own bookings (optional)** — add where you're staying and any flights, trains or buses you've booked, including between cities, when you create the trip or later. The plan works around them: nothing during a journey or the airport run, and each day starts from your accommodation.

### Date & season awareness
- **Dates per city** are part of trip input, and every itinerary item has a date.
- **Public holidays** for each country on the route are fetched from Nager.Date and passed into the Gemini prompt.
- **Closure checker** — after generation, a deterministic pass in code cross-checks every item's date against the holiday list. Risky items are flagged and sent back to the agent for re-planning.
- **Closures become suggestions** — holidays shut things but also create events (e.g. New Year closures in Japan → hatsumōde, the first shrine visit of the year).
- **Seasonal filtering** — interests and activities are filtered by season. Near-term trips use Open-Meteo forecasts; trips further out use historical climate averages.
- **Honest about opening hours** — uncertain items are marked "check hours before going" rather than presented as fact. Stretch: Gemini's Google Search grounding for live closure checks (test early — may not combine cleanly with structured JSON output).

### Money layer (Wise track)
- **Every itinerary item is costed** in local currency and converted to the user's home currency at live rates.
- **Budget per day and per city**, with a running trip total.
- **"Load your card" prompts** — e.g. "You'll spend ~¥85,000 in Kyoto — convert before Tuesday."
- **Overspend alerts** that suggest cheaper swaps.
- **FX history charts** showing how rate moves change the trip cost.

### Adaptive agent (incident.io track)
- **Edits change priorities, not just items** — when the user changes what matters ("actually I hate crowds", "cut the budget by £200", "we're arriving a day late"), the agent drops conclusions that no longer hold, re-plans everything affected (other days, budget, closure conflicts) and explains what it changed and why.
- **Closure conflicts** — when a must-see from the user's TikToks falls on a holiday closure, the agent weighs the conflict and either moves it to another day or replaces it, explaining the trade-off.

### Voice (ElevenLabs track)
- **Phrase coach** — before the trip, learn useful phrases for each destination, spoken aloud.
- **Live translator** — during the trip, speak and get a spoken translation. Context-aware: it knows which city you're in from the itinerary and a **trip clock** (simulated date/time for demo purposes).

### Extras
- **Map view** of each day's stops (Leaflet + OpenStreetMap)

---

## Why this matters for Wise

Wise's product pillars are transparency, convenience, price, speed and coverage. Travel is where most people first deal with foreign currency — and where hidden fees and confusing conversions hurt most. This project:

- Shows the **true cost of a trip** before you go (transparency).
- Removes the friction of planning, budgeting and translating in one place (convenience).
- Tells you **when and how much to convert**, in every currency on your route (coverage).
- Could ship as a **"Trips" feature inside the Wise app**, driving card spend and currency conversions.

---

## Tracks

| Track | How we qualify |
|---|---|
| **Wise (Main Track)** — Max Ease | Multi-currency budgeting, live FX, conversion prompts, friction removal across trip planning |
| **incident.io** — Adaptable Agents | Chat edits that change priorities or correct assumptions, plus closure conflicts: abandons outdated plans, weighs conflicting data (holidays vs. user must-sees vs. budget), changes course without paralysis |
| **ElevenLabs** — Voice & Audio AI | Phrase coach and live voice translator |
| **MLH: Best Use of Gemini API** | Itinerary generation, link/screenshot extraction (multimodal), chat editing, re-planning |
| **MLH: Best Use of Tiger Data** | Postgres for trips/itineraries + time-series for spending and FX rates |
| **MLH: Best Use of Vultr** | Deployment |
| **MLH: Best Domain Name from GoDaddy Registry** | Project domain |
| **DEV Writing Challenge** | Post-hackathon write-up |

> Check with organisers whether there's a cap on MLH prizes per team. If so, prioritise Gemini and Tiger Data.

---

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | Next.js 16 (App Router) + React 19, TypeScript, Tailwind CSS v4, shadcn/ui (Base UI) + Lucide icons |
| Backend | Python, FastAPI + Uvicorn, Pydantic, SQLAlchemy + psycopg ([details](backend/README.md)) |
| Database | Tiger Data (PostgreSQL + time-series) |
| AI | Google Gemini API (structured JSON output, multimodal) |
| Voice | ElevenLabs speech-to-text + text-to-speech |
| Maps | Leaflet + OpenStreetMap |
| Weather | Open-Meteo (forecast + historical climate) |
| Public holidays | Nager.Date |
| FX rates | Frankfurter (European Central Bank reference rates), stored in a Tiger Data hypertable, with a hardcoded fallback |
| Opening hours | Google Places API (New), used only for weekly opening hours |
| Geocoding | Nominatim (OpenStreetMap) |
| Hosting | Vultr (Ubuntu VM, systemd), Caddy in front for HTTPS |
| Domain | GoDaddy Registry |

---

## How we used Gemini

Gemini plans every itinerary, and we treat its output as **structured data, not text**. Each request sends a
Pydantic response schema, so Gemini returns JSON with a date, start time, duration, place, local cost and
opening-hours status for every stop. Our code then validates it: exact trip dates, real place IDs, 24-hour times,
ISO currency codes. If anything is wrong, it retries once with the problems listed. The prompt carries the facts
that matter: each date's weekday, the destination's public holidays (from Nager.Date), and guidance on weekly and
seasonal closures, so on 1 Jan in Japan it suggests hatsumōde instead of a closed museum. The places users import
from TikTok and YouTube go in as a clearly delimited **data block** that Gemini is told never to take instructions
from, with delimiter text stripped first, as a prompt-injection guard. Gemini only estimates **local costs per
person**; currency conversion and every total are done in code with exact decimals. After generation, each stop is
checked against its real weekly opening hours. Anything closed, or any saved place Gemini left out, goes back for
**one revision pass**. Gemini is also multimodal in our import flow: it reads videos, screenshots and captions and
extracts the places in them. Because free-tier quota is per model, calls fall back across Gemini Flash models when
one runs out of quota. Itinerary generation also falls back when a model is overloaded, within a per-request time
limit, so it answers or says it's busy rather than hanging.

## How we used Tiger Data

Tiger Data (PostgreSQL with TimescaleDB) is our only database. Trips, the user's places and the AI-suggested stops
are relational tables. Each generated itinerary is stored as one JSONB document in exactly the shape the front end
receives, so it's always read and written whole. The TimescaleDB feature is **FX history**: `fx_rates` is a
**hypertable**. Every exchange rate we fetch is stored with its timestamp and source, indexed by currency pair and
time. That makes "latest GBP→JPY rate" a fast lookup (used as a 6-hour cache in front of the rates API), and builds
up a history of rates over time: the data needed to show how currency moves change a trip's cost. Tiger Data also caches
public holidays, video-import results and geocoding lookups, so pre-imported demo content survives redeploys and
doesn't spend AI quota twice.

## Getting started

```bash
# Clone
git clone [repo-url]
cd [repo-name]

# Environment variables — copy and fill in
cp .env.example .env
```

`.env.example`:
```
GEMINI_API_KEY=
ELEVENLABS_API_KEY=
DATABASE_URL=          # Tiger Data connection string
FX_API_KEY=
```

> Never commit `.env`. API keys stay local.

### Back end

Python 3.11+. Full details (environment variables, deploy, endpoints, design notes) are in [backend/README.md](backend/README.md).
The live API is at **https://api.tripezium.club** ([interactive docs](https://api.tripezium.club/docs)).

```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # DATABASE_URL, GEMINI_API_KEY (+ optional GOOGLE_MAPS_API_KEY)
python apply_schema.py             # creates the tables and the fx_rates hypertable
python seed_demo.py                # demo trip t_demo0001, with its itinerary
uvicorn app.main:app --reload --port 8000    # API docs at http://localhost:8000/docs
python -m pytest -q                # tests
```

### Front end

Node.js 20+. The live site is at [https://tripezium.club](https://tripezium.club).

```bash
cd frontend
npm install
# create .env.local with:
#   GEMINI_API_KEY=...          # used by the /api/plan-day route
#   ELEVENLABS_API_KEY=...      # used by the /api/voice-edit route and the Listen button
#   NEXT_PUBLIC_API_URL=http://localhost:8000   # optional; points at the live API if not set
npm run dev                     # http://localhost:3000
npm run build && npm start      # production build
npm run lint && npm run typecheck
```

---

## Demo

**Demo trip:** Seoul → Osaka → Kyoto → Tokyo. Two currencies (KRW, JPY) and two languages show off the money layer and the phrase coach.

**2-minute video outline**

| Time | Beat |
|---|---|
| 0:00–0:10 | Problem: "planning a trip means 20 tabs and no idea what it costs" |
| 0:10–0:35 | Paste TikToks → places appear |
| 0:35–1:00 | Itinerary with live yen/won budget |
| 1:00–1:25 | Kyoto on 1 Jan: closure flagged → agent swaps in hatsumōde at Fushimi Inari and explains why (this happened to us planning the real trip) |
| 1:25–1:45 | Phrase coach speaking Japanese |
| 1:45–2:00 | Wise business case |

---

## Known limitations

- **TikTok saved folders/collections** have no public API, so import works from pasted links and screenshots instead.
- **Trip clock** simulates being mid-trip for the demo; a production version would use device location and time.
- Costs are AI estimates, not live prices.
- Travel times are estimated from distance (walking, public transport or train), not live routes or timetables.
- A change saved from the itinerary page can't be undone; ask for the change back instead.
- Holiday data covers public holidays; individual venue closures and opening hours are flagged as "check before going" rather than guaranteed.

---


## Credits

Built with:
- [Google Gemini API](https://ai.google.dev/)
- [ElevenLabs](https://elevenlabs.io/)
- [Tiger Data](https://www.tigerdata.com/)
- [Vultr](https://www.vultr.com/)
- [GoDaddy Registry](https://www.godaddy.com/)
- [Leaflet](https://leafletjs.com/) + [OpenStreetMap](https://www.openstreetmap.org/)
- [Open-Meteo](https://open-meteo.com/)
- [Nager.Date](https://date.nager.at/)
- [TikTok oEmbed](https://developers.tiktok.com/doc/embed-videos/)

Back end:
- [FastAPI](https://fastapi.tiangolo.com/) and [Uvicorn](https://www.uvicorn.org/)
- [Pydantic](https://docs.pydantic.dev/) and [pydantic-settings](https://docs.pydantic.dev/latest/concepts/pydantic_settings/)
- [SQLAlchemy](https://www.sqlalchemy.org/) and [psycopg](https://www.psycopg.org/)
- [TimescaleDB](https://www.timescale.com/) (on Tiger Data)
- [httpx](https://www.python-httpx.org/)
- [python-multipart](https://github.com/Kludex/python-multipart) (screenshot uploads)
- [google-genai](https://github.com/googleapis/python-genai) (Gemini Python SDK)
- [Google Places API (New)](https://developers.google.com/maps/documentation/places/web-service/op-overview) (opening hours only)
- [Nominatim](https://nominatim.org/) (OpenStreetMap geocoding)
- [GeoNames](https://www.geonames.org/) city data, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (via [all-the-cities](https://github.com/zeke/all-the-cities); also used by the front end's city dropdown)
- [Frankfurter](https://frankfurter.dev/) (European Central Bank exchange rates)
- [Caddy](https://caddyserver.com/) (HTTPS reverse proxy)
- [pytest](https://docs.pytest.org/)

Front end:
- [Next.js](https://nextjs.org) (App Router + API routes) and [React](https://react.dev)
- [TypeScript](https://www.typescriptlang.org)
- [Tailwind CSS](https://tailwindcss.com) and [tw-animate-css](https://github.com/Wombosvideo/tw-animate-css)
- [shadcn/ui](https://ui.shadcn.com) on [Base UI](https://base-ui.com), with [class-variance-authority](https://cva.style)
- [Lucide](https://lucide.dev) icons
- [Leaflet](https://leafletjs.com) with [OpenStreetMap](https://www.openstreetmap.org) tiles
- [React DayPicker](https://daypicker.dev) and [date-fns](https://date-fns.org) (date selection)
- [next-themes](https://github.com/pacocoursey/next-themes) (light/dark mode)
- [Google Gemini API](https://ai.google.dev) (day planning and voice edits, via Next.js API routes)
- [ElevenLabs](https://elevenlabs.io) (speech-to-text and text-to-speech)
- [Nominatim](https://nominatim.org) (geocoding)
- [ESLint](https://eslint.org) and [Prettier](https://prettier.io)

## Team

- Stephanie Carvalho 
- Abia Thangal 
- Arany Nanthakumaran 
- Divyaa Nagasundhar 
