#!/usr/bin/env bash
#
# « Toujours disponible ? » pour les annonces collectées (§6.3) : relit chez la
# source la page de chaque annonce qui entre dans sa dernière semaine.
#
#   ops/reconfirm-portal.sh [--dry-run]
#
# Codes de sortie : 0 succès (y compris « rien à relire »), 1 échec — dont
# l'arrêt anticipé quand la source refuse ou ne répond plus.
JOB_NAME=reconfirm-portal
# shellcheck source=lib/job-runner.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/job-runner.sh"

job_log "démarrage · node=${NODE}"

summary="$(mktemp)"
trap 'rm -f "$summary"' EXIT

status=0
"$NODE" db/jobs/reconfirm-portal.mjs --json "$@" >"$summary" 2>>"$JOB_LOG" || status=$?

due="$(job_json_field "$summary" due)"
checked="$(job_json_field "$summary" checked)"
confirmed="$(job_json_field "$summary" confirmed)"
concluded="$(job_json_field "$summary" concluded)"
withdrawn="$(job_json_field "$summary" withdrawn)"
unclear="$(job_json_field "$summary" unclear)"
unreadable="$(job_json_field "$summary" unreadable)"

# Un arrêt anticipé laisse quand même un bilan : le journaliser avant d'échouer
# dit ce qui a pu être fait avant que la source ne coupe.
counts="${checked:-0}/${due:-0} relue(s) · ${confirmed:-0} reconduite(s) · ${concluded:-0} conclue(s)"\
" · ${withdrawn:-0} disparue(s) · ${unclear:-0} douteuse(s) · ${unreadable:-0} illisible(s)"

[[ $status -eq 0 ]] || job_die "le job de relecture a renvoyé le code ${status} · ${counts}."

if [[ "${1:-}" == "--dry-run" ]]; then
  job_log "terminé (simulation, échantillon) · ${counts}."
  exit 0
fi

job_log "terminé · ${counts}."
