import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { "anthropic-beta": "managed-agents-2026-04-01" },
});

const AGENT_ID = process.env.AGENT_ID || "agent_XXXX";

async function runDevSecOpsScan(namespace: string = "default") {
  console.log(`\n🚀 Démarrage audit DevSecOps — namespace: ${namespace}`);
  console.log(`⏰ ${new Date().toISOString()}\n`);

  const environment = await (client.beta as any).environments.create({
    name: `eks-scan-${namespace}-${Date.now()}`,
    config: {
      type: "cloud",
      networking: { type: "unrestricted" },
    },
  });

  const session = await (client.beta as any).sessions.create({
    agent: AGENT_ID,
    environment_id: environment.id,
    title: `DevSecOps Audit — ${namespace} — ${new Date().toISOString()}`,
  });

  console.log(`📋 Session ID : ${session.id}`);

  const stream = await (client.beta as any).sessions.events.stream(session.id);

  await (client.beta as any).sessions.events.send(session.id, {
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
5. Alerte Slack immédiate pour chaque CVE CRITICAL trouvé
6. Rapport final avec score de sécurité /100 et plan de remédiation
7. Envoi du rapport complet sur Slack`,
          },
        ],
      },
    ],
  });

  let fullReport = "";
  const toolsUsed: string[] = [];
  let criticalCount = 0;

  for await (const event of stream) {
    switch (event.type) {
      case "agent.message":
        for (const block of (event as any).content || []) {
          if (block.text) {
            process.stdout.write(block.text);
            fullReport += block.text;
          }
        }
        break;

      case "agent.tool_use":
        const toolName = (event as any).name || "unknown";
        toolsUsed.push(toolName);
        if (toolName === "slack_alert_critical") criticalCount++;
        console.log(`\n  🔧 [${toolName}]`);
        break;

      case "session.status_idle":
        console.log("\n\n✅ Audit terminé.\n");
        break;

      case "session.status_error":
        console.error(`\n❌ Erreur session : ${(event as any).error}`);
        break;
    }
  }

  const reportsDir = "./reports";
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir);

  const reportPath = path.join(
    reportsDir,
    `security-report-${namespace}-${Date.now()}.md`
  );
  fs.writeFileSync(reportPath, fullReport);

  console.log("─".repeat(50));
  console.log(`📄 Rapport sauvegardé : ${reportPath}`);
  console.log(`🔧 Outils utilisés    : ${[...new Set(toolsUsed)].join(", ")}`);
  console.log(`🔴 Alertes critiques  : ${criticalCount}`);
  console.log("─".repeat(50));
}

const namespace = process.argv[2] || "default";
runDevSecOpsScan(namespace).catch((err) => {
  console.error("Erreur fatale :", err);
  process.exit(1);
});
