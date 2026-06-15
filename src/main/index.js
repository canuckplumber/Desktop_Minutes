import fs from "node:fs/promises";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildMeetingMinutesPdfHtml,
  createRealtimeClientSecret,
  getPublicConfig,
  runMeetingAnalysis,
} from "./openai.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rendererUrl = process.env.ELECTRON_RENDERER_URL;
const rendererFile = path.join(__dirname, "../../dist/index.html");
const appIcon = path.join(__dirname, "../../assets/meeting-minutes-icon.ico");

function createWindow() {
  const window = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    backgroundColor: "#101719",
    icon: appIcon,
    title: "Meeting Minutes Studio",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(rendererFile);
  }
}

function registerHandlers() {
  ipcMain.handle("config:get", async () => getPublicConfig());

  ipcMain.handle("openai:create-realtime-token", async (_event, options) =>
    createRealtimeClientSecret(options ?? {}),
  );

  ipcMain.handle("meeting:analyze", async (_event, payload) =>
    runMeetingAnalysis(payload),
  );

  ipcMain.handle("meeting:export", async (_event, payload) => {
    const suggestedName = `${slugify(payload?.title || "meeting-minutes")}.pdf`;
    const result = await dialog.showSaveDialog({
      title: "Export meeting minutes as PDF",
      defaultPath: suggestedName,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    await exportMeetingMinutesPdf(result.filePath, payload);
    return { canceled: false, filePath: result.filePath };
  });
}

async function exportMeetingMinutesPdf(filePath, payload) {
  const exportWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });

  try {
    const html = buildMeetingMinutesPdfHtml(payload);
    await exportWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    );

    const pdf = await exportWindow.webContents.printToPDF({
      printBackground: true,
      pageSize: "Letter",
      margins: {
        top: 0.5,
        bottom: 0.5,
        left: 0.5,
        right: 0.5,
      },
      preferCSSPageSize: true,
    });

    await fs.writeFile(filePath, pdf);
  } finally {
    exportWindow.close();
  }
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

app.whenReady().then(() => {
  registerHandlers();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
