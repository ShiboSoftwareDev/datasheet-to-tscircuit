export function errorMessage(errors: Array<{ message: string }>): string | undefined {
  const messages = [...new Set(errors.map(({ message }) => message.trim()).filter(Boolean))]
  return messages.length > 0 ? messages.join("; ") : undefined
}

export function titleFromIdentifier(identifier: string): string {
  return identifier.replace(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase())
}

export function averageDefined(values: Array<number | undefined>): number | undefined {
  const finite = values.filter((value): value is number => value !== undefined && Number.isFinite(value))
  return finite.length > 0 ? finite.reduce((sum, value) => sum + value, 0) / finite.length : undefined
}

export function maximumDefined(values: Array<number | undefined>): number | undefined {
  const finite = values.filter((value): value is number => value !== undefined && Number.isFinite(value))
  return finite.length > 0 ? Math.max(...finite) : undefined
}
