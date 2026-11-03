import { formatValidationError } from '../validation'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { pgPool } from '../db'
import { activeNetwork, getNetworkConfig, type NetworkName } from '../config'
import {
  assetsEqual,
  findPairByAsset,
  formatAssetId,
  parseAssetQuery,
} from '../pairMatch'
import '../middleware/network' // declares req.network on the FastifyRequest type

/**
 * Default quote currency for `/basket` when `?quote=` is omitted.
 *
 * Every component in a basket must be denominated in the same quote currency
 * and oriented in the same direction (`quote per asset`) so weighted
 * contributions can be summed meaningfully (#174).
 */
export const DEFAULT_BASKET_QUOTE = 'USDC'

interface ComponentQuoteLookup {
  price: number | null
  unwatchedOrMismatched: boolean
}

async function fetchAssetVWAPInQuote(
  rawAsset: string,
  rawQuote: string,
  network: NetworkName
): Promise<ComponentQuoteLookup> {
  const reqAsset = parseAssetQuery(rawAsset)
  const quoteAsset = parseAssetQuery(rawQuote)
  const watchedPairs = getNetworkConfig(network).pairs

  // Same asset code as the quote currency itself (e.g. USDC in a USDC-quoted basket)
  if (reqAsset.code === quoteAsset.code) {
    if (reqAsset.issuer && quoteAsset.issuer && reqAsset.issuer !== quoteAsset.issuer) {
      return { price: null, unwatchedOrMismatched: true }
    }
    if (watchedPairs.length > 0) {
      if (reqAsset.issuer) {
        const matchesWatched = watchedPairs.some(
          (p) => assetsEqual(reqAsset, p.assetA) || assetsEqual(reqAsset, p.assetB)
        )
        if (!matchesWatched) {
          return { price: null, unwatchedOrMismatched: true }
        }
      }
      if (quoteAsset.issuer) {
        const matchesWatchedQuote = watchedPairs.some(
          (p) => assetsEqual(quoteAsset, p.assetA) || assetsEqual(quoteAsset, p.assetB)
        )
        if (!matchesWatchedQuote) {
          return { price: null, unwatchedOrMismatched: true }
        }
      }
    } else if (reqAsset.issuer || quoteAsset.issuer) {
      return { price: null, unwatchedOrMismatched: true }
    }
    return { price: 1, unwatchedOrMismatched: false }
  }

  // When watched pairs are configured on this network, resolve via findPair
  // semantics (honouring any supplied issuer) and query by pair_key.
  if (watchedPairs.length > 0) {
    const match = findPairByAsset(rawAsset, rawQuote, network)
    if (!match) {
      return { price: null, unwatchedOrMismatched: true }
    }

    const result = await pgPool.query(
      `SELECT
         COALESCE(SUM(price::numeric * base_volume::numeric), 0)
         / NULLIF(SUM(base_volume::numeric), 0) AS vwap
       FROM price_points
       WHERE pair_key = $1
         AND network = $2
         AND COALESCE(observed_at, timestamp) > NOW() - INTERVAL '5 minutes'`,
      [match.pair.pairKey, network]
    )
    const vwap = result.rows[0]?.vwap
    if (vwap === null || vwap === undefined) {
      return { price: null, unwatchedOrMismatched: true }
    }
    const parsedVwap = parseFloat(vwap)
    if (!Number.isFinite(parsedVwap) || parsedVwap <= 0) {
      return { price: null, unwatchedOrMismatched: true }
    }

    // price_points stores `assetB per assetA`. When the requested component sits
    // on the counter leg (`assetB`), invert so every component is `quote per asset`.
    const orientedPrice = match.side === 'counter' ? 1 / parsedVwap : parsedVwap
    return { price: orientedPrice, unwatchedOrMismatched: false }
  }

  // Fallback when no watched pairs are registered in config: honour issuer
  // rejection if an issuer was specified without watched pairs, otherwise
  // restrict strictly to the (asset, quote) pair and orient counter-side rows.
  if (reqAsset.issuer || quoteAsset.issuer) {
    return { price: null, unwatchedOrMismatched: true }
  }

  const result = await pgPool.query(
    `SELECT
       COALESCE(
         SUM(
           (CASE
             WHEN asset_a = $1 AND asset_b = $3 THEN price::numeric
             WHEN asset_b = $1 AND asset_a = $3 THEN 1.0 / NULLIF(price::numeric, 0)
           END) * base_volume::numeric
         ) / NULLIF(SUM(base_volume::numeric), 0),
         null
       ) AS vwap
     FROM price_points
     WHERE ((asset_a = $1 AND asset_b = $3) OR (asset_b = $1 AND asset_a = $3))
       AND network = $2
       AND COALESCE(observed_at, timestamp) > NOW() - INTERVAL '5 minutes'`,
    [reqAsset.code, network, quoteAsset.code]
  )
  const vwap = result.rows[0]?.vwap
  if (vwap === null || vwap === undefined) {
    return { price: null, unwatchedOrMismatched: false }
  }
  const parsedVwap = parseFloat(vwap)
  if (!Number.isFinite(parsedVwap) || parsedVwap <= 0) {
    return { price: null, unwatchedOrMismatched: false }
  }
  return { price: parsedVwap, unwatchedOrMismatched: false }
}

const toArray = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : [v]))

const BasketQuerySchema = z
  .object({
    asset: toArray.optional(),
    weight: toArray.optional(),
    quote: z.string().trim().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    const assets = data.asset ?? []
    const weightStrings = data.weight ?? []
    if (assets.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['asset'],
        message: 'at least one asset is required',
      })
    }
    if (assets.length === 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['asset'],
        message: 'basket requires at least 2 assets',
      })
    }
    if (assets.length !== weightStrings.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weight'],
        message: 'number of assets and weights must match',
      })
    }
    const weights = weightStrings.map((w) => parseFloat(w))
    if (weights.some((w) => isNaN(w) || w <= 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['weight'],
        message: 'all weights must be positive numbers',
      })
    }
  })

export async function registerBasketRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: { asset?: string | string[]; weight?: string | string[]; quote?: string }
  }>('/basket', { config: { scope: 'read:prices' } }, async (req, reply) => {
    const parsed = BasketQuerySchema.safeParse(req.query)
    if (!parsed.success) {
      return reply.status(400).send(formatValidationError(parsed.error))
    }
    const assets = parsed.data.asset ?? []
    const weightStrings = parsed.data.weight ?? []
    const hasExplicitQuote = parsed.data.quote !== undefined
    const quoteInput = parsed.data.quote ?? DEFAULT_BASKET_QUOTE
    const quoteLabel = formatAssetId(parseAssetQuery(quoteInput))

    const rawWeightValues = weightStrings.map((w) => parseFloat(w))

    const weightSum = rawWeightValues.reduce((a, b) => a + b, 0)
    const normalizedWeights = rawWeightValues.map((w) => w / weightSum)

    // `price_points` indexes `network` as the leading column of
    // (network, pair_key, timestamp): without the predicate the range scan
    // cannot use the index, and a basket would blend two chains' prices.
    const network: NetworkName = req.network ?? activeNetwork
    const watchedPairs = getNetworkConfig(network).pairs

    const lookups = await Promise.all(
      assets.map((a) => fetchAssetVWAPInQuote(a, quoteInput, network))
    )

    const components = assets.map((asset, i) => ({
      asset: formatAssetId(parseAssetQuery(asset)),
      price: lookups[i].price,
      unwatchedOrMismatched: lookups[i].unwatchedOrMismatched,
      weight: normalizedWeights[i],
    }))

    const missingComponents = components.filter((c) => c.price === null)
    if (missingComponents.length > 0) {
      const missingAssets = missingComponents.map((c) => c.asset)
      const shouldReturn404 =
        hasExplicitQuote ||
        watchedPairs.length > 0 ||
        missingComponents.some((c) => c.unwatchedOrMismatched)

      if (shouldReturn404) {
        return reply.status(404).send({
          error: `No price data found for: ${missingAssets.join(', ')} in quote ${quoteLabel}`,
          reason: 'missing_price_data',
          missingAssets,
          quote: quoteLabel,
          requestedAt: new Date().toISOString(),
        })
      }

      // 200 with reason: query was valid but no price data exists (yet).
      // A 404 would imply the assets themselves are invalid/unwatched.
      return {
        error: `No price data found for: ${missingAssets.join(', ')}`,
        reason: 'missing_price_data',
        missingAssets,
        quote: quoteLabel,
        requestedAt: new Date().toISOString(),
      }
    }

    const basketPrice = components.reduce(
      (sum, c) => sum + c.weight * (c.price as number),
      0
    )

    return {
      quote: quoteLabel,
      basketPrice,
      components: components.map((c) => ({
        asset: c.asset,
        price: c.price as number,
        weight: parseFloat(c.weight.toFixed(8)),
        contribution: parseFloat((c.weight * (c.price as number)).toFixed(8)),
      })),
      weightSum: parseFloat(normalizedWeights.reduce((a, b) => a + b, 0).toFixed(8)),
      computedAt: new Date().toISOString(),
    }
  })
}
