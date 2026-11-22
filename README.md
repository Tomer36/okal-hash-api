# okal-hash-api

Gateway to the Hashavshevet reports. Report templates live in `reports/<number>.txt`.

An API only, with no pages: the reports page and the template updates are in Rivo ("דוחות API",
and its "הצפנה" panel for operations users). Rivo reaches this service through the gateway
(`/hashAPI/route-hashAPI/<n>` → `/reports/<n>`) and through auth-service (`/templates`), both on
the same server, so the service listens on `127.0.0.1` and `::1` only and serves no files (the
provider token in `config/default.json` is never reachable).

## Updating a report template

From Rivo's reports page: choose the report, open "הצפנה" and press "עדכן הצפנה". Rivo calls
`POST /templates/<report>/update` with the login's name. The server runs
`hrep <company> <מזהה>` in the Hconnect folder, checks the output (valid JSON, readable Hebrew
field names) and runs the report once against Hashavshevet with it. Only if that call succeeds
is the new template saved and used, from the next call on, without a restart. Single-customer
reports need a customer number for the test.

Rivo checks first and turns on second: `activate: false` keeps the tested file as a version that
is not in use and returns the first rows; `POST /templates/<report>/activate` then turns that
version on (with `name` for a new report). Every check also returns a plan,
`changes: { added, removed, changed, unchanged, problems, blocked }`, comparing the filters with
the file in use (`services/templateContract.mjs`, which also owns the filter names the report calls
fill in). A problem of level "error" refuses the change before Hashavshevet is called (422, stage
`plan`): a single-customer report losing its customer filter, report 198 losing its card-number
filter (the new-cards check), report 200 losing its document-number filter. A "warning" (a filter
behind a field on the reports page is gone, or no filters at all) is shown and confirmed in Rivo.

- New versions are kept in `C:\okal-services\report-templates` (outside the repository, so a
  deploy is never blocked by local changes): `versions/<report>/<time>.txt`, `active.json`
  (the version in use per report; no entry means the git file) and `updates.log` (who, when,
  result, failures included).
- `POST /templates/<report>/activate` switches to one of the versions, or back to the git file
  with `version: null`. A version is checked against the plan's rules before it is turned on.
- `POST /templates/<report>/check-version` (`{ version }`) and `/check-git` check an existing
  file like any change (plan, test call, rows) without saving a copy; Rivo uses them before turning
  an older version or a newer git file on. `gitNewer` in the list and the details says the git file
  changed after the version in use was turned on (recorded in `git-hashes.json`).
- Checked versions never turned on are removed after 30 days (the newest 5 per report and any
  version once in use stay), right after the daily backup.
- The details give each filter `filledBy`: the request field that fills it on every run (`dates`,
  `client`, `sortCode`, `headerNumber`, `invoiceNumber`, `cardNumber`), or null for a filter that
  keeps its value in the file (Rivo offers those as extra fields). The list gives `needsClient`,
  from the report's own file.
- A report number that is not in git can be added the same way, with a name. Rivo then lists
  it and builds its form from the template's filters, sending the values by filter id
  (`params` in the request body). A customer filter becomes the usual customer number field.
- Filter values of a template (`defVal`, e.g. a sort-code range) can be changed without hrep:
  `POST /templates/<report>/values` with `{ by, clientNumber, values: { <filter id>: value } }`
  tests the file with the new values against Hashavshevet and saves it as a new version. An
  update (`/update`) takes the same `values`, by the ids of the file in use, and puts them into
  the fresh hrep output by filter (name, operation and side), so an update keeps them. Dates and
  the customer filter are refused: every run sets them.
- `names.json` in the same folder holds the names given in Rivo.
- hrep encrypts by the report's "מזהה" in Hashavshevet's list of API reports (report 186), which
  for some reports is not the report number: 225 → 227, 227 → 228, 280 → 229, 276 → 230,
  285 → 231 (`templates.HREP_IDS`). An update may send `hrepId`; a changed one is kept in
  `hrep-ids.json` in the same folder and used from then on.
- Settings: `templates.HREP_DIR`, `templates.HREP_COMPANY`, `templates.OVERRIDE_DIR` and
  `templates.HREP_IDS` in `config/default.json` (`HASH_TEMPLATE_DIR` overrides the folder).

To make an updated template the default in git, copy the version file over
`reports/<number>.txt`, commit it, and switch the report back to the original file after the
deploy.

## Backup of the report-templates folder

The folder above is outside git, so the service copies it at start and then daily to
`templates.BACKUP_DIR` (`C:\okal-services\report-templates-backup`, or `HASH_TEMPLATE_BACKUP_DIR`),
one folder per day, the newest 14 days kept. Point it at another disk or a network share, so one
lost disk does not take both. To restore: stop the `okal-hash-api` service, copy the chosen day's
folder over `C:\okal-services\report-templates`, start the service.

## Deploy

Every push runs the tests. Before them, `scripts/check-template-changes.mjs` checks every
`reports/<n>.txt` changed in the push with the same rules as a change from Rivo (readable file,
then the plan against the previous version of the file): a change that would break something
fails the run, so it is not deployed. A push to the `production` branch also deploys to the
server: the self-hosted runner updates the code, restarts the `okal-hash-api` service and checks
that the gateway is listening.
