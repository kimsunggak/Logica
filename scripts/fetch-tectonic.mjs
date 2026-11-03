#!/usr/bin/env node
/**
 * Download the Tectonic TeX engine that ships inside LOGICA as a Tauri sidecar
 * (src-tauri/binaries/tectonic-<target triple>[.exe]).
 *
 * Runs before `tauri dev` / `tauri build`. The archive for the target platform
 * is fetched from the official GitHub release and must match the SHA-256 pinned
 * below; anything else is rejected. Nothing is downloaded when the binary for
 * this version is already in place.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.17.0";
const RELEASE = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${VERSION}`;

/** Tauri target triple -> release archive and its SHA-256. */
const ASSETS = {
  "x86_64-pc-windows-msvc": {
    file: `tectonic-${VERSION}-x86_64-pc-windows-msvc.zip`,
    sha256: "f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f",
  },
  "x86_64-apple-darwin": {
    file: `tectonic-${VERSION}-x86_64-apple-darwin.tar.gz`,
    sha256: "7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80",
  },
  "aarch64-apple-darwin": {
    file: `tectonic-${VERSION}-aarch64-apple-darwin.tar.gz`,
    sha256: "a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667",
  },
  // Linux uses the statically linked musl build: it runs on any distribution.
  "x86_64-unknown-linux-gnu": {
    file: `tectonic-${VERSION}-x86_64-unknown-linux-musl.tar.gz`,
    sha256: "8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7",
  },
  "aarch64-unknown-linux-gnu": {
    file: `tectonic-${VERSION}-aarch64-unknown-linux-musl.tar.gz`,
    sha256: "b10954a95404f3ab2328d2fa59a5ebab8e657f893fab096f98be8db7c0c979b8",
  },
};

function targetTriple() {
  if (process.env.TAURI_ENV_TARGET_TRIPLE) return process.env.TAURI_ENV_TARGET_TRIPLE;
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const host = /^host: (\S+)$/m.exec(out);
  if (!host) throw new Error("Could not determine the Rust target triple (rustc -vV).");
  return host[1];
}

async function main() {
  const triple = targetTriple();
  const asset = ASSETS[triple];
  if (!asset) {
    console.error(`[tectonic] No bundled TeX engine for ${triple}. Supported: ${Object.keys(ASSETS).join(", ")}`);
    process.exit(1);
  }
  const exe = triple.includes("windows") ? ".exe" : "";
  const binDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "binaries");
  const target = join(binDir, `tectonic-${triple}${exe}`);
  const stamp = `${target}.version`;
  if (existsSync(target) && existsSync(stamp) && readFileSync(stamp, "utf8").trim() === `${VERSION} ${asset.sha256}`) {
    return; // already in place
  }

  console.log(`[tectonic] Downloading Tectonic ${VERSION} for ${triple}...`);
  const response = await fetch(`${RELEASE}/${asset.file}`);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} for ${asset.file}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== asset.sha256) {
    throw new Error(`Checksum mismatch for ${asset.file}: expected ${asset.sha256}, got ${digest}. Refusing to use it.`);
  }

  const work = mkdtempSync(join(tmpdir(), "logica-tectonic-"));
  try {
    const archivePath = join(work, asset.file);
    writeFileSync(archivePath, archive);
    // bsdtar (Windows 10+, macOS) and GNU tar (Linux, for .tar.gz) both handle these archives.
    execFileSync("tar", ["-xf", archivePath, "-C", work]);
    const extracted = join(work, `tectonic${exe}`);
    if (!existsSync(extracted)) throw new Error(`tectonic${exe} not found in ${asset.file}`);
    mkdirSync(binDir, { recursive: true });
    rmSync(target, { force: true });
    renameSync(extracted, target);
    if (!exe) chmodSync(target, 0o755);
    writeFileSync(stamp, `${VERSION} ${asset.sha256}\n`);
    console.log(`[tectonic] Installed ${target}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[tectonic] ${err.message}`);
  process.exit(1);
});
