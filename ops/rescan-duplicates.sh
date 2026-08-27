#!/usr/bin/env bash
#
# Réévaluation de la file de déduplication une fois les photos hachées (§6.2).
# À lancer APRÈS ops/process-media.sh : c'est lui qui produit les empreintes
# sans lesquelles la corroboration ne peut pas être exigée.
#
#   ops/rescan-duplicates.sh [--dry-run]
#
# Codes de sortie : 0 succès (y compris « rien à réévaluer »), 1 échec.
JOB_NAME=rescan-duplicates
# shellcheck source=lib/job-runner.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/job-runner.sh"

job_log "démarrage · node=${NODE}"

summary="$(mktemp)"
trap 'rm -f "$summary"' EXIT

# Voir ops/expire-listings.sh : `|| status=$?` plutôt que `set +e`.
status=0
"$NODE" db/jobs/rescan-duplicates.mjs --json "$@" >"$summary" 2>>"$JOB_LOG" || status=$?

[[ $status -eq 0 ]] || job_die "la réévaluation a renvoyé le code ${status}."

dropped="$(job_json_field "$summary" pairsDropped)"
queued="$(job_json_field "$summary" queued)"
after="$(job_json_field "$summary" queueAfter)"

if [[ "${1:-}" == "--dry-run" ]]; then
  job_log "terminé (simulation) · ${dropped:-0} paire(s) sortiraient, ${queued:-0} entreraient."
  exit 0
fi

job_log "terminé · ${dropped:-0} paire(s) retirée(s), ${queued:-0} déposée(s) · file : ${after:-?}."
