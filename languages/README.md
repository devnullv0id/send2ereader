# Languages

Drop a `<code>.json` file here — or, running the Docker image, into `/data/languages`
on the volume — and restart the server. It appears in every language picker and as a
choice for the admin's default. English is built in and needs no file.

A file the server cannot read is skipped with a warning in the log; the server always
starts. Any string a file does not translate stays English, so a partial file is fine.

The same code in both folders: the one on the data volume wins, whole file.

## The format

```json
{
  "_meta": { "code": "de", "name": "Deutsch" },
  "strings": {
    "Send": "Senden",
    "At least {min} characters": "Mindestens {min} Zeichen"
  }
}
```

- **Keys are the English strings themselves**, exactly as the app says them. The
  shipped [de.json](de.json) is the master list — copy it, keep the keys, replace the
  values.
- `_meta.name` is what the pickers show. `_meta.code` is a short language code
  (`de`, `pt-br`) and should match the filename.
- `{placeholders}` carry values the server fills in. Copy each one into your
  translation unchanged, wherever your grammar puts it. A mismatch is logged at boot
  and the entry still loads.
- Plurals are separate keys (`"{n} minute"`, `"{n} minutes"`) — translate each.
- Two sentences carry a live duration the page rewrites in place (the sign-in-link
  and reset notes). Keep exactly one "number word" phrase in them, e.g.
  `15 Minuten`, so the rewrite can find it.

The German file is machine-drafted and marked `"reviewed": false` — corrections
welcome.
