import { randomBytes } from 'node:crypto'

/** `billing-7f2a`: a readable slug plus a short random suffix. */
export function slugId(title: string, suffixBytes = 2): string {
  const slug =
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'block'
  return `${slug}-${randomBytes(suffixBytes).toString('hex')}`
}

export function opaqueId(prefix: string, bytes = 6): string {
  return `${prefix}_${randomBytes(bytes).toString('hex')}`
}

export function token(): string {
  return randomBytes(24).toString('base64url')
}
