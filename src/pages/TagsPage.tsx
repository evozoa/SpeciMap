import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { generateTagId } from '../lib/tagid'
import { APP_ORIGIN, supabase } from '../lib/supabase'
import type { PageSize, TagFormat } from '../tags/dimensions'

interface BatchRow {
  id: string
  label: string | null
  prefix: string | null
  tag_count: number
  format: string
  page_size: string
  created_at: string
}

const MAX_BATCH = 500

/**
 * Batch wizard. Online-only by design (you print at home): tag IDs are
 * registered in the database BEFORE the PDF is offered, so a printed tag
 * always resolves when scanned.
 */
export default function TagsPage() {
  const { session } = useAuth()
  const [batches, setBatches] = useState<BatchRow[]>([])
  const [count, setCount] = useState(52)
  const [format, setFormat] = useState<TagFormat>('insert')
  const [pageSize, setPageSize] = useState<PageSize>('letter')
  const [label, setLabel] = useState('')
  const [prefix, setPrefix] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!session) return
    void supabase
      .from('tag_batches')
      .select('id,label,prefix,tag_count,format,page_size,created_at')
      .order('created_at', { ascending: false })
      .then(({ data }) => setBatches(data ?? []))
  }, [session])

  async function createBatch(e: FormEvent) {
    e.preventDefault()
    if (!session) return
    setError(null)
    try {
      setBusy('Reserving tag IDs…')
      const n = Math.min(Math.max(1, count), MAX_BATCH)

      const { data: batch, error: batchErr } = await supabase
        .from('tag_batches')
        .insert({
          created_by: session.user.id,
          label: label || null,
          prefix: prefix || null,
          tag_count: n,
          format,
          page_size: pageSize,
        })
        .select('id')
        .single()
      if (batchErr) throw new Error(batchErr.message)

      // Reserve IDs; on the (astronomically rare) collision, regenerate.
      const ids: string[] = []
      let attempts = 0
      while (ids.length < n && attempts < 5) {
        attempts++
        const candidates = Array.from({ length: n - ids.length }, generateTagId)
        const rows = candidates.map((id, i) => ({
          id,
          batch_id: batch.id,
          seq: ids.length + i + 1,
        }))
        const { error: tagErr } = await supabase
          .from('tags')
          .upsert(rows, { onConflict: 'id', ignoreDuplicates: true })
        if (tagErr) throw new Error(tagErr.message)
        const { data: inserted, error: checkErr } = await supabase
          .from('tags')
          .select('id')
          .eq('batch_id', batch.id)
        if (checkErr) throw new Error(checkErr.message)
        ids.length = 0
        ids.push(...(inserted ?? []).map((r) => r.id))
      }
      if (ids.length < n) throw new Error('could not reserve enough tag IDs')

      setBusy('Rendering PDF…')
      // pdf-lib is heavy and print-only: load it on demand.
      const { generateTagSheetPdf } = await import('../tags/pdf')
      // Stable print order: by registered sequence.
      const { data: ordered } = await supabase
        .from('tags')
        .select('id,seq')
        .eq('batch_id', batch.id)
        .order('seq')
      const pdf = await generateTagSheetPdf({
        ids: (ordered ?? []).map((r) => r.id),
        format,
        pageSize,
        prefix: prefix || undefined,
        label: label || undefined,
        origin: APP_ORIGIN,
      })
      downloadPdf(pdf, `specimap-tags-${label || batch.id.slice(0, 8)}.pdf`)
      setBatches((prev) => [
        {
          id: batch.id,
          label: label || null,
          prefix: prefix || null,
          tag_count: n,
          format,
          page_size: pageSize,
          created_at: new Date().toISOString(),
        },
        ...prev,
      ])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  if (!session) {
    return (
      <div className="flex min-h-full flex-col items-center justify-center gap-3 p-6">
        <p className="text-slate-400">Sign in to generate tag sheets.</p>
        <Link to="/auth" className="rounded-lg bg-emerald-600 px-5 py-3 font-semibold">
          Sign in
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col gap-6 p-4">
      <header className="flex items-center justify-between">
        <Link to="/" className="text-sm text-slate-400 underline">
          ← Home
        </Link>
        <h1 className="text-xl font-bold">Tag sheets</h1>
      </header>

      <form onSubmit={(e) => void createBatch(e)} className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Number of tags
            <input
              type="number"
              min={1}
              max={MAX_BATCH}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Style
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as TagFormat)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2"
            >
              <option value="insert">Insert (inside vial)</option>
              <option value="punch">Punch-hole (under cap)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Paper
            <select
              value={pageSize}
              onChange={(e) => setPageSize(e.target.value as PageSize)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2"
            >
              <option value="letter">Letter</option>
              <option value="a4">A4</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Prefix (optional)
            <input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value.toUpperCase().slice(0, 6))}
              placeholder="PS26"
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono"
            />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-sm">
          Batch label (optional)
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Pond survey June 2026"
            className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2"
          />
        </label>
        <button
          disabled={!!busy || !navigator.onLine}
          className="rounded-lg bg-emerald-600 px-4 py-3 font-semibold disabled:opacity-50"
        >
          {busy ?? 'Generate & download PDF'}
        </button>
        {!navigator.onLine && (
          <p className="text-sm text-amber-400">
            Generating tags requires a connection (IDs are registered first so
            every printed tag scans).
          </p>
        )}
        {error && <p className="text-sm text-red-400">{error}</p>}
        <p className="text-xs text-slate-500">
          Print at 100% ("Actual Size") on waterproof laser paper. Each sheet
          includes a 50mm calibration ruler — measure it before cutting.
        </p>
      </form>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Previous batches
        </h2>
        {batches.length === 0 && (
          <p className="text-sm text-slate-500">No batches yet.</p>
        )}
        {batches.map((b) => (
          <Link
            key={b.id}
            to={`/tags/${b.id}`}
            className="flex items-center justify-between rounded-lg bg-slate-900 p-3"
          >
            <div>
              <div className="font-semibold">{b.label ?? 'Unlabeled batch'}</div>
              <div className="text-xs text-slate-400">
                {b.tag_count} × {b.format} · {b.page_size} ·{' '}
                {new Date(b.created_at).toLocaleDateString()}
              </div>
            </div>
            <span className="text-sm text-emerald-400">Reprint →</span>
          </Link>
        ))}
      </section>
    </div>
  )
}

export function downloadPdf(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
