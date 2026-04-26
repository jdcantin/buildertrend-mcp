# Buildertrend MCP Server
### Solar Alternatives Inc. — Internal Tooling

An MCP server that gives Claude full read/write access to Buildertrend via AI-driven browser automation (Stagehand + Browserbase). No official API required.

---

## Tools

| Tool | Description |
|---|---|
| `bt_list_jobs` | List all jobs with status, address, dates |
| `bt_get_job` | Full job details + client info |
| `bt_create_job` | Create a new job |
| `bt_update_job_details` | Update any Job Details tab field |
| `bt_get_client_info` | Get client contacts for a job |
| `bt_update_client_info` | Update client contacts |
| `bt_list_daily_logs` | List daily logs with media flags |
| `bt_get_daily_log` | Full daily log with media URLs |
| `bt_get_media_urls` | All photo/video URLs for a job |
| `bt_list_reports` | List available reports |
| `bt_export_report` | Export a report (CSV/PDF) |
| `bt_export_all_jobs_data` | Full data dump of all jobs |
| `bt_search` | Global search across all data |
| `bt_get_session_status` | Check browser session health |
| `bt_reset_session` | Force re-login |

---

## Prerequisites

- Node.js 18+
- Browserbase account: [browserbase.com](https://browserbase.com)
- Buildertrend login credentials

---

## Environment Variables

Set these in Railway (never commit them):

```
BUILDERTREND_EMAIL=your@email.com
BUILDERTREND_PASSWORD=yourpassword
BROWSERBASE_API_KEY=bb_live_xxxx
BROWSERBASE_PROJECT_ID=your-project-id
```

---

## Deploy to Railway

1. Push this repo to GitHub
2. New Project → Deploy from GitHub repo
3. Add all 4 environment variables above
4. Railway sets `PORT` automatically → SSE/HTTP mode activates

### Connect to Claude Desktop

```json
{
  "mcpServers": {
    "buildertrend": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://YOUR-RAILWAY-URL.up.railway.app/mcp"
      ]
    }
  }
}
```

---

## How It Works

Stagehand maintains a **persistent logged-in browser session** in Browserbase. Each tool call navigates to the relevant Buildertrend page and uses AI to extract or update data using plain English instructions. The session auto-recovers if it expires.

This approach is resilient to Buildertrend UI changes because instructions like "click the Save button" don't rely on hardcoded CSS selectors.

---

## Notes

- First tool call will take ~10-15 seconds as Stagehand logs in
- Subsequent calls are fast (session stays warm)
- `bt_export_all_jobs_data` with client enrichment can take several minutes for large job lists — use `status_filter` to scope it down
- Media URLs from `bt_get_media_urls` are direct download links valid for the session duration
