# okal-hash-api

Gateway to the Hashavshevet reports. Report templates live in `reports/<number>.txt`.

## Deploy

Every push runs the tests. A push to the `production` branch also deploys to the server:
the self-hosted runner updates the code, restarts the `okal-hash-api` service and checks
that the gateway is listening.
