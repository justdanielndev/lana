const declaration = {
    type: "function",
    function: {
        name: "get_coding_stats",
        description: "Get your daily coding time stats from HackaTime for a specific date range. Returns project breakdown and daily average.",
        parameters: {
            type: "object",
            properties: {
                start_date: { type: "string", description: "Start date in YYYY-MM-DD format (optional)" },
                end_date: { type: "string", description: "End date in YYYY-MM-DD format (optional)" }
            },
            required: []
        }
    }
};

async function run({ toolInput, deps }) {
    const stats = await deps.getCodingStats(toolInput.start_date, toolInput.end_date);

    const topProjects = stats.projects
        ? stats.projects.slice(0, 5).map((p) =>
            `• ${p.name}: ${p.text} (${p.percent.toFixed(1)}%)`
        ).join('\n')
        : 'No project data available';

    const message = `Coding Stats\n\n` +
        `Total: ${stats.human_readable_total}\n` +
        `Daily Avg: ${stats.human_readable_daily_average}\n\n` +
        `Top Projects:\n${topProjects}`;

    return { success: true, message };
}

module.exports = {
    declaration,
    run
};
