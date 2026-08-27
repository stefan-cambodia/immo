#!/usr/bin/env node
/**
 * Vérifie que chaque tâche planifiée est réellement planifiée — hors ligne.
 *
 * Une tâche `ops/*.sh` posée sur le socle commun (`JOB_NAME=`) n'existe pour
 * l'exploitation que si trois choses la nomment : un timer systemd, une ligne
 * du repli cron.d, et la table des cadences du README. Une purge écrite,
 * documentée et jamais lancée est pire qu'absente : le code promet une
 * rétention que rien ne tient. C'est arrivé — deux tâches sur huit n'avaient
 * ni timer ni ligne cron — et ce contrôle est là pour que ça ne se reproduise
 * pas sans bruit.
 *
 * Il vérifie aussi l'inverse : un timer ou une ligne cron qui nomme une tâche
 * disparue échouerait à chaque échéance.
 *
 *   node db/checks/scheduler.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");

let pass = 0, fail = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : " — " + detail}`);
  if (ok) pass++; else fail++;
};

// ------------------------------------------------------------ inventaire
const jobs = readdirSync(join(ROOT, "ops"))
  .filter((f) => f.endsWith(".sh") && /^JOB_NAME=/m.test(read("ops", f)))
  .map((f) => {
    const name = read("ops", f).match(/^JOB_NAME=(\S+)/m)[1];
    return { file: f, name };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const timers = readdirSync(join(ROOT, "ops", "systemd"))
  .filter((f) => /^cambodia-immo-.+\.timer$/.test(f))
  .map((f) => ({ file: f, name: f.replace(/^cambodia-immo-/, "").replace(/\.timer$/, ""),
                 body: read("ops", "systemd", f) }));

const cron = read("ops", "cron.d", "cambodia-immo");
const cronJobs = [...cron.matchAll(/__APP_ROOT__\/ops\/([\w-]+)\.sh/g)].map((m) => m[1]);

const readme = read("README.md");
const readmeRows = [...readme.matchAll(/^\| `ops\/([\w-]+)\.sh` \|/gm)].map((m) => m[1]);

console.log(`Tâches sur le socle commun : ${jobs.map((j) => j.name).join(", ")}`);
check("le nom de chaque tâche est celui de son fichier",
      jobs.every((j) => j.file === `${j.name}.sh`),
      jobs.filter((j) => j.file !== `${j.name}.sh`).map((j) => `${j.file}≠${j.name}`).join(", "));
check("au moins six tâches", jobs.length >= 6, String(jobs.length));

// ------------------------------------------------------- tâche → planning
console.log("\nChaque tâche est planifiée trois fois");
for (const j of jobs) {
  const timer = timers.find((t) => t.name === j.name);
  check(`${j.name} : timer systemd`, Boolean(timer), `ops/systemd/cambodia-immo-${j.name}.timer absent`);
  if (timer) {
    check(`${j.name} : le timer instancie le bon service`,
          timer.body.includes(`Unit=cambodia-immo@${j.name}.service`), "Unit= ne nomme pas la tâche");
    check(`${j.name} : le timer rattrape les échéances manquées`,
          /^Persistent=true$/m.test(timer.body), "Persistent=true absent");
    check(`${j.name} : le timer a une cadence`, /^OnCalendar=/m.test(timer.body), "OnCalendar= absent");
  }
  check(`${j.name} : ligne cron.d`, cronJobs.includes(j.name), "absente de ops/cron.d/cambodia-immo");
  check(`${j.name} : ligne dans la table des cadences du README`, readmeRows.includes(j.name), "absente");
}

// ------------------------------------------------------- planning → tâche
console.log("\nRien ne planifie une tâche qui n'existe pas");
const known = new Set(jobs.map((j) => j.name));
check("chaque timer nomme une tâche existante",
      timers.every((t) => known.has(t.name)),
      timers.filter((t) => !known.has(t.name)).map((t) => t.file).join(", "));
check("chaque ligne cron nomme une tâche existante",
      cronJobs.every((n) => known.has(n)),
      cronJobs.filter((n) => !known.has(n)).join(", "));
check("le README ne documente pas de tâche disparue",
      readmeRows.every((n) => known.has(n)),
      readmeRows.filter((n) => !known.has(n)).join(", "));

// Le texte d'introduction compte les tâches en toutes lettres ; il doit
// suivre l'inventaire, sinon il ment dès la tâche suivante.
const counts = { six: 6, sept: 7, huit: 8, neuf: 9, dix: 10 };
const intro = readme.match(/^(\w+) tâches tournent en dehors de l'application/m);
check("le README compte les tâches juste",
      intro && counts[intro[1].toLowerCase()] === jobs.length,
      intro ? `« ${intro[1]} » pour ${jobs.length}` : "phrase d'introduction introuvable");
const timerCount = readme.match(/et (\w+) timers `Persistent=true`/);
check("le README compte les timers juste",
      timerCount && counts[timerCount[1]] === timers.length,
      timerCount ? `« ${timerCount[1]} » pour ${timers.length}` : "mention introuvable");

console.log(`\n${pass} réussite(s), ${fail} échec(s).`);
process.exit(fail ? 1 : 0);
