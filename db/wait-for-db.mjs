import { execSync } from "node:child_process";

const deadline = Date.now() + 60_000;
process.stdout.write("Attente de PostgreSQL");
while (Date.now() < deadline) {
  try {
    execSync("docker compose exec -T db pg_isready -U immo -d cambodia_immo", { stdio: "ignore" });
    console.log("\nPostgreSQL est prêt.");
    process.exit(0);
  } catch {
    process.stdout.write(".");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
}
console.error("\nTimeout : la base n'a pas démarré.");
process.exit(1);
