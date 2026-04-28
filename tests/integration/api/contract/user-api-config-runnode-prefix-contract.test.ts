import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildMockRequest } from '../../../helpers/request'
import {
  installAuthMocks,
  mockAuthenticated,
  resetAuthMockState,
} from '../../../helpers/auth'

type UserPreferenceSnapshot = {
  customProviders: string | null
  customModels: string | null
}

const prismaMock = vi.hoisted(() => ({
  userPreference: {
    findUnique: vi.fn<(...args: unknown[]) => Promise<UserPreferenceSnapshot | null>>(),
    upsert: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  },
}))

const encryptApiKeyMock = vi.hoisted(() => vi.fn((value: string) => `enc:${value}`))
const decryptApiKeyMock = vi.hoisted(() => vi.fn((value: string) => value.replace(/^enc:/, '')))
const getBillingModeMock = vi.hoisted(() => vi.fn(async () => 'OFF'))

vi.mock('@/lib/prisma', () => ({
  prisma: prismaMock,
}))

vi.mock('@/lib/crypto-utils', () => ({
  encryptApiKey: encryptApiKeyMock,
  decryptApiKey: decryptApiKeyMock,
}))

vi.mock('@/lib/billing/mode', () => ({
  getBillingMode: getBillingModeMock,
}))

const routeContext = { params: Promise.resolve({}) }

function readSavedModelsFromUpsert(): Array<Record<string, unknown>> {
  const firstCall = prismaMock.userPreference.upsert.mock.calls[0]
  if (!firstCall) {
    throw new Error('expected prisma.userPreference.upsert to be called at least once')
  }

  const payload = firstCall[0] as { update?: { customModels?: unknown } }
  const rawModels = payload.update?.customModels
  if (typeof rawModels !== 'string') {
    throw new Error('expected update.customModels to be a JSON string')
  }

  const parsed = JSON.parse(rawModels) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error('expected update.customModels to parse as an array')
  }
  return parsed as Array<Record<string, unknown>>
}

describe('api contract - user api-config PUT runnode/* video template', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    resetAuthMockState()

    prismaMock.userPreference.findUnique.mockResolvedValue({
      customProviders: null,
      customModels: null,
    })
    prismaMock.userPreference.upsert.mockResolvedValue({ id: 'pref-1' })
    getBillingModeMock.mockResolvedValue('OFF')
  })

  it('normalizes any runnode/ modelId video multipart template to application/json', async () => {
    installAuthMocks()
    mockAuthenticated('user-1')
    const route = await import('@/app/api/user/api-config/route')

    const modelKey = 'openai-compatible:oa-contract::runnode/prefix-contract-probe'
    const req = buildMockRequest({
      path: '/api/user/api-config',
      method: 'PUT',
      body: {
        providers: [
          { id: 'openai-compatible:oa-contract', name: 'OpenAI Compat', baseUrl: 'https://compat.test/v1', apiKey: 'oa-key' },
        ],
        models: [
          {
            modelId: 'runnode/prefix-contract-probe',
            modelKey,
            name: 'RunNode prefix probe',
            type: 'video',
            provider: 'openai-compatible:oa-contract',
            compatMediaTemplate: {
              version: 1,
              mediaType: 'video',
              mode: 'async',
              create: {
                method: 'POST',
                path: '/videos',
                contentType: 'multipart/form-data',
                multipartFileFields: ['input_reference'],
                bodyTemplate: {
                  model: '{{model}}',
                  prompt: '{{prompt}}',
                  input_reference: '{{image}}',
                },
              },
              status: {
                method: 'GET',
                path: '/videos/{{task_id}}',
              },
              response: {
                taskIdPath: '$.id',
                statusPath: '$.status',
              },
              polling: {
                intervalMs: 3000,
                timeoutMs: 180000,
                doneStates: ['completed'],
                failStates: ['failed'],
              },
            },
          },
        ],
      },
    })

    const res = await route.PUT(req, routeContext)
    expect(res.status).toBe(200)
    const savedModels = readSavedModelsFromUpsert()
    const savedModel = savedModels.find((item) => item.modelKey === modelKey)
    expect(savedModel?.compatMediaTemplate).toMatchObject({
      mediaType: 'video',
      mode: 'async',
      create: {
        path: '/videos',
        contentType: 'application/json',
      },
    })
    const createConfig = (savedModel?.compatMediaTemplate as { create?: Record<string, unknown> } | undefined)?.create
    expect(createConfig).not.toHaveProperty('multipartFileFields')
  })
})
