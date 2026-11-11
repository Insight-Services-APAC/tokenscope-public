/*
 * The words and "what happens when" of TokenScope, for the people who use it
 * (#604). The /help page reads this file; docs/wiki/Using-TokenScope.md holds
 * the same sentences and a test pins that the two agree.
 *
 * Every sentence here is a claim about the product. Change one only after
 * checking the code it describes (CLAUDE.md rule 17). No role codes, no admin
 * terms and no em dashes. Usage and Chargeback are two separate questions:
 * neither is used to explain the other.
 */
export interface HelpEntry {
  /** The URL fragment on /help, and the wiki heading's slug. */
  id: string
  term: string
  body: string[]
}

export const HELP_TERMS: HelpEntry[] = [
  {
    id: 'session',
    term: 'Session',
    body: [
      'One working session in your AI coding tool. If you resume it later, it carries on as the same session. A session is what you tag to a project. Helpers the tool starts along the way count as part of it.',
    ],
  },
  {
    id: 'device',
    term: 'Device',
    body: [
      'One tool on a computer, connected to TokenScope. Containers that use the same tool and share one home folder usually count as one device. You name and revoke your devices on My account.',
      'A device reads Sending when TokenScope has recorded usage from it in the last 24 hours, Idle when none has been recorded for up to 30 days, and Not in use after that. A device connected in the last 30 days with no usage yet reads Idle. Cannot send means TokenScope is rejecting the credential the device sends with, and it is the only state that is a fault.',
    ],
  },
  {
    id: 'provider-recorded-day',
    term: 'Provider-recorded day',
    body: [
      'Usage your provider counted for a day beyond what was recorded from your devices. It has a date and an amount but no times, because the provider reports it by the day. You can tag it to a project the same way as a session.',
    ],
  },
  {
    id: 'unallocated',
    term: 'Unallocated',
    body: ['Usage that is not on a project. It counts under your Business Unit until you tag it to a project.'],
  },
  {
    id: 'allowance',
    term: 'Allowance',
    body: [
      'An amount of unallocated usage per person each month that TokenScope treats as normal. It is the same for everyone. Going past it shows on your own pages and to the owner of your Business Unit. It stops nothing.',
    ],
  },
  {
    id: 'budget',
    term: 'Budget',
    body: ['An amount set for a project. Budgets are for reporting: TokenScope enforces no limit and blocks nothing.'],
  },
  {
    id: 'business-unit',
    term: 'Business Unit',
    body: ['The part of the organisation that usage is reported under. Each person is placed under one, and a Business Unit can have owners who can see its figures.'],
  },
  {
    id: 'usage',
    term: 'Usage',
    body: [
      'The answer to "what did I, my project or my Business Unit use, and on what?" Usage comes from your devices and from the provider\'s own figures. Budgets read Usage figures.',
    ],
  },
  {
    id: 'chargeback',
    term: 'Chargeback',
    body: ['The answer to "what does each Business Unit pay?" Chargeback figures come only from the provider\'s usage and billing data.'],
  },
  {
    id: 'estimated',
    term: 'Estimated',
    body: [
      'A figure that may still change. Chargeback figures read Estimated, then Settling, then Provisional, on each provider\'s own timetable. Usage marked indicative was worked out from the devices\' own reports and may differ from what the provider records.',
    ],
  },
  {
    id: 'dismissed',
    term: 'Dismissed',
    body: [
      'An item you have decided to leave unallocated, so it stops asking for a decision. The usage stays in your unallocated total. You can restore it from the Dismissed list. If its cost later grows by more than $1, it comes back to your list of usage to tag.',
    ],
  },
]

export const HELP_WHAT_HAPPENS: HelpEntry[] = [
  {
    id: 'over-a-budget',
    term: 'I go over a budget',
    body: [
      'Nothing stops you or your tools. The project reads Over on My projects, and the people responsible for it, and those who used it, get inbox alerts as it nears and passes its budget.',
    ],
  },
  {
    id: 'i-dismiss-an-item',
    term: 'I dismiss an item',
    body: ['It leaves your list of usage to tag and moves to the Dismissed list. Its usage stays unallocated, and you can restore it.'],
  },
  {
    id: 'my-project-ends',
    term: 'My project ends',
    body: [
      'You can no longer tag usage to it. On My projects it folds under Ended projects, unless it has usage in the month shown, when it stays listed above the fold. Under Last month, a project that ended during that month keeps its card.',
    ],
  },
  {
    id: 'i-stop-using-a-device',
    term: 'I stop using a device',
    body: [
      'After a day with no recorded usage it reads Idle, and after 30 days it moves under Not in use on My account. Neither is a warning. It may still be able to send, so revoke the devices you no longer have. Revoking takes away its credential for sending, and connecting a device again is quick.',
    ],
  },
  {
    id: 'i-use-a-personal-subscription',
    term: 'I use a personal subscription',
    body: [
      'Declare it on My account for the Claude tool you pay for yourself. The usage stays visible in your Usage figures and is not flagged for having no company bill behind it. Declaring does not by itself change Chargeback.',
    ],
  },
]
