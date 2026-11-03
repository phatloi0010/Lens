import { describe, it, expect, vi, beforeEach } from 'vitest'
import Fastify from 'fastify'
import type { WatchedPair } from '../types'

const { mockQuery, mockWatchedPairs } = vi.hoisted(() => ({
  mockQuery: vi.fn(),
  mockWatchedPairs: { testnet: [] as WatchedPair[], mainnet: [] as WatchedPair[] },
}))

vi.mock('../db', () => ({
  pgPool: { query: mockQuery },
}))

vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>()
  return {
    ...actual,
    getNetworkConfig: (network: 'testnet' | 'mainnet') => ({
      ...actual.getNetworkConfig(network),
      pairs: mockWatchedPairs[network] ?? [],
    }),
  }
})

import { registerBasketRoutes } from '../routes/basket'

const TESTNET_USDC = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const MAINNET_USDC = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const TESTNET_EURC = 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2'
const TESTNET_JPYC = 'GBVAOIACNSB7OVUXJYC5UE2D4YK2F7A24T7EE5YOMN4CE6GCHUTOUQXM'

async function buildApp() {
  const app = Fastify({ logger: false })
  await registerBasketRoutes(app)
  await app.ready()
  return app
}

describe('GET /basket', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockWatchedPairs.testnet = []
    mockWatchedPairs.mainnet = []
  })

  it('returns weighted basket price with normalized weights', async () => {
    mockQuery.mockImplementation(async (_sql: string, params: string[]) => {
      const asset = params[0]
      if (asset === 'USDC') return { rows: [{ vwap: '1.0' }] }
      if (asset === 'XLM') return { rows: [{ vwap: '0.1' }] }
      return { rows: [{ vwap: null }] }
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/basket?asset=USDC&weight=1&asset=XLM&weight=1',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.quote).toBe('USDC')
    expect(body.basketPrice).toBeCloseTo(0.55, 5)
    expect(body.weightSum).toBeCloseTo(1.0, 5)
    expect(body.components).toHaveLength(2)
    expect(body.components[0].asset).toBe('USDC')
    expect(body.components[0].weight).toBeCloseTo(0.5, 5)
    expect(body.components[1].asset).toBe('XLM')
    expect(body.components[1].weight).toBeCloseTo(0.5, 5)
    expect(body.computedAt).toBeDefined()
  })

  it('normalizes unequal weights to sum to 1.0', async () => {
    mockQuery.mockImplementation(async (_sql: string, params: string[]) => {
      const asset = params[0]
      if (asset === 'USDC') return { rows: [{ vwap: '1.0' }] }
      if (asset === 'EURC') return { rows: [{ vwap: '1.1' }] }
      return { rows: [{ vwap: null }] }
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/basket?asset=USDC&weight=3&asset=EURC&weight=1',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.weightSum).toBeCloseTo(1.0, 5)
    // USDC weight = 0.75, EURC weight = 0.25
    // basketPrice = 0.75*1.0 + 0.25*1.1 = 0.75 + 0.275 = 1.025
    expect(body.basketPrice).toBeCloseTo(1.025, 5)
    expect(body.components[0].weight).toBeCloseTo(0.75, 5)
    expect(body.components[1].weight).toBeCloseTo(0.25, 5)
  })

  it('returns 400 when no assets provided', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/basket' })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toMatch(/Invalid asset: at least one asset is required/)
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when only one asset provided', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/basket?asset=USDC&weight=1' })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toMatch(/Invalid asset: basket requires at least 2 assets/)
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when asset and weight counts do not match', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/basket?asset=USDC&asset=XLM&weight=1',
    })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toMatch(/Invalid weight: number of assets and weights must match/)
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 when a weight is not a positive number', async () => {
    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/basket?asset=USDC&weight=0&asset=XLM&weight=1',
    })
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.error).toMatch(/Invalid weight: all weights must be positive numbers/)
    expect(body.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 for a negative or non-numeric weight', async () => {
    const app = await buildApp()
    const negative = await app.inject({
      method: 'GET',
      url: '/basket?asset=USDC&weight=-1&asset=XLM&weight=1',
    })
    expect(negative.statusCode).toBe(400)
    expect(negative.json().code).toBe('VALIDATION_ERROR')

    const nonNumeric = await app.inject({
      method: 'GET',
      url: '/basket?asset=USDC&weight=abc&asset=XLM&weight=1',
    })
    expect(nonNumeric.statusCode).toBe(400)
    expect(nonNumeric.json().code).toBe('VALIDATION_ERROR')
    await app.close()
  })

  it('returns 200 with error and reason when an asset has no price data', async () => {
    mockQuery.mockImplementation(async (_sql: string, params: string[]) => {
      const asset = params[0]
      if (asset === 'USDC') return { rows: [{ vwap: '1.0' }] }
      return { rows: [{ vwap: null }] }
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/basket?asset=USDC&weight=1&asset=UNKNOWN&weight=1',
    })
    // Changed from 404 to 200 per issue #262: the asset code is valid, the
    // query succeeded, there is just no data. A 404 would imply the endpoint
    // or the asset itself doesn't exist.
    expect(res.statusCode).toBe(200)
    expect(res.json().error).toMatch(/UNKNOWN/)
    expect(res.json().reason).toBe('missing_price_data')
    expect(res.json().missingAssets).toContain('UNKNOWN')
  })

  it('does not pool two pairs that share a base asset with different quote currencies', async () => {
    const xlmUsdcKey = `USDC:${TESTNET_USDC}/XLM`
    const xlmEurcKey = `EURC:${TESTNET_EURC}/XLM`
    mockWatchedPairs.testnet = [
      {
        assetA: { code: 'XLM', issuer: null },
        assetB: { code: 'USDC', issuer: TESTNET_USDC },
        pairKey: xlmUsdcKey,
      },
      {
        assetA: { code: 'XLM', issuer: null },
        assetB: { code: 'EURC', issuer: TESTNET_EURC },
        pairKey: xlmEurcKey,
      },
    ]

    const queriedPairKeys: string[] = []
    mockQuery.mockImplementation(async (_sql: string, params: string[]) => {
      const pairKey = params[0]
      queriedPairKeys.push(pairKey)
      // XLM/USDC trades at 0.10 USDC per XLM; XLM/EURC trades at 0.90 EURC per XLM.
      // Previously, WHERE (asset_a = 'XLM' OR asset_b = 'XLM') pooled both into 0.50!
      if (pairKey === xlmUsdcKey) return { rows: [{ vwap: '0.10' }] }
      if (pairKey === xlmEurcKey) return { rows: [{ vwap: '0.90' }] }
      return { rows: [{ vwap: null }] }
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/basket?asset=XLM&asset=USDC&weight=1&weight=1&quote=USDC',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.quote).toBe('USDC')
    expect(queriedPairKeys).toEqual([xlmUsdcKey])
    expect(queriedPairKeys).not.toContain(xlmEurcKey)
    expect(body.components[0]).toMatchObject({ asset: 'XLM', price: 0.1 })
    expect(body.components[1]).toMatchObject({ asset: 'USDC', price: 1 })
    expect(body.basketPrice).toBeCloseTo(0.55, 5)
  })

  it('inverts prices when the requested asset sits on the counter side of the pair', async () => {
    const usdcXlmKey = `USDC:${TESTNET_USDC}/XLM`
    mockWatchedPairs.testnet = [
      {
        // assetA is USDC (quote), assetB is XLM (counter side):
        // price in price_points is XLM per USDC (10.0), so USDC per XLM is 1 / 10 = 0.10.
        assetA: { code: 'USDC', issuer: TESTNET_USDC },
        assetB: { code: 'XLM', issuer: null },
        pairKey: usdcXlmKey,
      },
    ]

    mockQuery.mockImplementation(async (_sql: string, params: string[]) => {
      if (params[0] === usdcXlmKey) return { rows: [{ vwap: '10.0' }] }
      return { rows: [{ vwap: null }] }
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/basket?asset=XLM&asset=USDC&weight=1&weight=1&quote=USDC',
    })

    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.components[0].asset).toBe('XLM')
    expect(body.components[0].price).toBeCloseTo(0.1, 8)
    expect(body.components[1].asset).toBe('USDC')
    expect(body.components[1].price).toBe(1)
    expect(body.basketPrice).toBeCloseTo(0.55, 5)
  })

  it('honours a supplied issuer using findPair semantics and returns 404 on issuer mismatch', async () => {
    const usdcXlmKey = `USDC:${TESTNET_USDC}/XLM`
    mockWatchedPairs.testnet = [
      {
        assetA: { code: 'USDC', issuer: TESTNET_USDC },
        assetB: { code: 'XLM', issuer: null },
        pairKey: usdcXlmKey,
      },
    ]

    mockQuery.mockImplementation(async (_sql: string, params: string[]) => {
      if (params[0] === usdcXlmKey) return { rows: [{ vwap: '10.0' }] }
      return { rows: [{ vwap: null }] }
    })

    const app = await buildApp()

    // Matching testnet issuer succeeds
    const validRes = await app.inject({
      method: 'GET',
      url: `/basket?asset=XLM&asset=USDC:${TESTNET_USDC}&weight=1&weight=1&quote=USDC:${TESTNET_USDC}`,
    })
    expect(validRes.statusCode).toBe(200)
    expect(validRes.json().basketPrice).toBeCloseTo(0.55, 5)

    // Mismatched mainnet issuer on testnet fails with 404 naming the asset
    const mismatchRes = await app.inject({
      method: 'GET',
      url: `/basket?asset=XLM&asset=USDC:${MAINNET_USDC}&weight=1&weight=1&quote=USDC:${TESTNET_USDC}`,
    })
    expect(mismatchRes.statusCode).toBe(404)
    expect(mismatchRes.json().error).toContain(`USDC:${MAINNET_USDC}`)
  })

  it('returns 404 naming the asset and quote when an asset has no price in the chosen quote', async () => {
    const xlmUsdcKey = `USDC:${TESTNET_USDC}/XLM`
    const eurcJpycKey = `EURC:${TESTNET_EURC}/JPYC:${TESTNET_JPYC}`
    mockWatchedPairs.testnet = [
      {
        assetA: { code: 'XLM', issuer: null },
        assetB: { code: 'USDC', issuer: TESTNET_USDC },
        pairKey: xlmUsdcKey,
      },
      {
        assetA: { code: 'EURC', issuer: TESTNET_EURC },
        assetB: { code: 'JPYC', issuer: TESTNET_JPYC },
        pairKey: eurcJpycKey,
      },
    ]

    mockQuery.mockImplementation(async (_sql: string, params: string[]) => {
      if (params[0] === xlmUsdcKey) return { rows: [{ vwap: '0.10' }] }
      if (params[0] === eurcJpycKey) return { rows: [{ vwap: '160.0' }] }
      return { rows: [{ vwap: null }] }
    })

    const app = await buildApp()
    const res = await app.inject({
      method: 'GET',
      url: '/basket?asset=XLM&asset=EURC&weight=1&weight=1&quote=USDC',
    })

    expect(res.statusCode).toBe(404)
    const body = res.json()
    expect(body.error).toMatch(/EURC/)
    expect(body.error).toMatch(/in quote USDC/)
    expect(body.missingAssets).toEqual(['EURC'])
    expect(body.basketPrice).toBeUndefined()
  })
})
