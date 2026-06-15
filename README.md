# Meeting Minutes Studio

Meeting Minutes Studio is an Electron desktop app for in-person meetings. It listens to a room microphone, streams live transcript updates, and keeps a sidebar of suggested talking points, action items, and draft minutes.

## What it does

- Captures live meeting audio from your microphone.
- Uses OpenAI Realtime transcription for low-latency transcript updates.
- Uses the OpenAI Responses API to turn the rolling transcript into:
  - live talking points,
  - draft minutes,
  - action items,
  - risks and parking-lot topics.
- Exports a meeting pack as PDF.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Set `OPENAI_API_KEY` in your Windows user environment variables.

```powershell
setx OPENAI_API_KEY "your_api_key_here"
```

Close and reopen your terminal after setting it so new processes can see it.

3. Optional fallback for local development only: copy `.env.example` to `.env` and fill in your key if you do not want to use the Windows environment variable.

```powershell
Copy-Item .env.example .env
```

Keep `.env` local only. It is already excluded from Git.

4. Run it as a local desktop app:

```bash
npm start
```

This builds the renderer and opens the Electron desktop window from local files.
If you want a double-click launcher inside the project folder, use `Launch Meeting Minutes Studio.vbs` for a quiet launch or `Launch Meeting Minutes Studio.cmd` for a visible terminal launch.

5. Optional development mode:

```bash
npm run dev
```

This also opens the Electron desktop app, but uses the live development server for faster iteration.

## Project shape

- `src/main` contains the Electron shell and secure OpenAI bridge.
- `src/preload` exposes a minimal safe API to the renderer.
- `src/renderer` contains the React meeting workspace.

## Current prototype limits

- Transcript commits are time-based, not silence-detected yet.
- Speaker diarization is not implemented in the live view.
- Minutes export to PDF, not DOCX yet.
