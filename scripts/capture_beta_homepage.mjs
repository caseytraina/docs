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
const DEFAULT_SCREENSHOT_TIMEOUT_MS = 120000;
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

function getClickActions() {
  const actions = [];

  for (let index = 0; index < process.argv.length; index += 1) {
    if (
      process.argv[index] === "--click-text" &&
      index + 1 < process.argv.length
    ) {
      actions.push({ type: "text", value: process.argv[index + 1] });
    }

    if (
      process.argv[index] === "--click-text-dom" &&
      index + 1 < process.argv.length
    ) {
      actions.push({ type: "textDom", value: process.argv[index + 1] });
    }

    if (
      process.argv[index] === "--scroll-text-dom" &&
      index + 1 < process.argv.length
    ) {
      actions.push({ type: "scrollTextDom", value: process.argv[index + 1] });
    }

    if (
      process.argv[index] === "--click-at" &&
      index + 1 < process.argv.length
    ) {
      const [x, y] = process.argv[index + 1]
        .split(",")
        .map((coordinate) => Number(coordinate.trim()));

      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(
          `Invalid --click-at value "${process.argv[index + 1]}". Use "x,y".`,
        );
      }

      actions.push({ type: "point", x, y });
    }

    if (
      process.argv[index] === "--double-click-at" &&
      index + 1 < process.argv.length
    ) {
      const [x, y] = process.argv[index + 1]
        .split(",")
        .map((coordinate) => Number(coordinate.trim()));

      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(
          `Invalid --double-click-at value "${process.argv[index + 1]}". Use "x,y".`,
        );
      }

      actions.push({ type: "doublePoint", x, y });
    }

    if (
      process.argv[index] === "--drag" &&
      index + 2 < process.argv.length
    ) {
      const [fromX, fromY] = process.argv[index + 1]
        .split(",")
        .map((coordinate) => Number(coordinate.trim()));
      const [toX, toY] = process.argv[index + 2]
        .split(",")
        .map((coordinate) => Number(coordinate.trim()));

      if (
        !Number.isFinite(fromX) ||
        !Number.isFinite(fromY) ||
        !Number.isFinite(toX) ||
        !Number.isFinite(toY)
      ) {
        throw new Error(
          `Invalid --drag value "${process.argv[index + 1]} ${process.argv[index + 2]}". Use "fromX,fromY toX,toY".`,
        );
      }

      actions.push({ type: "drag", fromX, fromY, toX, toY });
    }

    if (
      process.argv[index] === "--wheel" &&
      index + 1 < process.argv.length
    ) {
      const [deltaX, deltaY] = process.argv[index + 1]
        .split(",")
        .map((coordinate) => Number(coordinate.trim()));

      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
        throw new Error(
          `Invalid --wheel value "${process.argv[index + 1]}". Use "deltaX,deltaY".`,
        );
      }

      actions.push({ type: "wheel", deltaX, deltaY });
    }

    if (process.argv[index] === "--scroll-window-top") {
      actions.push({ type: "scrollWindowTop" });
    }

    if (
      process.argv[index] === "--fill-placeholder" &&
      index + 2 < process.argv.length
    ) {
      actions.push({
        type: "fillPlaceholder",
        placeholder: process.argv[index + 1],
        value: process.argv[index + 2],
      });
    }
  }

  return actions;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getPageState(page) {
  return page.evaluate(() => {
    const controls = [...document.querySelectorAll("button, a, [role='button']")]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          text: (element.textContent || "").replace(/\s+/g, " ").trim(),
          ariaLabel: element.getAttribute("aria-label"),
          role: element.getAttribute("role"),
          tag: element.tagName.toLowerCase(),
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      })
      .filter((item) => item.text || item.ariaLabel);

    return {
      title: document.title,
      url: window.location.href,
      text: document.body?.innerText || "",
      controls,
    };
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
  const clicked = await page.evaluate((targetText) => {
    const normalize = (value) => value.replace(/\s+/g, " ").trim();
    const elements = [
      ...document.querySelectorAll("button, a, [role='button']"),
    ];
    const element = elements.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return (
        normalize(candidate.textContent || "") === targetText &&
        rect.width > 0 &&
        rect.height > 0
      );
    });

    if (!element) {
      return false;
    }

    element.click();
    return true;
  }, text);

  if (clicked) {
    return;
  }

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
      await first.click({ timeout: 5000, force: true });
      return;
    } catch {
      // Try the next locator strategy.
    }
  }

  throw new Error(`Could not find a clickable element with text "${text}".`);
}

async function clickByTextDom(page, text) {
  const clicked = await page.evaluate((targetText) => {
    const normalize = (value) => value.replace(/\s+/g, " ").trim();
    const elements = [
      ...document.querySelectorAll("button, a, [role='button']"),
    ];
    const element = elements.find(
      (candidate) => normalize(candidate.textContent || "") === targetText,
    );

    if (!element) {
      return false;
    }

    element.click();
    return true;
  }, text);

  if (!clicked) {
    throw new Error(`Could not find a clickable element with text "${text}".`);
  }
}

async function captureScreenshot(page, outputPath, timeoutMs) {
  await page
    .setViewportSize({
      width: DEFAULT_WINDOW_WIDTH,
      height: DEFAULT_WINDOW_HEIGHT,
    })
    .catch(async () => {
      const session = await page.context().newCDPSession(page);
      await session
        .send("Emulation.setDeviceMetricsOverride", {
          width: DEFAULT_WINDOW_WIDTH,
          height: DEFAULT_WINDOW_HEIGHT,
          deviceScaleFactor: 1,
          mobile: false,
        })
        .catch(() => {});
    });

  try {
    await page.screenshot({
      path: outputPath,
      timeout: timeoutMs,
    });
    return;
  } catch (error) {
    if (error?.name !== "TimeoutError") {
      throw error;
    }
  }

  const session = await page.context().newCDPSession(page);
  const result = await session.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    fromSurface: true,
  });
  await writeFile(outputPath, Buffer.from(result.data, "base64"));
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
  const screenshotTimeoutMs = Number(
    getArg("--screenshot-timeout-ms", String(DEFAULT_SCREENSHOT_TIMEOUT_MS)),
  );
  const stateOutputPath = getArg("--state-output", null);
  const postClickStateOutputPath = getArg("--post-click-state-output", null);
  const skipScreenshot = process.argv.includes("--skip-screenshot");
  const chromePath = getArg("--chrome-path", DEFAULT_CHROME_PATH);
  const debugTimeoutMs = Number(
    getArg("--debug-timeout-ms", String(DEFAULT_DEBUG_TIMEOUT_MS)),
  );
  const debugPort = Number(
    getArg("--debug-port", String(42000 + Math.floor(Math.random() * 1000))),
  );
  const clickActions = getClickActions();

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
      const state = await getPageState(page);
      await writeFile(path.resolve(stateOutputPath), JSON.stringify(state, null, 2));
    }

    for (const clickAction of clickActions) {
      if (clickAction.type === "text") {
        await clickByText(page, clickAction.value);
      } else if (clickAction.type === "textDom") {
        await clickByTextDom(page, clickAction.value);
      } else if (clickAction.type === "scrollTextDom") {
        await page.evaluate((targetText) => {
          const normalize = (value) => value.replace(/\s+/g, " ").trim();
          const elements = [
            ...document.querySelectorAll("button, a, [role='button']"),
          ];
          const element = elements.find(
            (candidate) => normalize(candidate.textContent || "") === targetText,
          );

          element?.scrollIntoView({ block: "center", inline: "center" });
        }, clickAction.value);
      } else if (clickAction.type === "point") {
        await page.mouse.click(clickAction.x, clickAction.y);
      } else if (clickAction.type === "doublePoint") {
        await page.mouse.dblclick(clickAction.x, clickAction.y);
      } else if (clickAction.type === "drag") {
        await page.mouse.move(clickAction.fromX, clickAction.fromY);
        await page.mouse.down();
        await page.mouse.move(clickAction.toX, clickAction.toY, { steps: 12 });
        await page.mouse.up();
      } else if (clickAction.type === "wheel") {
        await page.mouse.wheel(clickAction.deltaX, clickAction.deltaY);
      } else if (clickAction.type === "scrollWindowTop") {
        await page.evaluate(() => {
          window.scrollTo(0, 0);
          document.documentElement.scrollTop = 0;
          document.body.scrollTop = 0;
        });
      } else if (clickAction.type === "fillPlaceholder") {
        await page
          .getByPlaceholder(new RegExp(clickAction.placeholder, "i"))
          .fill(clickAction.value);
      }

      await page.waitForTimeout(postClickWaitMs);
    }

    if (postClickStateOutputPath) {
      const state = await getPageState(page);
      await writeFile(
        path.resolve(postClickStateOutputPath),
        JSON.stringify(state, null, 2),
      );
    }

    if (skipScreenshot) {
      return;
    }

    await captureScreenshot(page, outputPath, screenshotTimeoutMs);

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
