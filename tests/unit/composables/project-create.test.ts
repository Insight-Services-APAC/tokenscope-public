/*
 * useProjectCreate (FE-3) — idempotent two-step create. The invariant under
 * test: POST /admin/projects runs AT MOST ONCE across submit attempts, so a
 * failed allocation step can be retried without colliding on the unique
 * project code; failedStep distinguishes the two failure messages.
 */
import { describe, it, expect, vi } from 'vitest'
import { useProjectCreate } from '../../../app/composables/useProjectCreate'

const PROJECT = {
  code: 'ACME-2026',
  display_name: 'Acme platform rebuild',
  type: 'billable',
  region_id: 'r1',
  cost_owning_unit_id: 'cou1',
}
const ALLOCATION = {
  budget_usd: '1000.00',
  effective: '[2026-06-01T00:00:00+00,2026-07-01T00:00:00+00)',
}

describe('useProjectCreate', () => {
  it('happy path: creates project then allocation, returns the allocation id', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ id: 'proj-1' })
      .mockResolvedValueOnce({ id: 'alloc-1' })
    const c = useProjectCreate({ post: post as never })

    const allocId = await c.submit(PROJECT, ALLOCATION)

    expect(allocId).toBe('alloc-1')
    expect(c.error.value).toBeNull()
    expect(c.failedStep.value).toBeNull()
    expect(post).toHaveBeenNthCalledWith(1, '/api/v1/admin/projects', PROJECT)
    expect(post).toHaveBeenNthCalledWith(2, '/api/v1/allocations', {
      ...ALLOCATION,
      project_id: 'proj-1',
    })
  })

  it('does NOT re-POST the project when only the allocation step failed', async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ id: 'proj-1' }) // project create OK
      .mockRejectedValueOnce({ data: { data: { detail: 'Budget overlaps.' } } }) // allocation fails
      .mockResolvedValueOnce({ id: 'alloc-2' }) // retry: allocation only
    const c = useProjectCreate({ post: post as never })

    const first = await c.submit(PROJECT, ALLOCATION)
    expect(first).toBeNull()
    expect(c.failedStep.value).toBe('allocation')
    expect(c.error.value).toBe('Budget overlaps.')
    expect(c.createdProjectId.value).toBe('proj-1')

    const second = await c.submit(PROJECT, ALLOCATION)
    expect(second).toBe('alloc-2')
    expect(c.failedStep.value).toBeNull()
    expect(c.error.value).toBeNull()

    // The crucial invariant: exactly ONE project POST across both attempts.
    const projectPosts = post.mock.calls.filter(([url]) => url === '/api/v1/admin/projects')
    expect(projectPosts).toHaveLength(1)
  })

  it('reports failedStep=project when step 1 fails (nothing created yet)', async () => {
    const post = vi.fn().mockRejectedValueOnce({ data: { statusMessage: 'Duplicate code' } })
    const c = useProjectCreate({ post: post as never })

    const result = await c.submit(PROJECT, ALLOCATION)

    expect(result).toBeNull()
    expect(c.failedStep.value).toBe('project')
    expect(c.error.value).toBe('Duplicate code')
    expect(c.createdProjectId.value).toBeNull()
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('re-entrancy: a submit while one is in flight is a no-op', async () => {
    let release!: (v: { id: string }) => void
    const post = vi
      .fn()
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
      .mockResolvedValueOnce({ id: 'alloc-1' })
    const c = useProjectCreate({ post: post as never })

    const first = c.submit(PROJECT, ALLOCATION)
    const second = await c.submit(PROJECT, ALLOCATION) // while first is in flight
    expect(second).toBeNull()
    expect(post).toHaveBeenCalledTimes(1)

    release({ id: 'proj-1' })
    await expect(first).resolves.toBe('alloc-1')
  })
})
