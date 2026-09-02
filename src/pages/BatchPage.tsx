import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { APP_ORIGIN, supabase } from '../lib/supabase'
import type { PageSize, TagFormat } from '../tags/dimensions'
import { downloadPdf } from './TagsPage'

/** Deterministic layout means a batch's PDF can always be regenerated. */
export default function BatchPage() {
  const { batchId } = useParams<{ batchId: string }>()
  const { session } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<{
    label: string | null
    prefix: string | null
    tag_count: number
    format: string
    page_size: string
  } | null>(null)

  useEffect(() => {
    if (!session || !batchId) return
    void supabase
      .from('tag_batches')
      .select('label,prefix,tag_count,format,page_size')
      .eq('id', batchId)
      .single()
      .then(({ data, error }) => {
        if (error) setError(error.message)
        else setInfo(data)
      })
  }, [session, batchId])

  async function reprint() {
    if (!batchId || !info) return
    setBusy(true)
    setError(null)
    try {
      const { data, error } = await supabase
        .from('tags')
        .select('id,seq')
        .eq('batch_id', batchId)
        .order('seq')
      if (error) throw new Error(error.message)
      const { generateTagSheetPdf } = await import('../tags/pdf')
      const pdf = await generateTagSheetPdf({
        ids: (data ?? []).map((r) => r.id),
        format: info.format as TagFormat,
        pageSize: info.page_size as PageSize,
        prefix: info.prefix ?? undefined,
        label: info.label ?? undefined,
        origin: APP_ORIGIN,
      })
      downloadPdf(pdf, `specimap-tags-${info.label || batchId.slice(0, 8)}.pdf`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-full max-w-lg flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <Link to="/tags" className="text-sm text-slate-400 underline">
          ← Tag sheets
        </Link>
      </header>
      {info ? (
        <div className="flex flex-col gap-4 rounded-lg bg-slate-900 p-4">
          <div>
            <h1 className="text-lg font-bold">{info.label ?? 'Unlabeled batch'}</h1>
            <p className="text-sm text-slate-400">
              {info.tag_count} × {info.format} · {info.page_size}
              {info.prefix ? ` · prefix ${info.prefix}` : ''}
            </p>
          </div>
          <button
            onClick={() => void reprint()}
            disabled={busy}
            className="rounded-lg bg-emerald-600 px-4 py-3 font-semibold disabled:opacity-50"
          >
            {busy ? 'Rendering…' : 'Download PDF again'}
          </button>
        </div>
      ) : (
        <p className="text-slate-400">{error ?? 'Loading…'}</p>
      )}
      {info && error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  )
}
