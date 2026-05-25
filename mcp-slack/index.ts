import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN!;
const DEFAULT_CHANNEL = process.env.SLACK_CHANNEL_ID!;

const server = new Server(
  { name: "slack-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "slack_alert_critical",
      description: "Envoie une alerte critique de sécurité sur Slack avec bloc formaté",
      inputSchema: {
        type: "object" as const,
        properties: {
          namespace: { type: "string", description: "Namespace K8s concerné" },
          severity: { type: "string", enum: ["CRITICAL", "HIGH", "MEDIUM"], description: "Niveau de sévérité" },
          cve_list: {
            type: "array",
            items: { type: "string" },
            description: "Liste des CVE IDs ex: ['CVE-2024-1234', 'CVE-2024-5678']",
          },
          image: { type: "string", description: "Image Docker concernée" },
          remediation: { type: "string", description: "Action corrective recommandée" },
          channel: { type: "string", description: "Channel Slack (optionnel, défaut: env SLACK_CHANNEL_ID)" },
        },
        required: ["namespace", "severity", "cve_list", "image", "remediation"],
      },
    },
    {
      name: "slack_send_report",
      description: "Envoie le rapport de sécurité complet sur Slack sous forme de fichier",
      inputSchema: {
        type: "object" as const,
        properties: {
          report_content: { type: "string", description: "Contenu Markdown du rapport" },
          title: { type: "string", description: "Titre du rapport" },
          score: { type: "number", description: "Score de sécurité 0-100" },
          channel: { type: "string" },
        },
        required: ["report_content", "title", "score"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const channel = (args.channel as string) || DEFAULT_CHANNEL;

  const post = async (body: object) => {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
    return res.json();
  };

  if (name === "slack_alert_critical") {
    const severity = args.severity as string;
    const emoji = severity === "CRITICAL" ? "🔴" : severity === "HIGH" ? "🟠" : "🟡";
    const cveText = (args.cve_list as string[]).join(", ");

    const body = {
      channel,
      text: `${emoji} Alerte sécurité ${severity} — Namespace: ${args.namespace}`,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: `${emoji} Sécurité ${severity} — ${args.namespace}` },
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Image concernée:*\n\`${args.image}\`` },
            { type: "mrkdwn", text: `*CVEs détectés:*\n${cveText}` },
          ],
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: `*Remédiation:*\n${args.remediation}` },
        },
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: `Scan automatique — ${new Date().toISOString()}` },
          ],
        },
      ],
    };

    const result = await post(body) as any;
    return {
      content: [{ type: "text" as const, text: result.ok ? `✅ Alerte envoyée (ts: ${result.ts})` : `❌ Erreur Slack: ${result.error}` }],
    };
  }

  if (name === "slack_send_report") {
    const score = args.score as number;
    const scoreEmoji = score >= 70 ? "🟢" : score >= 40 ? "🟡" : "🔴";

    const body = {
      channel,
      text: `${scoreEmoji} Rapport DevSecOps — Score: ${score}/100`,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: `${scoreEmoji} ${args.title}` },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Score de sécurité:* ${score}/100\n\n\`\`\`\n${(args.report_content as string).slice(0, 2000)}\n\`\`\``,
          },
        },
      ],
    };

    const result = await post(body) as any;
    return {
      content: [{ type: "text" as const, text: result.ok ? `✅ Rapport envoyé` : `❌ Erreur: ${result.error}` }],
    };
  }

  return { content: [{ type: "text" as const, text: "Outil inconnu" }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
