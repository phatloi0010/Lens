import { getNetworkConfig, type NetworkName } from './config'
import type { WatchedPair } from './types'

export interface ParsedAssetQuery {
  code: string
  issuer: string | null
}

/**
 * Parse an asset identifier from query/path parameters (`CODE`, `CODE:ISSUER`, or `native`).
 */
export function parseAssetQuery(raw: string): ParsedAssetQuery {
  const trimmed = raw.trim()
  if (trimmed.toLowerCase() === 'native') {
    return { code: 'XLM', issuer: null }
  }
  const [code, issuer] = trimmed.split(':')
  const normalizedCode = (code ?? '').toUpperCase()
  const normalizedIssuer =
    !issuer || issuer.toLowerCase() === 'native' || normalizedCode === 'XLM'
      ? null
      : issuer
  return { code: normalizedCode, issuer: normalizedIssuer }
}

/**
 * Canonical display/storage identifier for an asset (`CODE` or `CODE:ISSUER`).
 */
export function formatAssetId(asset: { code: string; issuer?: string | null }): string {
  const code = asset.code.toUpperCase()
  if (!asset.issuer || code === 'XLM') return code
  return `${code}:${asset.issuer}`
}

/**
 * Check whether two asset descriptors refer to the same asset, enforcing the
 * issuer whenever both sides supply one.
 */
export function assetsEqual(
  q: { code: string; issuer?: string | null },
  side: { code: string; issuer?: string | null }
): boolean {
  if (q.code.toUpperCase() !== side.code.toUpperCase()) return false
  if (!q.issuer || !side.issuer) return true
  return q.issuer === side.issuer
}

/**
 * Resolve a requested pair against the ones this network watches, honouring a
 * supplied issuer on either leg.
 */
export function findPair(
  assetA: string,
  assetB: string,
  network: NetworkName
): WatchedPair | undefined {
  const qA = parseAssetQuery(assetA)
  const qB = parseAssetQuery(assetB)

  return getNetworkConfig(network).pairs.find(
    (p) =>
      (assetsEqual(qA, p.assetA) && assetsEqual(qB, p.assetB)) ||
      (assetsEqual(qA, p.assetB) && assetsEqual(qB, p.assetA))
  )
}

export interface PairSideMatch {
  pair: WatchedPair
  /**
   * Which leg of `pair` the requested `asset` sits on:
   * - `'base'`: `asset` is `pair.assetA` (`price` in `price_points` is `quote per asset`)
   * - `'counter'`: `asset` is `pair.assetB` (`price` in `price_points` is `asset per quote` and must be inverted)
   */
  side: 'base' | 'counter'
}

/**
 * Resolve `(asset, quote)` against the watched pairs on `network` and return
 * both the matched pair and which side `asset` occupies so callers can orient
 * prices consistently in `quote per asset`.
 */
export function findPairByAsset(
  asset: string,
  quote: string,
  network: NetworkName
): PairSideMatch | undefined {
  const qAsset = parseAssetQuery(asset)
  const qQuote = parseAssetQuery(quote)

  for (const p of getNetworkConfig(network).pairs) {
    if (assetsEqual(qAsset, p.assetA) && assetsEqual(qQuote, p.assetB)) {
      return { pair: p, side: 'base' }
    }
    if (assetsEqual(qAsset, p.assetB) && assetsEqual(qQuote, p.assetA)) {
      return { pair: p, side: 'counter' }
    }
  }
  return undefined
}
