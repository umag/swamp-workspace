import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// kubectl executor
// ---------------------------------------------------------------------------

function isTransientKubectlError(text) {
  return (
    text.includes("connection refused") ||
    text.includes("connection reset") ||
    text.includes("Unable to connect to the server") ||
    text.includes("i/o timeout") ||
    text.includes("TLS handshake timeout") ||
    text.includes("net/http: request canceled")
  );
}

async function kubectl(
  globalArgs,
  args,
  _timeout = 30000,
  retries = 0,
  retryDelay = 10000,
) {
  const cmdArgs = [...args];

  if (globalArgs.kubeconfig) {
    cmdArgs.push("--kubeconfig", globalArgs.kubeconfig);
  }
  if (globalArgs.context) {
    cmdArgs.push("--context", globalArgs.context);
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const cmd = new Deno.Command("kubectl", {
      args: cmdArgs,
      stdout: "piped",
      stderr: "piped",
    });

    const output = await cmd.output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);

    if (output.success) {
      return { stdout, stderr };
    }

    const errText = stderr || stdout;
    if (attempt < retries && isTransientKubectlError(errText)) {
      await new Promise((r) => setTimeout(r, retryDelay));
      continue;
    }

    throw new Error(`kubectl ${args.slice(0, 3).join(" ")} failed: ${errText}`);
  }
  throw new Error(
    `kubectl ${args.slice(0, 3).join(" ")} failed after ${
      retries + 1
    } attempts`,
  );
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const GlobalArgs = z.object({
  kubeconfig: z
    .string()
    .optional()
    .describe("Path to kubeconfig for the Cozystack management cluster"),
  context: z
    .string()
    .optional()
    .describe("Kubeconfig context to use"),
});

const AppDefSchema = z
  .object({
    name: z.string(),
    kind: z.string(),
    plural: z.string(),
    singular: z.string(),
    category: z.string().optional(),
    description: z.string().optional(),
    timestamp: z.string(),
  })
  .passthrough();

const AppInstanceSchema = z
  .object({
    name: z.string(),
    namespace: z.string(),
    kind: z.string(),
    specJson: z.string().describe("Application spec as JSON string"),
    ready: z.string().optional(),
    status: z.string().optional(),
    age: z.string().optional(),
    timestamp: z.string(),
  })
  .passthrough();

const WorkloadSchema = z
  .object({
    name: z.string(),
    namespace: z.string(),
    kind: z.string(),
    type: z.string().optional(),
    cpu: z.string().optional(),
    memory: z.string().optional(),
    operational: z.boolean().optional(),
    timestamp: z.string(),
  })
  .passthrough();

const PackageSchema = z
  .object({
    name: z.string(),
    variant: z.string().optional(),
    ready: z.string().optional(),
    status: z.string().optional(),
    timestamp: z.string(),
  })
  .passthrough();

const TenantSchema = z
  .object({
    name: z.string(),
    namespace: z.string(),
    host: z.string().optional(),
    ready: z.string().optional(),
    timestamp: z.string(),
  })
  .passthrough();

const ResultSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  warnings: z.array(z.string()).optional(),
  timestamp: z.string(),
});

const SecretSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  dataJson: z.string().meta({ sensitive: true }).describe(
    "Secret data as JSON string",
  ),
  timestamp: z.string(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseAge(creationTimestamp) {
  if (!creationTimestamp) return "unknown";
  const ms = Date.now() - new Date(creationTimestamp).getTime();
  const hours = Math.floor(ms / 3600000);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function getCondition(conditions, type) {
  if (!conditions) return undefined;
  const c = conditions.find((c) => c.type === type);
  return c ? c.status : undefined;
}

function getConditionMessage(conditions, type) {
  if (!conditions) return undefined;
  const c = conditions.find((c) => c.type === type);
  return c ? c.message : undefined;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/**
 * Cozystack platform management model: installs the operator via Helm, applies
 * platform packages, manages applications and tenants, bootstraps CNI/PodCIDRs,
 * and reports platform health. Wraps `kubectl` and `helm` against a Cozystack
 * management cluster.
 */
export const model = {
  type: "@magistr/cozystack-platform",
  version: "2026.07.16.2",
  globalArguments: GlobalArgs,
  checks: {
    "cluster-reachable": {
      description: "Verify kubectl can reach the Kubernetes cluster",
      labels: ["live"],
      appliesTo: [
        "install",
        "createApp",
        "deleteApp",
        "updateApp",
        "createTenant",
        "applyPackage",
        "patchFluxTenants",
        "assignPodCIDRs",
        "configurePlatform",
      ],
      execute: async (context) => {
        try {
          const cmdArgs = ["cluster-info", "--request-timeout=5s"];
          if (context.globalArgs.kubeconfig) {
            cmdArgs.push("--kubeconfig", context.globalArgs.kubeconfig);
          }
          if (context.globalArgs.context) {
            cmdArgs.push("--context", context.globalArgs.context);
          }
          const cmd = new Deno.Command("kubectl", {
            args: cmdArgs,
            stdout: "piped",
            stderr: "piped",
          });
          const output = await cmd.output();
          if (!output.success) {
            const stderr = new TextDecoder().decode(output.stderr);
            return {
              pass: false,
              errors: [`Cluster unreachable: ${stderr.split("\n")[0]}`],
            };
          }
          return { pass: true };
        } catch (e) {
          return {
            pass: false,
            errors: [
              `kubectl not available: ${
                e instanceof Error ? e.message : String(e)
              }`,
            ],
          };
        }
      },
    },
    "helm-available": {
      description: "Verify helm binary is available",
      labels: ["dependency"],
      appliesTo: ["install"],
      execute: async () => {
        try {
          const cmd = new Deno.Command("helm", {
            args: ["version", "--short"],
            stdout: "piped",
            stderr: "piped",
          });
          const output = await cmd.output();
          if (!output.success) {
            return {
              pass: false,
              errors: ["helm binary found but returned error"],
            };
          }
          return { pass: true };
        } catch {
          return { pass: false, errors: ["helm binary not found in PATH"] };
        }
      },
    },
  },
  resources: {
    appDef: {
      description: "Cozystack application definition",
      schema: AppDefSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    app: {
      description: "Cozystack application instance",
      schema: AppInstanceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    workload: {
      description: "Cozystack workload status",
      schema: WorkloadSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    package: {
      description: "Cozystack platform package",
      schema: PackageSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    tenant: {
      description: "Cozystack tenant",
      schema: TenantSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    result: {
      description: "Operation result",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    secret: {
      description: "Application secret (credentials)",
      schema: SecretSchema,
      sensitiveOutput: true,
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    getOperatorStatus: {
      description:
        "Check if Cozystack operator deployment exists and its rollout status",
      arguments: z.object({}),
      execute: async (_args, context) => {
        try {
          const { stdout } = await kubectl(
            context.globalArgs,
            [
              "get",
              "deploy/cozystack-operator",
              "-n",
              "cozy-system",
              "-o",
              "json",
            ],
            15000,
            2,
          );
          const deploy = JSON.parse(stdout);
          const replicas = deploy.status?.readyReplicas || 0;
          const desired = deploy.spec?.replicas || 1;
          const handle = await context.writeResource(
            "result",
            "operator-status",
            {
              success: replicas >= desired,
              message: `Operator: ${replicas}/${desired} ready`,
              timestamp: new Date().toISOString(),
            },
          );
          return { dataHandles: [handle] };
        } catch (e) {
          const handle = await context.writeResource(
            "result",
            "operator-status",
            {
              success: false,
              message: `Operator not found: ${
                e instanceof Error ? e.message : String(e)
              }`,
              timestamp: new Date().toISOString(),
            },
          );
          return { dataHandles: [handle] };
        }
      },
    },

    getFluxTenantsStatus: {
      description:
        "Check flux-tenants deployment state (hostNetwork, tolerations)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        try {
          const { stdout } = await kubectl(
            context.globalArgs,
            [
              "get",
              "deploy/flux-tenants",
              "-n",
              "cozy-fluxcd",
              "-o",
              "json",
            ],
            15000,
            2,
          );
          const deploy = JSON.parse(stdout);
          const podSpec = deploy.spec?.template?.spec || {};
          const hasHostNetwork = podSpec.hostNetwork === true;
          const tolerations = podSpec.tolerations || [];
          const hasNotReadyToleration = tolerations.some((t) =>
            t.key === "node.kubernetes.io/not-ready"
          );
          const hasCiliumToleration = tolerations.some((t) =>
            t.key === "node.cilium.io/agent-not-ready"
          );
          const replicas = deploy.status?.readyReplicas || 0;
          const desired = deploy.spec?.replicas || 1;

          const warnings: string[] = [];
          if (!hasHostNetwork) warnings.push("hostNetwork not set");
          if (!hasNotReadyToleration) {
            warnings.push("missing not-ready toleration");
          }
          if (!hasCiliumToleration) {
            warnings.push("missing cilium-agent-not-ready toleration");
          }

          const handle = await context.writeResource(
            "result",
            "flux-tenants-status",
            {
              success: replicas >= desired && hasHostNetwork &&
                hasNotReadyToleration,
              message:
                `flux-tenants: ${replicas}/${desired} ready, hostNetwork=${hasHostNetwork}`,
              warnings: warnings.length > 0 ? warnings : undefined,
              timestamp: new Date().toISOString(),
            },
          );
          return { dataHandles: [handle] };
        } catch (e) {
          const handle = await context.writeResource(
            "result",
            "flux-tenants-status",
            {
              success: false,
              message: `flux-tenants not found: ${
                e instanceof Error ? e.message : String(e)
              }`,
              timestamp: new Date().toISOString(),
            },
          );
          return { dataHandles: [handle] };
        }
      },
    },

    getNodePodCIDRs: {
      description: "Get current PodCIDR assignments on all nodes",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { stdout } = await kubectl(
          context.globalArgs,
          [
            "get",
            "nodes",
            "-o",
            "json",
          ],
          15000,
          2,
        );
        const nodes = JSON.parse(stdout);
        let allAssigned = true;
        const warnings: string[] = [];

        for (const node of nodes.items || []) {
          const name = node.metadata.name;
          const podCIDR = node.spec?.podCIDR || "";
          if (!podCIDR) {
            allAssigned = false;
            warnings.push(`${name}: no PodCIDR assigned`);
          }
        }

        const handle = await context.writeResource("result", "node-pod-cidrs", {
          success: allAssigned,
          message: allAssigned
            ? `All ${(nodes.items || []).length} nodes have PodCIDRs assigned`
            : `${warnings.length} nodes missing PodCIDRs`,
          warnings: warnings.length > 0 ? warnings : undefined,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    getPlatformPackage: {
      description: "Check if Platform Package CR exists and its status",
      arguments: z.object({}),
      execute: async (_args, context) => {
        try {
          const { stdout } = await kubectl(
            context.globalArgs,
            [
              "get",
              "packages.cozystack.io",
              "cozystack.cozystack-platform",
              "-o",
              "json",
            ],
            15000,
            2,
          );
          const pkg = JSON.parse(stdout);
          const conditions = pkg.status?.conditions;
          const ready = conditions?.find((c) => c.type === "Ready");
          const handle = await context.writeResource(
            "result",
            "platform-package-status",
            {
              success: ready?.status === "True",
              message: `Platform Package: variant=${
                pkg.spec?.variant || "unknown"
              }, ready=${ready?.status || "unknown"}`,
              warnings: ready?.status !== "True"
                ? [ready?.message || "Not ready"]
                : undefined,
              timestamp: new Date().toISOString(),
            },
          );
          return { dataHandles: [handle] };
        } catch (e) {
          const handle = await context.writeResource(
            "result",
            "platform-package-status",
            {
              success: false,
              message: `Platform Package not found: ${
                e instanceof Error ? e.message : String(e)
              }`,
              timestamp: new Date().toISOString(),
            },
          );
          return { dataHandles: [handle] };
        }
      },
    },

    listAppDefinitions: {
      description:
        "List available application definitions (what can be deployed)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { stdout } = await kubectl(
          context.globalArgs,
          [
            "get",
            "applicationdefinitions.cozystack.io",
            "-o",
            "json",
          ],
          30000,
          5,
        );
        const data = JSON.parse(stdout);
        const handles: unknown[] = [];
        for (const item of data.items || []) {
          const spec = item.spec || {};
          const app = spec.application || {};
          const dashboard = spec.dashboard || {};
          const handle = await context.writeResource(
            "appDef",
            app.kind || item.metadata.name,
            {
              name: item.metadata.name,
              kind: app.kind || item.metadata.name,
              plural: app.plural || "",
              singular: app.singular || "",
              category: dashboard.category,
              description: dashboard.description,
              timestamp: new Date().toISOString(),
            },
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    listApps: {
      description: "List application instances in a namespace (tenant)",
      arguments: z.object({
        namespace: z.string().describe("Namespace (tenant) to list apps in"),
        kind: z
          .string()
          .optional()
          .describe("Filter by app kind (e.g. Postgres, Kubernetes, Redis)"),
      }),
      execute: async (args, context) => {
        // First discover what API resources exist under apps.cozystack.io
        const { stdout: apiOut } = await kubectl(context.globalArgs, [
          "api-resources",
          "--api-group=apps.cozystack.io",
          "--no-headers",
          "-o",
          "name",
        ]);
        const resourceNames = apiOut
          .trim()
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => l.trim().split(".")[0]);

        if (resourceNames.length === 0) {
          throw new Error(
            "No apps.cozystack.io resources found. Is Cozystack installed?",
          );
        }

        const handles: unknown[] = [];
        const kindsToQuery = args.kind
          ? resourceNames.filter((r) =>
            r.toLowerCase().includes(args.kind.toLowerCase())
          )
          : resourceNames;

        for (const resource of kindsToQuery) {
          try {
            const { stdout } = await kubectl(context.globalArgs, [
              "get",
              `${resource}.apps.cozystack.io`,
              "-n",
              args.namespace,
              "-o",
              "json",
            ]);
            const data = JSON.parse(stdout);
            for (const item of data.items || []) {
              const conditions = item.status?.conditions;
              const handle = await context.writeResource(
                "app",
                `${resource}-${item.metadata.name}`,
                {
                  name: item.metadata.name,
                  namespace: item.metadata.namespace,
                  kind: item.kind || resource,
                  specJson: JSON.stringify(item.spec || {}),
                  ready: getCondition(conditions, "Ready"),
                  status: getConditionMessage(conditions, "Ready"),
                  age: parseAge(item.metadata.creationTimestamp),
                  timestamp: new Date().toISOString(),
                },
              );
              handles.push(handle);
            }
          } catch {
            // Some resources may not exist in this namespace
          }
        }
        return { dataHandles: handles };
      },
    },

    getApp: {
      description: "Get a specific application instance",
      arguments: z.object({
        namespace: z.string().describe("Namespace (tenant)"),
        kind: z.string().describe(
          "App kind (e.g. postgres, kubernetes, redis)",
        ),
        name: z.string().describe("App instance name"),
      }),
      execute: async (args, context) => {
        const { stdout } = await kubectl(context.globalArgs, [
          "get",
          `${args.kind}.apps.cozystack.io`,
          args.name,
          "-n",
          args.namespace,
          "-o",
          "json",
        ]);
        const item = JSON.parse(stdout);
        const conditions = item.status?.conditions;
        const handle = await context.writeResource(
          "app",
          `${args.kind}-${args.name}`,
          {
            name: item.metadata.name,
            namespace: item.metadata.namespace,
            kind: item.kind || args.kind,
            specJson: JSON.stringify(item.spec || {}),
            ready: getCondition(conditions, "Ready"),
            status: getConditionMessage(conditions, "Ready"),
            age: parseAge(item.metadata.creationTimestamp),
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    createApp: {
      description:
        "Create a Cozystack application (Kubernetes cluster, database, VM, etc.)",
      arguments: z.object({
        namespace: z.string().describe("Namespace (tenant) to deploy in"),
        kind: z.string().describe(
          "App kind (e.g. Postgres, Kubernetes, Redis, VirtualMachine)",
        ),
        name: z.string().describe("Name for the app instance"),
        specJson: z
          .string()
          .default("{}")
          .describe(
            "Spec as JSON string (app-specific values like replicas, size, version)",
          ),
      }),
      execute: async (args, context) => {
        const spec = JSON.parse(args.specJson);
        const manifest = JSON.stringify({
          apiVersion: "apps.cozystack.io/v1alpha1",
          kind: args.kind,
          metadata: {
            name: args.name,
            namespace: args.namespace,
          },
          spec,
        });

        const cmd = new Deno.Command("kubectl", {
          args: [
            "apply",
            "-f",
            "-",
            ...(context.globalArgs.kubeconfig
              ? ["--kubeconfig", context.globalArgs.kubeconfig]
              : []),
            ...(context.globalArgs.context
              ? ["--context", context.globalArgs.context]
              : []),
          ],
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        });
        const proc = cmd.spawn();
        const writer = proc.stdin.getWriter();
        await writer.write(new TextEncoder().encode(manifest));
        await writer.close();
        const output = await proc.output();
        const stdout = new TextDecoder().decode(output.stdout);
        const stderr = new TextDecoder().decode(output.stderr);

        if (!output.success) {
          throw new Error(
            `Failed to create ${args.kind}/${args.name}: ${stderr || stdout}`,
          );
        }

        const handle = await context.writeResource(
          "result",
          `create-${args.kind}-${args.name}`,
          {
            success: true,
            message: `Created ${args.kind}/${args.name} in ${args.namespace}`,
            warnings: stderr ? stderr.split("\n").filter((l) => l.trim()) : [],
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    deleteApp: {
      description: "Delete a Cozystack application instance",
      arguments: z.object({
        namespace: z.string().describe("Namespace (tenant)"),
        kind: z.string().describe("App kind (e.g. postgres, kubernetes)"),
        name: z.string().describe("App instance name"),
      }),
      execute: async (args, context) => {
        await kubectl(context.globalArgs, [
          "delete",
          `${args.kind}.apps.cozystack.io`,
          args.name,
          "-n",
          args.namespace,
        ], 60000);
        const handle = await context.writeResource(
          "result",
          `delete-${args.kind}-${args.name}`,
          {
            success: true,
            message: `Deleted ${args.kind}/${args.name} from ${args.namespace}`,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    listTenants: {
      description: "List Cozystack tenants",
      arguments: z.object({
        namespace: z
          .string()
          .default("tenant-root")
          .describe("Parent namespace (default: tenant-root)"),
      }),
      execute: async (args, context) => {
        const { stdout } = await kubectl(context.globalArgs, [
          "get",
          "tenants.apps.cozystack.io",
          "-n",
          args.namespace,
          "-o",
          "json",
        ]);
        const data = JSON.parse(stdout);
        const handles: unknown[] = [];
        for (const item of data.items || []) {
          const conditions = item.status?.conditions;
          const handle = await context.writeResource(
            "tenant",
            item.metadata.name,
            {
              name: item.metadata.name,
              namespace: item.metadata.namespace,
              host: item.spec?.host,
              ready: getCondition(conditions, "Ready"),
              timestamp: new Date().toISOString(),
            },
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    createTenant: {
      description: "Create a new Cozystack tenant",
      arguments: z.object({
        namespace: z
          .string()
          .default("tenant-root")
          .describe("Parent namespace"),
        name: z.string().describe("Tenant name"),
        host: z
          .string()
          .optional()
          .describe("Tenant host domain"),
      }),
      execute: async (args, context) => {
        const manifest = JSON.stringify({
          apiVersion: "apps.cozystack.io/v1alpha1",
          kind: "Tenant",
          metadata: {
            name: args.name,
            namespace: args.namespace,
          },
          spec: {
            ...(args.host ? { host: args.host } : {}),
          },
        });

        const cmd = new Deno.Command("kubectl", {
          args: [
            "apply",
            "-f",
            "-",
            ...(context.globalArgs.kubeconfig
              ? ["--kubeconfig", context.globalArgs.kubeconfig]
              : []),
            ...(context.globalArgs.context
              ? ["--context", context.globalArgs.context]
              : []),
          ],
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        });
        const proc = cmd.spawn();
        const writer = proc.stdin.getWriter();
        await writer.write(new TextEncoder().encode(manifest));
        await writer.close();
        const output = await proc.output();
        const stderr = new TextDecoder().decode(output.stderr);

        if (!output.success) {
          throw new Error(`Failed to create tenant ${args.name}: ${stderr}`);
        }

        const handle = await context.writeResource(
          "result",
          `create-tenant-${args.name}`,
          {
            success: true,
            message: `Created tenant ${args.name} in ${args.namespace}`,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    listPackages: {
      description: "List installed Cozystack platform packages",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const { stdout } = await kubectl(
          context.globalArgs,
          [
            "get",
            "packages.cozystack.io",
            "-A",
            "-o",
            "json",
          ],
          30000,
          5,
        );
        const data = JSON.parse(stdout);
        const handles: unknown[] = [];
        for (const item of data.items || []) {
          const conditions = item.status?.conditions;
          const handle = await context.writeResource(
            "package",
            item.metadata.name,
            {
              name: item.metadata.name,
              variant: item.spec?.variant,
              ready: getCondition(conditions, "Ready"),
              status: getConditionMessage(conditions, "Ready"),
              timestamp: new Date().toISOString(),
            },
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    listWorkloads: {
      description: "List workloads and their resource usage across namespaces",
      arguments: z.object({
        namespace: z
          .string()
          .optional()
          .describe("Namespace to filter (omit for all namespaces)"),
      }),
      execute: async (args, context) => {
        const nsArgs = args.namespace ? ["-n", args.namespace] : ["-A"];
        const { stdout } = await kubectl(context.globalArgs, [
          "get",
          "workloads.cozystack.io",
          ...nsArgs,
          "-o",
          "json",
        ]);
        const data = JSON.parse(stdout);
        const handles: unknown[] = [];
        for (const item of data.items || []) {
          const s = item.status || {};
          const handle = await context.writeResource(
            "workload",
            `${item.metadata.namespace}-${item.metadata.name}`,
            {
              name: item.metadata.name,
              namespace: item.metadata.namespace,
              kind: s.kind || "unknown",
              type: s.type,
              cpu: s.resources?.cpu,
              memory: s.resources?.memory,
              operational: s.operational,
              timestamp: new Date().toISOString(),
            },
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    getAppSecret: {
      description:
        "Get credentials/secrets for an application (e.g. database passwords)",
      arguments: z.object({
        namespace: z.string().describe("Namespace (tenant)"),
        name: z.string().describe("Secret name (usually matches app name)"),
      }),
      execute: async (args, context) => {
        const { stdout } = await kubectl(context.globalArgs, [
          "get",
          "secret",
          args.name,
          "-n",
          args.namespace,
          "-o",
          "json",
        ]);
        const secret = JSON.parse(stdout);
        const decoded: Record<string, string> = {};
        for (const [key, val] of Object.entries(secret.data || {})) {
          decoded[key] = atob(val as string);
        }
        const handle = await context.writeResource("secret", args.name, {
          name: secret.metadata.name,
          namespace: secret.metadata.namespace,
          dataJson: JSON.stringify(decoded),
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    getTenantKubeconfig: {
      description:
        "Get kubeconfig for a tenant (to access the tenant's Kubernetes API)",
      arguments: z.object({
        tenantNamespace: z
          .string()
          .describe("Tenant namespace (e.g. tenant-root, tenant-myteam)"),
        tenantName: z
          .string()
          .describe("Tenant name (usually matches the namespace suffix)"),
      }),
      execute: async (args, context) => {
        // Get the server URL from current config
        const { stdout: serverOut } = await kubectl(context.globalArgs, [
          "config",
          "view",
          "--minify",
          "-o",
          "jsonpath={.clusters[0].cluster.server}",
        ]);

        // Get the tenant secret
        const { stdout: secretOut } = await kubectl(context.globalArgs, [
          "get",
          "secret",
          args.tenantName,
          "-n",
          args.tenantNamespace,
          "-o",
          "json",
        ]);
        const secret = JSON.parse(secretOut);
        const token = atob(secret.data?.token || "");
        const caCrt = secret.data?.["ca.crt"] || "";
        const ns = atob(secret.data?.namespace || "");

        const kubeconfig = JSON.stringify(
          {
            apiVersion: "v1",
            kind: "Config",
            clusters: [{
              name: args.tenantName,
              cluster: {
                server: serverOut,
                "certificate-authority-data": caCrt,
              },
            }],
            contexts: [{
              name: args.tenantName,
              context: {
                cluster: args.tenantName,
                namespace: ns,
                user: args.tenantName,
              },
            }],
            "current-context": args.tenantName,
            users: [{
              name: args.tenantName,
              user: { token },
            }],
          },
          null,
          2,
        );

        const handle = await context.writeResource(
          "secret",
          `kubeconfig-${args.tenantName}`,
          {
            name: `kubeconfig-${args.tenantName}`,
            namespace: args.tenantNamespace,
            dataJson: JSON.stringify({ kubeconfig }),
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    updateApp: {
      description: "Update an existing Cozystack application spec",
      arguments: z.object({
        namespace: z.string().describe("Namespace (tenant)"),
        kind: z.string().describe("App kind (e.g. postgres, kubernetes)"),
        name: z.string().describe("App instance name"),
        specJson: z
          .string()
          .describe(
            "New spec fields as JSON string to merge (only provided fields are updated)",
          ),
      }),
      execute: async (args, context) => {
        const newFields = JSON.parse(args.specJson);
        // Get current state
        const { stdout: currentOut } = await kubectl(context.globalArgs, [
          "get",
          `${args.kind}.apps.cozystack.io`,
          args.name,
          "-n",
          args.namespace,
          "-o",
          "json",
        ]);
        const current = JSON.parse(currentOut);

        // Merge spec
        const mergedSpec = { ...(current.spec || {}), ...newFields };
        const manifest = JSON.stringify({
          apiVersion: current.apiVersion || "apps.cozystack.io/v1alpha1",
          kind: current.kind || args.kind,
          metadata: {
            name: args.name,
            namespace: args.namespace,
          },
          spec: mergedSpec,
        });

        const cmd = new Deno.Command("kubectl", {
          args: [
            "apply",
            "-f",
            "-",
            ...(context.globalArgs.kubeconfig
              ? ["--kubeconfig", context.globalArgs.kubeconfig]
              : []),
            ...(context.globalArgs.context
              ? ["--context", context.globalArgs.context]
              : []),
          ],
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        });
        const proc = cmd.spawn();
        const writer = proc.stdin.getWriter();
        await writer.write(new TextEncoder().encode(manifest));
        await writer.close();
        const output = await proc.output();
        const stderr = new TextDecoder().decode(output.stderr);

        if (!output.success) {
          throw new Error(
            `Failed to update ${args.kind}/${args.name}: ${stderr}`,
          );
        }

        const handle = await context.writeResource(
          "result",
          `update-${args.kind}-${args.name}`,
          {
            success: true,
            message: `Updated ${args.kind}/${args.name} in ${args.namespace}`,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    install: {
      description:
        "Install Cozystack operator via Helm and apply platform ConfigMap (idempotent)",
      arguments: z.object({
        version: z
          .string()
          .describe("Cozystack version to install (e.g., 0.31.0)"),
        platformConfigPath: z
          .string()
          .describe(
            "Path to the platform ConfigMap YAML file (e.g. cozystack-platform.yaml)",
          ),
        variant: z
          .string()
          .default("talos")
          .describe(
            "Operator variant: talos, generic, or hosted (default: talos)",
          ),
      }),
      execute: async (args, context) => {
        const kubeconfigArgs = [
          ...(context.globalArgs.kubeconfig
            ? ["--kubeconfig", context.globalArgs.kubeconfig]
            : []),
          ...(context.globalArgs.context
            ? ["--context", context.globalArgs.context]
            : []),
        ];

        const warnings: string[] = [];

        // 1. Install operator via Helm
        const helmArgs = [
          "upgrade",
          "--install",
          "cozystack",
          "oci://ghcr.io/cozystack/cozystack/cozy-installer",
          "--version",
          args.version,
          "--namespace",
          "cozy-system",
          "--create-namespace",
          "--set",
          `cozystackOperator.variant=${args.variant}`,
          ...kubeconfigArgs,
        ];
        context.logger.info(`helm ${helmArgs.join(" ")}`);

        const helmCmd = new Deno.Command("helm", {
          args: helmArgs,
          stdout: "piped",
          stderr: "piped",
        });
        const helmOutput = await helmCmd.output();
        const helmStdout = new TextDecoder().decode(helmOutput.stdout);
        const helmStderr = new TextDecoder().decode(helmOutput.stderr);
        if (!helmOutput.success) {
          throw new Error(
            `Helm install failed: ${helmStderr || helmStdout}`,
          );
        }
        context.logger.info(helmStdout || "Helm install completed");
        if (helmStderr.trim()) {
          warnings.push(
            ...helmStderr.split("\n").filter((l) => l.trim()),
          );
        }

        // 2. Apply platform ConfigMap
        const cfgCmd = new Deno.Command("kubectl", {
          args: ["apply", "-f", args.platformConfigPath, ...kubeconfigArgs],
          stdout: "piped",
          stderr: "piped",
        });
        const cfgOutput = await cfgCmd.output();
        const cfgStdout = new TextDecoder().decode(cfgOutput.stdout);
        const cfgStderr = new TextDecoder().decode(cfgOutput.stderr);
        if (!cfgOutput.success) {
          throw new Error(
            `Failed to apply platform config: ${cfgStderr || cfgStdout}`,
          );
        }
        if (cfgStderr.trim()) {
          warnings.push(
            ...cfgStderr.split("\n").filter((l) => l.trim()),
          );
        }

        const handle = await context.writeResource("result", "install", {
          success: true,
          message:
            "Cozystack operator installed via Helm and platform ConfigMap applied",
          warnings: warnings.length > 0 ? warnings : undefined,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    waitReady: {
      description: "Wait for Cozystack operator deployment to be ready",
      arguments: z.object({
        timeoutSeconds: z
          .number()
          .default(300)
          .describe("Timeout in seconds for rollout status (default: 300)"),
      }),
      execute: async (args, context) => {
        const { stdout, stderr } = await kubectl(
          context.globalArgs,
          [
            "-n",
            "cozy-system",
            "rollout",
            "status",
            "deploy/cozystack-operator",
            `--timeout=${args.timeoutSeconds}s`,
          ],
          (args.timeoutSeconds + 30) * 1000,
          2,
        );

        const warnings = stderr
          ? stderr.split("\n").filter((l) => l.trim())
          : [];

        const handle = await context.writeResource("result", "wait-ready", {
          success: true,
          message: stdout.trim() || "Cozystack operator deployment is ready",
          warnings: warnings.length > 0 ? warnings : undefined,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    applyPackage: {
      description:
        "Create or update the Platform Package CR that triggers full platform deployment",
      arguments: z.object({
        variant: z
          .string()
          .default("isp-full")
          .describe("Platform variant (default: isp-full)"),
        host: z.string().describe("Root host domain (e.g. cluster.example)"),
        apiServerEndpoint: z
          .string()
          .describe(
            "API server endpoint URL (e.g. https://192.0.2.10:6443)",
          ),
        podCIDR: z.string().default("10.244.0.0/16").describe("Pod CIDR"),
        podGateway: z.string().default("10.244.0.1").describe("Pod gateway"),
        serviceCIDR: z.string().default("10.96.0.0/16").describe(
          "Service CIDR",
        ),
        joinCIDR: z.string().default("100.64.0.0/16").describe("Join CIDR"),
        externalIPs: z
          .array(z.string())
          .optional()
          .describe("External IPs for service exposure"),
        exposedServices: z
          .array(z.string())
          .default(["dashboard", "api"])
          .describe("Services to expose (default: dashboard, api)"),
      }),
      execute: async (args, context) => {
        const manifest = {
          apiVersion: "cozystack.io/v1alpha1",
          kind: "Package",
          metadata: { name: "cozystack.cozystack-platform" },
          spec: {
            variant: args.variant,
            components: {
              platform: {
                values: {
                  publishing: {
                    host: args.host,
                    apiServerEndpoint: args.apiServerEndpoint,
                    exposedServices: args.exposedServices,
                    ...(args.externalIPs
                      ? { externalIPs: args.externalIPs }
                      : {}),
                  },
                  networking: {
                    podCIDR: args.podCIDR,
                    podGateway: args.podGateway,
                    serviceCIDR: args.serviceCIDR,
                    joinCIDR: args.joinCIDR,
                  },
                },
              },
            },
          },
        };

        const yamlContent = JSON.stringify(manifest);
        const cmd = new Deno.Command("kubectl", {
          args: [
            "apply",
            "-f",
            "-",
            ...(context.globalArgs.kubeconfig
              ? ["--kubeconfig", context.globalArgs.kubeconfig]
              : []),
            ...(context.globalArgs.context
              ? ["--context", context.globalArgs.context]
              : []),
          ],
          stdin: "piped",
          stdout: "piped",
          stderr: "piped",
        });
        const proc = cmd.spawn();
        const writer = proc.stdin.getWriter();
        await writer.write(new TextEncoder().encode(yamlContent));
        await writer.close();
        const output = await proc.output();
        const stdout = new TextDecoder().decode(output.stdout);
        const stderr = new TextDecoder().decode(output.stderr);
        if (!output.success) {
          throw new Error(
            `Failed to apply Platform Package: ${stderr || stdout}`,
          );
        }
        context.logger.info(stdout || "Platform Package applied");

        const handle = await context.writeResource("result", "apply-package", {
          success: true,
          message: `Platform Package applied with variant=${args.variant}`,
          timestamp: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    patchFluxTenants: {
      description:
        "Patch flux-tenants deployment with hostNetwork and tolerations for bootstrap (needed before CNI is ready)",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const patch = {
          spec: {
            template: {
              spec: {
                hostNetwork: true,
                tolerations: [
                  { key: "node.kubernetes.io/not-ready", operator: "Exists" },
                  { key: "node.kubernetes.io/unreachable", operator: "Exists" },
                  { key: "node.cilium.io/agent-not-ready", operator: "Exists" },
                  {
                    key: "node.cloudprovider.kubernetes.io/uninitialized",
                    operator: "Exists",
                  },
                ],
              },
            },
          },
        };

        await kubectl(
          context.globalArgs,
          [
            "patch",
            "deployment",
            "flux-tenants",
            "-n",
            "cozy-fluxcd",
            "--type=strategic",
            "-p",
            JSON.stringify(patch),
          ],
          30000,
          10,
          15000,
        );

        const handle = await context.writeResource(
          "result",
          "patch-flux-tenants",
          {
            success: true,
            message:
              "Patched flux-tenants with hostNetwork=true and bootstrap tolerations",
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    assignPodCIDRs: {
      description:
        "Assign PodCIDRs to nodes (needed for Cilium IPAM=kubernetes when allocate-node-cidrs=false)",
      arguments: z.object({
        podSubnet: z
          .string()
          .default("10.244.0.0/16")
          .describe("Pod subnet to allocate /24 blocks from"),
        nodeSubnetSize: z
          .number()
          .default(24)
          .describe("Subnet size for each node (default: /24)"),
      }),
      execute: async (args, context) => {
        // Get all nodes
        const { stdout } = await kubectl(
          context.globalArgs,
          ["get", "nodes", "-o", "json"],
          30000,
          3,
        );
        const nodes = JSON.parse(stdout);
        const warnings: string[] = [];
        let assigned = 0;

        // Parse base subnet
        const [baseIP] = args.podSubnet.split("/");
        const parts = baseIP.split(".").map(Number);

        for (let i = 0; i < (nodes.items || []).length; i++) {
          const node = nodes.items[i];
          if (node.spec.podCIDR) {
            context.logger.info(
              `Node ${node.metadata.name} already has podCIDR=${node.spec.podCIDR}, skipping`,
            );
            continue;
          }

          // Allocate /24 blocks: 10.244.0.0/24, 10.244.1.0/24, etc.
          const cidr = `${parts[0]}.${parts[1]}.${i}.0/${args.nodeSubnetSize}`;
          context.logger.info(`Assigning ${cidr} to ${node.metadata.name}`);

          try {
            await kubectl(
              context.globalArgs,
              [
                "patch",
                "node",
                node.metadata.name,
                "--type",
                "merge",
                "-p",
                JSON.stringify({
                  spec: { podCIDR: cidr, podCIDRs: [cidr] },
                }),
              ],
              30000,
            );
            assigned++;
          } catch (e) {
            warnings.push(
              `Failed to assign ${cidr} to ${node.metadata.name}: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
        }

        const handle = await context.writeResource(
          "result",
          "assign-pod-cidrs",
          {
            success: true,
            message: `Assigned PodCIDRs to ${assigned} nodes`,
            warnings: warnings.length > 0 ? warnings : undefined,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },

    listHelmReleases: {
      description: "List HelmRelease status across all namespaces",
      arguments: z.object({
        readyOnly: z.boolean().default(false).describe(
          "Only show ready releases",
        ),
        notReadyOnly: z.boolean().default(false).describe(
          "Only show not-ready releases",
        ),
      }),
      execute: async (args, context) => {
        const { stdout } = await kubectl(
          context.globalArgs,
          ["get", "helmreleases.helm.toolkit.fluxcd.io", "-A", "-o", "json"],
          30000,
          5,
        );
        const data = JSON.parse(stdout);
        const handles: unknown[] = [];
        let readyCount = 0;
        let totalCount = 0;

        for (const item of data.items || []) {
          totalCount++;
          const conditions = item.status?.conditions;
          const ready = getCondition(conditions, "Ready");
          const message = getConditionMessage(conditions, "Ready");

          if (ready === "True") readyCount++;
          if (args.readyOnly && ready !== "True") continue;
          if (args.notReadyOnly && ready === "True") continue;

          const handle = await context.writeResource(
            "result",
            `hr-${item.metadata.namespace}-${item.metadata.name}`,
            {
              success: ready === "True",
              message: `${item.metadata.namespace}/${item.metadata.name}: ${
                ready === "True" ? "Ready" : message || "Not ready"
              }`,
              timestamp: new Date().toISOString(),
            },
          );
          handles.push(handle);
        }

        context.logger.info(`HelmReleases: ${readyCount}/${totalCount} ready`);
        return { dataHandles: handles };
      },
    },

    configurePlatform: {
      description:
        "Idempotent platform configuration (enable ingress, monitoring, etcd on root tenant)",
      arguments: z.object({
        ingress: z
          .boolean()
          .default(true)
          .describe("Enable ingress (default: true)"),
        monitoring: z
          .boolean()
          .default(true)
          .describe("Enable monitoring (default: true)"),
        etcd: z
          .boolean()
          .default(true)
          .describe("Enable etcd (default: true)"),
        externalIPs: z
          .array(z.string())
          .optional()
          .describe("External IPs to set on the ingress service"),
      }),
      execute: async (args, context) => {
        const warnings: string[] = [];

        // Build the patch for the tenant resource
        const tenantPatch = {
          spec: {
            ingress: args.ingress,
            monitoring: args.monitoring,
            etcd: args.etcd,
          },
        };

        await kubectl(
          context.globalArgs,
          [
            "patch",
            "tenants.apps.cozystack.io",
            "root",
            "-n",
            "tenant-root",
            "--type=merge",
            "-p",
            JSON.stringify(tenantPatch),
          ],
          60000,
          2,
        );

        // If externalIPs provided, patch the ingress service
        if (args.externalIPs && args.externalIPs.length > 0) {
          const svcPatch = {
            spec: {
              externalIPs: args.externalIPs,
            },
          };

          try {
            await kubectl(
              context.globalArgs,
              [
                "patch",
                "svc",
                "ingress-nginx-controller",
                "-n",
                "cozy-ingress",
                "--type=merge",
                "-p",
                JSON.stringify(svcPatch),
              ],
              60000,
              2,
            );
          } catch (err) {
            warnings.push(
              `Failed to patch ingress service externalIPs: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }

        const features: string[] = [];
        if (args.ingress) features.push("ingress");
        if (args.monitoring) features.push("monitoring");
        if (args.etcd) features.push("etcd");

        const handle = await context.writeResource(
          "result",
          "configure-platform",
          {
            success: true,
            message: `Platform configured with: ${features.join(", ")}${
              args.externalIPs
                ? ` | externalIPs: ${args.externalIPs.join(", ")}`
                : ""
            }`,
            warnings: warnings.length > 0 ? warnings : undefined,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
