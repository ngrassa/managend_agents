import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const server = new Server(
  { name: "kubectl-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "kubectl_get",
      description: "Liste les ressources K8s (pods, deployments, services, etc.)",
      inputSchema: {
        type: "object" as const,
        properties: {
          resource: { type: "string", description: "pods | deployments | services | configmaps | secrets" },
          namespace: { type: "string", description: "namespace K8s (défaut: default)" },
          flags: { type: "string", description: "flags additionnels ex: -o yaml | -o wide" },
        },
        required: ["resource"],
      },
    },
    {
      name: "kubectl_describe",
      description: "Détails complets d'une ressource K8s",
      inputSchema: {
        type: "object" as const,
        properties: {
          resource: { type: "string" },
          name: { type: "string" },
          namespace: { type: "string" },
        },
        required: ["resource", "name"],
      },
    },
    {
      name: "kubectl_dry_run",
      description: "Valide un manifest K8s sans l'appliquer (dry-run server-side)",
      inputSchema: {
        type: "object" as const,
        properties: {
          manifest_path: { type: "string", description: "chemin absolu vers le fichier YAML" },
        },
        required: ["manifest_path"],
      },
    },
    {
      name: "kubectl_get_images",
      description: "Liste toutes les images des pods d'un namespace",
      inputSchema: {
        type: "object" as const,
        properties: {
          namespace: { type: "string" },
        },
        required: [],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  let cmd = "";

  switch (name) {
    case "kubectl_get": {
      const ns = (args.namespace as string) ? `-n ${args.namespace}` : "--all-namespaces";
      cmd = `kubectl get ${args.resource} ${ns} ${args.flags || ""}`;
      break;
    }
    case "kubectl_describe": {
      const ns = (args.namespace as string) ? `-n ${args.namespace}` : "";
      cmd = `kubectl describe ${args.resource} ${args.name} ${ns}`;
      break;
    }
    case "kubectl_dry_run": {
      cmd = `kubectl apply --dry-run=server -f ${args.manifest_path}`;
      break;
    }
    case "kubectl_get_images": {
      const ns = (args.namespace as string) ? `-n ${args.namespace}` : "--all-namespaces";
      cmd = `kubectl get pods ${ns} -o jsonpath="{range .items[*]}{.metadata.name}{' '}{range .spec.containers[*]}{.image}{' '}{end}{'\\n'}{end}"`;
      break;
    }
    default:
      return { content: [{ type: "text" as const, text: `Outil inconnu: ${name}` }] };
  }

  try {
    const { stdout, stderr } = await execAsync(cmd, { timeout: 30000 });
    return { content: [{ type: "text" as const, text: stdout || stderr }] };
  } catch (err: any) {
    return { content: [{ type: "text" as const, text: `ERREUR kubectl: ${err.message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
