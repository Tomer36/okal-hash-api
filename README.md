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

- New versions are kept in `C:\okal-services\report-templates` (outside the repository, so a
  deploy is never blocked by local changes): `versions/<report>/<time>.txt`, `active.json`
  (the version in use per report; no entry means the git file) and `updates.log` (who, when,
  result, failures included).
- `POST /templates/<report>/activate` switches to one of the versions, or back to the git file
  with `version: null`.
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

## Deploy

Every push runs the tests. A push to the `production` branch also deploys to the server:
the self-hosted runner updates the code, restarts the `okal-hash-api` service and checks
that the gateway is listening.
