import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Stagehand } from "@browserbasehq/stagehand";
import { z } from "zod";
import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";

// ── Configuration ─────────────────────────────────────────────────────────────
const BT_EMAIL    = process.env.BUILDERTREND_EMAIL    || "";
const BT_PASSWORD = process.env.BUILDERTREND_PASSWORD || "";
const BB_API_KEY  = process.env.BROWSERBASE_API_KEY   || "";
const BB_PROJECT  = process.env.BROWSERBASE_PROJECT_ID || "";
const BT_BASE     = "https://buildertrend.net";

// ── Session management ────────────────────────────────────────────────────────
// We maintain a single long-lived Stagehand session so we don't re-login
// on every tool call. Session is lazily initialized on first use.
let _stagehand = null;
let _loggedIn  = false;

async function getSession() {
  if (_stagehand && _loggedIn) return _stagehand;

  console.error("[BT] Starting new Browserbase session...");
  _stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey: BB_API_KEY,
    projectId: BB_PROJECT,
    modelName: "anthropic/claude-sonnet-4-6",
    verbose: 0,
  });

  await _stagehand.init();
  await login(_stagehand);
  _loggedIn = true;
  console.error("[BT] Session ready.");
  return _stagehand;
}

async function login(sh) {
  console.error("[BT] Logging in...");
  const page = sh.page;
  await page.goto(`${BT_BASE}/login`);
  await page.act(`type "${BT_EMAIL}" into the email field`);
  await page.act(`type "${BT_PASSWORD}" into the password field`);
  await page.act("click the sign in or log in button");
  await page.waitForLoadState("networkidle");
  console.error("[BT] Login complete.");
}

// ── Helper: navigate with session recovery ────────────────────────────────────
async function withBT(fn) {
  try {
    const sh = await getSession();
    return await fn(sh);
  } catch (err) {
    // If session expired, reset and retry once
    if (err.message?.includes("session") || err.message?.includes("login")) {
      console.error("[BT] Session expired, resetting...");
      _stagehand = null;
      _loggedIn = false;
      const sh = await getSession();
      return await fn(sh);
    }
    throw err;
  }
}

// ── Tool definitions ──────────────────────────────────────────────────────────
const TOOLS = [

  // ── JOBS ───────────────────────────────────────────────────────────────────
  {
    name: "bt_list_jobs",
    description: "List all jobs/projects in Buildertrend. Returns job names, IDs, status, and addresses.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter by status: active, completed, lead, etc." },
        search: { type: "string", description: "Search term to filter jobs by name or address" },
        limit:  { type: "number", description: "Max number of jobs to return (default 50)" },
      },
    },
  },
  {
    name: "bt_get_job",
    description: "Get full details of a single job including all Job Details and Clients tab fields.",
    inputSchema: {
      type: "object",
      properties: {
        job_name: { type: "string", description: "Job name or partial name to identify the job" },
        job_id:   { type: "string", description: "Buildertrend job ID if known" },
      },
    },
  },
  {
    name: "bt_create_job",
    description: "Create a new job in Buildertrend.",
    inputSchema: {
      type: "object",
      properties: {
        job_name:      { type: "string", description: "Name of the job" },
        address:       { type: "string", description: "Job site address" },
        city:          { type: "string" },
        state:         { type: "string" },
        zip:           { type: "string" },
        client_name:   { type: "string", description: "Primary client name" },
        client_email:  { type: "string" },
        client_phone:  { type: "string" },
        start_date:    { type: "string", description: "Projected start date MM/DD/YYYY" },
        completion_date: { type: "string", description: "Projected completion date MM/DD/YYYY" },
        description:   { type: "string", description: "Job description or notes" },
        template:      { type: "string", description: "Template name to apply if any" },
      },
      required: ["job_name"],
    },
  },
  {
    name: "bt_update_job_details",
    description: "Update job details tab fields for an existing job (dates, address, status, description, etc).",
    inputSchema: {
      type: "object",
      properties: {
        job_name:         { type: "string", description: "Job name to identify the job" },
        job_id:           { type: "string" },
        status:           { type: "string", description: "Job status to set" },
        start_date:       { type: "string", description: "MM/DD/YYYY" },
        completion_date:  { type: "string", description: "MM/DD/YYYY" },
        address:          { type: "string" },
        city:             { type: "string" },
        state:            { type: "string" },
        zip:              { type: "string" },
        description:      { type: "string" },
        custom_fields:    { type: "object", description: "Any custom field names and values as key-value pairs" },
      },
      required: ["job_name"],
    },
  },

  // ── CLIENTS ────────────────────────────────────────────────────────────────
  {
    name: "bt_get_client_info",
    description: "Get client/homeowner contact information for a job.",
    inputSchema: {
      type: "object",
      properties: {
        job_name: { type: "string" },
        job_id:   { type: "string" },
      },
    },
  },
  {
    name: "bt_update_client_info",
    description: "Update client contact information on a job's Clients tab.",
    inputSchema: {
      type: "object",
      properties: {
        job_name:      { type: "string" },
        job_id:        { type: "string" },
        first_name:    { type: "string" },
        last_name:     { type: "string" },
        email:         { type: "string" },
        phone:         { type: "string" },
        alt_phone:     { type: "string" },
        mailing_address: { type: "string" },
        notes:         { type: "string" },
      },
      required: ["job_name"],
    },
  },

  // ── DAILY LOGS ─────────────────────────────────────────────────────────────
  {
    name: "bt_list_daily_logs",
    description: "List all daily logs for a job, including notes, weather, crew, and media attachments.",
    inputSchema: {
      type: "object",
      properties: {
        job_name:   { type: "string" },
        job_id:     { type: "string" },
        start_date: { type: "string", description: "Filter from date MM/DD/YYYY" },
        end_date:   { type: "string", description: "Filter to date MM/DD/YYYY" },
      },
    },
  },
  {
    name: "bt_get_daily_log",
    description: "Get a specific daily log entry with full details and list of media files.",
    inputSchema: {
      type: "object",
      properties: {
        job_name: { type: "string" },
        log_date: { type: "string", description: "Date of the log MM/DD/YYYY" },
        log_id:   { type: "string" },
      },
    },
  },
  {
    name: "bt_get_media_urls",
    description: "Get download URLs for all photos and videos from a daily log or job.",
    inputSchema: {
      type: "object",
      properties: {
        job_name: { type: "string" },
        job_id:   { type: "string" },
        log_date: { type: "string", description: "Specific date to get media from. Omit for all job media." },
      },
    },
  },

  // ── REPORTS & EXPORTS ──────────────────────────────────────────────────────
  {
    name: "bt_list_reports",
    description: "List available reports in Buildertrend for a job or globally.",
    inputSchema: {
      type: "object",
      properties: {
        job_name: { type: "string", description: "Scope to a specific job, or omit for all reports" },
        category: { type: "string", description: "Report category: financial, schedule, budget, etc." },
      },
    },
  },
  {
    name: "bt_export_report",
    description: "Export a report from Buildertrend and return its data or download link.",
    inputSchema: {
      type: "object",
      properties: {
        report_name: { type: "string", description: "Name of the report to export" },
        job_name:    { type: "string", description: "Job to scope the report to if applicable" },
        format:      { type: "string", description: "Export format: pdf, csv, excel (default csv)" },
        date_range:  { type: "string", description: "Date range: this_month, last_month, this_year, custom" },
        start_date:  { type: "string", description: "Custom start date MM/DD/YYYY" },
        end_date:    { type: "string", description: "Custom end date MM/DD/YYYY" },
      },
      required: ["report_name"],
    },
  },
  {
    name: "bt_export_all_jobs_data",
    description: "Export a full data dump of all jobs with key fields for migration or sync to another system.",
    inputSchema: {
      type: "object",
      properties: {
        include_clients:    { type: "boolean", description: "Include client contact info (default true)" },
        include_financials: { type: "boolean", description: "Include budget/financial summary (default false)" },
        include_schedule:   { type: "boolean", description: "Include schedule dates (default false)" },
        status_filter:      { type: "string",  description: "Only export jobs with this status" },
      },
    },
  },

  // ── UTILITY ────────────────────────────────────────────────────────────────
  {
    name: "bt_search",
    description: "Search across all Buildertrend data — jobs, clients, documents — by keyword.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term" },
      },
      required: ["query"],
    },
  },
  {
    name: "bt_get_session_status",
    description: "Check if the Buildertrend browser session is active and logged in.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "bt_reset_session",
    description: "Force a fresh login to Buildertrend. Use if you get authentication errors.",
    inputSchema: { type: "object", properties: {} },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────
async function handleTool(name, args) {
  // Non-browser tools
  if (name === "bt_get_session_status") {
    return { active: _loggedIn, hasSession: !!_stagehand };
  }
  if (name === "bt_reset_session") {
    _stagehand = null;
    _loggedIn = false;
    await getSession();
    return { success: true, message: "Session reset and re-authenticated." };
  }

  return withBT(async (sh) => {
    const page = sh.page;

    switch (name) {

      // ── LIST JOBS ───────────────────────────────────────────────────────────
      case "bt_list_jobs": {
        await page.goto(`${BT_BASE}/app/jobs`);
        await page.waitForLoadState("networkidle");
        if (args.search) await page.act(`search for "${args.search}" in the jobs search box`);
        if (args.status) await page.act(`filter jobs by status "${args.status}"`);
        const jobs = await page.extract({
          instruction: "extract a list of all visible jobs with their name, ID or URL, status, address, and start date",
          schema: z.object({
            jobs: z.array(z.object({
              name:       z.string(),
              id:         z.string().optional(),
              status:     z.string().optional(),
              address:    z.string().optional(),
              start_date: z.string().optional(),
            }))
          }),
        });
        return jobs;
      }

      // ── GET JOB ─────────────────────────────────────────────────────────────
      case "bt_get_job": {
        if (args.job_id) {
          await page.goto(`${BT_BASE}/app/jobs/${args.job_id}/details`);
        } else {
          await page.goto(`${BT_BASE}/app/jobs`);
          await page.act(`search for and click on the job named "${args.job_name}"`);
          await page.act("click on the Job Details tab");
        }
        await page.waitForLoadState("networkidle");
        const details = await page.extract({
          instruction: "extract ALL fields visible on the Job Details tab including job name, address, dates, status, description, and any custom fields",
          schema: z.object({
            job_name:         z.string().optional(),
            job_id:           z.string().optional(),
            status:           z.string().optional(),
            address:          z.string().optional(),
            city:             z.string().optional(),
            state:            z.string().optional(),
            zip:              z.string().optional(),
            start_date:       z.string().optional(),
            completion_date:  z.string().optional(),
            description:      z.string().optional(),
            custom_fields:    z.record(z.string()).optional(),
          }),
        });
        // Also grab clients tab
        await page.act("click on the Clients tab");
        await page.waitForLoadState("networkidle");
        const clients = await page.extract({
          instruction: "extract all client contact information including names, emails, phones, and addresses",
          schema: z.object({
            clients: z.array(z.object({
              name:    z.string().optional(),
              email:   z.string().optional(),
              phone:   z.string().optional(),
              address: z.string().optional(),
            })).optional(),
          }),
        });
        return { ...details, ...clients };
      }

      // ── CREATE JOB ──────────────────────────────────────────────────────────
      case "bt_create_job": {
        await page.goto(`${BT_BASE}/app/jobs/new`);
        await page.waitForLoadState("networkidle");
        if (args.template) await page.act(`select the template "${args.template}"`);
        await page.act(`fill in the job name as "${args.job_name}"`);
        if (args.address)    await page.act(`enter the address "${args.address}"`);
        if (args.city)       await page.act(`enter the city "${args.city}"`);
        if (args.state)      await page.act(`enter the state "${args.state}"`);
        if (args.zip)        await page.act(`enter the zip code "${args.zip}"`);
        if (args.start_date) await page.act(`set the start date to "${args.start_date}"`);
        if (args.completion_date) await page.act(`set the projected completion date to "${args.completion_date}"`);
        if (args.description) await page.act(`enter the description "${args.description}"`);
        if (args.client_name) {
          await page.act("click on the Clients tab or Add Client button");
          await page.act(`enter client name "${args.client_name}"`);
          if (args.client_email) await page.act(`enter client email "${args.client_email}"`);
          if (args.client_phone) await page.act(`enter client phone "${args.client_phone}"`);
        }
        await page.act("click the Save or Create Job button");
        await page.waitForLoadState("networkidle");
        const result = await page.extract({
          instruction: "extract the new job ID or URL and confirmation that the job was created",
          schema: z.object({
            success: z.boolean(),
            job_id:  z.string().optional(),
            message: z.string().optional(),
          }),
        });
        return result;
      }

      // ── UPDATE JOB DETAILS ──────────────────────────────────────────────────
      case "bt_update_job_details": {
        if (args.job_id) {
          await page.goto(`${BT_BASE}/app/jobs/${args.job_id}/details`);
        } else {
          await page.goto(`${BT_BASE}/app/jobs`);
          await page.act(`search for and open the job named "${args.job_name}"`);
          await page.act("click the Job Details tab");
        }
        await page.waitForLoadState("networkidle");
        await page.act("click Edit or the edit pencil icon to enable editing");
        if (args.status)          await page.act(`change the status to "${args.status}"`);
        if (args.start_date)      await page.act(`set the start date to "${args.start_date}"`);
        if (args.completion_date) await page.act(`set the completion date to "${args.completion_date}"`);
        if (args.address)         await page.act(`update the address to "${args.address}"`);
        if (args.city)            await page.act(`update the city to "${args.city}"`);
        if (args.state)           await page.act(`update the state to "${args.state}"`);
        if (args.zip)             await page.act(`update the zip to "${args.zip}"`);
        if (args.description)     await page.act(`update the description to "${args.description}"`);
        if (args.custom_fields) {
          for (const [field, value] of Object.entries(args.custom_fields)) {
            await page.act(`set the field "${field}" to "${value}"`);
          }
        }
        await page.act("click Save to save the changes");
        await page.waitForLoadState("networkidle");
        return { success: true, message: `Job "${args.job_name}" details updated.` };
      }

      // ── GET CLIENT INFO ─────────────────────────────────────────────────────
      case "bt_get_client_info": {
        if (args.job_id) {
          await page.goto(`${BT_BASE}/app/jobs/${args.job_id}/clients`);
        } else {
          await page.goto(`${BT_BASE}/app/jobs`);
          await page.act(`search for and open the job named "${args.job_name}"`);
          await page.act("click the Clients tab");
        }
        await page.waitForLoadState("networkidle");
        return await page.extract({
          instruction: "extract all client information including names, emails, phone numbers, mailing addresses, and any notes",
          schema: z.object({
            clients: z.array(z.object({
              first_name: z.string().optional(),
              last_name:  z.string().optional(),
              email:      z.string().optional(),
              phone:      z.string().optional(),
              alt_phone:  z.string().optional(),
              address:    z.string().optional(),
              notes:      z.string().optional(),
            })),
          }),
        });
      }

      // ── UPDATE CLIENT INFO ──────────────────────────────────────────────────
      case "bt_update_client_info": {
        if (args.job_id) {
          await page.goto(`${BT_BASE}/app/jobs/${args.job_id}/clients`);
        } else {
          await page.goto(`${BT_BASE}/app/jobs`);
          await page.act(`search for and open the job named "${args.job_name}"`);
          await page.act("click the Clients tab");
        }
        await page.waitForLoadState("networkidle");
        await page.act("click Edit on the client record");
        if (args.first_name) await page.act(`set first name to "${args.first_name}"`);
        if (args.last_name)  await page.act(`set last name to "${args.last_name}"`);
        if (args.email)      await page.act(`set email to "${args.email}"`);
        if (args.phone)      await page.act(`set phone to "${args.phone}"`);
        if (args.alt_phone)  await page.act(`set alternate phone to "${args.alt_phone}"`);
        if (args.mailing_address) await page.act(`set mailing address to "${args.mailing_address}"`);
        if (args.notes)      await page.act(`set notes to "${args.notes}"`);
        await page.act("click Save");
        await page.waitForLoadState("networkidle");
        return { success: true, message: "Client info updated." };
      }

      // ── LIST DAILY LOGS ─────────────────────────────────────────────────────
      case "bt_list_daily_logs": {
        if (args.job_id) {
          await page.goto(`${BT_BASE}/app/jobs/${args.job_id}/daily-logs`);
        } else {
          await page.goto(`${BT_BASE}/app/jobs`);
          await page.act(`search for and open the job named "${args.job_name}"`);
          await page.act("click on Daily Logs in the navigation");
        }
        await page.waitForLoadState("networkidle");
        if (args.start_date) await page.act(`filter daily logs from "${args.start_date}"`);
        if (args.end_date)   await page.act(`filter daily logs to "${args.end_date}"`);
        return await page.extract({
          instruction: "extract all daily log entries with their date, author, weather, notes summary, and whether they have photos or videos attached",
          schema: z.object({
            logs: z.array(z.object({
              date:        z.string(),
              author:      z.string().optional(),
              weather:     z.string().optional(),
              notes:       z.string().optional(),
              has_media:   z.boolean().optional(),
              media_count: z.number().optional(),
            })),
          }),
        });
      }

      // ── GET DAILY LOG ───────────────────────────────────────────────────────
      case "bt_get_daily_log": {
        if (args.log_id) {
          await page.goto(`${BT_BASE}/app/daily-logs/${args.log_id}`);
        } else {
          await page.goto(`${BT_BASE}/app/jobs`);
          await page.act(`open the job named "${args.job_name}"`);
          await page.act("click on Daily Logs");
          await page.act(`click on the daily log for ${args.log_date}`);
        }
        await page.waitForLoadState("networkidle");
        return await page.extract({
          instruction: "extract all fields from this daily log including date, weather, crew members, hours worked, equipment, notes, and a list of all photo and video filenames or URLs",
          schema: z.object({
            date:          z.string().optional(),
            weather:       z.string().optional(),
            crew:          z.array(z.string()).optional(),
            hours_worked:  z.number().optional(),
            equipment:     z.array(z.string()).optional(),
            notes:         z.string().optional(),
            media:         z.array(z.object({
              filename: z.string().optional(),
              url:      z.string().optional(),
              type:     z.string().optional(),
            })).optional(),
          }),
        });
      }

      // ── GET MEDIA URLS ──────────────────────────────────────────────────────
      case "bt_get_media_urls": {
        if (args.job_id) {
          await page.goto(`${BT_BASE}/app/jobs/${args.job_id}/photos`);
        } else {
          await page.goto(`${BT_BASE}/app/jobs`);
          await page.act(`open the job named "${args.job_name}"`);
          await page.act("click on Photos or Media in the navigation");
        }
        await page.waitForLoadState("networkidle");
        if (args.log_date) await page.act(`filter media to the date ${args.log_date}`);
        return await page.extract({
          instruction: "extract all photo and video URLs, filenames, dates, and captions visible on this page",
          schema: z.object({
            media: z.array(z.object({
              url:      z.string(),
              filename: z.string().optional(),
              date:     z.string().optional(),
              caption:  z.string().optional(),
              type:     z.enum(["photo", "video", "document"]).optional(),
            })),
          }),
        });
      }

      // ── LIST REPORTS ────────────────────────────────────────────────────────
      case "bt_list_reports": {
        await page.goto(`${BT_BASE}/app/reports`);
        await page.waitForLoadState("networkidle");
        if (args.category) await page.act(`click on the "${args.category}" report category`);
        return await page.extract({
          instruction: "extract all available report names and their categories",
          schema: z.object({
            reports: z.array(z.object({
              name:     z.string(),
              category: z.string().optional(),
            })),
          }),
        });
      }

      // ── EXPORT REPORT ───────────────────────────────────────────────────────
      case "bt_export_report": {
        await page.goto(`${BT_BASE}/app/reports`);
        await page.waitForLoadState("networkidle");
        if (args.job_name) await page.act(`select the job "${args.job_name}"`);
        await page.act(`find and click on the report named "${args.report_name}"`);
        await page.waitForLoadState("networkidle");
        if (args.date_range) await page.act(`set date range to "${args.date_range}"`);
        if (args.start_date) await page.act(`set start date to "${args.start_date}"`);
        if (args.end_date)   await page.act(`set end date to "${args.end_date}"`);
        const fmt = args.format || "csv";
        await page.act(`export or download the report as ${fmt}`);
        await page.waitForLoadState("networkidle");
        const result = await page.extract({
          instruction: "extract any download link, exported data visible on screen, or confirmation message",
          schema: z.object({
            download_url: z.string().optional(),
            data:         z.string().optional(),
            message:      z.string().optional(),
          }),
        });
        return result;
      }

      // ── EXPORT ALL JOBS DATA ─────────────────────────────────────────────────
      case "bt_export_all_jobs_data": {
        await page.goto(`${BT_BASE}/app/jobs`);
        await page.waitForLoadState("networkidle");
        if (args.status_filter) await page.act(`filter jobs by status "${args.status_filter}"`);
        // Get job list first
        const { jobs } = await page.extract({
          instruction: "extract all visible jobs with name, ID, status, address, start date, and completion date",
          schema: z.object({
            jobs: z.array(z.object({
              name:            z.string(),
              id:              z.string().optional(),
              status:          z.string().optional(),
              address:         z.string().optional(),
              start_date:      z.string().optional(),
              completion_date: z.string().optional(),
            })),
          }),
        });
        // Enrich with client data if requested
        const enriched = [];
        const includeClients = args.include_clients !== false;
        for (const job of (jobs || []).slice(0, 100)) {
          const entry = { ...job };
          if (includeClients && job.id) {
            try {
              await page.goto(`${BT_BASE}/app/jobs/${job.id}/clients`);
              await page.waitForLoadState("networkidle");
              const clients = await page.extract({
                instruction: "extract primary client name, email, and phone",
                schema: z.object({
                  client_name:  z.string().optional(),
                  client_email: z.string().optional(),
                  client_phone: z.string().optional(),
                }),
              });
              Object.assign(entry, clients);
            } catch (_) { /* skip if client tab fails */ }
          }
          enriched.push(entry);
        }
        return { total: enriched.length, jobs: enriched };
      }

      // ── SEARCH ──────────────────────────────────────────────────────────────
      case "bt_search": {
        await page.goto(`${BT_BASE}/app`);
        await page.act(`use the global search to search for "${args.query}"`);
        await page.waitForLoadState("networkidle");
        return await page.extract({
          instruction: "extract all search results with their type (job, client, document), name, and link",
          schema: z.object({
            results: z.array(z.object({
              type: z.string().optional(),
              name: z.string(),
              url:  z.string().optional(),
            })),
          }),
        });
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });
}

// ── MCP Server factory ────────────────────────────────────────────────────────
function createMcpServer() {
  const s = new Server(
    { name: "buildertrend-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  s.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await handleTool(name, args || {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  });
  return s;
}

// ── Start — dual mode: HTTP (Railway) or stdio (local) ────────────────────────
const USE_HTTP = process.env.MCP_TRANSPORT === "sse" || process.env.PORT;

if (USE_HTTP) {
  const PORT = parseInt(process.env.PORT || "3000", 10);
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ status: "ok", service: "buildertrend-mcp" }));

  // Streamable HTTP (primary)
  const httpSessions = new Map();
  app.all("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] || randomUUID();
    let transport = httpSessions.get(sessionId);
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
        onsessioninitialized: (id) => { httpSessions.set(id, transport); },
      });
      transport.onclose = () => httpSessions.delete(sessionId);
      await createMcpServer().connect(transport);
    }
    await transport.handleRequest(req, res);
  });

  // SSE (fallback)
  const sseSessions = new Map();
  app.get("/sse", async (req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    sseSessions.set(transport.sessionId, transport);
    res.on("close", () => sseSessions.delete(transport.sessionId));
    await createMcpServer().connect(transport);
  });
  app.post("/messages", async (req, res) => {
    const transport = sseSessions.get(req.query.sessionId);
    if (!transport) return res.status(404).json({ error: "Session not found" });
    await transport.handlePostMessage(req, res);
  });

  app.listen(PORT, () => {
    console.log(`Buildertrend MCP server listening on port ${PORT}`);
    console.log(`  Health: http://localhost:${PORT}/health`);
    console.log(`  MCP:    http://localhost:${PORT}/mcp`);
    console.log(`  SSE:    http://localhost:${PORT}/sse`);
  });

} else {
  const transport = new StdioServerTransport();
  await createMcpServer().connect(transport);
  console.error("Buildertrend MCP server running (stdio)");
}
