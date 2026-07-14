import { z } from 'zod'
import { DEMO_PERSONAS } from '../auth/roles'

const personaKeys = DEMO_PERSONAS.map((p) => p.key) as [string, ...string[]]

export const DevLoginBody = z.object({
  persona: z.enum(personaKeys as [string, ...string[]]),
})
export type DevLoginBody = z.infer<typeof DevLoginBody>

export const MeResponse = z.object({
  authenticated: z.boolean(),
  teammateId: z.string().uuid().optional(),
  email: z.string().email().optional(),
  displayName: z.string().optional(),
  role: z.string().optional(),
  regionId: z.string().uuid().optional(),
  orgPath: z.string().optional(),
  landing: z.string().optional(),
  // Wave-V — persona-impersonation surface. Present only when the
  // current session was minted via the admin → persona override
  // (NUXT_ALLOW_PERSONA_OVERRIDE=true). The UI renders "Acting as
  // <impersonatorEmail>" when this is set so silent impersonation is
  // impossible.
  impersonatorEmail: z.string().email().optional(),
  impersonatedAt: z.string().optional(),
})
export type MeResponse = z.infer<typeof MeResponse>
