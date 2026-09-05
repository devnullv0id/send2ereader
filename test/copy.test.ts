import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

interface Entry {
  line: number
  text: string
}

const fixture: Record<string, unknown> = JSON.parse(
  readFileSync(join(root, 'test/fixtures/design-copy.json'), 'utf8')
)

const OVERRIDES: { was: string; now: string; why: string }[] = [
  {
    was: 'Profile',
    now: 'Account',
    why: 'asked for: the rail button, the account menu and the section this panel sits in all call it Account, and only the heading beside the avatar said Profile. The internal names are untouched — the panel is still data-panel="profile" and the menu still links to /settings#profile, because that fragment is a live link',
  },
  {
    was: 'Sign in',
    now: 'Create account',
    why: 'asked for: the design shares one heading across four views, where you can see which is open. These are four pages at four URLs, and one titled "Sign in" that asks you to create an account reads as the wrong page',
  },
  {
    was: 'Only to remember your devices, defaults and history. Sending works without it, and always will.',
    now: 'An account remembers your devices, defaults and history. Sending works without one, and always will.',
    why: "asked for, on the create page: the design writes this once for a screen you arrive at signed out, so it argues for having an account at all — which is this page's job now that it has its own heading",
  },
  {
    was: 'Only to remember your devices, defaults and history. Sending works without it, and always will.',
    now: 'Signing in brings back your devices, defaults and history. Sending works without it, and always will.',
    why: 'asked for, on the sign-in page: someone here already has an account, so the argument for having one belongs on the create page and this says what signing in gets back. Second sentence unchanged on both — it is the promise the product rests on',
  },
  {
    was: "Only an address with an account here can sign in, get a link or receive a code. Nothing is shared with anyone — the account is a row in your own server's database.",
    now: '',
    why: 'asked for: removed from the create page and from first-run setup. Both halves are now said elsewhere — the sub says an account is optional, and the sign-in screen already lists the ways in',
  },
  {
    was: 'What happens to your file',
    now: 'What each device reads',
    why: 'asked for: the panel lists what the devices support instead of what converts into what. Step 3 already names the pipeline for the file in hand, so the rules said the same thing twice and in the abstract',
  },
  {
    was: 'All conversion rules',
    now: 'Supported formats',
    why: 'the toggle has to say what the panel now contains; likewise "Hide the rules" is "Hide the list"',
  },
  {
    was: 'Tolino',
    now: 'Other eReaders',
    why: 'asked for: the list named one brand among three targets and left every other reader unaccounted for. Naming none of them is also the truer statement — there is no tolino target in the code, only kobo, kindle and none',
  },
  {
    was: 'Sent unchanged to a Kindle. For other readers it is converted to EPUB.',
    now: '',
    why: 'asked for, and the design was wrong for this server anyway: the KFX-to-EPUB step is skipped when the target is none, and Tolino, PocketBook and anything unrecognised all resolve to none — so a KFX sent to one of those goes unchanged, not converted. The row was a format among devices; it is gone',
  },
  {
    was: 'EPUB and KFX become a Kobo EPUB. Everything else is sent unchanged.',
    now: 'EPUB, KEPUB, MOBI, PDF, CBZ, CBR, TXT and HTML.',
    why: 'the same change: each row is now the formats that device reads. These lists are device facts and are not encoded anywhere in this repo — kindleNative is the only one the code states — so they are the least verifiable strings on the page and the first place to look if a device refuses a file',
  },
  {
    was: 'EPUB, KEPUB, MOBI, AZW3, KFX, PDF, CBZ, CBR, TXT or HTML.',
    now: 'EPUB, KEPUB, MOBI, AZW3, KFX, PDF, CBZ, CBR, TXT, HTML or HTMLZ.',
    why: 'HTMLZ is accepted as a source as well as offered as an output — calibre reads it, verified by round-tripping one here — so the list that tells people what they may drop has to say so',
  },
  {
    was: 'HTML — single page',
    now: 'HTMLZ — one zipped page',
    why: 'bug, not taste: calibre has an HTML input plugin and no HTML output plugin, so this target failed every time with "No plugin to handle output format: html". Verified by running ebook-convert here — .html exits 1, .htmlz exits 0. HTMLZ is also the only single-file shape, since HTML output would be a page plus a sibling folder of images',
  },
  {
    was: 'HELD 24 HOURS OR UNTIL DOWNLOADED',
    now: 'HELD <KOBO_QUEUE_TTL> OR UNTIL DOWNLOADED',
    why: 'the design writes 24 hours as a literal in three places and KOBO_QUEUE_TTL defaults to six, so all three were wrong out of the box — the live server reports ttlSeconds 21600. /healthz now carries it and the page states what the server says, the same treatment the password minimum already had',
  },
  {
    was: 'DEVICE LAST SYNCED 3 MIN AGO · NOTHING WAITING',
    now: 'Connected / Last sync 3 min ago. Nothing waiting to be collected.',
    why: 'asked for, to a supplied mockup: the design states the device in one monospace line beside two text links. It is a box now, like the ones on Send, with six states — not connected, syncing, connected, connected with books waiting, last sync failed, not seen in a while',
  },
  {
    was: 'WAITING FOR THE DEVICE TO SYNC FOR THE FIRST TIME',
    now: 'Not connected yet / Enter the endpoint on your Kobo and tap Sync. This turns green once it checks in.',
    why: 'the same change: the line said what was happening and not what to do about it, and this state is the one where somebody is most likely to be stuck',
  },
  {
    was: 'Regenerate token',
    now: 'New token',
    why: 'asked for, to a supplied mockup: two quiet text links became two buttons, with the consequence of each written underneath rather than left to the words on them',
  },
  {
    was: 'Revoke',
    now: 'Turn off Kobo sync',
    why: 'the same: "Revoke" did not say what would be revoked, and it sits next to a token, an endpoint and a device — any of which it could have meant',
  },
  {
    was: 'Copy line',
    now: 'Copy',
    why: 'asked for: the button sits against the line it copies, so "line" only made it wider than the Copy beside the endpoint. Both now reserve the width of "Copied" so neither changes size when clicked, which the design does not do',
  },
  { was: 'Again', now: 'Repeat password', why: 'asked for: "Again" did not say what of' },
  { was: 'Again', now: 'Repeat new password', why: 'the same, on the reset view' },
  {
    was: 'Or a six-digit code',
    now: '',
    why: 'asked for: removed. A link signs in whichever browser opens it; the code exists to sign in the machine you are at, and this instance does not keep that distinction',
  },
  {
    was: 'No third party unless you chose one. On a self-hosted instance the account lives on your own server.',
    now: '',
    why: 'asked for: removed from the sign-in screen',
  },
  {
    was: 'Convert to',
    now: 'Convert for / Format',
    why: 'asked for: Convert now runs the same four steps as Send, so the one step that picked a format is the two Send has — the device it is for, then which of that device\'s formats. "Convert to" survives on the button, where it names the format actually chosen',
  },
  {
    was: 'Fix EPUB layout',
    now: 'Fix layout',
    why: 'asked for: it no longer only fixes EPUB. The option is offered for EPUB, KEPUB and AZW3 output, so naming one of the three in the label made the other two look like a mistake',
  },
  {
    was: 'APPLIES TO THE KEPUB WE MAKE',
    now: '',
    why: 'asked for: removed. The line under each option named what it applied to, which is the same thing the format tile above and the Conversion step below already say, and it changed as you moved between formats — one more thing moving on a page that is supposed to hold still',
  },
  {
    was: 'Only for EPUB and KEPUB output.',
    now: '',
    why: 'asked for: an option that does not fit the chosen format is hidden on Convert, not greyed, so nothing is left on screen for this reason to explain. Fix layout is offered for EPUB, KEPUB and AZW3 output and absent everywhere else',
  },
  {
    was: 'Only for PDF sources.',
    now: '',
    why: 'asked for: same rule the other way round. Crop PDF margins is shown only when the target is PDF and hidden otherwise, so its reason never has anything to sit under',
  },
  {
    was: 'Show anyway',
    now: '',
    why: 'asked for, on Send: the options that do not fit the file are no longer listed at all, so there is nothing to reveal. The one that fits is drawn, Transliterate filename is always drawn and greys itself when the name is already ASCII, and the rest are absent - the same rule Convert follows',
  },
  {
    was: 'Hide these',
    now: '',
    why: 'asked for: the other half of the Show anyway pair, with nothing left to hide',
  },
  {
    was: 'Uploading',
    now: 'Sending file',
    why: 'asked for, on Send: the progress panel is gone and the bar is the button itself, which has room for one label. Uploading, Converting with X and Waiting for your eReader became one line that does not rewrite itself mid-send, the same way Convert reads Converting file throughout',
  },
  {
    was: 'Queueing for the next sync',
    now: '',
    why: 'asked for: the third stage name the single button label replaces. What happens after the upload is still said in full on the Waiting for your Kobo panel once it lands',
  },
  {
    was: 'No need to keep anything open — it waits at your endpoint for the next sync.',
    now: '',
    why: 'asked for indirectly: it was the note under the progress bar, and the bar is now the button. The line under the button is the retention line, which you asked to keep, with Cancel beside it - there is no second line to put this in',
  },
  {
    was: 'Reading the file',
    now: 'Converting file',
    why: 'asked for, on Convert only: the three stage names now live inside the button that started the run, where a label that rewrites itself twice mid-conversion is the last moving part on a page held deliberately still. One label for the whole run, and only the number and the fill change. Send keeps its stage list, which sits in a panel of its own',
  },
  {
    was: 'Packing the result',
    now: '',
    why: 'asked for: the second of the three stage names the single button label replaces',
  },
  {
    was: "Pick a format above and we'll name the pipeline below.",
    now: '',
    why: 'asked for indirectly: it was the one element that appeared only in the file-chosen-no-format state, so it made the card taller than Send\'s by exactly its own height. It also said nothing the page was not already saying — the button underneath reads "Pick a format", and the pipeline is named in a step called Conversion that is headed whether or not it has a line yet',
  },
  {
    was: "What we'll do to it",
    now: 'Options',
    why: 'asked for, on Convert only: the design gives one panel a title covering both the pipeline and the checkboxes. Those are now two things in two places — the checkboxes sit under the formats as Options, and the pipeline is its own step called Conversion — so one title could not name both. Send is untouched and still says it',
  },
  {
    was: 'Convert another',
    now: 'Convert another book',
    why: 'asked for: the same act, moved. The design ends a conversion with a third button inside the result panel, while the page\'s own button below it still said "Convert to KEPUB" — an offer to redo what had just been done, under a panel already showing the result. The button says "Convert another book" once there is one, and the panel carries Download and Send it to an eReader only',
  },
  {
    was: 'Override',
    now: '',
    why: 'asked for: the four targets were behind a button that named none of them, and hidden outright in Kobo-sync mode. They are tiles now, always on screen under "Convert for", drawn with the same component Convert uses for formats. A fail-safe you have to find is not a fail-safe',
  },
  {
    was: 'Close overrides',
    now: '',
    why: 'the other half of the Override pair. Nothing opens, so nothing closes',
  },
  {
    was: 'Collapse',
    now: '',
    why: 'it was disabled and marked data-unbacked because it needed somewhere to store the preference. Steps 1 and 2 now collapse on their own as you finish with them, which is what the button was reaching for, and it needs nothing stored',
  },
  {
    was: 'Supported formats',
    now: '',
    why: 'asked for: the panel opened inside the card and pushed it ~200px taller, which the card is not allowed to do. Its content was also the third telling — the drop box lists what you may drop and step 3 names the pipeline for the file in hand',
  },
  {
    was: 'What each device reads',
    now: '',
    why: 'the body of that panel, removed with it. The retention line keeps the one fact that was only stated there — how long the file survives',
  },
  {
    was: 'Held only while your eReader shows the key, or until a paired Kobo collects it.',
    now: 'Held only while your eReader shows the key, or until a paired Kobo collects it. Deleted about {expireSeconds} after you close the key page.',
    why: 'the deletion timing lived in the disclosure that is now gone, and it is the one line in there that was not said anywhere else. It reads from /healthz as it always did',
  },
  {
    was: "What we'll do to it",
    now: 'Convert for',
    why: 'asked for: the title stopped being true. It headed a pipeline and a checkbox list; the checkboxes are now a step of their own called Options, so all that is left under it is the device choice and the one line naming the pipeline. "Convert for" was already the label inside it, so the step takes its name and the duplicate label goes',
  },
  {
    was: 'Auto uses whichever device generated the key.',
    now: '',
    why: 'the sentence under the segmented control became the hover text on the Auto tile, the same treatment every format tile on Convert already gets. It is still in send.js and still says the same thing — it just no longer occupies 45px of a card that has none to spare',
  },
  {
    was: "Collapse step 3 when nothing's ambiguous",
    now: 'Kindle format / Kobo format / Options start as',
    why: 'asked for: the two Send defaults described a page that no longer exists — there is no step 3 panel to collapse, every step folds to a summary once you are past it. Worse, neither toggle did anything: they were written to localStorage and read by nothing. The panel now sets the format each device starts on and the state the two options start in, and the Send page reads them',
  },
  {
    was: "Hide options that can't apply",
    now: '',
    why: 'the other dead toggle. Options that cannot apply are shown greyed with the reason on both pages now, never hidden, so there is nothing left to choose between',
  },
  {
    was: 'Deliver sends over sync / Wake the device after each send / Hold a book until it’s collected',
    now: 'three statements of what actually happens',
    why: 'all three were switches that could never move, and were marked data-unbacked to say so. Two describe behaviour that is unconditional here — a sync send is always a library entry, and it always waits to be collected — and the third describes a push channel a Kobo does not have. A settings page with dead switches teaches people not to trust it, so they are three lines of fact under the endpoint instead',
  },
  {
    was: 'until that link is opened. Expires in 30 minutes.',
    now: 'until that link is opened. It lasts {EMAIL_TOKEN_TTL} and works once.',
    why: 'the design states a life this link does not have: a confirmation link is EMAIL_TOKEN_TTL, twenty-four hours by default and settable, so the sentence was wrong out of the box. The page reads it from /auth/status, the same treatment the queue TTL and the password minimum already had',
  },
  {
    was: 'Eight characters minimum.',
    now: 'At least {MIN_PASSWORD_LENGTH} characters.',
    why: "asked for: the minimum is an env setting, so the page reads it from /auth/status rather than stating the design's eight",
  },
  {
    was: 'a masked password field and nothing else',
    now: 'an eye inside the field',
    why: 'asked for: these forms ask twice and the reason to look is to check the two against each other',
  },
  {
    was: 'a submit that is always live',
    now: 'a submit gated until the fields are filled and the passwords match',
    why: 'asked for: a live button on an incomplete form promises a round trip that only comes back with a complaint',
  },
]

function normalise(text: string): string {
  return text
    .replaceAll('&amp;', '&')
    .replaceAll('&minus;', '−')
    .replaceAll('&times;', '×')
    .replaceAll('&#39;', "'")
    .replace(/\bereader/gi, 'ereader')
}

describe('the design owns this copy', () => {
  const files = Object.entries(fixture).filter(([name]) => !name.startsWith('_'))

  it('has something to check', () => {
    expect(files.length).toBeGreaterThan(8)
    expect(files.flatMap(([, entries]) => entries as Entry[]).length).toBeGreaterThan(150)
  })

  for (const [file, entries] of files) {
    describe(file, () => {
      const source = readFileSync(join(root, file), 'utf8')

      for (const entry of entries as Entry[]) {
        it(`says "${entry.text.slice(0, 60)}" (prototype ${entry.line})`, () => {
          expect(normalise(source)).toContain(normalise(entry.text))
        })
      }
    })
  }
})

describe('the deliberate departures', () => {
  it('each says what it replaced and why', () => {
    expect(OVERRIDES.length).toBeGreaterThan(0)
    for (const entry of OVERRIDES) {
      expect(entry.was, 'an override must name the design string it replaces').not.toBe('')
      expect(
        entry.why.length,
        `${entry.was}: an override without a reason is drift`
      ).toBeGreaterThan(20)
    }
  })
})
