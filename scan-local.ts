/**
 * Scan DevSecOps local — supporte Mistral et Anthropic.
 * Priorité : MISTRAL_API_KEY → ANTHROPIC_API_KEY
 * Usage : npx ts-node scan-local.ts [namespace]
 */
import { exec }     from "child_process";
import { promisify } from "util";
import * as fs      from "fs";
import * as path    from "path";

const execAsync = promisify(exec);

const MISTRAL_KEY   = process.env.MISTRAL_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PROVIDER      = MISTRAL_KEY ? "mistral" : "anthropic";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID!;

if (!MISTRAL_KEY && !ANTHROPIC_KEY) {
  console.error("❌ Aucune clé API — définir MISTRAL_API_KEY ou ANTHROPIC_API_KEY");
  process.exit(1);
}

console.log(`🔑 Provider : ${PROVIDER === "mistral" ? "Mistral AI" : "Anthropic Claude"}`);

// ── Définition des outils ─────────────────────────────────────────────────

const TOOLS_ANTHROPIC = [
  { name: "kubectl_get",       description: "Liste les ressources K8s d'un namespace",                     input_schema: { type: "object", properties: { resource: { type: "string" }, namespace: { type: "string" }, flags: { type: "string" } }, required: ["resource"] } },
  { name: "kubectl_get_images",description: "Liste toutes les images Docker des pods d'un namespace",       input_schema: { type: "object", properties: { namespace: { type: "string" } }, required: [] } },
  { name: "trivy_scan_image",  description: "Scanne une image Docker pour des CVEs (CRITICAL,HIGH)",        input_schema: { type: "object", properties: { image: { type: "string" }, severity: { type: "string", default: "CRITICAL,HIGH" } }, required: ["image"] } },
  { name: "trivy_scan_manifest",description: "Scanne les misconfigurations d'un manifest K8s",             input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "telegram_alert_critical", description: "Envoie une alerte critique de sécurité sur Telegram",   input_schema: { type: "object", properties: { namespace: { type: "string" }, severity: { type: "string" }, cve_list: { type: "array", items: { type: "string" } }, image: { type: "string" }, remediation: { type: "string" } }, required: ["namespace","severity","cve_list","image","remediation"] } },
  { name: "telegram_send_report", description: "Envoie le rapport de sécurité complet sur Telegram",       input_schema: { type: "object", properties: { report_content: { type: "string" }, title: { type: "string" }, score: { type: "number" } }, required: ["report_content","title","score"] } },
] as const;

const TOOLS_MISTRAL = TOOLS_ANTHROPIC.map(t => ({
  type: "function" as const,
  function: {
    name:        t.name,
    description: t.description,
    parameters:  (t as any).input_schema,
  },
}));

// ── Appel LLM ─────────────────────────────────────────────────────────────

const SYSTEM = `Tu es un expert DevSecOps spécialisé AWS EKS.
Utilise les outils pour inspecter le cluster, scanner les vulnérabilités et alerter via Telegram.
Sois méthodique : utilise les vrais résultats des outils pour ton analyse.`;

type Message = { role: string; content: any; tool_call_id?: string; name?: string };

async function callMistral(messages: Message[]): Promise<{ text: string; toolCalls: any[] }> {
  let attempt = 0;
  let data: any;
  while (true) {
    const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${MISTRAL_KEY}` },
      body: JSON.stringify({
        model:       "mistral-large-latest",
        messages:    [{ role: "system", content: SYSTEM }, ...messages],
        tools:       TOOLS_MISTRAL,
        tool_choice: "auto",
      }),
    });
    data = await res.json() as any;
    if (res.status === 429 && attempt < 4) {
      const wait = (attempt + 1) * 15000;
      console.log(`\n  ⏳ Rate limit Mistral — retry dans ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
      attempt++;
      continue;
    }
    break;
  }
  if (data.object === "error" || data.error) throw new Error(data.error?.message || JSON.stringify(data));

  const msg  = data.choices[0].message;
  const text = msg.content || "";
  const toolCalls = (msg.tool_calls || []).map((tc: any) => ({
    id:    tc.id,
    name:  tc.function.name,
    input: JSON.parse(tc.function.arguments || "{}"),
  }));
  return { text, toolCalls };
}

async function callAnthropic(messages: Message[]): Promise<{ text: string; toolCalls: any[]; stopReason: string }> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client    = new Anthropic({ apiKey: ANTHROPIC_KEY });

  const res = await client.messages.create({
    model:      "claude-sonnet-4-6",
    max_tokens: 4096,
    system:     SYSTEM,
    tools:      TOOLS_ANTHROPIC as any,
    messages:   messages as any,
  });

  const text = res.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  const toolCalls = res.content.filter((b: any) => b.type === "tool_use").map((b: any) => ({
    id: b.id, name: b.name, input: b.input,
    _raw: b,
  }));
  return { text, toolCalls, stopReason: res.stop_reason ?? "end_turn" };
}

// ── Exécuteurs d'outils ───────────────────────────────────────────────────

async function runTool(name: string, args: any): Promise<string> {
  switch (name) {

    case "kubectl_get": {
      const ns  = args.namespace ? `-n ${args.namespace}` : "--all-namespaces";
      const cmd = `kubectl get ${args.resource} ${ns} ${args.flags || ""}`;
      try { const { stdout, stderr } = await execAsync(cmd, { timeout: 30000 }); return stdout || stderr || "(vide)"; }
      catch (e: any) { return `ERREUR kubectl: ${e.message}`; }
    }

    case "kubectl_get_images": {
      const ns  = args.namespace ? `-n ${args.namespace}` : "--all-namespaces";
      const cmd = `kubectl get pods ${ns} -o jsonpath="{range .items[*]}{.metadata.name}{'\\t'}{range .spec.containers[*]}{.image}{' '}{end}{'\\n'}{end}"`;
      try { const { stdout } = await execAsync(cmd, { timeout: 30000 }); return stdout || "(aucun pod)"; }
      catch (e: any) { return `ERREUR kubectl: ${e.message}`; }
    }

    case "trivy_scan_image": {
      const sev = args.severity || "CRITICAL,HIGH";
      const cmd = `trivy image --severity ${sev} --format json --quiet ${args.image}`;
      try { const { stdout } = await execAsync(cmd, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }); return stdout || "{}"; }
      catch (e: any) { return e.stdout || e.message; }
    }

    case "trivy_scan_manifest": {
      const cmd = `trivy config --format json --quiet ${args.path}`;
      try { const { stdout } = await execAsync(cmd, { timeout: 60000 }); return stdout || "{}"; }
      catch (e: any) { return e.stdout || e.message; }
    }

    case "telegram_alert_critical": {
      const emoji = args.severity === "CRITICAL" ? "🔴" : args.severity === "HIGH" ? "🟠" : "🟡";
      const cves  = (args.cve_list as string[]).map(c => `• <code>${c}</code>`).join("\n");
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

    default: return `Outil inconnu : ${name}`;
  }
}

async function sendTelegram(text: string): Promise<string> {
  if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN.includes("PLACEHOLDER")) return "⚠️ TELEGRAM_BOT_TOKEN non configuré";
  const res  = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ chat_id: TELEGRAM_CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  const data = await res.json() as any;
  return data.ok ? `✅ Telegram msg ${data.result?.message_id}` : `❌ Telegram: ${data.description}`;
}

// ── Boucle agent ──────────────────────────────────────────────────────────

async function runDevSecOpsScan(namespace: string = "default") {
  console.log(`\n🚀 Audit DevSecOps — namespace: ${namespace} [${PROVIDER}]`);
  console.log(`⏰ ${new Date().toISOString()}\n`);

  const TASK = `Lance un audit DevSecOps complet sur le namespace Kubernetes "${namespace}".
1. Liste pods et deployments (kubectl_get)
2. Extrait toutes les images (kubectl_get_images)
3. Scanne chaque image avec trivy (CRITICAL,HIGH)
4. Alerte Telegram immédiate pour chaque CVE CRITICAL (telegram_alert_critical)
5. Génère un rapport final avec score /100 et plan de remédiation
6. Envoie le rapport sur Telegram (telegram_send_report)`;

  const messages: Message[] = [{ role: "user", content: TASK }];
  let fullReport = "";
  const toolsUsed: string[] = [];
  let round = 0;

  while (round++ < 15) {
    if (PROVIDER === "mistral") {
      const { text, toolCalls } = await callMistral(messages);

      if (text) { process.stdout.write(text); fullReport += text; }
      if (toolCalls.length === 0) break;

      // Ajouter réponse assistant avec tool_calls au format Mistral
      messages.push({
        role: "assistant",
        content: text || "",
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls.map(tc => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.input) } })) } : {}),
      } as any);

      // Exécuter les outils et ajouter les résultats
      for (const tc of toolCalls) {
        console.log(`\n  🔧 [${tc.name}] ${JSON.stringify(tc.input).slice(0, 80)}`);
        toolsUsed.push(tc.name);
        const result = await runTool(tc.name, tc.input);
        messages.push({ role: "tool", content: result, tool_call_id: tc.id, name: tc.name });
      }

    } else {
      const { text, toolCalls, stopReason } = await callAnthropic(messages);

      if (text) { process.stdout.write(text); fullReport += text; }
      if (stopReason === "end_turn" || toolCalls.length === 0) break;

      // Ajouter réponse assistant au format Anthropic
      const rawContent = toolCalls[0]?._raw
        ? toolCalls.map(tc => tc._raw)
        : [];
      if (text) rawContent.unshift({ type: "text", text });
      messages.push({ role: "assistant", content: rawContent });

      // Exécuter les outils
      const results = [];
      for (const tc of toolCalls) {
        console.log(`\n  🔧 [${tc.name}] ${JSON.stringify(tc.input).slice(0, 80)}`);
        toolsUsed.push(tc.name);
        const result = await runTool(tc.name, tc.input);
        results.push({ type: "tool_result", tool_use_id: tc.id, content: result });
      }
      messages.push({ role: "user", content: results });
    }
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
runDevSecOpsScan(namespace).catch(err => {
  console.error("Erreur :", err.message);
  process.exit(1);
});
