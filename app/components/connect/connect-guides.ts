/*
 * The per-client connect instructions, built from this deployment's connect
 * config (GET /api/v1/connect/config, #415). Pure, so the copy is unit-testable
 * without mounting the component.
 *
 * Marketplace, plugin names and the server URL come from the config; nothing
 * here names a deployment. When the deployment's origin differs from the server
 * a plugin's default build ships with, or that build ships with none (the public
 * Claude plugin), an extra step points the plugin at this deployment.
 *
 * Copy rules (#418): a step says WHAT to do in one short sentence. Reasons and
 * edge cases go in `details` (a collapsed "More detail") or in `troubleshooting`
 * (a collapsed "Trouble connecting?"). Nothing is dropped; it moves.
 */
import {
  claudeMarketplaceArg,
  needsMcpRegistration,
  type ConnectClient,
  type ConnectConfig,
} from '#shared/connect'

/* A paragraph is a list of inline segments so prose can mix with <code> and
 * <strong> without v-html. Spaces are baked into the string segments. */
export type Segment = string | { code: string } | { strong: string }
export type Paragraph = Segment[]

export interface Step {
  title: string
  /** Where the step happens. Set only when a guide's steps happen in different places. */
  badge?: string
  intro: Paragraph
  commands?: string[]
  notes?: Paragraph[]
  details?: Paragraph[]
}

export interface Guide {
  /* DOM hooks kept from the original account-page cards for smoke/e2e selectors. */
  testid: string
  cmdTestidPrefix: string
  icon: string
  name: string
  accent: string
  lead: Paragraph
  /** One line: what has to be installed first. */
  prerequisites?: Paragraph
  steps: Step[]
  troubleshooting: Paragraph[]
}

type StepBody = Omit<Step, 'title'> & { label: string }

/** Number the steps in order, so an optional step never leaves a gap. */
function numbered(steps: StepBody[]): Step[] {
  return steps.map(({ label, ...s }, i) => ({ ...s, title: `${i + 1}. ${label}` }))
}

function claudeGuide(c: ConnectConfig): Guide {
  // A build with no server needs this step even when this deployment cannot
  // name its own origin: the user then gets the step without a URL to paste.
  const noServer = c.claudeBundledOrigin === ''
  const register = needsMcpRegistration(c, 'claude-code') && (noServer || c.mcpUrl)
  const steps: StepBody[] = [
    {
      label: 'Install the plugin',
      intro: ['Run these one at a time:'],
      commands: [
        `/plugin marketplace add ${claudeMarketplaceArg(c)}`,
        `/plugin install ${c.claudePlugin}@${c.marketplaceName}`,
      ],
      notes: [['When asked, choose ', { strong: 'Install for you' }, '.']],
      details: [
        ['Run them separately: Claude Code treats a multi-line paste as one command.'],
        [
          { strong: 'Install for you' },
          ' is user scope, so the plugin works in all your repos. Don’t choose project or local scope. A repo carries its own ',
          { code: '.tokenscope' },
          ' file instead.',
        ],
      ],
    },
  ]
  if (register) {
    const olderClient: Paragraph[] = c.mcpUrl
      ? [
          [
            'Older Claude Code? In a terminal, run: ',
            { code: `claude mcp add --transport http --scope user tokenscope ${c.mcpUrl}` },
          ],
        ]
      : []
    steps.push({
      label: 'Point the plugin at this deployment',
      intro: [
        'Run ',
        { code: '/plugin' },
        ', open ',
        { strong: 'tokenscope' },
        ' → ',
        { strong: 'Configure options' },
        ', and set ',
        { strong: 'TokenScope server URL' },
        c.origin ? ' to:' : '. Ask your administrator for the address.',
      ],
      ...(c.origin ? { commands: [c.origin] } : {}),
      notes: [['Needs Claude Code 2.1.207 or later.'], ...olderClient],
      details: [
        noServer
          ? ['This plugin build ships without a server, so you have to tell it which one to use.']
          : ['The plugin’s built-in server is ', { code: c.claudeBundledOrigin }, ', not this deployment.'],
        [
          'This is a user setting. A repository’s settings cannot change it, so a cloned project can never redirect your setup to another server.',
        ],
      ],
    })
  }
  steps.push(
    {
      label: 'Sign in',
      intro: ['Run this, choose ', { strong: 'tokenscope' }, ', and approve in your browser:'],
      commands: ['/mcp'],
      details: [
        [
          'Installing the plugin does not sign you in. Signing in lets the TokenScope tools in Claude Code read your usage and tag sessions. The next step needs it.',
        ],
      ],
    },
    {
      label: 'Turn on tracking',
      intro: ['Run:'],
      commands: ['/tokenscope:setup'],
      notes: [['Don’t skip this. Without it, nothing is tracked.']],
      details: [
        [
          'Setup registers this computer with TokenScope. A helper on your computer saves the credential, so there is nothing to copy, and the credential never passes through the chat.',
        ],
      ],
    },
    {
      label: 'Restart Claude Code',
      intro: ['Quit Claude Code and open it again.'],
      details: [['Claude Code reads the tracking settings only when it starts.']],
    },
    {
      label: 'Check it works',
      intro: ['Run:'],
      commands: ['/tokenscope:status'],
      notes: [[{ strong: 'Green' }, ' means you’re done.']],
      details: [
        [
          'Green means this computer is signed in and set up to send usage. It does not prove usage has arrived: that shows in TokenScope about 5 minutes after you use Claude Code.',
        ],
      ],
    },
  )
  return {
    testid: 'connect-claude-code',
    cmdTestidPrefix: 'install-cmd',
    icon: 'logos:claude-icon',
    name: 'Claude Code',
    accent: '#D97757',
    lead: ['Do every step in Claude Code.'],
    prerequisites: [{ strong: 'Windows:' }, ' nothing else to install. ', { strong: 'macOS / Linux:' }, ' needs Node.js.'],
    steps: numbered(steps),
    troubleshooting: [
      [
        { strong: 'Windows without Node.js:' },
        ' tracking works, but the status line, ',
        { code: '/tokenscope:backfill' },
        ' and tagging sessions from a repo’s ',
        { code: '.tokenscope' },
        ' file need Node.js. Without it, a plugin update doesn’t update your tracking settings, so run ',
        { code: '/tokenscope:setup' },
        ' again after each update. To get everything, run ',
        { code: 'winget install OpenJS.NodeJS.LTS' },
        ', then ',
        { code: '/tokenscope:setup' },
        ' again.',
      ],
      [
        { strong: 'The browser sign-in can’t get back to Claude Code:' },
        ' copy the link the sign-in page shows into Claude Code.',
      ],
      [
        { strong: '/mcp says “URL is unset or invalid”:' },
        ' run ',
        { code: '/plugin' },
        ', open tokenscope → Configure options, set the server URL, then restart Claude Code.',
      ],
      [
        { strong: 'Status isn’t green:' },
        ' check you restarted Claude Code. In a repo with a ',
        { code: '.tokenscope' },
        ' file, restart once more if you see a “superseded device enrolment” warning. Still not green? Run ',
        { code: '/tokenscope:setup' },
        ' again.',
      ],
    ],
  }
}

function copilotGuide(c: ConnectConfig): Guide {
  const register = needsMcpRegistration(c, 'copilot-cli') && c.mcpUrl
  const installDetails: Paragraph[] = [
    [
      'The first command adds ',
      { code: c.marketplaceSource },
      ' as a plugin marketplace. The second installs the ',
      { code: c.copilotPlugin },
      ' plugin from it.',
    ],
    [
      'Enterprise-managed organisations can ship the plugin through ',
      { code: '.github-private/.github/copilot/settings.json' },
      ' instead. It installs when you sign in to Copilot.',
    ],
  ]
  if (c.marketplaceRef) {
    installDetails.push([
      'This deployment pins Claude Code to ',
      { code: c.marketplaceRef },
      '. Copilot CLI has no documented way to pin a marketplace ref, so it installs from the default branch.',
    ])
  }
  const steps: StepBody[] = [
    {
      label: 'Install the plugin',
      badge: 'In a terminal',
      intro: ['Run these one at a time in your terminal, not inside Copilot:'],
      commands: [
        `copilot plugin marketplace add ${c.marketplaceSource}`,
        `copilot plugin install ${c.copilotPlugin}@${c.marketplaceName}`,
      ],
      details: installDetails,
    },
  ]
  if (register) {
    steps.push({
      label: 'Point the plugin at this deployment',
      badge: 'In a terminal',
      intro: ['Run:'],
      commands: [`copilot mcp add --transport http tokenscope ${c.mcpUrl}`],
      details: [
        ['The plugin’s built-in server is ', { code: c.copilotBundledOrigin }, ', not this deployment.'],
        [
          'Setup reads this registration ahead of the built-in one. Your organisation can avoid this step by publishing a plugin build that names this server.',
        ],
      ],
    })
  }
  steps.push(
    {
      label: 'Sign in and turn on tracking',
      badge: 'In Copilot',
      intro: [
        'Start ',
        { code: 'copilot' },
        ', type ',
        { code: '/' },
        ' and run the ',
        { strong: 'tokenscope-setup' },
        ' skill. Approve the sign-in in your browser, then follow its prompts.',
      ],
      details: [
        [
          'Setup signs you in, saves a credential on this computer (nothing to copy) and turns on the plugin’s usage extension, which sends each session’s usage to TokenScope.',
        ],
      ],
    },
    {
      label: 'Restart Copilot',
      badge: 'In a terminal',
      intro: ['Quit ', { code: 'copilot' }, ' and start it again.'],
      details: [['The usage extension loads when a session starts, so the next session is the first one that sends usage.']],
    },
    {
      label: 'Check it works',
      badge: 'In Copilot',
      intro: [
        'After a few minutes of using Copilot, type ',
        { code: '/' },
        ' and run the TokenScope ',
        { strong: 'status' },
        ' skill.',
      ],
      notes: [[{ strong: 'Green' }, ' means you’re done.']],
      details: [
        [
          'It checks that this computer can send usage, that a record arrived, and that it is tagged to a project. Usage takes about 5 minutes to arrive.',
        ],
        [
          'Copilot has no always-on status line, so run this whenever you want to check, or if your sessions seem to have stopped showing up.',
        ],
      ],
    },
  )
  return {
    testid: 'connect-copilot-cli',
    cmdTestidPrefix: 'copilot-install-cmd',
    icon: 'logos:github-copilot',
    name: 'Copilot CLI',
    accent: '#3e332d',
    lead: ['Some steps run in a terminal and some inside Copilot. Each step says where.'],
    steps: numbered(steps),
    troubleshooting: [
      [
        { strong: 'No browser, or it didn’t open:' },
        ' open the sign-in link Copilot prints, on any computer. Then open the link the sign-in page gives back on the computer running Copilot, in a browser or with ',
        { code: 'curl' },
        '.',
      ],
      [
        { strong: 'Status says your usage is untagged:' },
        ' run the ',
        { strong: 'project' },
        ' skill in that repo. Setup can’t fix tagging.',
      ],
      [
        { strong: 'Status says it isn’t sending:' },
        ' check you restarted ',
        { code: 'copilot' },
        ' and used it for a few minutes. Still not sending? Run the ',
        { strong: 'tokenscope-setup' },
        ' skill again.',
      ],
    ],
  }
}

export function buildGuide(client: ConnectClient, config: ConnectConfig): Guide {
  return client === 'claude-code' ? claudeGuide(config) : copilotGuide(config)
}
