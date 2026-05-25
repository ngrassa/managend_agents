import * as fs from "fs";
import * as path from "path";

const API_KEY  = process.env.ANTHROPIC_API_KEY!;
const AGENT_ID = process.env.AGENT_ID || process.env.CLAUDE_AGENT_ID || "agent_016H69NZqGCQmnggLrbrCJKs";
const BASE     = "https://api.anthropic.com/v1";
const HEADERS  = {
  "x-api-key":        API_KEY,
  "anthropic-version": "2023-06-01",
  "anthropic-beta":   "managed-agents-2026-04-01",
  "content-type":     "application/json",
};

async function api(method: string, path: string, body?: object) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json() as any;
  if (data.type === "error") throw new Error(`API ${path}: ${data.error.message}`);
  return data;
}

async function runDevSecOpsScan(namespace: string = "default") {
  console.log(`\n🚀 Démarrage audit DevSecOps — namespace: ${namespace}`);
  console.log(`⏰ ${new Date().toISOString()}\n`);

  // 1. Créer un environnement cloud managé
  const environment = await api("POST", "/environments", {
    name: `eks-scan-${namespace}-${Date.now()}`,
    config: {
      type: "cloud",
      networking: { type: "unrestricted" },
    },
  });
  console.log(`🌐 Environnement : ${environment.id}`);

  // 2. Ouvrir une session agent
  const session = await api("POST", "/sessions", {
    agent: AGENT_ID,
    environment_id: environment.id,
    title: `DevSecOps Audit — ${namespace} — ${new Date().toISOString()}`,
  });
  console.log(`📋 Session ID   : ${session.id}`);

  // 3. Envoyer la tâche
  await api("POST", `/sessions/${session.id}/events`, {
    events: [
      {
        type: "user.message",
        content: [
          {
            type: "text",
            text: `Lance un audit DevSecOps complet sur le namespace Kubernetes "${namespace}".

Suis exactement ce processus :
1. Inventaire des ressources (pods, deployments, services)
2. Extraction de toutes les images Docker utilisées
3. Scan trivy de chaque image (CRITICAL et HIGH uniquement)
4. Scan trivy des manifests pour misconfigurations
5. Alerte Telegram immédiate pour chaque CVE CRITICAL trouvé
6. Rapport final avec score de sécurité /100 et plan de remédiation
7. Envoi du rapport complet sur Telegram`,
          },
        ],
      },
    ],
  });

  // 4. Stream des événements
  const streamRes = await fetch(`${BASE}/sessions/${session.id}/events/stream`, {
    headers: { ...HEADERS, accept: "text/event-stream" },
  });

  let fullReport = "";
  const toolsUsed: string[] = [];
  let criticalCount = 0;

  if (!streamRes.body) throw new Error("Stream non disponible");

  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (raw === "[DONE]") break;

      try {
        const event = JSON.parse(raw);
        switch (event.type) {
          case "agent.message":
            for (const block of event.content || []) {
              if (block.text) {
                process.stdout.write(block.text);
                fullReport += block.text;
              }
            }
            break;
          case "agent.tool_use":
            const toolName = event.name || "unknown";
            toolsUsed.push(toolName);
            if (toolName.includes("alert_critical")) criticalCount++;
            console.log(`\n  🔧 [${toolName}]`);
            break;
          case "session.status_idle":
            console.log("\n\n✅ Audit terminé.\n");
            break;
          case "session.status_error":
            console.error(`\n❌ Erreur session : ${event.error}`);
            break;
        }
      } catch { /* ligne SSE non-JSON */ }
    }
  }

  // 5. Sauvegarde locale
  const reportsDir = "./reports";
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir);
  const reportPath = path.join(reportsDir, `security-report-${namespace}-${Date.now()}.md`);
  fs.writeFileSync(reportPath, fullReport);

  console.log("─".repeat(50));
  console.log(`📄 Rapport sauvegardé : ${reportPath}`);
  console.log(`🔧 Outils utilisés    : ${[...new Set(toolsUsed)].join(", ")}`);
  console.log(`🔴 Alertes critiques  : ${criticalCount}`);
  console.log("─".repeat(50));
}

const namespace = process.argv[2] || "default";
runDevSecOpsScan(namespace).catch((err) => {
  console.error("Erreur fatale :", err.message);
  process.exit(1);
});
