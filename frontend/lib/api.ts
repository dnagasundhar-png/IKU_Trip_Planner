// Talks to C's back end (backend/README.md has the full contract). Every error the API
// returns is { error, message }, and `message` is written to be shown to the user.
import { loadCities } from "./destinations"
import { addDays, daysBetween, suggestCitiesFor } from "./route"
import { loadTrip, saveTrip } from "./trip-store"
import type { Itinerary, ItineraryDay, ItemStatus, Place, Trip } from "./types"

// Inlined at build time (must be written out literally). Defaults to the live API.
const BASE = (process.env.NEXT_PUBLIC_API_URL || "https://api.tripezium.club").replace(/\/$/, "")

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    // File uploads (FormData) set their own multipart Content-Type; everything else is JSON.
    const json = !(init?.body instanceof FormData)
    res = await fetch(BASE + path, { ...init, headers: { ...(json ? { "Content-Type": "application/json" } : {}), ...init?.headers } })
  } catch {
    throw new ApiError(0, "network", "Can't reach the server. Check your connection and try again.")
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const message = String(body?.message ?? `Something went wrong (${res.status}).`).replace(/^Value error, /, "")
    throw new ApiError(res.status, body?.error ?? "http_error", message)
  }
  return body as T
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
})

// --- Shapes as the API sends them -------------------------------------------------

type ApiLeg = { city: string; country: string; days: number }

type ApiTripIn = {
  destination: string
  route: ApiLeg[]
  startDate: string
  endDate: string
  dayStart: string
  dayEnd: string
  travellers: number
  interests: string[]
  homeCurrency: string
}

type ApiPlace = {
  id: string
  name: string
  nameEnglish: string | null
  category: string | null
  lat: number | null
  lng: number | null
  confidence: number | null
  sourceUrl?: string | null
  timestamp?: string | null
  tip?: string | null
}

type ApiItinerary = {
  homeCurrency: string
  tripTotalHome: number
  days: {
    date: string
    city: string | null
    holiday: string | null
    dayTotalHome: number
    items: {
      time: string
      placeId: string
      durationMins: number
      note: string
      estimatedCost: number // per person, local currency
      currency: string
      costHome: number // per person, home currency
      status: ItemStatus
    }[]
  }[]
}

// --- Trip: create once, then send only changes ---------------------------------------

export const isServerTrip = (id: string) => id.startsWith("t_")
const isDemoTrip = (id: string) => id.startsWith("t_demo") // read-only on the server

/**
 * The route as the API wants it: real cities only. A whole-country leg ("explore") is expanded
 * into the same popular cities the itinerary page shows for it.
 */
async function apiRoute(trip: Trip): Promise<ApiLeg[]> {
  const legs: ApiLeg[] = []
  for (const leg of trip.route) {
    if (!leg.explore) {
      legs.push({ city: leg.city, country: leg.country, days: leg.days })
      continue
    }
    for (const part of suggestCitiesFor(leg.country, leg.days)) {
      // No suggested cities for this country: use its most populous city instead of the country's name.
      const city = part.city === leg.city ? ((await loadCities(leg.country))[0] ?? part.city) : part.city
      legs.push({ city, country: leg.country, days: part.days })
    }
  }
  return legs
}

async function payload(trip: Trip): Promise<ApiTripIn> {
  const route = await apiRoute(trip)
  const routeDays = route.reduce((n, r) => n + r.days, 0)
  // The API requires the route's days to add up to the trip. If the user's per-city dates
  // don't match the trip dates, the route wins (the itinerary page shows the same days).
  const endDate = route.length && routeDays !== daysBetween(trip.startDate, trip.endDate)
    ? addDays(trip.startDate, routeDays - 1)
    : trip.endDate
  return {
    destination: trip.destination || route.map((r) => r.city).join(" & ") || "My trip",
    route,
    startDate: trip.startDate,
    endDate,
    dayStart: trip.dayStart,
    dayEnd: trip.dayEnd,
    travellers: trip.travellers,
    interests: trip.interests,
    homeCurrency: trip.budget?.currency || "GBP",
  }
}

/**
 * Make sure the server has this trip as it is now: create it the first time, PATCH it if the
 * user changed anything since. Changing the plan (dates, cities, interests...) makes the server
 * drop the old itinerary, so the itinerary page regenerates. Returns the saved trip.
 */
export function syncTrip(trip: Trip): Promise<Trip> {
  // One sync at a time. Two overlapping first syncs (React runs effects twice in development; a quick
  // double navigation in production) would otherwise both POST and create two trips, and imported
  // places could end up on a different trip from the itinerary. A queued call picks up the id the
  // earlier one saved, so it PATCHes that trip instead of creating another.
  const run = syncQueue.then(() => {
    const stored = loadTrip()
    const fresh = !isServerTrip(trip.id) && isServerTrip(stored.id) ? { ...trip, id: stored.id, synced: stored.synced } : trip
    return syncNow(fresh)
  })
  syncQueue = run.catch(() => undefined)
  return run
}

let syncQueue: Promise<unknown> = Promise.resolve()

async function syncNow(trip: Trip): Promise<Trip> {
  if (isDemoTrip(trip.id)) return trip
  const body = await payload(trip)
  const key = JSON.stringify(body)
  if (isServerTrip(trip.id) && trip.synced === key) return trip

  let id = trip.id
  if (isServerTrip(id)) {
    try {
      await request(`/trips/${id}`, send("PATCH", body))
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e
      id = "" // the server doesn't know it any more: start a new one
    }
  }
  if (!isServerTrip(id)) id = (await request<{ id: string }>("/trips", send("POST", body))).id

  return saveTrip({ id, synced: key, endDate: body.endDate })
}

/** A trip from the server, in the front end's shape (e.g. to show the demo trip). */
export async function getTrip(id: string): Promise<Trip> {
  const t = await request<ApiTripIn & { id: string }>(`/trips/${id}`)
  return {
    id: t.id,
    destination: t.destination,
    stops: [],
    datesPerCity: false,
    route: t.route.map((r, i) => ({ cityId: `leg-${i}`, city: r.city, country: r.country, days: r.days })),
    startDate: t.startDate,
    endDate: t.endDate,
    dayStart: t.dayStart,
    dayEnd: t.dayEnd,
    travellers: t.travellers,
    interests: t.interests,
    budget: { amount: null, currency: t.homeCurrency },
  }
}

export const DEMO_TRIP_ID = "t_demo0001"

// --- Places and itinerary ------------------------------------------------------------

function toPlace(p: ApiPlace): Place {
  return {
    id: p.id,
    name: p.name,
    nameEnglish: p.nameEnglish || p.name,
    category: p.category ?? "",
    lat: p.lat,
    lng: p.lng,
    confidence: p.confidence,
    sourceUrl: p.sourceUrl ?? undefined,
    timestamp: p.timestamp ?? undefined,
    tip: p.tip ?? undefined,
  }
}

function toItinerary(it: ApiItinerary): Itinerary {
  const home = it.homeCurrency
  const days: ItineraryDay[] = it.days.map((d) => ({
    date: d.date,
    city: d.city,
    holiday: d.holiday,
    total: { amount: d.dayTotalHome, currency: home },
    items: d.items.map((i) => ({
      time: i.time,
      placeId: i.placeId,
      durationMins: i.durationMins,
      note: i.note || undefined,
      cost: { amount: i.costHome, currency: home },
      localCost: { amount: i.estimatedCost, currency: i.currency },
      status: i.status,
    })),
  }))
  return { days, total: { amount: it.tripTotalHome, currency: home } }
}

export async function getPlaces(tripId: string): Promise<Place[]> {
  const { places } = await request<{ places: ApiPlace[] }>(`/trips/${tripId}/places`)
  return places.map(toPlace)
}

/** The stored itinerary, or null if there isn't one yet. Fast: no AI involved. */
export async function getItinerary(tripId: string): Promise<Itinerary | null> {
  try {
    return toItinerary(await request<ApiItinerary>(`/trips/${tripId}/itinerary`))
  } catch (e) {
    if (e instanceof ApiError && e.code === "no_itinerary") return null
    throw e
  }
}

/** Plan the trip with Gemini. Slow (roughly 25-60 s): show a loading state. */
export async function generateItinerary(tripId: string): Promise<Itinerary> {
  return toItinerary(await request<ApiItinerary>(`/trips/${tripId}/itinerary`, send("POST")))
}

// --- Imports (D's importer: YouTube / TikTok links, screenshots, pasted captions) -----

export type ImportStatus = "pending" | "running" | "done" | "failed"

export type ImportJob = {
  jobId: string
  status: ImportStatus
  platform: string // youtube | tiktok | text | screenshot
  link: string | null
  places: Place[]
  error: string | null // code when status is "failed", e.g. "no_places", "gemini_quota"
  message: string | null // safe to show; also set on some "done" jobs (a TikTok slideshow asks for screenshots)
}

type ApiImportJob = Omit<ImportJob, "places"> & { places: ApiPlace[] }

export const MAX_SCREENSHOTS = 10
export const MAX_SCREENSHOT_MB = 10
export const MAX_CAPTION_CHARS = 10_000

const toJob = (j: ApiImportJob): ImportJob => ({ ...j, places: j.places.map(toPlace) })

/** A YouTube or TikTok link (short links like youtu.be / vm.tiktok.com are fine). Returns at once; poll the job. */
export async function importLink(link: string, tripId?: string): Promise<ImportJob> {
  return toJob(await request<ApiImportJob>("/imports", send("POST", { link, tripId })))
}

/** A pasted caption or any text that mentions places. */
export async function importText(text: string, tripId?: string, sourceUrl?: string): Promise<ImportJob> {
  return toJob(await request<ApiImportJob>("/imports/text", send("POST", { text, tripId, sourceUrl })))
}

/** 1-10 screenshots (JPEG/PNG/WebP/HEIC, 10 MB each), read together, so a whole TikTok slideshow works. */
export async function importScreenshots(files: File[], tripId?: string): Promise<ImportJob> {
  const form = new FormData()
  for (const f of files) form.append("files", f)
  if (tripId) form.append("tripId", tripId)
  return toJob(await request<ApiImportJob>("/imports/images", { method: "POST", body: form }))
}

export async function getImport(jobId: string): Promise<ImportJob> {
  return toJob(await request<ApiImportJob>(`/imports/${jobId}`))
}

/** Save the places the user ticked. The server drops any older itinerary, so the next one includes them. */
export async function savePlaces(tripId: string, places: Place[]): Promise<Place[]> {
  const body = {
    places: places.map((p) => ({
      id: p.id, name: p.name, nameEnglish: p.nameEnglish, category: p.category || null,
      lat: p.lat, lng: p.lng, confidence: p.confidence,
      sourceUrl: p.sourceUrl ?? null, timestamp: p.timestamp ?? null, tip: p.tip ?? null,
    })),
  }
  const { places: saved } = await request<{ places: ApiPlace[] }>(`/trips/${tripId}/places`, send("POST", body))
  return saved.map(toPlace)
}
