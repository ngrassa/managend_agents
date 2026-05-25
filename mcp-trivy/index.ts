import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const server = new Server(
  { name: "trivy-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "trivy_scan_image",
      description: "Scanne une image Docker pour des CVEs",
      inputSchema: {
        type: "object" as const,
        properties: {
          image: { type: "string", description: "ex: node:latest, nginx:1.21" },
          severity: {
            type: "string",
            description: "Niveaux séparés par virgule: CRITICAL,HIGH,MEDIUM,LOW",
            default: "CRITICAL,HIGH",
          },
        },
        required: ["image"],
      },
    },
    {
      name: "trivy_scan_manifest",
      description: "Scanne un manifest K8s pour des misconfigurations de sécurité",
      inputSchema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "chemin vers le fichier YAML ou répertoire" },
        },
        required: ["path"],
      },
    },
    {
      name: "trivy_scan_fs",
      description: "Scanne un répertoire complet (dépendances, secrets, IaC)",
      inputSchema: {
        type: "object" as const,
        properties: {
          path: { type: "string", description: "chemin du répertoire à scanner" },
          scanners: {
            type: "string",
            description: "vuln,secret,config (défaut: vuln,secret)",
            default: "vuln,secret",
          },
        },
        required: ["path"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  let cmd = "";

  switch (name) {
    case "trivy_scan_image": {
      const sev = (args.severity as string) || "CRITICAL,HIGH";
      cmd = `trivy image --severity ${sev} --format json --quiet ${args.image}`;
      break;
    }
    case "trivy_scan_manifest": {
      cmd = `trivy config --format json --quiet ${args.path}`;
      break;
    }
    case "trivy_scan_fs": {
      const scanners = (args.scanners as string) || "vuln,secret";
      cmd = `trivy fs --scanners ${scanners} --format json --quiet ${args.path}`;
      break;
    }
    default:
      return { content: [{ type: "text" as const, text: `Outil inconnu: ${name}` }] };
  }

  try {
    const { stdout } = await execAsync(cmd, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
    return { content: [{ type: "text" as const, text: stdout }] };
  } catch (err: any) {
    // trivy retourne exit code 1 si des vulnérabilités sont trouvées — ce n'est pas une erreur
    return { content: [{ type: "text" as const, text: err.stdout || err.message }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
