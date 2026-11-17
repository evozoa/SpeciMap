/**
 * Sequential catalog numbers for a batch: "AUM 12345" for the first item,
 * then "AUM 12346", … Keeps leading zeros ("MSST 0099" -> "MSST 0100").
 * Without a trailing number, every item gets the text as given.
 */
export function catalogSequence(start: string, count: number): string[] {
  const m = /^(.*?)(\d+)(\D*)$/.exec(start.trim())
  if (!m) return Array.from({ length: count }, () => start.trim())
  const [, head, digits, tail] = m
  const first = BigInt(digits)
  return Array.from({ length: count }, (_, i) => {
    const n = (first + BigInt(i)).toString()
    return `${head}${n.padStart(digits.length, '0')}${tail}`
  })
}
