#!/usr/bin/env bash
#
# File de modération des prix invraisemblables (§6.1).
#
#   ops/review-prices.sh [--dry-run]
#
# Codes de sortie : 0 succès (y compris « rien à signaler »), 1 échec.
JOB_NAME=review-prices
# shellcheck source=lib/job-runner.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/job-runner.sh"

job_log "démarrage · node=${NODE}"

summary="$(mktemp)"
trap 'rm -f "$summary"' EXIT

status=0
"$NODE" db/jobs/review-prices.mjs --json "$@" >"$summary" 2>>"$JOB_LOG" || status=$?
[[ $status -eq 0 ]] || job_die "le job des prix a renvoyé le code ${status}."

queued="$(job_json_field "$summary" queued)"
closed="$(job_json_field "$summary" closed)"
open="$(job_json_field "$summary" open)"

if [[ "${1:-}" == "--dry-run" ]]; then
  job_log "terminé (simulation) · ${queued:-0} signalement(s) seraient ouverts · file ${open:-0}."
  exit 0
fi

job_log "terminé · ${queued:-0} ouvert(s) · ${closed:-0} refermé(s) sans décision · file ${open:-0}."
