#!/usr/bin/env bash
#
# Cycle de facturation et de quotas (phase 3 — §8).
#
#   ops/billing.sh [--dry-run]
#
# À planifier une fois par jour, après ops/expire-listings.sh : les places
# libérées par les expirations profitent aux annonces retenues par le quota.
# Codes de sortie : 0 succès, 1 échec.
JOB_NAME=billing
# shellcheck source=lib/job-runner.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/job-runner.sh"

job_log "démarrage · node=${NODE}"

summary="$(mktemp)"
trap 'rm -f "$summary"' EXIT

status=0
"$NODE" db/jobs/billing.mjs --json "$@" >"$summary" 2>>"$JOB_LOG" || status=$?

[[ $status -eq 0 ]] || job_die "le job de facturation a renvoyé le code ${status}."

invoices="$(job_json_field "$summary" invoices)"
amount="$(job_json_field "$summary" amountUsd)"
expired="$(job_json_field "$summary" featuredExpired)"
released="$(job_json_field "$summary" released)"
overdue="$(job_json_field "$summary" overdue)"

if [[ "${1:-}" == "--dry-run" ]]; then
  job_log "terminé (simulation) · ${invoices:-0} facture(s) seraient émises (${amount:-0} \$)."
  exit 0
fi

job_log "terminé · ${invoices:-0} facture(s) émise(s) (${amount:-0} \$) · ${expired:-0} mise(s) en avant éteinte(s) · ${released:-0} annonce(s) retenue(s) publiée(s) · ${overdue:-0} facture(s) en retard."
