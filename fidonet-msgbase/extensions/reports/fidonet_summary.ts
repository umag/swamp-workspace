// FidoNet message base summary report
// Produces area stats, top senders, date range, and message breakdown

/** Summary report over FidoNet message base results: area stats, top senders, date range, and monthly distribution. */
export const report = {
  name: "@magistr/fidonet-summary",
  description:
    "Summarize FidoNet message base results — top senders, areas, date distribution",
  scope: "method" as const,
  labels: ["fidonet", "summary"],

  execute: async (context) => {
    // Read data from the method execution
    const handles = context.dataHandles || [];
    if (handles.length === 0) {
      return {
        markdown: "# FidoNet Summary\n\nNo data produced by this execution.\n",
        json: { empty: true },
      };
    }

    // Find the messages data handle (skip report handles)
    let messagesData: Record<string, unknown> | null = null;
    let areasData: Record<string, unknown> | null = null;

    for (const handle of handles) {
      if (handle.tags?.reportName) continue;
      // Try reading from the data path on disk
      const pathCandidates = [
        handle.metadata?.path,
        handle.metadata?.rawPath,
      ].filter(Boolean);

      let data: Record<string, unknown> | null = null;

      // Try reading raw file from the path
      for (const p of pathCandidates) {
        try {
          const rawPath = `${p}/raw`;
          const raw = await Deno.readTextFile(rawPath);
          data = JSON.parse(raw);
          break;
        } catch {
          try {
            const raw = await Deno.readTextFile(p as string);
            data = JSON.parse(raw);
            break;
          } catch {
            // continue
          }
        }
      }

      // Fallback: scan data directory by model ID and handle name
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
              } catch {
                // skip
              }
            }
          }
        } catch {
          // directory doesn't exist
        }
      }

      if (data) {
        if (data.areas) areasData = data;
        if (data.messages) messagesData = data;
      }
    }

    // Handle listAreas output
    if (areasData) {
      const areas = areasData.areas as Array<Record<string, unknown>>;
      const totalMessages = areasData.totalMessages as number;
      const jamAreas = areas.filter((a) => a.format === "jam");
      const squishAreas = areas.filter((a) => a.format === "squish");

      const top10 = areas.slice(0, 10);

      let md = "# FidoNet Message Base Summary\n\n";
      md += `| Metric | Value |\n|--------|-------|\n`;
      md += `| Total areas | ${areas.length} |\n`;
      md += `| JAM areas | ${jamAreas.length} |\n`;
      md += `| Squish areas | ${squishAreas.length} |\n`;
      md += `| Total messages | ${totalMessages.toLocaleString()} |\n\n`;

      md += "## Top 10 Areas by Message Count\n\n";
      md += "| Area | Format | Messages |\n|------|--------|----------|\n";
      for (const a of top10) {
        md += `| ${a.name} | ${a.format} | ${
          (a.activeMessages as number).toLocaleString()
        } |\n`;
      }

      const json = {
        totalAreas: areas.length,
        jamAreas: jamAreas.length,
        squishAreas: squishAreas.length,
        totalMessages,
        top10: top10.map((a) => ({
          name: a.name,
          format: a.format,
          messages: a.activeMessages,
        })),
      };

      return { markdown: md, json };
    }

    // Handle messages output (readArea, searchBySender, searchByText)
    if (messagesData) {
      const messages = messagesData.messages as Array<
        Record<string, unknown>
      >;
      const query = messagesData.query as string | undefined;
      const area = messagesData.area as string | undefined;
      const count = messages.length;

      if (count === 0) {
        return {
          markdown: "# FidoNet Summary\n\nNo messages found.\n",
          json: { count: 0 },
        };
      }

      // Aggregate senders
      const senderCounts: Record<string, number> = {};
      for (const m of messages) {
        const from = m.from as string;
        senderCounts[from] = (senderCounts[from] || 0) + 1;
      }
      const topSenders = Object.entries(senderCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15);

      // Aggregate areas
      const areaCounts: Record<string, number> = {};
      for (const m of messages) {
        const a = m.area as string;
        areaCounts[a] = (areaCounts[a] || 0) + 1;
      }
      const topAreas = Object.entries(areaCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

      // Date range
      const timestamps = messages
        .map((m) => m.timestamp as number)
        .filter((t) => t > 0)
        .sort((a, b) => a - b);
      const earliest = timestamps.length > 0
        ? new Date(timestamps[0] * 1000).toISOString().split("T")[0]
        : "N/A";
      const latest = timestamps.length > 0
        ? new Date(timestamps[timestamps.length - 1] * 1000)
          .toISOString()
          .split("T")[0]
        : "N/A";

      // Monthly distribution
      const monthCounts: Record<string, number> = {};
      for (const t of timestamps) {
        const d = new Date(t * 1000);
        const key = `${d.getFullYear()}-${
          String(d.getMonth() + 1).padStart(2, "0")
        }`;
        monthCounts[key] = (monthCounts[key] || 0) + 1;
      }
      const months = Object.entries(monthCounts).sort((a, b) =>
        a[0].localeCompare(b[0])
      );

      // Build markdown
      let md = "# FidoNet Message Summary\n\n";
      if (query) md += `**Query:** \`${query}\`\n\n`;
      if (area) md += `**Area:** ${area}\n\n`;

      md += `| Metric | Value |\n|--------|-------|\n`;
      md += `| Messages | ${count} |\n`;
      md += `| Unique senders | ${Object.keys(senderCounts).length} |\n`;
      md += `| Areas | ${Object.keys(areaCounts).length} |\n`;
      md += `| Date range | ${earliest} — ${latest} |\n\n`;

      md += "## Top Senders\n\n";
      md += "| Sender | Messages |\n|--------|----------|\n";
      for (const [name, cnt] of topSenders) {
        md += `| ${name} | ${cnt} |\n`;
      }

      if (topAreas.length > 1) {
        md += "\n## Areas\n\n";
        md += "| Area | Messages |\n|------|----------|\n";
        for (const [name, cnt] of topAreas) {
          md += `| ${name} | ${cnt} |\n`;
        }
      }

      if (months.length > 1) {
        md += "\n## Monthly Distribution\n\n";
        md += "| Month | Messages |\n|-------|----------|\n";
        for (const [month, cnt] of months) {
          md += `| ${month} | ${cnt} |\n`;
        }
      }

      const json = {
        count,
        query,
        area,
        uniqueSenders: Object.keys(senderCounts).length,
        dateRange: { earliest, latest },
        topSenders: Object.fromEntries(topSenders),
        areaCounts,
        monthlyDistribution: monthCounts,
      };

      return { markdown: md, json };
    }

    return {
      markdown: "# FidoNet Summary\n\nUnrecognized data format.\n",
      json: { error: "unrecognized data" },
    };
  },
};
