#!/usr/bin/env bun
/**
 * CAST fork: install upstream's PREBUILT pi_natives N-API addons instead of
 * compiling crates/ with Rust.
 *
 *   bun cast/fetch-natives.ts                 # host platform (e.g. linux-x64)
 *   bun cast/fetch-natives.ts darwin-arm64    # another platform (for cross builds)
 *   bun cast/fetch-natives.ts --all           # every platform in the lock
 *   bun cast/fetch-natives.ts --relock        # rewrite cast/natives.lock.json for the
 *                                             # version in packages/natives/package.json
 *
 * Tarballs are cached in vendor/npm/ and verified against the sha512 integrity
 * pinned in cast/natives.lock.json (the same value npm/bun check). The *.node
 * files are copied into packages/natives/native/, which is where the workspace
 * loader (packages/natives/native/loader-state.js) and the standalone-binary
 * embedder (packages/natives/scripts/embed-native.ts) look for them.
 *
 * Patching Rust code under crates/ is NOT possible with this flow: the
 * prebuilt addons are upstream's bytes for exactly the pinned version.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = path.join(import.meta.dir, "..");
const lockPath = path.join(import.meta.dir, "natives.lock.json");
const vendorDir = path.join(root, "vendor", "npm");
const nativeDir = path.join(root, "packages", "natives", "native");
const ALL_TAGS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"];

interface Lock {
	package: string;
	version: string;
	note?: string;
	platforms: Record<string, { tarball: string; integrity: string }>;
}

function nativesVersion(): string {
	const pkg = JSON.parse(fs.readFileSync(path.join(root, "packages", "natives", "package.json"), "utf8"));
	return pkg.version;
}

function sri(bytes: Uint8Array): string {
	return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

async function relock(): Promise<void> {
	const version = nativesVersion();
	const platforms: Lock["platforms"] = {};
	for (const tag of ALL_TAGS) {
		const name = `@oh-my-pi/pi-natives-${tag}`;
		const res = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2F")}/${version}`);
		if (!res.ok) {
			console.error(`relock: ${name}@${version} not on npm (${res.status}); skipping`);
			continue;
		}
		const meta = (await res.json()) as { dist: { tarball: string; integrity: string } };
		platforms[tag] = { tarball: meta.dist.tarball, integrity: meta.dist.integrity };
	}
	const lock: Lock = {
		package: "@oh-my-pi/pi-natives",
		version,
		note: "Prebuilt N-API addons published by upstream to npm. Regenerate with: bun cast/fetch-natives.ts --relock",
		platforms,
	};
	fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
	console.log(`relock: wrote ${lockPath} for ${version} (${Object.keys(platforms).join(", ")})`);
}

async function fetchOne(lock: Lock, tag: string): Promise<void> {
	const entry = lock.platforms[tag];
	if (!entry) throw new Error(`no ${tag} entry in ${lockPath}`);
	fs.mkdirSync(vendorDir, { recursive: true });
	const tgz = path.join(vendorDir, `pi-natives-${tag}-${lock.version}.tgz`);
	let bytes: Uint8Array | null = fs.existsSync(tgz) ? new Uint8Array(fs.readFileSync(tgz)) : null;
	if (bytes && sri(bytes) !== entry.integrity) {
		console.warn(`${tag}: cached tarball fails integrity, re-downloading`);
		bytes = null;
	}
	if (!bytes) {
		console.log(`${tag}: downloading ${entry.tarball}`);
		const res = await fetch(entry.tarball);
		if (!res.ok) throw new Error(`${tag}: HTTP ${res.status} for ${entry.tarball}`);
		bytes = new Uint8Array(await res.arrayBuffer());
		if (sri(bytes) !== entry.integrity) throw new Error(`${tag}: integrity mismatch for ${entry.tarball}`);
		fs.writeFileSync(tgz, bytes);
	}
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `cast-natives-${tag}-`));
	try {
		const tar = Bun.spawnSync(["tar", "-xzf", tgz, "-C", tmp], { stderr: "pipe" });
		if (tar.exitCode !== 0) throw new Error(`${tag}: tar failed: ${tar.stderr.toString()}`);
		const pkgDir = path.join(tmp, "package");
		const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
		if (manifest.version !== lock.version) {
			throw new Error(`${tag}: tarball is ${manifest.version}, lock says ${lock.version}`);
		}
		const nodes = fs.readdirSync(pkgDir).filter(f => f.endsWith(".node"));
		if (nodes.length === 0) throw new Error(`${tag}: tarball has no .node files`);
		for (const f of nodes) {
			fs.copyFileSync(path.join(pkgDir, f), path.join(nativeDir, f));
			console.log(`${tag}: installed packages/natives/native/${f}`);
		}
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes("--relock")) return relock();
	const lock = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Lock;
	const want = nativesVersion();
	if (lock.version !== want) {
		throw new Error(
			`natives.lock.json pins ${lock.version} but packages/natives is ${want}. Run: bun cast/fetch-natives.ts --relock`,
		);
	}
	const tags = args.includes("--all")
		? Object.keys(lock.platforms)
		: args.filter(a => !a.startsWith("-")).length > 0
			? args.filter(a => !a.startsWith("-"))
			: [`${process.platform}-${process.arch}`];
	for (const tag of tags) await fetchOne(lock, tag);
}

await main();
