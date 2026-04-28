import { beforeEach, describe, expect, it, vi } from 'vitest'

const getProviderConfigMock = vi.hoisted(() => vi.fn(async () => ({
  id: 'openai-compatible:oa-1',
  apiKey: 'oa-key',
  baseUrl: 'https://oa.test/v1',
})))

vi.mock('@/lib/api-config', () => ({
  getProviderConfig: getProviderConfigMock,
}))

import { pollAsyncTask } from '@/lib/async-poll'

const PROVIDER_TOKEN = Buffer.from('openai-compatible:oa-1', 'utf8').toString('base64url')

/**
 * pollOpenAIVideoTask now uses raw fetch (not OpenAI SDK),
 * so we mock fetch instead of the SDK.
 */
describe('async poll OPENAI video status mapping', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    getProviderConfigMock.mockResolvedValue({
      id: 'openai-compatible:oa-1',
      apiKey: 'oa-key',
      baseUrl: 'https://oa.test/v1',
    })
    fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
  })

  it('maps queued/in_progress to pending', async () => {
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'queued' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'in_progress' }),
      })

    const queued = await pollAsyncTask(`OPENAI:VIDEO:${PROVIDER_TOKEN}:vid_queued`, 'user-1')
    const progress = await pollAsyncTask(`OPENAI:VIDEO:${PROVIDER_TOKEN}:vid_running`, 'user-1')

    expect(queued).toEqual({ status: 'pending' })
    expect(progress).toEqual({ status: 'pending' })
  })

  it('maps completed to direct result_url', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'vid_done',
        status: 'completed',
        result_url: 'https://api.runnode.cn/v1/files/video.mp4',
      }),
    })

    const result = await pollAsyncTask(`OPENAI:VIDEO:${PROVIDER_TOKEN}:vid_done`, 'user-1')

    expect(result.status).toBe('completed')
    expect(result.resultUrl).toBe('https://api.runnode.cn/v1/files/video.mp4')
    expect(result.videoUrl).toBe('https://api.runnode.cn/v1/files/video.mp4')
    expect(result.downloadHeaders).toBeUndefined()
  })

  it('maps completed to failed when no direct url exists', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'vid_done_without_url',
        status: 'completed',
      }),
    })

    const result = await pollAsyncTask(`OPENAI:VIDEO:${PROVIDER_TOKEN}:vid_done_without_url`, 'user-1')
    expect(result).toEqual({
      status: 'failed',
      error: 'OpenAI video task completed but no result_url/video_url returned',
    })
  })

  it('maps failed to failed with provider error message', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'vid_failed',
        status: 'failed',
        error: { message: 'generation failed' },
      }),
    })

    const result = await pollAsyncTask(`OPENAI:VIDEO:${PROVIDER_TOKEN}:vid_failed`, 'user-1')
    expect(result).toEqual({ status: 'failed', error: 'generation failed' })
  })
})
