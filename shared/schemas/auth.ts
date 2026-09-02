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
  /*
   * The Reporting nav verdict, resolved server-side (server/auth/
   * nav-visibility.ts). The nav RENDERS this and never re-derives it — the
   * client used to fetch two of the three inputs itself and OR them, which
   * cost two blocking round-trips per cold load and let the browser disagree
   * with the server about who may see what.
   *
   * Optional because an unauthenticated probe returns `{ authenticated: false }`
   * alone; present on every authenticated response.
   */
  reporting: z
    .object({
      visible: z.boolean(),
      /** 'cost-centre' deep-links a non-role owner to their P&L; null = let the shell self-land. */
      scope: z.enum(['cost-centre']).nullable(),
    })
    .optional(),
  // Wave-V — persona-impersonation surface. Present only when the
  // current session was minted via the admin → persona override
  // (NUXT_ALLOW_PERSONA_OVERRIDE=true). The UI renders "Acting as
  // <impersonatorEmail>" when this is set so silent impersonation is
  // impossible.
  impersonatorEmail: z.string().email().optional(),
  impersonatedAt: z.string().optional(),
})
export type MeResponse = z.infer<typeof MeResponse>
