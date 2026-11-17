import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { describeStorage, placementOf } from './store'

/** "Stored in Box …, A3 · Freezer rack …, no. 5": where an item is kept. */
export default function StorageLine({ tagId }: { tagId: string }) {
  const data = useLiveQuery(async () => {
    const p = await placementOf(tagId)
    return p ? { box: p.boxTagId, text: await describeStorage(tagId) } : null
  }, [tagId])
  if (!data) return null
  return (
    <Link to={`/box/${data.box}`} className="rounded-lg bg-slate-900 p-4 text-sm">
      <span className="text-slate-400">Stored in</span> <span className="text-emerald-400 underline">{data.text}</span>
    </Link>
  )
}
