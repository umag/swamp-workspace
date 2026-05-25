// FidoNet message display report
// Renders found messages in a readable format

/** Display report that renders FidoNet messages from search or area read results in a readable Markdown format. */
export const report = {
  name: "@magistr/fidonet-messages",
  description: "Display FidoNet messages from search or area read results",
  scope: "method" as const,
  labels: ["fidonet", "messages"],

  execute: async (context) => {
    const handles = context.dataHandles || [];
    let messagesData: Record<string, unknown> | null = null;

    for (const handle of handles) {
      if (handle.tags?.reportName) continue;

      let data: Record<string, unknown> | null = null;
      const pathCandidates = [
        handle.metadata?.path,
        handle.metadata?.rawPath,
      ].filter(Boolean);

      for (const p of pathCandidates) {
        try {
          const raw = await Deno.readTextFile(`${p}/raw`);
          data = JSON.parse(raw);
          break;
        } catch {
          try {
            const raw = await Deno.readTextFile(p as string);
            data = JSON.parse(raw);
            break;
          } catch { /* continue */ }
        }
      }

      if (!data) {
        try {
          const globBase =
            `${context.repoDir}/.swamp/data/@magistr/fidonet-msgbase/${context.modelId}/${handle.name}`;
          for await (const entry of Deno.readDir(globBase)) {
            if (entry.isDirectory) {
              try {
                const raw = await Deno.readTextFile(
                  `${globBase}/${entry.name}/raw`,
                );
                data = JSON.parse(raw);
              } catch { /* skip */ }
            }
          }
        } catch { /* skip */ }
      }

      if (data?.messages) {
        messagesData = data;
        break;
      }
    }

    if (!messagesData) {
      return {
        markdown: "# Messages\n\nNo messages found.\n",
        json: { count: 0, messages: [] },
      };
    }

    const messages = messagesData.messages as Array<Record<string, unknown>>;
    const query = messagesData.query as string | undefined;
    const area = messagesData.area as string | undefined;

    let md = "# FidoNet Messages\n\n";
    if (query) md += `**Query:** \`${query}\`\n\n`;
    if (area) md += `**Area:** ${area}\n\n`;
    md += `**${messages.length} messages found**\n\n---\n\n`;

    const jsonMessages: Array<Record<string, unknown>> = [];

    for (const m of messages) {
      const date = (m.date as string || "").slice(0, 10);
      const from = m.from as string || "?";
      const to = m.to as string || "?";
      const subject = m.subject as string || "(no subject)";
      const areaName = m.area as string || "";
      const address = m.address as string || "";
      const body = (m.body as string || "").trim();
      const origin = m.origin as string || "";

      // Clean body: strip kludges and trailing origin/tearline
      const cleanBody = body
        // deno-lint-ignore no-control-regex
        .replace(/^\x01[^\n]*\n/gm, "")
        .replace(/^---.*$/m, "")
        .replace(/^\* Origin:.*$/m, "")
        .replace(/^ *SEEN-BY:.*$/gm, "")
        .trim();

      md += `### ${subject}\n\n`;
      md += `**From:** ${from}`;
      if (address) md += ` (${address})`;
      md += ` **To:** ${to} **Date:** ${date}`;
      if (areaName) md += ` **Area:** ${areaName}`;
      md += "\n\n";
      md += `${cleanBody}\n\n`;
      if (origin) md += `> *Origin: ${origin}*\n\n`;
      md += "---\n\n";

      jsonMessages.push({
        date,
        from,
        to,
        subject,
        area: areaName,
        address,
        body: cleanBody,
        origin,
      });
    }

    return {
      markdown: md,
      json: { count: messages.length, query, area, messages: jsonMessages },
    };
  },
};
