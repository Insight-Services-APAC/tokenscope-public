/*
 * useProjectCreate — idempotent two-step project + baseline-budget creation
 * (FE-3, projects/new.vue).
 *
 * Step 1 (POST /admin/projects) runs AT MOST ONCE: the created id is
 * remembered across submit attempts, so a failed step 2 (POST /allocations)
 * can be retried without re-POSTing the project — a re-POST would 409 on the
 * unique project code and dead-end the user with an orphaned, budget-less
 * project. `failedStep` lets the page distinguish "project create failed"
 * from "project created, budget failed".
 */
import { ref } from 'vue'
import { apiErrorDetail } from './useApiError'

export interface ProjectCreateBody {
  code: string
  display_name: string
  type: string
  region_id: string
  cost_owning_unit_id: string
  /** Optional finance-system WBS code (correlation only). */
  wbs_code?: string
}

export interface AllocationCreateBody {
  budget_usd: string
  effective: string
}

type PostFn = <T>(url: string, body: Record<string, unknown>) => Promise<T>

export function useProjectCreate(deps?: { post?: PostFn }) {
  // Injectable for unit tests; defaults to $fetch in the app.
  const post: PostFn =
    deps?.post ??
    (<T,>(url: string, body: Record<string, unknown>) =>
      $fetch<T>(url, { method: 'POST', body }) as Promise<T>)

  const createdProjectId = ref<string | null>(null)
  const submitting = ref(false)
  const error = ref<string | null>(null)
  const failedStep = ref<'project' | 'allocation' | null>(null)

  /**
   * Returns the new allocation id on full success, null on any failure
   * (inspect `failedStep` / `error`). Safe to call again after a failure:
   * an already-created project is never re-POSTed.
   */
  async function submit(
    project: ProjectCreateBody,
    allocation: AllocationCreateBody,
  ): Promise<string | null> {
    if (submitting.value) return null
    submitting.value = true
    error.value = null
    failedStep.value = null
    try {
      if (!createdProjectId.value) {
        try {
          const p = await post<{ id: string }>('/api/v1/admin/projects', { ...project })
          createdProjectId.value = p.id
        } catch (err) {
          failedStep.value = 'project'
          error.value = apiErrorDetail(err, 'Project create failed.')
          return null
        }
      }
      try {
        const a = await post<{ id: string }>('/api/v1/allocations', {
          ...allocation,
          project_id: createdProjectId.value,
        })
        return a.id
      } catch (err) {
        failedStep.value = 'allocation'
        error.value = apiErrorDetail(err, 'Budget allocation failed.')
        return null
      }
    } finally {
      submitting.value = false
    }
  }

  return { createdProjectId, submitting, error, failedStep, submit }
}
