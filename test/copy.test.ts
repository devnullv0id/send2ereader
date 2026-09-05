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
    was: 'No book files are deleted, because none were ever kept. Books already on your ereader stay there. Anonymous sending keeps working.',
    now: 'Any books this server is still keeping for you go with it. Books already on your eReader stay there. Anonymous sending keeps working.',
    why: 'bug, not taste: it was true when nothing was ever kept server-side, and the library made it false. Deleting your own account runs library.forgetUser (src/routes/devices.ts:356), which removes every kept book file for good — so the sentence promised the opposite of what the button does, on an action that cannot be undone',
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
  {
    was: 'MOBI is the one whose cover the Kindle displays. AZW3 is newer, but a downloaded AZW3 arrives without its cover.',
    now: 'MOBI keeps its cover on a Kindle. A downloaded AZW3 does not.',
    why: 'asked for: the page read like an essay when the job is configuring a server. One sentence saying what happens, and the reasoning left to the commit that set it',
  },
  {
    was: "The same settings the calibre plugin offers. Anything left as it is here is left to the engine's own default, and nothing is sent with the book.",
    now: "Anything left alone uses the engine's own default.",
    why: 'asked for: the page read like an essay when the job is configuring a server. One sentence saying what happens, and the reasoning left to the commit that set it',
  },
  {
    was: "History lists what you have sent and converted. Without a library that list is this browser's own and goes no further; with one, it is kept on the server and the books can be fetched again until each reaches its deadline.",
    now: "Without a library, History is this browser's own. With one, the books are kept here until their deadline.",
    why: 'asked for: the page read like an essay when the job is configuring a server. One sentence saying what happens, and the reasoning left to the commit that set it',
  },
  {
    was: 'Off by default. With it off this server keeps nothing: a book is deleted the moment it has been delivered, and History shows only what this browser sent. With it on, what you send and convert stays here so you can fetch it again.',
    now: 'Off, a book is deleted the moment it is delivered. On, it stays here so you can fetch it again.',
    why: 'asked for: the page read like an essay when the job is configuring a server. One sentence saying what happens, and the reasoning left to the commit that set it',
  },
  {
    was: "A Kobo asks a server for its library every time it syncs, and which server that is lives in one line of a config file on the device. Point it here and a book you send arrives the way a bought one does — proper title, author and cover, filed in the device's own library instead of dropped in as a loose sideloaded file. The queue keeps nothing of its own: it holds each book only until the device collects it.",
    now: "Point your Kobo here and a sent book arrives the way a bought one does: title, author and cover, in the device's own library. The queue holds it only until the device collects it.",
    why: 'asked for: the page read like an essay when the job is configuring a server. One sentence saying what happens, and the reasoning left to the commit that set it',
  },
  {
    was: "A new token invalidates the old URL — you'd edit the config file again. Turning sync off deletes the endpoint and anything waiting at it.",
    now: 'A new token breaks the old URL. Turning sync off deletes the endpoint and anything waiting at it.',
    why: 'asked for: the page read like an essay when the job is configuring a server. One sentence saying what happens, and the reasoning left to the commit that set it',
  },
  {
    was: 'The host and protocol come from whatever public address your server is configured with, so this line is already correct for your instance.',
    now: "Built from this server's public address, so it is already right.",
    why: 'asked for: the page read like an essay when the job is configuring a server. One sentence saying what happens, and the reasoning left to the commit that set it',
  },
  {
    was: 'Save, eject properly, unplug. On the device tap Sync — the first one takes a minute while it rebuilds the library.',
    now: 'Save, eject, unplug. Tap Sync on the device — the first one takes a minute.',
    why: 'asked for: the page read like an essay when the job is configuring a server. One sentence saying what happens, and the reasoning left to the commit that set it',
  },
  {
    was: "The file is deleted the moment the device confirms delivery — that isn't optional, and this app never keeps a library. The endpoint only answers requests carrying this token. Anyone holding the URL can push a book to your device or collect one waiting there, so treat it like a password and regenerate if it leaks.",
    now: 'The endpoint answers only requests carrying this token, and anyone holding the URL can push a book to your device or collect one waiting. Treat it like a password.',
    why: 'asked for: the page read like an essay when the job is configuring a server. One sentence saying what happens, and the reasoning left to the commit that set it',
  },
  {
    was: "Shown to whoever administers this server, so they can tell one account from another without reading everybody's address.",
    now: 'Shown to whoever administers this server, so they can tell accounts apart without reading addresses.',
    why: 'asked for: the page read like an essay when the job is configuring a server. One sentence saying what happens, and the reasoning left to the commit that set it',
  },
  {
    was: 'Kobo sync needs a confirmed address: it hands the device a token that can collect your books, so the address has to be one you can actually open. Everything else already works, including sending by key.',
    now: 'Kobo sync needs a confirmed address, because the device is handed a token that can collect your books. Everything else already works.',
    why: 'asked for: the page read like an essay when the job is configuring a server. One sentence saying what happens, and the reasoning left to the commit that set it',
  },
  {
    was: 'The address only changes once you open the link we send to the new one. The old address gets a notice either way.',
    now: 'It changes only once you open the link sent to the new address. The old one gets a notice either way.',
    why: 'asked for: the page read like an essay when the job is configuring a server. One sentence saying what happens, and the reasoning left to the commit that set it',
  },
  {
    was: 'A passkey signs you in with the fingerprint reader or PIN that already unlocks your device. Nothing to remember, and nothing a leaked database could reveal.',
    now: 'Signs you in with the fingerprint reader or PIN that already unlocks your device.',
    why: 'asked for: the page read like an essay when the job is configuring a server. One sentence saying what happens, and the reasoning left to the commit that set it',
  },
  {
    was: 'Ask for a six-digit code from an authenticator app after the password. Sending a book never asks for it, only signing in does.',
    now: 'A six-digit code from an authenticator app, after the password. Only signing in asks for it.',
    why: 'asked for: the page read like an essay when the job is configuring a server. One sentence saying what happens, and the reasoning left to the commit that set it',
  },
  {
    was: "This can't be undone and no confirmation email is sent. You'll be signed out immediately and this browser goes back to anonymous sending.",
    now: "This can't be undone. You'll be signed out and this browser goes back to anonymous sending.",
    why: 'asked for: the page read like an essay when the job is configuring a server. One sentence saying what happens, and the reasoning left to the commit that set it',
  },
  {
    was: 'This is the only account on this server. Deleting it puts the server back to its first-run state, where the next person to open it in a browser is asked to create the administrator account.',
    now: 'The only account on this server. Deleting it puts the server back to its first-run state.',
    why: 'asked for: the page read like an essay when the job is configuring a server. One sentence saying what happens, and the reasoning left to the commit that set it',
  },
  {
    was: "This is the only time they're shown. Each code works once, and they're the way back in if you lose the authenticator.",
    now: "Shown once. Each works once, and they're the way back in if you lose the authenticator.",
    why: 'asked for: the page read like an essay when the job is configuring a server. One sentence saying what happens, and the reasoning left to the commit that set it',
  },
  {
    was: 'The device collects it the next time it syncs — asleep, off wifi or in a bag is fine. After a day, or the moment it downloads, the server drops the file.',
    now: 'Collected on the next sync; asleep or off wifi is fine. Dropped after a day, or once it downloads.',
    why: 'asked for: the same pass that cut the configuration screens. What happens, in a sentence, with the reasoning left to the commit',
  },
  {
    was: 'The upload and the conversion finish either way — they are already under way. What waits is the last step: the book is not handed to your eReader until you answer.',
    now: 'The upload and conversion finish either way. Only the hand-off to your eReader waits for your answer.',
    why: 'asked for: the same pass that cut the configuration screens. What happens, in a sentence, with the reasoning left to the commit',
  },
  {
    was: 'Names, sizes and destinations live in this browser\'s storage — clearing site data clears them, and another browser shows nothing. "Send again" takes you back to step 2 to pick the file once more; no copy was kept anywhere.',
    now: 'Kept in this browser\'s storage, so clearing site data clears them. "Send again" returns to step 2 to pick the file again.',
    why: 'asked for: the same pass that cut the configuration screens. What happens, in a sentence, with the reasoning left to the commit',
  },
  {
    was: 'Each book keeps the deadline it was given when it arrived, so changing how long books are kept in Settings applies to the next one and not to these. Downloading takes a copy and leaves the book here; Delete removes the file from the server straight away.',
    now: 'Each book keeps the deadline it arrived with, so a change in Settings applies to the next one. Download leaves the book here; Delete removes it now.',
    why: 'asked for: the same pass that cut the configuration screens. What happens, in a sentence, with the reasoning left to the commit',
  },
  {
    was: "Cancelling deletes the file from the server straight away. If the device already collected it, the copy on the device stays — there's no way to reach back into it.",
    now: 'Cancelling deletes the file from the server. If the device already collected it, that copy stays.',
    why: 'asked for: the same pass that cut the configuration screens. What happens, in a sentence, with the reasoning left to the commit',
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
