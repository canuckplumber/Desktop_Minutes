import dotenv from "dotenv";
import OpenAI from "openai";

if (!process.env.OPENAI_API_KEY) {
  // Prefer the machine's environment variable and only use the project .env
  // as a development fallback.
  dotenv.config({ path: ".env", quiet: true });
}

const DEFAULTS = {
  language: "en",
  transcriptionDelay: "low",
  realtimeTranscriptionModel: "gpt-realtime-whisper",
  suggestionModel: "gpt-5.5",
  analysisIntervalMs: 20000,
};

const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "speakingPoints",
    "decisions",
    "risks",
    "parkingLot",
    "actionItems",
    "minutesDraft",
  ],
  properties: {
    summary: { type: "string" },
    speakingPoints: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["point", "reason", "priority"],
        properties: {
          point: { type: "string" },
          reason: { type: "string" },
          priority: {
            type: "string",
            enum: ["high", "medium", "low"],
          },
        },
      },
    },
    decisions: {
      type: "array",
      items: { type: "string" },
    },
    risks: {
      type: "array",
      items: { type: "string" },
    },
    parkingLot: {
      type: "array",
      items: { type: "string" },
    },
    actionItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["owner", "task", "due"],
        properties: {
          owner: { type: "string" },
          task: { type: "string" },
          due: { type: "string" },
        },
      },
    },
    minutesDraft: { type: "string" },
  },
};

const ANALYSIS_PROMPT = `
You are a live meeting coach and minute-taker for an in-person business meeting.

Your job:
- Read the rolling meeting transcript and existing notes.
- Produce a concise summary of where the meeting stands right now.
- Suggest 3 to 5 useful points that the meeting owner should consider saying next.
- Highlight decisions already made.
- Highlight risks, blockers, and unresolved questions.
- Capture specific action items with an owner and due date if one is stated. If a due date is not stated, write "Not specified".
- Write a polished minutes draft in Markdown with sections for Summary, Decisions, Action Items, Risks, and Parking Lot.

Rules:
- Be specific and practical.
- Base recommendations on the transcript, not generic facilitation advice.
- Do not invent owners or deadlines.
- Keep the speaking points tactical and phrased like things the user could actually say in the meeting.
`.trim();

function getServerConfig() {
  return {
    openaiApiKey: process.env.OPENAI_API_KEY?.trim() || "",
    language: process.env.MEETING_LANGUAGE?.trim() || DEFAULTS.language,
    transcriptionDelay:
      process.env.MEETING_TRANSCRIPTION_DELAY?.trim() ||
      DEFAULTS.transcriptionDelay,
    realtimeTranscriptionModel:
      process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL?.trim() ||
      DEFAULTS.realtimeTranscriptionModel,
    suggestionModel:
      process.env.OPENAI_SUGGESTION_MODEL?.trim() || DEFAULTS.suggestionModel,
    analysisIntervalMs: normalizeInterval(
      process.env.MEETING_ANALYSIS_INTERVAL_MS,
    ),
  };
}

function normalizeInterval(value) {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 5000) {
    return parsed;
  }

  return DEFAULTS.analysisIntervalMs;
}

function requireApiKey(config) {
  if (!config.openaiApiKey) {
    throw new Error(
      "OPENAI_API_KEY is missing. Set it in your Windows environment variables or add it to a project .env file as a fallback.",
    );
  }
}

function createClient(config) {
  requireApiKey(config);
  return new OpenAI({ apiKey: config.openaiApiKey });
}

function trimTranscriptSegments(segments) {
  const finalSegments = (segments || [])
    .filter((segment) => segment.status === "final" && segment.text?.trim())
    .slice(-60);

  const transcriptText = finalSegments
    .map((segment) => `- ${segment.text.trim()}`)
    .join("\n")
    .slice(-14000);

  return { finalSegments, transcriptText };
}

function buildAnalysisPayload(payload) {
  const { finalSegments, transcriptText } = trimTranscriptSegments(
    payload?.transcriptSegments,
  );

  return {
    title: payload?.title || "Untitled meeting",
    participants: payload?.participants || [],
    manualNotes: payload?.manualNotes || "",
    existingMinutesDraft: payload?.minutesDraft || "",
    transcriptText,
    finalSegments,
  };
}

export function getPublicConfig() {
  const config = getServerConfig();

  return {
    hasApiKey: Boolean(config.openaiApiKey),
    defaultLanguage: config.language,
    transcriptionDelay: config.transcriptionDelay,
    realtimeTranscriptionModel: config.realtimeTranscriptionModel,
    suggestionModel: config.suggestionModel,
    analysisIntervalMs: config.analysisIntervalMs,
  };
}

export async function createRealtimeClientSecret(options = {}) {
  const config = getServerConfig();
  requireApiKey(config);

  const session = {
    type: "transcription",
    audio: {
      input: {
        transcription: {
          model: config.realtimeTranscriptionModel,
          language: options.language || config.language,
          delay: options.delay || config.transcriptionDelay,
        },
        turn_detection: null,
      },
    },
  };

  const response = await fetch(
    "https://api.openai.com/v1/realtime/client_secrets",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ session }),
    },
  );

  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      `Failed to create a realtime client secret: ${details || response.statusText}`,
    );
  }

  const data = await response.json();

  return {
    value: data.value ?? data.client_secret?.value,
    expiresAt: data.expires_at ?? data.client_secret?.expires_at,
  };
}

export async function runMeetingAnalysis(payload) {
  const config = getServerConfig();
  const client = createClient(config);
  const analysisPayload = buildAnalysisPayload(payload);

  if (!analysisPayload.transcriptText) {
    return {
      summary: "Waiting for enough finished transcript to analyze the meeting.",
      speakingPoints: [],
      decisions: [],
      risks: [],
      parkingLot: [],
      actionItems: [],
      minutesDraft: payload?.minutesDraft || "",
      generatedAt: new Date().toISOString(),
    };
  }

  const response = await client.responses.create({
    model: config.suggestionModel,
    reasoning: { effort: "low" },
    text: {
      format: {
        type: "json_schema",
        name: "meeting_analysis",
        schema: ANALYSIS_SCHEMA,
        strict: true,
      },
    },
    input: [
      {
        role: "developer",
        content: ANALYSIS_PROMPT,
      },
      {
        role: "user",
        content: JSON.stringify(analysisPayload, null, 2),
      },
    ],
  });

  const outputText = response.output_text?.trim();
  if (!outputText) {
    throw new Error("The analysis response came back empty.");
  }

  const parsed = JSON.parse(outputText);
  return {
    ...parsed,
    generatedAt: new Date().toISOString(),
  };
}

export function buildMeetingMinutesPdfHtml(payload) {
  const title = payload?.title?.trim() || "Meeting Minutes";
  const participants = (payload?.participants || []).filter(Boolean);
  const analysis = payload?.analysis || null;
  const minutesDraft = payload?.minutesDraft?.trim() || "";
  const transcriptSegments = (payload?.transcriptSegments || [])
    .filter((segment) => segment.status === "final" && segment.text?.trim())
    .map((segment) => segment.text.trim());

  const actionItems = (analysis?.actionItems || []).map((item) => ({
    owner: item.owner || "Not specified",
    task: item.task || "Not specified",
    due: item.due || "Not specified",
  }));

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      @page {
        size: Letter;
        margin: 0.55in;
      }

      :root {
        color-scheme: light;
        font-family: "Segoe UI", "Arial", sans-serif;
        color: #102426;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        color: #102426;
        background: #ffffff;
        font-size: 11pt;
        line-height: 1.5;
      }

      .sheet {
        display: flex;
        flex-direction: column;
        gap: 18px;
      }

      .hero {
        padding: 22px 24px;
        border-radius: 22px;
        color: #eef7f5;
        background:
          radial-gradient(circle at top left, rgba(116, 210, 193, 0.16), transparent 28%),
          linear-gradient(135deg, #143438, #0c1315);
      }

      .eyebrow {
        margin: 0 0 8px;
        color: #f4b85f;
        font-size: 9pt;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.16em;
      }

      h1 {
        margin: 0;
        font-size: 26pt;
        line-height: 1.05;
      }

      .meta {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
        margin-top: 18px;
      }

      .meta-card {
        padding: 12px 14px;
        border-radius: 16px;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.08);
      }

      .meta-card span {
        display: block;
        color: rgba(238, 247, 245, 0.74);
        font-size: 9pt;
      }

      .meta-card strong {
        display: block;
        margin-top: 6px;
        font-size: 11pt;
        color: #ffffff;
      }

      .grid {
        display: grid;
        grid-template-columns: 1.1fr 0.9fr;
        gap: 16px;
      }

      .card {
        padding: 16px 18px;
        border: 1px solid #d7e7e3;
        border-radius: 18px;
        background: #fbfdfc;
        break-inside: avoid;
      }

      .card h2 {
        margin: 0 0 10px;
        font-size: 13pt;
        color: #143438;
      }

      .summary {
        background:
          linear-gradient(135deg, rgba(244, 184, 95, 0.14), rgba(116, 210, 193, 0.1)),
          #fbfdfc;
      }

      .minutes {
        white-space: pre-wrap;
      }

      .section-title {
        margin: 0 0 10px;
        color: #143438;
        font-size: 12pt;
      }

      ul, ol {
        margin: 0;
        padding-left: 20px;
      }

      li + li {
        margin-top: 6px;
      }

      .action-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .action-item {
        padding: 10px 12px;
        border-radius: 14px;
        background: #f2f7f5;
        border: 1px solid #d7e7e3;
      }

      .action-item strong,
      .action-item span {
        display: block;
      }

      .action-item span {
        color: #4a6463;
        font-size: 10pt;
      }

      .transcript {
        padding: 0;
        border: none;
        background: transparent;
      }

      .transcript-entry {
        padding: 10px 0;
        border-bottom: 1px solid #dce9e6;
      }

      .transcript-entry:last-child {
        border-bottom: none;
      }

      .muted {
        color: #5e7674;
      }
    </style>
  </head>
  <body>
    <div class="sheet">
      <section class="hero">
        <p class="eyebrow">Meeting Minutes Studio</p>
        <h1>${escapeHtml(title)}</h1>
        <div class="meta">
          <div class="meta-card">
            <span>Participants</span>
            <strong>${escapeHtml(
              participants.length ? participants.join(", ") : "Not listed",
            )}</strong>
          </div>
          <div class="meta-card">
            <span>Generated</span>
            <strong>${escapeHtml(formatTimestamp(new Date().toISOString()))}</strong>
          </div>
          <div class="meta-card">
            <span>Transcript turns</span>
            <strong>${escapeHtml(String(transcriptSegments.length))}</strong>
          </div>
        </div>
      </section>

      <section class="card summary">
        <h2>Current Summary</h2>
        <div class="minutes">${escapeHtml(
          analysis?.summary || "No summary captured yet.",
        )}</div>
      </section>

      <section class="grid">
        <section class="card">
          <h2>Draft Minutes</h2>
          <div class="minutes">${escapeHtml(
            minutesDraft || "No draft minutes yet.",
          )}</div>
        </section>

        <section class="card">
          <h2>Action Items</h2>
          ${
            actionItems.length
              ? `<div class="action-list">${actionItems
                  .map(
                    (item) => `<div class="action-item">
                  <strong>${escapeHtml(item.task)}</strong>
                  <span>Owner: ${escapeHtml(item.owner)}</span>
                  <span>Due: ${escapeHtml(item.due)}</span>
                </div>`,
                  )
                  .join("")}</div>`
              : `<p class="muted">No action items captured yet.</p>`
          }
        </section>
      </section>

      <section class="grid">
        <section class="card">
          <h2>Decisions</h2>
          ${renderHtmlList(
            analysis?.decisions || [],
            "No decisions captured yet.",
          )}
        </section>

        <section class="card">
          <h2>Risks</h2>
          ${renderHtmlList(analysis?.risks || [], "No risks captured yet.")}
        </section>
      </section>

      <section class="grid">
        <section class="card">
          <h2>Parking Lot</h2>
          ${renderHtmlList(
            analysis?.parkingLot || [],
            "No parking-lot topics captured yet.",
          )}
        </section>

        <section class="card">
          <h2>Manual Notes</h2>
          <div class="minutes">${escapeHtml(
            payload?.manualNotes?.trim() || "None",
          )}</div>
        </section>
      </section>

      <section class="card transcript">
        <h2 class="section-title">Transcript</h2>
        ${
          transcriptSegments.length
            ? transcriptSegments
                .map(
                  (entry) =>
                    `<div class="transcript-entry">${escapeHtml(entry)}</div>`,
                )
                .join("")
            : `<p class="muted">No final transcript captured yet.</p>`
        }
      </section>
    </div>
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTimestamp(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function renderHtmlList(items, fallback) {
  if (!items.length) {
    return `<p class="muted">${escapeHtml(fallback)}</p>`;
  }

  return `<ul>${items
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("")}</ul>`;
}
