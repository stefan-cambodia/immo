#!/usr/bin/env bash
#
# Purge des mesures de terrain au-delà de la fenêtre d'observation (§10).
#
#   ops/purge-metrics.sh [--dry-run] [--days 60]
#
# Codes de sortie : 0 succès (y compris « rien à purger »), 1 échec.
JOB_NAME=purge-metrics
# shellcheck source=lib/job-runner.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/job-runner.sh"

job_log "démarrage · node=${NODE}"

summary="$(mktemp)"
trap 'rm -f "$summary"' EXIT

# Voir ops/expire-listings.sh : `|| status=$?` plutôt que `set +e`, pour que le
# trap ERR ne masque pas le message d'échec.
status=0
"$NODE" db/jobs/purge-metrics.mjs --json "$@" >"$summary" 2>>"$JOB_LOG" || status=$?

[[ $status -eq 0 ]] || job_die "la purge des mesures a renvoyé le code ${status}."

searches="$(job_json_field "$summary" purgedSearchEvents)"
vitals="$(job_json_field "$summary" purgedWebVitals)"

if [[ "${1:-}" == "--dry-run" ]]; then
  job_log "terminé (simulation) · ${searches:-0} recherche(s) et ${vitals:-0} mesure(s) seraient purgées."
  exit 0
fi

job_log "terminé · ${searches:-0} recherche(s) et ${vitals:-0} mesure(s) purgées."
