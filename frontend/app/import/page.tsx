"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AlertTriangle, Check, ImagePlus, Link2, Loader2, MapPinOff, Play, Type, X } from "lucide-react"

import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { PageShell } from "@/components/page-shell"
import {
  ApiError,
  DEMO_TRIP_ID,
  MAX_CAPTION_CHARS,
  MAX_SCREENSHOT_MB,
  MAX_SCREENSHOTS,
  getImport,
  importLink,
  importScreenshots,
  importText,
  isServerTrip,
  savePlaces,
  syncTrip,
  type ImportJob,
} from "@/lib/api"
import { loadTrip } from "@/lib/trip-store"
import type { Place } from "@/lib/types"

type Tab = "link" | "screenshots" | "caption"

// One import the user started, as shown in the list (the server's job + what we need to display it).
type Entry = ImportJob & { label: string; startedAt: number }

const POLL_MS = 2000
const SURE = 0.6 // below this confidence, a place starts unticked and is flagged "Not sure"
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]

const isActive = (j: Entry) => j.status === "pending" || j.status === "running"
// Words that don't tell two places apart ("Senso-ji" vs "Sensō-ji Temple" from two different imports).
const GENERIC = /\b(the|temple|shrine|street|st|dori)\b/g
/** One key per real place across imports: accents, punctuation and generic words don't count. */
const placeKey = (p: Place) => {
  const key = (p.nameEnglish || p.name)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(GENERIC, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "")
  return key || (p.nameEnglish || p.name).trim().toLowerCase()
}
const isSupportedLink = (s: string) => {
  try {
    const host = new URL(s.trim()).hostname.replace(/^(www|m)\./, "")
    return host === "youtu.be" || host.endsWith("youtube.com") || host === "tiktok.com" || host.endsWith(".tiktok.com")
  } catch {
    return false
  }
}
const short = (s: string, n = 42) => (s.length > n ? s.slice(0, n - 1) + "…" : s)
const elapsed = (from: number) => {
  const s = Math.max(0, Math.round((Date.now() - from) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

/** "02:14" -> a YouTube link that opens at that moment. */
function watchAt(p: Place): string | undefined {
  if (!p.sourceUrl) return undefined
  if (!p.timestamp || !/youtube\.com|youtu\.be/.test(p.sourceUrl)) return p.sourceUrl
  const secs = p.timestamp.split(":").reduce((acc, part) => acc * 60 + (Number(part) || 0), 0)
  return `${p.sourceUrl}${p.sourceUrl.includes("?") ? "&" : "?"}t=${secs}s`
}

/** The places to tick by default when an import finishes: the ones we're sure of and can map. */
const confidentKeys = (j: ImportJob) =>
  j.status === "done" ? j.places.filter((p) => (p.confidence ?? 0) >= SURE && p.lat !== null).map(placeKey) : []

function storageKey(tripId: string) {
  return `imports:${tripId}`
}

export default function ImportPage() {
  const router = useRouter()
  const [tripId, setTripId] = useState<string | null>(null)
  const [tripError, setTripError] = useState("")
  const [tab, setTab] = useState<Tab>("link")
  const [link, setLink] = useState("")
  const [caption, setCaption] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const [formError, setFormError] = useState("")
  const [starting, setStarting] = useState(false)
  const [jobs, setJobs] = useState<Entry[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState("")
  const [, setTick] = useState(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const restored = useRef(false)

  const isDemo = tripId === DEMO_TRIP_ID

  // The trip must exist on the server so imported places have somewhere to go.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        let t = loadTrip()
        if (!isServerTrip(t.id)) t = await syncTrip(t)
        if (cancelled) return
        setTripId(t.id)
        try {
          const saved = JSON.parse(sessionStorage.getItem(storageKey(t.id)) || "null")
          if (saved?.jobs) setJobs(saved.jobs)
          if (saved?.selected) setSelected(saved.selected)
        } catch {
          // nothing saved, or storage blocked
        }
      } catch (e) {
        if (!cancelled) setTripError(e instanceof Error ? e.message : "Couldn't load your trip.")
      } finally {
        restored.current = true
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Keep imports across a refresh or a trip to another page and back.
  useEffect(() => {
    if (!tripId || !restored.current) return
    try {
      sessionStorage.setItem(storageKey(tripId), JSON.stringify({ jobs, selected }))
    } catch {
      // storage blocked: imports still work on this page
    }
  }, [tripId, jobs, selected])

  // Poll running imports. Long videos take a minute or two the first time; cached ones are instant.
  const running = jobs.some(isActive)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(async () => {
      setTick((n) => n + 1)
      const active = jobs.filter(isActive)
      const updates = await Promise.all(
        active.map(async (j) => {
          try {
            return await getImport(j.jobId)
          } catch (e) {
            if (e instanceof ApiError && e.status === 404) {
              // The server restarted and forgot the job. The result may be cached, so a retry is quick.
              return { ...j, status: "failed" as const, error: "lost", message: "This import was interrupted. Please try it again." }
            }
            return null // network blip: try again on the next tick
          }
        }),
      )
      setJobs((cur) =>
        cur.map((j) => {
          const u = updates.find((x) => x?.jobId === j.jobId)
          return u ? { ...j, ...u } : j
        }),
      )
      // Tick the places we're sure of as each import finishes.
      const keys = updates.flatMap((u) => (u ? confidentKeys(u) : []))
      if (keys.length) setSelected((s) => [...new Set([...s, ...keys])])
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [running, jobs])

  // Every place found so far, one per name (the most confident wins), in the order they were found.
  const places = useMemo(() => {
    const byKey = new Map<string, Place>()
    for (const j of jobs) {
      if (j.status !== "done") continue
      for (const p of j.places) {
        const k = placeKey(p)
        const prev = byKey.get(k)
        if (!prev || (p.confidence ?? 0) > (prev.confidence ?? 0)) byKey.set(k, p)
      }
    }
    return [...byKey.values()]
  }, [jobs])

  const chosen = places.filter((p) => selected.includes(placeKey(p)))
  const toggle = (k: string) => setSelected((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]))

  async function start(kind: Tab) {
    setFormError("")
    let label = ""
    let call: () => Promise<ImportJob>
    if (kind === "link") {
      const value = link.trim()
      if (!isSupportedLink(value)) return setFormError("Paste a YouTube or TikTok link.")
      label = short(value.replace(/^https?:\/\/(www\.)?/, ""))
      call = () => importLink(value, tripId ?? undefined)
    } else if (kind === "caption") {
      const value = caption.trim()
      if (!value) return setFormError("Paste a caption or some text that mentions places.")
      label = `Caption: “${short(value.replace(/\s+/g, " "), 34)}”`
      call = () => importText(value, tripId ?? undefined)
    } else {
      if (!files.length) return setFormError("Choose at least one screenshot.")
      label = files.length === 1 ? "1 screenshot" : `${files.length} screenshots`
      const batch = files
      call = () => importScreenshots(batch, tripId ?? undefined)
    }

    setStarting(true)
    try {
      const job = await call()
      setJobs((cur) => [{ ...job, label, startedAt: Date.now() }, ...cur])
      const keys = confidentKeys(job) // rarely: already finished when it comes back
      if (keys.length) setSelected((s) => [...new Set([...s, ...keys])])
      if (kind === "link") setLink("")
      if (kind === "caption") setCaption("")
      if (kind === "screenshots") setFiles([])
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Couldn't start the import. Please try again.")
    } finally {
      setStarting(false)
    }
  }

  function addFiles(list: FileList | null) {
    setFormError("")
    if (!list) return
    const next = [...files]
    for (const f of Array.from(list)) {
      if (!IMAGE_TYPES.includes(f.type)) {
        setFormError(`“${f.name}” isn’t a JPEG, PNG, WebP or HEIC image.`)
        continue
      }
      if (f.size > MAX_SCREENSHOT_MB * 1024 * 1024) {
        setFormError(`“${f.name}” is over ${MAX_SCREENSHOT_MB} MB.`)
        continue
      }
      if (next.length >= MAX_SCREENSHOTS) {
        setFormError(`Up to ${MAX_SCREENSHOTS} screenshots at a time.`)
        break
      }
      next.push(f)
    }
    setFiles(next)
    if (fileInput.current) fileInput.current.value = ""
  }

  async function saveAndContinue() {
    if (!tripId) return
    setSaving(true)
    setSaveError("")
    try {
      if (chosen.length) await savePlaces(tripId, chosen)
      try {
        sessionStorage.removeItem(storageKey(tripId))
      } catch {
        // ignore
      }
      router.push("/itinerary")
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Couldn't save your places. Please try again.")
      setSaving(false)
    }
  }

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "link", label: "Link", icon: <Link2 className="size-4" /> },
    { id: "screenshots", label: "Screenshots", icon: <ImagePlus className="size-4" /> },
    { id: "caption", label: "Caption", icon: <Type className="size-4" /> },
  ]

  return (
    <PageShell
      step={3}
      back="/interests"
      title="Add video ideas"
      subtitle="Paste a YouTube or TikTok link, upload screenshots, or paste a caption. We’ll pull out the places."
      footer={
        <div className="flex flex-col gap-2">
          {saveError ? (
            <p role="alert" className="text-sm text-destructive">
              {saveError}
            </p>
          ) : null}
          {running && !saving ? (
            <p className="text-xs text-muted-foreground">Still finding places. You can wait, or carry on without them.</p>
          ) : null}
          {chosen.length && !isDemo ? (
            <Button size="lg" className="h-12 w-full text-base" onClick={saveAndContinue} disabled={saving || !tripId}>
              {saving ? (
                <>
                  <Loader2 className="animate-spin" /> Saving your places…
                </>
              ) : (
                `Add ${chosen.length} place${chosen.length === 1 ? "" : "s"} and build my itinerary`
              )}
            </Button>
          ) : (
            <Link
              href="/itinerary"
              className={buttonVariants({ size: "lg", variant: places.length ? "outline" : "default", className: "h-12 w-full text-base" })}
            >
              {places.length ? "Build my itinerary without these" : "Skip, build my itinerary"}
            </Link>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-6">
        {tripError ? (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {tripError}
          </p>
        ) : null}
        {isDemo ? (
          <p className="rounded-lg border bg-muted p-3 text-sm">
            You’re looking at the demo trip, so places can’t be added to it. Start your own trip to save them.
          </p>
        ) : null}

        <section className="flex flex-col gap-3">
          <div role="tablist" aria-label="How to add ideas" className="grid grid-cols-3 gap-1 rounded-xl bg-muted p-1">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => {
                  setTab(t.id)
                  setFormError("")
                }}
                className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition-colors ${
                  tab === t.id ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>

          {tab === "link" ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                start("link")
              }}
            >
              <div className="relative flex-1">
                <Link2 className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="YouTube or TikTok link"
                  placeholder="https://youtube.com/... or tiktok.com/..."
                  className="h-11 pl-9"
                  inputMode="url"
                  autoComplete="off"
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                />
              </div>
              <Button type="submit" className="h-11" disabled={starting || !link.trim()}>
                {starting ? <Loader2 className="animate-spin" /> : null} Find places
              </Button>
            </form>
          ) : null}

          {tab === "screenshots" ? (
            <div className="flex flex-col gap-2">
              <input
                ref={fileInput}
                type="file"
                accept={IMAGE_TYPES.join(",")}
                multiple
                hidden
                onChange={(e) => addFiles(e.target.files)}
              />
              <Button
                type="button"
                variant="outline"
                className="h-11"
                onClick={() => fileInput.current?.click()}
                disabled={files.length >= MAX_SCREENSHOTS}
              >
                <ImagePlus /> Choose screenshots
              </Button>
              <p className="text-xs text-muted-foreground">
                Great for TikTok slideshows: add every slide (up to {MAX_SCREENSHOTS}) and they’re read together.
              </p>
              {files.length ? (
                <ul className="flex flex-col gap-1.5">
                  {files.map((f, i) => (
                    <li key={`${f.name}-${i}`} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                      <span className="flex-1 truncate">{f.name}</span>
                      <span className="text-xs text-muted-foreground">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
                      <button
                        type="button"
                        aria-label={`Remove ${f.name}`}
                        className="grid size-7 place-items-center rounded-full hover:bg-muted"
                        onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}
                      >
                        <X className="size-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <Button type="button" className="h-11" onClick={() => start("screenshots")} disabled={starting || !files.length}>
                {starting ? <Loader2 className="animate-spin" /> : null}
                Find places in {files.length === 1 ? "1 screenshot" : `${files.length || ""} screenshots`.trim()}
              </Button>
            </div>
          ) : null}

          {tab === "caption" ? (
            <div className="flex flex-col gap-2">
              <textarea
                aria-label="Caption or notes"
                placeholder="Paste a TikTok or Instagram caption, or any notes that mention places"
                rows={5}
                maxLength={MAX_CAPTION_CHARS}
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                className="w-full min-w-0 rounded-lg border border-input bg-transparent px-3 py-2 text-base outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm"
              />
              <Button type="button" className="h-11" onClick={() => start("caption")} disabled={starting || !caption.trim()}>
                {starting ? <Loader2 className="animate-spin" /> : null} Find places
              </Button>
            </div>
          ) : null}

          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}
        </section>

        {jobs.length ? (
          <section className="flex flex-col gap-2" aria-label="Your imports">
            <h2 className="text-sm font-medium">Your imports</h2>
            {jobs.map((j) => (
              <div key={j.jobId} className="flex flex-col gap-2 rounded-xl border p-3">
                <div className="flex items-center gap-2 text-sm">
                  {isActive(j) ? (
                    <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                  ) : j.status === "done" ? (
                    <Check className="size-4 shrink-0 text-primary" />
                  ) : (
                    <AlertTriangle className="size-4 shrink-0 text-destructive" />
                  )}
                  <span className="flex-1 truncate font-medium">{j.label}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {isActive(j)
                      ? elapsed(j.startedAt)
                      : j.status === "done"
                        ? `${j.places.length} place${j.places.length === 1 ? "" : "s"}`
                        : "Didn’t work"}
                  </span>
                </div>
                {isActive(j) ? (
                  <p className="text-xs text-muted-foreground">
                    Finding places… a long video can take a minute or two the first time.
                  </p>
                ) : null}
                {!isActive(j) && j.message ? (
                  <div className="flex flex-col gap-2">
                    <p className={`text-xs ${j.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
                      {j.message}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" size="sm" variant="outline" onClick={() => setTab("screenshots")}>
                        <ImagePlus /> Add screenshots
                      </Button>
                      {j.status === "failed" ? (
                        <Button type="button" size="sm" variant="outline" onClick={() => setTab("caption")}>
                          <Type /> Paste the caption
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </section>
        ) : null}

        {places.length ? (
          <section className="flex flex-col gap-2" aria-label="Places found">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-medium">Places found</h2>
              <span className="text-xs text-muted-foreground">
                {chosen.length} of {places.length} ticked
              </span>
            </div>
            <p className="-mt-1 text-xs text-muted-foreground">
              Untick anything you don’t want. Places we’re not sure about start unticked.
            </p>
            <ul className="flex flex-col gap-2">
              {places.map((p) => {
                const k = placeKey(p)
                const on = selected.includes(k)
                const unsure = (p.confidence ?? 0) < SURE
                const watch = watchAt(p)
                return (
                  <li key={k}>
                    <label
                      className={`flex cursor-pointer gap-3 rounded-xl border p-3 transition-colors ${
                        on ? "border-primary bg-primary/5" : "hover:bg-muted"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggle(k)}
                        className="mt-0.5 size-5 shrink-0 accent-[var(--primary)]"
                      />
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-medium">{p.nameEnglish || p.name}</span>
                          {p.nameEnglish && p.name !== p.nameEnglish ? (
                            <span className="text-sm text-muted-foreground">{p.name}</span>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          {p.category ? <span className="capitalize">{p.category}</span> : null}
                          {unsure ? (
                            <span className="rounded-full bg-amber-100 px-2 py-0.5 font-medium text-amber-900">Not sure</span>
                          ) : null}
                          {p.lat === null ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 font-medium">
                              <MapPinOff className="size-3" /> Not on the map
                            </span>
                          ) : null}
                          {watch && p.timestamp ? (
                            <a
                              href={watch}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-0.5 font-medium text-primary hover:underline"
                            >
                              <Play className="size-3" /> {p.timestamp}
                            </a>
                          ) : null}
                        </div>
                        {p.tip ? <p className="text-sm">{p.tip}</p> : null}
                      </div>
                    </label>
                  </li>
                )
              })}
            </ul>
          </section>
        ) : null}
      </div>
    </PageShell>
  )
}
