import { useId } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { knownSpecies } from '../db/drafts'

interface Props {
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  id?: string
  className?: string
}

/**
 * Free-text species name with suggestions from names already used on this
 * device, so repeat species are quick to enter and spelled consistently.
 */
export default function SpeciesInput({ value, onChange, onBlur, id, className }: Props) {
  const listId = useId()
  const suggestions = useLiveQuery(knownSpecies, [], [])
  return (
    <>
      <input
        id={id}
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder="Species (optional), e.g. Lepomis megalotis"
        autoCapitalize="sentences"
        autoComplete="off"
        spellCheck={false}
        className={`italic placeholder:not-italic ${className ?? ''}`}
      />
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </>
  )
}
