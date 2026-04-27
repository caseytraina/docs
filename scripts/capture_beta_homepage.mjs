import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright-core";

const DEFAULT_URL = "https://beta.overlap.ai";
const DEFAULT_OUTPUT = "images/generated/beta-homepage-raw.png";
const DEFAULT_WINDOW_WIDTH = 1440;
const DEFAULT_WINDOW_HEIGHT = 960;
const DEFAULT_WAIT_MS = 10000;
const DEFAULT_POST_CLICK_WAIT_MS = 3000;
const DEFAULT_PROFILE_ROOT = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Google",
  "Chrome",
);
const DEFAULT_CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_DEBUG_TIMEOUT_MS = 30000;

function getArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index !== -1 && index + 1 < process.argv.length) {
    return process.argv[index + 1];
  }

  return fallback;
}

function getArgs(name) {
  const values = [];

  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && index + 1 < process.argv.length) {
      values.push(process.argv[index + 1]);
    }
  }

  return values;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForProcessExit(childProcess, timeoutMs = 5000) {
  await Promise.race([
    new Promise((resolve) => {
      childProcess.once("exit", resolve);
      childProcess.once("close", resolve);
    }),
    delay(timeoutMs),
  ]);
}

async function detectProfileName(profileRoot) {
  const localStatePath = path.join(profileRoot, "Local State");
  const raw = await readFile(localStatePath, "utf8");
  const data = JSON.parse(raw);
  return data?.profile?.last_used || "Default";
}

async function pathExists(targetPath) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function copyIfPresent(sourcePath, destinationPath) {
  if (!(await pathExists(sourcePath))) {
    return;
  }

  await mkdir(path.dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath, { recursive: true });
}

async function waitForDebugEndpoint(port, timeoutMs) {
  const startedAt = Date.now();
  const endpoint = `http://127.0.0.1:${port}/json/version`;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        return endpoint;
      }
    } catch {
      // Chrome may still be starting up.
    }

    await delay(250);
  }

  throw new Error(`Timed out waiting for Chrome DevTools on port ${port}.`);
}

async function clickByText(page, text) {
  const candidates = [
    page.getByRole("button", { name: text, exact: true }),
    page.getByRole("link", { name: text, exact: true }),
    page.getByText(text, { exact: true }),
    page.locator(`[aria-label="${text}"]`),
    page.getByRole("button", { name: new RegExp(text, "i") }),
    page.getByRole("link", { name: new RegExp(text, "i") }),
    page.getByText(new RegExp(text, "i")),
  ];

  for (const candidate of candidates) {
    const first = candidate.first();
    try {
      await first.waitFor({ state: "visible", timeout: 5000 });
      await first.click();
      return;
    } catch {
      // Try the next locator strategy.
    }
  }

  throw new Error(`Could not find a clickable element with text "${text}".`);
}

async function main() {
  const profileRoot = getArg("--profile-root", DEFAULT_PROFILE_ROOT);
  const profileName =
    getArg("--profile-name", null) || (await detectProfileName(profileRoot));
  const outputPath = path.resolve(getArg("--output", DEFAULT_OUTPUT));
  const pathArg = getArg("--path", null);
  const url = getArg("--url", pathArg ? new URL(pathArg, DEFAULT_URL).toString() : DEFAULT_URL);
  const windowWidth = Number(getArg("--width", String(DEFAULT_WINDOW_WIDTH)));
  const windowHeight = Number(getArg("--height", String(DEFAULT_WINDOW_HEIGHT)));
  const waitMs = Number(getArg("--wait-ms", String(DEFAULT_WAIT_MS)));
  const postClickWaitMs = Number(
    getArg("--post-click-wait-ms", String(DEFAULT_POST_CLICK_WAIT_MS)),
  );
  const stateOutputPath = getArg("--state-output", null);
  const chromePath = getArg("--chrome-path", DEFAULT_CHROME_PATH);
  const debugTimeoutMs = Number(
    getArg("--debug-timeout-ms", String(DEFAULT_DEBUG_TIMEOUT_MS)),
  );
  const debugPort = Number(
    getArg("--debug-port", String(42000 + Math.floor(Math.random() * 1000))),
  );
  const clickTexts = getArgs("--click-text");

  const tempUserDataDir = await mkdtemp(
    path.join(os.tmpdir(), "overlap-playwright-profile-"),
  );
  const tempProfileDir = path.join(tempUserDataDir, profileName);
  let chromeProcess;
  let browser;

  try {
    await copyIfPresent(
      path.join(profileRoot, "Local State"),
      path.join(tempUserDataDir, "Local State"),
    );
    await mkdir(tempProfileDir, { recursive: true });

    const profilePathsToCopy = [
      "Cookies",
      "Extension Cookies",
      "Extension Rules",
      "Extension Scripts",
      "Extension State",
      "Extensions",
      "Local Storage",
      "Login Data",
      "Network",
      "Preferences",
      "Secure Preferences",
      "Session Storage",
      "Sessions",
      "Shared Dictionary",
      "shared_proto_db",
      "Web Data",
    ];

    for (const relativePath of profilePathsToCopy) {
      await copyIfPresent(
        path.join(profileRoot, profileName, relativePath),
        path.join(tempProfileDir, relativePath),
      );
    }

    chromeProcess = spawn(
      chromePath,
      [
        "--headless=new",
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${tempUserDataDir}`,
        `--profile-directory=${profileName}`,
        `--window-size=${windowWidth},${windowHeight}`,
        "--hide-scrollbars",
        "--disable-dev-shm-usage",
        "--disable-background-networking",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
      },
    );

    let browserErrors = "";
    chromeProcess.stderr.on("data", (chunk) => {
      browserErrors += chunk.toString();
    });

    await waitForDebugEndpoint(debugPort, debugTimeoutMs);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);

    const context = browser.contexts()[0];
    const existingPage = context.pages()[0];
    const page = existingPage || (await context.newPage());

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });
    await page
      .waitForFunction(() => Boolean(document.body?.innerText?.trim()), {
        timeout: 30000,
      })
      .catch(() => {});
    await page.waitForTimeout(waitMs);

    if (stateOutputPath) {
      const state = await page.evaluate(() => ({
        title: document.title,
        url: window.location.href,
        text: document.body?.innerText || "",
      }));
      await writeFile(path.resolve(stateOutputPath), JSON.stringify(state, null, 2));
    }

    for (const clickText of clickTexts) {
      await clickByText(page, clickText);
      await page.waitForTimeout(postClickWaitMs);
    }

    await page.screenshot({
      path: outputPath,
      timeout: 0,
    });

    if (!(await pathExists(outputPath)) && browserErrors) {
      throw new Error(browserErrors);
    }
  } finally {
    await browser?.close().catch(() => {});
    if (chromeProcess) {
      chromeProcess.kill("SIGKILL");
      await waitForProcessExit(chromeProcess);
    }
    await rm(tempUserDataDir, { recursive: true, force: true }).catch(async () => {
      await delay(500);
      await rm(tempUserDataDir, { recursive: true, force: true });
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
