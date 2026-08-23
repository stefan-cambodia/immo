# shellcheck shell=bash
#
# Socle commun aux tâches planifiées.
#
# Un cron n'a ni le PATH, ni le répertoire courant, ni l'environnement d'un
# shell de connexion, et il avale les erreurs en silence. Tout ce qui suit
# existe pour ces quatre raisons. Chaque tâche s'y raccorde ainsi :
#
#   JOB_NAME=ma-tache
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/job-runner.sh"
#   job_log "…"; "$NODE" db/jobs/…
#
# Fournit : $ROOT, $NODE, job_log, job_die, job_json_field.
# Garantit : verrou exclusif, répertoire de travail, environnement chargé,
#            journal horodaté, sortie non nulle en cas d'échec.

set -Eeuo pipefail

: "${JOB_NAME:?JOB_NAME doit être défini avant de sourcer job-runner.sh}"

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly ROOT

readonly JOB_LOCK="${JOB_LOCK_FILE:-/tmp/cambodia-immo-${JOB_NAME}.lock}"
readonly JOB_LOG="${JOB_LOG_FILE:-${ROOT}/var/log/${JOB_NAME}.log}"

mkdir -p -- "$(dirname -- "$JOB_LOG")"

# Horodatage sur chaque ligne : un journal de cron sans date est inexploitable.
job_log() { printf '%s  [%s] %s\n' "$(date -Is)" "$JOB_NAME" "$*" | tee -a "$JOB_LOG" >&2; }

job_die() {
  job_log "ÉCHEC : $*"
  exit 1
}
trap 'job_die "interrompu ligne ${LINENO}"' ERR

# --------------------------------------------------------------- verrouillage
# Deux exécutions simultanées se marcheraient dessus. Un chevauchement n'est
# pas une erreur : l'exécution précédente fait déjà le travail.
exec 9>"$JOB_LOCK"
if ! flock -n 9; then
  job_log "exécution déjà en cours (verrou $JOB_LOCK) — abandon."
  exit 0
fi

cd -- "$ROOT"

# ------------------------------------------------------------ environnement
# Chargement sans `source` : le fichier d'environnement est une liste de
# variables, pas un script à exécuter.
job_load_env() {
  local file="$1" line key value
  [[ -f "$file" ]] || return 0
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" != *=* ]] && continue
    key="${line%%=*}"; value="${line#*=}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    # Une valeur déjà présente dans l'environnement l'emporte : c'est ce qui
    # permet à l'unité systemd ou au crontab de surcharger le fichier.
    [[ -n "${!key:-}" ]] && continue
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
    export "$key=$value"
  done < "$file"
}

job_load_env "${ROOT}/.env.local"
job_load_env "${ROOT}/.env"

# ------------------------------------------------------------------- node
# cron n'hérite pas du PATH d'un shell de connexion : nvm, asdf et volta sont
# invisibles. Le binaire est donc résolu explicitement.
job_resolve_node() {
  if [[ -n "${NODE_BIN:-}" && -x "${NODE_BIN}" ]]; then echo "$NODE_BIN"; return; fi
  if command -v node >/dev/null 2>&1; then command -v node; return; fi
  local candidate
  for candidate in /usr/local/bin/node /usr/bin/node /opt/homebrew/bin/node \
                   "$HOME"/.nvm/versions/node/*/bin/node \
                   "$HOME"/.volta/bin/node; do
    [[ -x "$candidate" ]] && { echo "$candidate"; return; }
  done
  return 1
}

NODE="$(job_resolve_node)" \
  || job_die "node introuvable. Renseignez NODE_BIN dans l'environnement du cron."
readonly NODE

# Distingue une exécution planifiée d'une exécution manuelle dans les traces.
export JOB_ACTOR="${JOB_ACTOR:-cron:$(hostname -s 2>/dev/null || echo inconnu)}"

# Lit un champ de la dernière ligne JSON d'un fichier produit par un job `--json`.
job_json_field() {
  "$NODE" -e '
    const fs = require("node:fs");
    const raw = fs.readFileSync(process.argv[1], "utf8").trim();
    if (!raw) { process.stdout.write(""); process.exit(0); }
    const value = JSON.parse(raw.split("\n").pop())[process.argv[2]];
    process.stdout.write(value === null || value === undefined ? "" : String(value));
  ' "$1" "$2"
}
