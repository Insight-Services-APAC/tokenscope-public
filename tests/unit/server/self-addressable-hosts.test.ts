/*
 * selfAddressableHosts — the Host allowlist, enumerated over EVERY deployment
 * shape rather than every code path.
 *
 * WHY EXHAUSTIVE. The allowlist that shipped in #204 was correct on two of the
 * three topologies we run and wrong on the third, and MCP — a crucial product
 * surface — was dead on dev until a user hit it. The integration tests covered
 * the code path; they encoded the same premise as the code ("Front Door is the
 * only thing that rewrites Host"), so they agreed with the bug.
 *
 * A per-topology test list has the same weakness one level up: it is still
 * hand-picked, so the topology nobody thought of is still missing. The
 * allowlist depends on exactly three booleans — pinned public origin?, Front
 * Door?, on the Container Apps platform? — so the honest coverage is all
 * 2x2x2 = 8, generated, times the four Host shapes that can arrive. Every cell
 * has a stated expected answer below. A future change to the derivation must
 * restate what it does in all eight, including the ones we do not deploy today.
 *
 * The expectations are a hand-written LITERAL table (ORACLE below), not a
 * computation. An oracle that recomputes the implementation's own rule agrees
 * with a wrong rule, which is the same defect one level up.
 */
import { describe, it, expect } from 'vitest'
import {
  selfAddressableHosts,
  isSelfAddressableHost,
  platformSelfHosts,
} from '../../../server/utils/public-url'

const PUBLIC = 'tokenscope.example.com'
const CA_APP = 'ca-tokenscope-example.example-env-0000.westus3.azurecontainerapps.io'
const CA_REV = 'ca-tokenscope-example--0000080.example-env-0000.westus3.azurecontainerapps.io'
const FOREIGN = 'attacker.example'

/** The four Host shapes that can reach us, named for what each represents. */
const HOST_SHAPES = [
  { name: 'the public hostname (proxy preserved Host)', host: PUBLIC },
  { name: 'the CA app-level FQDN (proxy rewrote Host)', host: CA_APP },
  { name: 'the CA revision-pinned FQDN', host: CA_REV },
  { name: 'an unrelated hostname', host: FOREIGN },
] as const

/** The three independent deployment facts, as booleans. */
interface Shape {
  pinned: boolean
  frontDoor: boolean
  onPlatform: boolean
}

function allShapes(): Shape[] {
  const out: Shape[] = []
  for (const pinned of [false, true])
    for (const frontDoor of [false, true])
      for (const onPlatform of [false, true]) out.push({ pinned, frontDoor, onPlatform })
  return out
}

function describeShape(s: Shape): string {
  return [
    s.pinned ? 'APP_PUBLIC_ORIGIN pinned' : 'no pinned origin',
    s.frontDoor ? 'behind Front Door' : 'no Front Door',
    s.onPlatform ? 'on Container Apps' : 'off-platform',
  ].join(' / ')
}

/*
 * The oracle: a LITERAL table, hand-written per cell.
 *
 * An earlier version computed the expectation from the same rule the
 * implementation applies. That is an oracle that agrees with a wrong rule —
 * the precise failure this whole file exists to prevent, one level up. Adversarial
 * review caught it. Written out, each cell is a claim someone can disagree with.
 *
 * Key: pinned/frontDoor/onPlatform as three booleans, then the verdict for each
 * of the four Host shapes in HOST_SHAPES order:
 *   [ public, CA app FQDN, CA revision FQDN, unrelated ]
 */
const ORACLE: Record<string, [boolean, boolean, boolean, boolean]> = {
  // Nothing pinned, no Front Door: publicHost IS the request Host, so whatever
  // arrives is trivially "us". Self-satisfying — documented, not endorsed.
  'F/F/F': [true, true, true, true],
  // Same, plus platform FQDNs — still self-satisfying for the same reason.
  'F/F/T': [true, true, true, true],
  // Front Door trusts the raw Host outright (FDID already vetted upstream).
  'F/T/F': [true, true, true, true],
  'F/T/T': [true, true, true, true],
  // PINNED, no Front Door — the only shapes where the check constrains anything.
  // Public host yes; platform FQDNs only when we actually know them; foreign no.
  'T/F/F': [true, false, false, false],
  'T/F/T': [true, true, true, false],
  // Pinned AND behind Front Door: raw Host trusted again, so all pass.
  'T/T/F': [true, true, true, true],
  'T/T/T': [true, true, true, true],
}

function key(s: Shape): string {
  return `${s.pinned ? 'T' : 'F'}/${s.frontDoor ? 'T' : 'F'}/${s.onPlatform ? 'T' : 'F'}`
}

function expectedAllowed(s: Shape, hostIndex: number): boolean {
  const row = ORACLE[key(s)]
  if (!row) throw new Error(`no oracle row for shape ${key(s)}`)
  return row[hostIndex]!
}

function hostsFor(s: Shape, rawHost: string): string[] {
  return selfAddressableHosts({
    publicHost: s.pinned ? PUBLIC : rawHost,
    rawHost,
    behindFrontDoor: s.frontDoor,
    platformHosts: s.onPlatform ? [CA_APP, CA_REV] : [],
  })
}

describe('selfAddressableHosts — every deployment shape x every Host shape', () => {
  it('the oracle covers every shape (guards against a silently unreachable row)', () => {
    // Without this, a renamed key would drop a shape from the table and
    // expectedAllowed would throw only for shapes that still exist.
    expect(Object.keys(ORACLE).sort()).toEqual(allShapes().map(key).sort())
  })

  for (const shape of allShapes()) {
    HOST_SHAPES.forEach(({ name, host }, i) => {
      const want = expectedAllowed(shape, i)
      it(`${describeShape(shape)} + ${name} → ${want ? 'allowed' : 'REJECTED'}`, () => {
        expect(isSelfAddressableHost(hostsFor(shape, host), host)).toBe(want)
      })
    })
  }
})

describe('the shapes that matter, called out by name', () => {
  /*
   * DEV AS DEPLOYED, and the regression that motivated all of this: IT's zone
   * WAF fronts dev, no Front Door, Host rewritten to the CA app FQDN.
   */
  it('dev: pinned origin + no Front Door + CA app FQDN → allowed', () => {
    const shape: Shape = { pinned: true, frontDoor: false, onPlatform: true }
    expect(hostsFor(shape, CA_APP)).toContain(CA_APP)
    // ...and the control is still a control in that same shape.
    expect(hostsFor(shape, FOREIGN)).not.toContain(FOREIGN)
  })

  it('dev: the app-level and revision FQDNs are DIFFERENT hosts, both real', () => {
    // CONTAINER_APP_HOSTNAME carries the `--0000080` revision segment; the
    // app-level FQDN does not. Covering one is not covering the other, and
    // building the fix on CONTAINER_APP_HOSTNAME alone (the intuitive
    // single-variable guess) would have deployed and stayed broken.
    expect(CA_APP).not.toBe(CA_REV)
    const shape: Shape = { pinned: true, frontDoor: false, onPlatform: true }
    expect(hostsFor(shape, CA_APP)).toContain(CA_APP)
    expect(hostsFor(shape, CA_REV)).toContain(CA_REV)
  })

  /*
   * HONEST LIMIT. With nothing pinned and no Front Door there is no
   * independent notion of self, so publicHost IS the raw Host and the check
   * cannot reject anything. True before this change too. Pinned as a fact so
   * the allowlist is never mistaken for protection in that shape.
   */
  it('un-fronted: the check is self-satisfying by construction', () => {
    const shape: Shape = { pinned: false, frontDoor: false, onPlatform: false }
    expect(hostsFor(shape, FOREIGN)).toContain(FOREIGN)
  })

  it('Front Door: the raw Host is trusted (require-front-door vetted X-Azure-FDID)', () => {
    const shape: Shape = { pinned: true, frontDoor: true, onPlatform: true }
    expect(hostsFor(shape, 'whatever-fd-sent.internal')).toContain('whatever-fd-sent.internal')
  })
})

describe('case handling', () => {
  const shape: Shape = { pinned: true, frontDoor: false, onPlatform: true }

  it('admits a Host differing from a self-host only by case', () => {
    // The SDK compares raw strings case-sensitively; hostnames are not
    // case-sensitive, so casing alone must not decide this.
    const upper = CA_APP.toUpperCase()
    expect(hostsFor(shape, upper)).toContain(upper)
  })

  it('does NOT admit a foreign host merely because casing was normalised', () => {
    expect(hostsFor(shape, FOREIGN.toUpperCase())).not.toContain(FOREIGN.toUpperCase())
  })
})

describe('default ports are the same authority', () => {
  const shape: Shape = { pinned: true, frontDoor: false, onPlatform: true }

  it('accepts an explicit :443 on a host we know without one', () => {
    // A proxy is entitled to send the default port; rejecting over it would be
    // the same class of outage as rejecting over the CA FQDN.
    expect(isSelfAddressableHost(hostsFor(shape, `${PUBLIC}:443`), `${PUBLIC}:443`)).toBe(true)
    expect(isSelfAddressableHost(hostsFor(shape, `${CA_APP}:443`), `${CA_APP}:443`)).toBe(true)
  })

  it('still rejects a NON-default port — that is a different authority', () => {
    // localhost:3450 is not localhost. Only :443 elides.
    expect(isSelfAddressableHost(hostsFor(shape, `${PUBLIC}:8443`), `${PUBLIC}:8443`)).toBe(false)
  })

  it('does NOT treat :80 as equivalent to :443 (different origins)', () => {
    // The regex version stripped both, so `example.com:80` matched a trusted
    // `example.com` that is only ever served over https.
    expect(isSelfAddressableHost([PUBLIC], `${PUBLIC}:80`)).toBe(false)
    expect(isSelfAddressableHost([`${PUBLIC}:80`], `${PUBLIC}:443`)).toBe(false)
  })

  it('still rejects a foreign host carrying :443', () => {
    expect(isSelfAddressableHost(hostsFor(shape, `${FOREIGN}:443`), `${FOREIGN}:443`)).toBe(false)
  })
})

describe('malformed authorities are refused, never normalised into a match', () => {
  it('rejects userinfo smuggled into the Host header', () => {
    expect(isSelfAddressableHost([PUBLIC], `evil@${PUBLIC}`)).toBe(false)
    expect(isSelfAddressableHost([PUBLIC], `${PUBLIC}@${FOREIGN}`)).toBe(false)
  })

  it('rejects a path, query or fragment riding along', () => {
    expect(isSelfAddressableHost([PUBLIC], `${PUBLIC}/evil`)).toBe(false)
    expect(isSelfAddressableHost([PUBLIC], `${PUBLIC}?x=1`)).toBe(false)
    expect(isSelfAddressableHost([PUBLIC], `${PUBLIC}#f`)).toBe(false)
  })

  it('two DIFFERENT malformed values never match each other', () => {
    // The regex version canonicalised `example.com::443` and `example.com:`
    // to the same string. Unparseable must equal nothing at all.
    expect(isSelfAddressableHost(['example.com:'], 'example.com::443')).toBe(false)
    expect(isSelfAddressableHost(['   '], '   ')).toBe(false)
    expect(isSelfAddressableHost(['[::1'], '[::1')).toBe(false)
  })

  it('handles IPv6 literals correctly rather than by accident', () => {
    expect(isSelfAddressableHost(['[::1]'], '[::1]:443')).toBe(true)
    expect(isSelfAddressableHost(['[::1]:3450'], '[::1]:3450')).toBe(true)
    expect(isSelfAddressableHost(['[::1]'], '[::2]')).toBe(false)
  })

  it('is case-insensitive on the hostname, as HTTP means it', () => {
    expect(isSelfAddressableHost([PUBLIC], PUBLIC.toUpperCase())).toBe(true)
  })
})

describe('an absent Host header is never self-addressable', () => {
  it('undefined Host → rejected', () => {
    // HTTP/1.1 requires Host and HTTP/2 synthesises it from :authority, so
    // absence is malformed. Answering it would make "did this deployment
    // accept my Host" ambiguous for anything probing the endpoint.
    expect(isSelfAddressableHost([PUBLIC, CA_APP], undefined)).toBe(false)
    expect(isSelfAddressableHost([PUBLIC, CA_APP], '')).toBe(false)
  })
})

describe('platformSelfHosts — the env-var reading itself', () => {
  const KEYS = ['CONTAINER_APP_NAME', 'CONTAINER_APP_ENV_DNS_SUFFIX', 'CONTAINER_APP_HOSTNAME', 'MCP_ALLOWED_HOSTS']

  function withEnv(env: Record<string, string | undefined>, fn: () => void) {
    const saved = new Map(KEYS.map((k) => [k, process.env[k]]))
    for (const k of KEYS) Reflect.deleteProperty(process.env, k)
    for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v
    try {
      fn()
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) Reflect.deleteProperty(process.env, k)
        else process.env[k] = v
      }
    }
  }

  /*
   * The shape tests above INJECT platformHosts, so they never exercise the
   * env-var reading — a misspelled variable or a wrong join would pass all of
   * them. These cover the derivation itself, which is the part that has to be
   * right on the deployed container.
   */
  it('joins name + suffix into the APP-level FQDN, and adds the revision FQDN', () => {
    withEnv(
      {
        CONTAINER_APP_NAME: 'ca-tokenscope-example',
        CONTAINER_APP_ENV_DNS_SUFFIX: 'example-env-0000.westus3.azurecontainerapps.io',
        CONTAINER_APP_HOSTNAME: CA_REV,
      },
      () => expect(platformSelfHosts()).toEqual([CA_APP, CA_REV]),
    )
  })

  it('name WITHOUT suffix yields no app-level FQDN (never a half-built host)', () => {
    withEnv({ CONTAINER_APP_NAME: 'ca-tokenscope-example' }, () =>
      expect(platformSelfHosts()).toEqual([]),
    )
    withEnv({ CONTAINER_APP_ENV_DNS_SUFFIX: 'suffix.example' }, () =>
      expect(platformSelfHosts()).toEqual([]),
    )
  })

  it('off-platform → empty', () => {
    withEnv({}, () => expect(platformSelfHosts()).toEqual([]))
  })

  it('MCP_ALLOWED_HOSTS is the escape hatch for a topology we do not model', () => {
    // A custom backend domain or private DNS alias must be addable by an
    // operator without a code change — the alternative is another dead MCP
    // surface waiting on a release.
    withEnv({ MCP_ALLOWED_HOSTS: 'proxy.internal, alias.example ,' }, () =>
      expect(platformSelfHosts()).toEqual(['proxy.internal', 'alias.example']),
    )
  })
})

describe('degenerate inputs', () => {
  it('no Host header at all → allowlist still well-formed, nothing empty in it', () => {
    const hosts = selfAddressableHosts({
      publicHost: PUBLIC,
      rawHost: undefined,
      behindFrontDoor: true,
      platformHosts: [CA_APP],
    })
    expect(hosts).toEqual([PUBLIC, CA_APP])
  })

  it('deduplicates when the public host IS the platform host', () => {
    const hosts = selfAddressableHosts({
      publicHost: CA_APP,
      rawHost: CA_APP,
      behindFrontDoor: true,
      platformHosts: [CA_APP],
    })
    expect(hosts).toEqual([CA_APP])
  })
})
