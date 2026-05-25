/**
 * Mode local : scan DevSecOps sans Managed Agents.
 * Appelle kubectl et trivy directement, envoie via Telegram.
 * Utilise l'API messages Claude avec tool_use pour le raisonnement.
 */
import Anthropic from "@anthropic-ai/sdk";
import { exec }  from "child_process";
import { promisify } from "util";
import * as fs   from "fs";
import * as path from "path";

const execAsync = promisify(exec);
const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN!;
const CHAT_ID    = process.env.TELEGRAM_CHAT_ID!;

// ── Outils exposés à Claude ────────────────────────────────────────────────

const TOOLS: Anthropic.Tool[] = [
  {
    name: "kubectl_get",
    description: "Liste les ressources K8s d'un namespace",
    input_schema: {
      type: "object",
      properties: {
        resource:  { type: "string" },
        namespace: { type: "string" },
        flags:     { type: "string" },
      },
      required: ["resource"],
    },
  },
  {
    name: "kubectl_get_images",
    description: "Liste toutes les images des pods d'un namespace",
    input_schema: {
      type: "object",
      properties: { namespace: { type: "string" } },
      required: [],
    },
  },
  {
    name: "trivy_scan_image",
    description: "Scanne une image Docker pour des CVEs (CRITICAL,HIGH par défaut)",
    input_schema: {
      type: "object",
      properties: {
        image:    { type: "string" },
        severity: { type: "string", default: "CRITICAL,HIGH" },
      },
      required: ["image"],
    },
  },
  {
    name: "trivy_scan_manifest",
    description: "Scanne les misconfigurations d'un manifest K8s",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "telegram_alert_critical",
    description: "Envoie une alerte critique sur Telegram",
    input_schema: {
      type: "object",
      properties: {
        namespace:   { type: "string" },
        severity:    { type: "string" },
        cve_list:    { type: "array", items: { type: "string" } },
        image:       { type: "string" },
        remediation: { type: "string" },
      },
      required: ["namespace", "severity", "cve_list", "image", "remediation"],
    },
  },
  {
    name: "telegram_send_report",
    description: "Envoie le rapport de sécurité complet sur Telegram",
    input_schema: {
      type: "object",
      properties: {
        report_content: { type: "string" },
        title:          { type: "string" },
        score:          { type: "number" },
      },
      required: ["report_content", "title", "score"],
    },
  },
];

// ── Exécuteurs d'outils ────────────────────────────────────────────────────

async function runTool(name: string, args: any): Promise<string> {
  switch (name) {

    case "kubectl_get": {
      const ns  = args.namespace ? `-n ${args.namespace}` : "--all-namespaces";
      const cmd = `kubectl get ${args.resource} ${ns} ${args.flags || ""}`;
      try {
        const { stdout, stderr } = await execAsync(cmd, { timeout: 30000 });
        return stdout || stderr || "(vide)";
      } catch (e: any) { return `ERREUR kubectl: ${e.message}`; }
    }

    case "kubectl_get_images": {
      const ns  = args.namespace ? `-n ${args.namespace}` : "--all-namespaces";
      const cmd = `kubectl get pods ${ns} -o jsonpath="{range .items[*]}{.metadata.name}{'\\t'}{range .spec.containers[*]}{.image}{' '}{end}{'\\n'}{end}"`;
      try {
        const { stdout } = await execAsync(cmd, { timeout: 30000 });
        return stdout || "(aucun pod)";
      } catch (e: any) { return `ERREUR kubectl: ${e.message}`; }
    }

    case "trivy_scan_image": {
      const sev = args.severity || "CRITICAL,HIGH";
      const cmd = `trivy image --severity ${sev} --format json --quiet ${args.image}`;
      try {
        const { stdout } = await execAsync(cmd, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
        return stdout || "{}";
      } catch (e: any) { return e.stdout || e.message; }
    }

    case "trivy_scan_manifest": {
      const cmd = `trivy config --format json --quiet ${args.path}`;
      try {
        const { stdout } = await execAsync(cmd, { timeout: 60000 });
        return stdout || "{}";
      } catch (e: any) { return e.stdout || e.message; }
    }

    case "telegram_alert_critical": {
      const emoji = args.severity === "CRITICAL" ? "🔴" : args.severity === "HIGH" ? "🟠" : "🟡";
      const cves  = (args.cve_list as string[]).map((c: string) => `• <code>${c}</code>`).join("\n");
      const text  = [
        `${emoji} <b>Alerte DevSecOps — ${args.severity}</b>`,
        `<b>Namespace :</b> <code>${args.namespace}</code>`,
        `<b>Image     :</b> <code>${args.image}</code>`,
        `<b>CVEs :</b>\n${cves}`,
        `<b>Remédiation :</b>\n<pre>${args.remediation}</pre>`,
        `<i>${new Date().toISOString()}</i>`,
      ].join("\n\n");
      return await sendTelegram(text);
    }

    case "telegram_send_report": {
      const score = args.score as number;
      const emoji = score >= 70 ? "🟢" : score >= 40 ? "🟡" : "🔴";
      const text  = [
        `${emoji} <b>${args.title}</b>`,
        `<b>Score :</b> ${score}/100`,
        `<pre>${(args.report_content as string).slice(0, 3500)}</pre>`,
      ].join("\n\n");
      return await sendTelegram(text);
    }

    default:
      return `Outil inconnu : ${name}`;
  }
}

async function sendTelegram(text: string): Promise<string> {
  if (!BOT_TOKEN || BOT_TOKEN.includes("PLACEHOLDER")) return "⚠️  TELEGRAM_BOT_TOKEN non configuré";
  const res  = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const data = await res.json() as any;
  return data.ok ? `✅ Telegram envoyé (msg ${data.result?.message_id})` : `❌ Erreur Telegram: ${data.description}`;
}

// ── Boucle agent ───────────────────────────────────────────────────────────

async function runDevSecOpsScan(namespace: string = "default") {
  console.log(`\n🚀 Audit DevSecOps local — namespace: ${namespace}`);
  console.log(`⏰ ${new Date().toISOString()}\n`);

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Lance un audit DevSecOps complet sur le namespace Kubernetes "${namespace}".

Processus :
1. Liste les pods et deployments (kubectl_get)
2. Extrait toutes les images (kubectl_get_images)
3. Scanne chaque image avec trivy (CRITICAL,HIGH)
4. Si CVE CRITICAL → alerte Telegram immédiate (telegram_alert_critical)
5. Génère un rapport final avec score /100 et plan de remédiation
6. Envoie le rapport sur Telegram (telegram_send_report)`,
    },
  ];

  const SYSTEM = `Tu es un expert DevSecOps spécialisé AWS EKS.
Tu utilises les outils pour inspecter le cluster, scanner les vulnérabilités et alerter via Telegram.
Sois méthodique : invente rien, utilise les vrais résultats des outils pour ton analyse.`;

  let fullReport = "";
  let round      = 0;
  const toolsUsed: string[] = [];

  while (round < 10) {
    round++;
    const response = await client.messages.create({
      model:      "claude-sonnet-4-6",
      max_tokens: 4096,
      system:     SYSTEM,
      tools:      TOOLS,
      messages,
    });

    // Texte de l'agent
    for (const block of response.content) {
      if (block.type === "text") {
        process.stdout.write(block.text);
        fullReport += block.text;
      }
    }

    if (response.stop_reason === "end_turn") break;
    if (response.stop_reason !== "tool_use")  break;

    // Exécuter les outils demandés
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;
      console.log(`\n  🔧 [${block.name}] ${JSON.stringify(block.input).slice(0, 80)}`);
      toolsUsed.push(block.name);
      const result = await runTool(block.name, block.input);
      toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
    }

    // Ajouter la réponse de l'agent + les résultats d'outils à la conversation
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user",      content: toolResults });
  }

  // Sauvegarde locale
  const dir = "./reports";
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const reportPath = path.join(dir, `security-report-${namespace}-${Date.now()}.md`);
  fs.writeFileSync(reportPath, fullReport);

  console.log("\n" + "─".repeat(50));
  console.log(`📄 Rapport : ${reportPath}`);
  console.log(`🔧 Outils  : ${[...new Set(toolsUsed)].join(", ")}`);
  console.log("─".repeat(50));
}

const namespace = process.argv[2] || "default";
runDevSecOpsScan(namespace).catch((err) => {
  console.error("Erreur :", err.message);
  process.exit(1);
});
